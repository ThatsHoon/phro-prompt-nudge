import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import type { Line, Nudge, Usage } from '../types'

const nudge = atom({ plugin: 'phro-prompt-nudge', key: 'nudge' } as const, null)
const isOff = atom({ plugin: 'phro-prompt-nudge', key: 'isOff' } as const, false)
// Recorded from prompt.submit and turn.complete, never read back from the transcript:
// the transcript's user rows also hold skill bodies, system reminders and command
// caveats other tools inject, which would reach Haiku as if the person wrote them.
const history = atom({ plugin: 'phro-prompt-nudge', key: 'history' } as const, [])
// Bumped on every human prompt. A turn is analyzed only when this moved since the last
// analysis (notification or scheduled turns repeat nothing), and a reply is dropped when
// it moved during the call (a nudge for an older prompt never shows).
const promptSeq = atom({ plugin: 'phro-prompt-nudge', key: 'promptSeq' } as const, 0)
const analyzedSeq = atom({ plugin: 'phro-prompt-nudge', key: 'analyzedSeq' } as const, 0)

// Origins where a person typed the prompt; deliveries, notifications and plugins are not theirs.
const HUMAN_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

// ponytail: last 8 lines, 600 chars each — enough context for a nudge, cheap for haiku
const RECENT = 8
const CLIP = 600

const SYSTEM = `You coach a developer on prompting an AI coding agent.
Read the recent conversation. Judge the user's LAST prompt: was it missing context, constraints, success criteria, scope, or was it ambiguous?
Then propose the single most useful next prompt the user could send, given the assistant's last answer.
Reply in the same language the user writes in.
Output ONLY JSON: {"tip": "<one sentence, max 80 chars, what to ask better>", "next": "<the next prompt, ready to send>"}
If the prompt was already sharp and no next step is worth suggesting, output {}.`

export function parseNudge(text: string): Nudge | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return null
  try {
    const { tip, next } = JSON.parse(json)
    if (typeof tip !== 'string' || !tip.trim()) return null
    return { tip: tip.trim().slice(0, 160), next: typeof next === 'string' ? next.trim().slice(0, 1000) : '' }
  } catch {
    return null // model output is untrusted; a bad reply means no nudge this turn
  }
}

/** The person's own words: tag-wrapped blocks a host or tool spliced in are dropped. */
export function typedText(text: string): string {
  return text
    .replace(/<([a-z][\w-]*)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

export function record(list: readonly Line[], line: Line): Line[] {
  return [...list, { role: line.role, text: line.text.slice(0, CLIP) }].slice(-RECENT)
}

export function addUsage(total: Usage | undefined, r: ModelCompleteResult): Usage {
  const t = total ?? { calls: 0, failed: 0, input: 0, output: 0, since: new Date().toISOString().slice(0, 10) }
  return {
    ...t,
    calls: t.calls + 1,
    failed: t.failed + (r.isAnswered ? 0 : 1),
    input: t.input + r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens,
    output: t.output + r.usage.output_tokens,
  }
}

async function analyze($: EngineInterface) {
  const seq = await read($, promptSeq)
  if (seq === (await read($, analyzedSeq))) return // no new human prompt since the last nudge
  await update($, analyzedSeq, () => seq)

  const lines = await read($, history)
  if (!lines.some(l => l.role === 'user')) return
  const transcript = lines.map(l => `${l.role.toUpperCase()}: ${l.text}`).join('\n\n')

  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: transcript,
    maxTokens: 300,
    effort: 'low',
    timeoutMs: 20000,
  })
  await $.store.set('usage', addUsage((await $.store.get('usage')) as Usage | undefined, r))
  if (!r.isAnswered || (await read($, promptSeq)) !== seq) return
  await update($, nudge, () => parseNudge(r.text))
}

export function formatUsage(u: Usage | undefined): string {
  if (!u) return 'No Haiku calls yet.'
  const per = (n: number) => Math.round(n / Math.max(1, u.calls))
  return (
    `Since ${u.since}: ${u.calls} Haiku calls (${u.failed} failed), ` +
    `${u.input} input + ${u.output} output tokens (avg ${per(u.input)} in / ${per(u.output)} out per call).`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nudge',
      description: 'Toggle prompt nudges on or off ("stats" shows Haiku token use)',
      argumentHint: '[stats]',
    })
    const stored = await $.store.get('isOff')
    if (typeof stored === 'boolean') await update($, isOff, () => stored)
    return next(e)
  })

  on('command.run', { command: 'nudge' }, async ($, e) => {
    if (e.args.trim() === 'stats') {
      return { text: formatUsage((await $.store.get('usage')) as Usage | undefined) }
    }
    const off = await update($, isOff, v => !v)
    await $.store.set('isOff', off)
    if (off) await update($, nudge, () => null)
    return { text: off ? 'Prompt nudges off.' : 'Prompt nudges on.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, nudge, () => null)
    const text = typedText(e.text)
    if (HUMAN_ORIGINS.has(e.origin.kind) && text && !text.startsWith('/')) {
      await update($, history, list => record(list, { role: 'user', text }))
      await update($, promptSeq, n => n + 1)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'
    if (!isMainAnswer) return result
    if (e.answer) {
      await update($, history, list => record(list, { role: 'assistant', text: e.answer }))
    }
    if (!(await read($, isOff))) {
      $.clock.after(0, () => {
        analyze($).catch(err => $.ui.log(`prompt-nudge: ${String(err)}`, { to: 'debug' }))
      })
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, nudge)
    if (e.props.hasSurvey || e.props.isWorking || current === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text dimColor>💡 {current.tip}</Text>
        <Box>
          {current.next && <Text>→ {current.next} </Text>}
          {current.next && (
            <Button
              key="use"
              label="Use"
              onPress={async () => {
                // insert at the cursor: an empty box gets the whole prompt, a draft is kept
                await $.prompt.fill({ text: current.next, mode: 'insert' })
                await update($, nudge, () => null)
              }}
            />
          )}
          <Button
            key="hide"
            label="Hide"
            onPress={() => update($, nudge, () => null)}
          />
        </Box>
      </Box>
    )
  })
}
