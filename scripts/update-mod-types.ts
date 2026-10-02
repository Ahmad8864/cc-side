import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import sessionEnv from '../shared/session-env.json'
import { declarationsFile, declarationsVersion, upstreamFile, upstreamNote } from './mod-types.ts'

// Claude Code writes its Mods declarations beside each mod it loads from a folder the
// person owns. Load an empty mod from a temporary folder, with a temporary configuration,
// in print mode with no prompt: Claude loads the mod, then exits on the missing prompt
// before any model request, so this needs no account and spends nothing.

const probe = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'mod-types' }),
  'hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
  'hooks/register.ts': 'export function register() {}\n',
}
const writtenDeclarations = '.claude-plugin/types/claude-code/index.d.ts'

const { values } = parseArgs({ options: { claude: { type: 'string' } } })
const claude = values.claude ?? process.env.CC_SIDE_CLAUDE ?? Bun.which('claude')
if (!claude) throw new Error('Claude Code executable not found; pass --claude <path>')

const reported = (await run([claude, '--version'])).stdout.trim()
const version = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(reported)?.[1]
if (!version) throw new Error(`Unexpected Claude Code version: ${reported}`)

const temporary = await mkdtemp(join(tmpdir(), 'cc-side-mod-types-'))
try {
  const plugin = join(temporary, 'plugin')
  for (const [path, text] of Object.entries(probe)) {
    await mkdir(dirname(join(plugin, path)), { recursive: true })
    await writeFile(join(plugin, path), text)
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(temporary, 'config'),
  }
  // Start a session of its own, even when run from inside another Claude session.
  for (const name of sessionEnv) delete env[name]
  const result = await run([claude, '--print', '--plugin-dir', plugin], { cwd: temporary, env })

  const declarations = await Bun.file(join(plugin, writtenDeclarations))
    .text()
    .catch(() => '')
  if (declarationsVersion(declarations) !== version) {
    throw new Error(
      `Claude Code ${version} did not write Mods declarations.\n${result.stderr || result.stdout}`,
    )
  }
  if (!declarations.includes("declare module 'claude-code' {")) {
    throw new Error('The written declarations have no claude-code module')
  }
  await writeFile(declarationsFile, declarations)
  await writeFile(upstreamFile, upstreamNote(version))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
console.log(`Updated types/claude-code.d.ts from Claude Code ${version}`)

// Runs a command to completion; its exit code is the caller's to judge.
async function run(command: string[], options: { cwd?: string; env?: typeof process.env } = {}) {
  const child = Bun.spawn(command, {
    ...options,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr }
}
