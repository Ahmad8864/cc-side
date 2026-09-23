import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Runs Claude with this checkout as its plugin, the side helper started from source by Bun.
const root = fileURLToPath(new URL('..', import.meta.url).href)
const claude = Bun.which('claude')
if (!claude) throw new Error('Install Claude Code first.')
if (!existsSync(`${root}/node_modules/@anthropic-ai/claude-agent-sdk`)) {
  throw new Error('Run bun install in the cc-side repository first.')
}
const child = Bun.spawn([claude, '--plugin-dir', root, ...process.argv.slice(2)], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: {
    ...process.env,
    CC_SIDE_BUN: process.execPath,
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    CLAUDE_CODE_NO_FLICKER: '1',
  },
})
process.exit(await child.exited)
