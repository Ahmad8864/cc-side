// The oldest Claude Code whose Mods API cc-side relies on.
export const oldestSupportedClaude = '2.1.287'

/** Whether a Claude Code version, a release or a development build of one, is supported. */
export function isSupportedClaude(version: string) {
  const release = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number)
  const have = release(version)
  const need = release(oldestSupportedClaude)!
  if (!have) return false
  const differs = have.findIndex((part, i) => part !== need[i])
  return differs < 0 || have[differs] > need[differs]
}
