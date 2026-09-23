import { expect, test } from 'bun:test'
import { chmod, copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('the helper starts from a checkout path containing spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-side test '))
  try {
    await copyFile(
      fileURLToPath(new URL('../bridge/start.ts', import.meta.url).href),
      join(directory, 'start.ts'),
    )
    await writeFile(
      join(directory, 'server.ts'),
      `await Bun.stdin.text(); console.log(JSON.stringify({ error: 'Test helper reached' }));`,
    )
    await writeFile(
      join(directory, 'main.ts'),
      `import { startHelper } from './start.ts'; await startHelper([${JSON.stringify(join(directory, 'server.ts'))}]);`,
    )
    const child = Bun.spawn([process.execPath, join(directory, 'main.ts')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    child.stdin.write('{}')
    child.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({ error: 'Test helper reached' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'darwin')(
  'the launcher runs the Claude executable that started it',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cc-side launcher '))
    try {
      const launcher = join(directory, 'cc-side')
      const helper = join(directory, `cc-side-darwin-${process.arch}`)
      const claude = join(directory, 'claude')
      await copyFile(fileURLToPath(new URL('../bin/cc-side', import.meta.url).href), launcher)
      await writeFile(helper, '#!/bin/sh\necho "$CC_SIDE_CLAUDE"\n')
      for (const file of [launcher, helper]) await chmod(file, 0o755)
      // A link to Bun named claude stands in for the main session's executable.
      await symlink(process.execPath, claude)
      await writeFile(
        join(directory, 'main.ts'),
        `await Bun.spawn([${JSON.stringify(launcher)}], { stdout: 'inherit' }).exited`,
      )
      const { CC_SIDE_CLAUDE, ...env } = process.env
      const child = Bun.spawn([claude, join(directory, 'main.ts')], { env, stdout: 'pipe' })
      expect((await new Response(child.stdout).text()).trim()).toBe(claude)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'darwin')(
  'launcher failures are startup errors the pane can show',
  async () => {
    const child = Bun.spawn([fileURLToPath(new URL('../bin/cc-side', import.meta.url).href)], {
      env: { ...process.env, CC_SIDE_CLAUDE: '/missing/claude' },
      stdout: 'pipe',
    })
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      error: 'Claude Code was not found. Install it before using cc-side.',
    })
  },
)
