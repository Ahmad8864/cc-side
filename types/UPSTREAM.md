`claude-code.d.ts` holds the Mods declarations Claude Code 2.1.287 wrote for a
plugin it loaded. Run `bun run types:update` after upgrading Claude Code.
The update bot runs the same command against the latest published CLI and
opens a PR with the generated declarations and check results.

Anthropic also publishes a reference copy in the Claude Code repository:
https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts

Mods are early access; review the generated diff and validate the plugin
against the new runtime before merging.
