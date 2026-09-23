import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { StartOptions } from '../shared/protocol.ts'

function resumePoint(history: SessionMessage[]): string | undefined {
  const pending = new Set<string>()
  let completed: string | undefined
  for (const entry of history) {
    const content = (entry.message as { content?: unknown } | null)?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (entry.type === 'assistant' && block?.type === 'tool_use') pending.add(block.id)
        if (entry.type === 'user' && block?.type === 'tool_result')
          pending.delete(block.tool_use_id)
      }
    }
    if (entry.type === 'user' && !pending.size) completed = entry.uuid
  }
  // Claude drops unfinished tool calls when loading history. Resume before
  // that batch so the side neither loses its checkpoint nor replays the tool.
  return pending.size ? completed : history.at(-1)?.uuid
}

/** An empty parent is valid; an unavailable nonempty parent must not lose context. */
export async function prepareStart(
  options: StartOptions,
  readHistory = getSessionMessages,
): Promise<StartOptions> {
  if (!/^[0-9a-f-]{36}$/i.test(options.parentSessionId) || !options.cwd.startsWith('/'))
    throw new Error('Invalid parent session')
  const history = await readHistory(options.parentSessionId, {
    dir: options.cwd,
    includeSystemMessages: true,
  })
  const resumeSessionAt = resumePoint(history)
  if (!resumeSessionAt && !options.allowEmptyParent) {
    throw new Error(
      'The main conversation is not saved yet. Wait for its current reply, then choose Retry.',
    )
  }
  return { ...options, resumeSessionAt }
}
