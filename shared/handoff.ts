import type { ChatMessage } from './protocol.ts'

/** The side's last reply from Claude, and the message it answered. */
export type Exchange = { question?: string; reply: string }

export function lastExchange(messages: ChatMessage[]): Exchange | undefined {
  // Side command output such as /help is not Claude's reply.
  const index = messages.findLastIndex((m) => m.role === 'assistant' && !m.local && m.text)
  if (index < 0) return undefined
  const question = messages.slice(0, index).findLast((m) => m.role === 'user')?.text
  return { reply: messages[index].text, ...(question ? { question } : {}) }
}

/** What main's Claude reads when the user shares the side's last exchange. */
export function sharedNote({ question, reply }: Exchange) {
  return [
    'The user shared this from a side chat, a separate conversation forked from this one. Treat it as context for their next message.',
    question && `<side-chat-question>\n${question}\n</side-chat-question>`,
    `<side-chat-reply>\n${reply}\n</side-chat-reply>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
