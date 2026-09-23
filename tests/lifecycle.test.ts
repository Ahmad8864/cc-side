import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A release check sets CC_SIDE_HELPER to test a compiled helper instead of the source.
const helper = process.env.CC_SIDE_HELPER
  ? [process.env.CC_SIDE_HELPER]
  : [process.execPath, fileURLToPath(new URL('../bridge/main.ts', import.meta.url).href)]

// Stands in for the side's Claude: it starts a tool of its own and reports both processes.
const fakeClaude = `
const tool = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'])
await Bun.write(process.env.CC_SIDE_TEST_PIDS, JSON.stringify([process.pid, tool.pid]))
setInterval(() => {}, 1000)
`

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await Bun.sleep(50)
  }
}

test('closing a side chat ends its helper, its Claude, and their tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-side lifecycle '))
  const pids = join(directory, 'pids.json')
  const started: number[] = []
  try {
    await writeFile(join(directory, 'claude.js'), fakeClaude)
    const options = {
      parentSessionId: crypto.randomUUID(),
      allowEmptyParent: true,
      cwd: directory,
      model: 'haiku',
      settingSources: [],
    }
    const start = Bun.spawn(helper, {
      env: {
        ...process.env,
        CC_SIDE_CLAUDE: join(directory, 'claude.js'),
        CC_SIDE_TEST_PIDS: pids,
      },
      stdin: new Blob([JSON.stringify(options)]),
      stdout: 'pipe',
    })
    const { url, token, pid } = JSON.parse(await new Response(start.stdout).text())
    started.push(pid)
    expect(await start.exited).toBe(0)
    await until(() => Bun.file(pids).exists())
    started.push(...JSON.parse(await readFile(pids, 'utf8')))
    const headers = { Authorization: `Bearer ${token}` }
    expect((await fetch(`${url}/state`, { headers })).ok).toBe(true)
    await fetch(`${url}/close`, { method: 'POST', headers })
    await until(() => !started.some(isRunning))
  } finally {
    for (const pid of started.filter(isRunning)) process.kill(pid, 'SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
