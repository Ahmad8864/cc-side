import { fileURLToPath } from 'node:url'

// The checked-in Mods declarations and the note naming the Claude Code that wrote them.
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url).href)
export const declarationsFile = path('../types/claude-code.d.ts')
export const upstreamFile = path('../types/UPSTREAM.md')

/** The Claude Code version on the first line of a declarations file. */
export function declarationsVersion(declarations: string) {
  return /^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\.\n/.exec(declarations)?.[1]
}

export function upstreamNote(version: string) {
  return `\`claude-code.d.ts\` holds the Mods declarations Claude Code ${version} wrote for a
plugin it loaded. Run \`bun run types:update\` after upgrading Claude Code.
The update bot runs the same command against the latest published CLI and
opens a PR with the generated declarations and check results.

Anthropic also publishes a reference copy in the Claude Code repository:
https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts

Mods are early access; review the generated diff and validate the plugin
against the new runtime before merging.
`
}
