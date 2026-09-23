import { expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('the helper starts from a checkout path containing spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-side test '))
  try {
    for (const file of ['start.ts', 'platform.ts'])
      await copyFile(
        fileURLToPath(new URL(`../bridge/${file}`, import.meta.url).href),
        join(directory, file),
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
