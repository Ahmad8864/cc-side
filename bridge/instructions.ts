import type { ChatMessage } from '../shared/protocol.ts'
import { parseCommand } from '../shared/commands.ts'

// What the side's Claude reads besides the user's own messages.
const sidePurpose =
  'The user opened a separate side chat from this conversation. Use the inherited context to answer their questions directly here, without continuing the parent task. Do not message other sessions unless the user asks.'
const editingOn =
  'You may edit files here, but the main conversation works in the same directory, so change only what the user asks.'
export const editingOff =
  'File edits are blocked in this side chat: read and search freely, and describe changes instead of making them. The user can allow edits with /edit on.'
const discussionLimit = 20000

/** Sent with the first message: the side's purpose, its edit setting, and any carried discussion. */
export function sideInstruction(canEdit: boolean | undefined, earlier: string) {
  return [`${sidePurpose} ${canEdit ? editingOn : editingOff}`, earlier]
    .filter(Boolean)
    .join('\n\n')
}

/** Sent with the next message after the user changes the edit setting. */
export function editingNote(canEdit: boolean | undefined) {
  return `The user turned file edits ${canEdit ? 'on' : 'off'}. ${canEdit ? editingOn : editingOff}`
}

// A refresh carries the side's questions and answers as text; tool results stay behind.
export function earlierDiscussion(messages: ChatMessage[]) {
  const turns = messages
    .filter(
      (m) => (m.role === 'user' && !parseCommand(m.text)) || (m.role === 'assistant' && !m.local),
    )
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`)
    .join('\n\n')
  if (!turns) return ''
  const recent = turns.length > discussionLimit ? `…${turns.slice(-discussionLimit)}` : turns
  return `This side chat was refreshed with the main conversation's latest context. Earlier in this side chat:\n\n${recent}`
}
