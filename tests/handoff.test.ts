import { expect, test } from 'bun:test'
import { lastExchange, sharedNote } from '../shared/handoff.ts'

test("the last exchange is Claude's last reply and the message it answered", () => {
  expect(
    lastExchange([
      { id: '1', role: 'user', text: 'Which test fails?' },
      { id: '2', role: 'assistant', text: 'Let me look.' },
      { id: '3', role: 'tool', text: 'Read', toolName: 'Read' },
      { id: '4', role: 'assistant', text: 'The parser test.' },
      { id: '5', role: 'user', text: '/help' },
      { id: '6', role: 'assistant', text: 'Commands…', local: true },
    ]),
  ).toEqual({ question: 'Which test fails?', reply: 'The parser test.' })
  expect(lastExchange([{ id: '1', role: 'assistant', text: 'Hi.' }])).toEqual({ reply: 'Hi.' })
  expect(lastExchange([{ id: '1', role: 'user', text: 'Hello?' }])).toBeUndefined()
})

test('a shared note frames the exchange as context and leaves out a missing question', () => {
  const note = sharedNote({ question: 'Which test fails?', reply: 'The parser test.' })
  expect(note).toStartWith('The user shared this from a side chat')
  expect(note).toContain('<side-chat-question>\nWhich test fails?\n</side-chat-question>')
  expect(note).toEndWith('<side-chat-reply>\nThe parser test.\n</side-chat-reply>')
  expect(sharedNote({ reply: 'The parser test.' })).not.toContain('side-chat-question')
})
