import { expect, test } from 'claude-code/testing'

import { addUsage, formatUsage, parseNudge, record, typedText } from './register'

test('parseNudge reads the model reply', async () => {
  expect(parseNudge('{"tip": "Name the file", "next": "Fix auth.ts:42"}')).toEqual({
    tip: 'Name the file',
    next: 'Fix auth.ts:42',
  })
  expect(parseNudge('Sure:\n```json\n{"tip":"Add success criteria"}\n```')).toEqual({
    tip: 'Add success criteria',
    next: '',
  })
  expect(parseNudge('{}')).toBe(null)
  expect(parseNudge('not json {oops')).toBe(null)
  expect(parseNudge('{"tip": 3}')).toBe(null)
})

test('typedText drops tag-wrapped blocks other tools splice in', async () => {
  expect(typedText('<system-reminder>\nCAVEMAN MODE\n</system-reminder>\n이거 고쳐줘')).toBe('이거 고쳐줘')
  expect(typedText('<local-command-caveat>x</local-command-caveat>')).toBe('')
  expect(typedText('a <b> c')).toBe('a <b> c')
})

test('record keeps the last 8 lines, each clipped', async () => {
  let list: { role: 'user' | 'assistant'; text: string }[] = []
  for (let i = 0; i < 10; i++) list = record(list, { role: 'user', text: String(i) })
  expect(list.map(l => l.text)).toEqual(['2', '3', '4', '5', '6', '7', '8', '9'])
  expect(record([], { role: 'assistant', text: 'x'.repeat(900) })[0]!.text.length).toBe(600)
})

test('parseNudge clips an overlong reply', async () => {
  const n = parseNudge(JSON.stringify({ tip: 't'.repeat(500), next: 'n'.repeat(5000) }))!
  expect([n.tip.length, n.next.length]).toEqual([160, 1000])
})

test('usage adds up and formats', async () => {
  const ok = { isAnswered: true, text: '', usage: { input_tokens: 1500, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as const
  const u = addUsage(addUsage(undefined, ok as never), ok as never)
  expect([u.calls, u.failed, u.input, u.output]).toEqual([2, 0, 3000, 160])
  expect(formatUsage(undefined)).toBe('No Haiku calls yet.')
})
