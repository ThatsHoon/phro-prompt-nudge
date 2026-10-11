import { expect, test } from 'claude-code/testing'

import { parseNudge } from './register'

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
