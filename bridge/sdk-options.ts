import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { StartOptions } from '../shared/protocol.ts'
import sessionEnv from '../shared/session-env.json'

/** The side's Claude: forked from main's saved conversation when there is one, saving nothing. */
export function sdkOptions(
  options: StartOptions,
  handlers: Pick<Options, 'canUseTool' | 'hooks' | 'stderr'>,
): Options {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CC_SIDE_WORKER: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  }
  // The side is a session of its own: drop what ties a process to the main one.
  for (const name of [...sessionEnv, 'CC_SIDE_TRACE']) delete env[name]
  const configuredMode = options.securitySettings?.permissions?.defaultMode
  return {
    pathToClaudeCodeExecutable: options.claudePath,
    cwd: options.cwd,
    ...(options.resumeSessionAt
      ? {
          resume: options.parentSessionId,
          resumeSessionAt: options.resumeSessionAt,
          forkSession: true,
        }
      : {}),
    persistSession: false,
    includePartialMessages: true,
    model: options.model,
    ...(options.effort ? { effort: options.effort } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: options.settingSources ?? ['user', 'project', 'local'],
    settings: options.securitySettings,
    // Main's sandbox fails closed here: no sandbox, no side chat.
    ...(options.securitySettings?.sandbox?.enabled
      ? { sandbox: { ...options.securitySettings.sandbox, failIfUnavailable: true } }
      : {}),
    // Keep a restrictive configured mode, but never one that skips approvals.
    permissionMode:
      configuredMode === 'plan' || configuredMode === 'dontAsk' ? configuredMode : 'default',
    ...(options.isolatedTest ? { strictMcpConfig: true, mcpServers: {} } : {}),
    env,
    ...handlers,
  }
}
