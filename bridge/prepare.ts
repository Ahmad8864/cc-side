import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import type { StartOptions } from '../shared/protocol.ts'

/** An empty parent is valid; an unavailable nonempty parent must not lose context. */
export async function prepareStart(options: StartOptions, readHistory = getSessionMessages): Promise<StartOptions> {
  if (!/^[0-9a-f-]{36}$/i.test(options.parentSessionId) || !options.cwd.startsWith('/')) throw new Error('Invalid parent session')
  const history = await readHistory(options.parentSessionId, { dir: options.cwd, includeSystemMessages: true })
  const resumeSessionAt = history.at(-1)?.uuid
  if (!resumeSessionAt && !options.allowEmptyParent) {
    throw new Error('The main conversation is not saved yet. Wait for its current reply, then choose Retry.')
  }
  return { ...options, resumeSessionAt }
}
