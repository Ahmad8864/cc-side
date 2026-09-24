import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleHelper } from '../scripts/bundle.ts'

// The runtimes the hook may run the helper with, where this machine has them.
const runtimes = { Bun: process.execPath, Node: Bun.which('node') }

// Stands in for the side's Claude: it starts a tool of its own and reports both processes.
const fakeClaude = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(process.env.CC_SIDE_TEST_PIDS, JSON.stringify([process.pid, tool.pid]))
setInterval(() => {}, 1000)
`

// A release check sets CC_SIDE_HELPER to test the built helper instead of a fresh bundle.
let helper = process.env.CC_SIDE_HELPER
let bundle: string | undefined
beforeAll(async () => {
  if (helper) return
  bundle = await mkdtemp(join(tmpdir(), 'cc-side helper '))
  helper = await bundleHelper(bundle)
})
afterAll(() => bundle && rm(bundle, { recursive: true, force: true }))

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

for (const [name, runtime] of Object.entries(runtimes)) {
  test.skipIf(!runtime)(
    `closing a side chat on ${name} ends its helper, its Claude, and their tools`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'cc-side lifecycle '))
      const pids = join(directory, 'pids.json')
      const started: number[] = []
      try {
        await writeFile(join(directory, 'claude.mjs'), fakeClaude)
        const options = {
          parentSessionId: crypto.randomUUID(),
          allowEmptyParent: true,
          cwd: directory,
          model: 'haiku',
          settingSources: [],
        }
        const start = Bun.spawn([runtime!, helper!], {
          env: {
            ...process.env,
            CC_SIDE_CLAUDE: join(directory, 'claude.mjs'),
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
    },
    20000,
  )
}
