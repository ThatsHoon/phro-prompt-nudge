import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Nudge } from '../types'

const nudge = atom({ plugin: 'phro-prompt-nudge', key: 'nudge' } as const, null)
const isOff = atom({ plugin: 'phro-prompt-nudge', key: 'isOff' } as const, false)

// ponytail: last 8 messages, 600 chars each — enough context for a nudge, cheap for haiku
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
    return { tip: tip.trim(), next: typeof next === 'string' ? next.trim() : '' }
  } catch {
    return null // model output is untrusted; a bad reply means no nudge this turn
  }
}

async function analyze($: EngineInterface) {
  const messages = (await $.session.messages()).filter(m => m.text)
  const transcript = messages
    .slice(-RECENT)
    .map(m => `${m.role.toUpperCase()}: ${m.text.slice(0, CLIP)}`)
    .join('\n\n')
  if (!transcript) return

  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: transcript,
    maxTokens: 300,
    effort: 'low',
    timeoutMs: 20000,
  })
  if (!r.isAnswered) return
  await update($, nudge, () => parseNudge(r.text))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nudge',
      description: 'Toggle prompt nudges on or off',
    })
    return next(e)
  })

  on('command.run', { command: 'nudge' }, async $ => {
    const off = await update($, isOff, v => !v)
    if (off) await update($, nudge, () => null)
    return { text: off ? 'Prompt nudges off.' : 'Prompt nudges on.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, nudge, () => null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'
    if (isMainAnswer && !(await read($, isOff))) {
      $.clock.after(0, () => void analyze($))
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
                await $.prompt.fill({ text: current.next, mode: 'replace' })
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
