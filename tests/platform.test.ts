import { expect, test } from 'bun:test'
import { chmod, copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { findClaude } from '../bridge/platform.ts'

// No process has this id, so only the fallbacks can answer.
const missingPid = 2147483647

test.skipIf(process.platform === 'win32')(
  'the side runs the executable of the Claude that started its helper',
  async () => {
    const found = findClaude(process.pid, { PATH: dirname(process.execPath) })
    expect(found && (await realpath(found))).toBe(await realpath(process.execPath))
  },
)

test.skipIf(process.platform === 'win32')(
  'a Claude executable removed by an update is not run',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cc-side removed '))
    const removed = join(directory, 'claude')
    await copyFile('/bin/sleep', removed)
    const child = Bun.spawn([removed, '10'])
    try {
      await rm(directory, { recursive: true, force: true })
      expect(findClaude(child.pid, { PATH: '' })).toBeUndefined()
    } finally {
      child.kill()
    }
  },
)

test('CC_SIDE_CLAUDE overrides the Claude executable', () => {
  expect(findClaude(process.pid, { CC_SIDE_CLAUDE: '/custom/claude' })).toBe('/custom/claude')
})

test('without a running parent, Claude is found on PATH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-side path '))
  try {
    const claude = join(directory, 'claude')
    await writeFile(claude, '')
    await chmod(claude, 0o755)
    expect(findClaude(missingPid, { PATH: `/missing${delimiter}${directory}` })).toBe(claude)
    expect(findClaude(missingPid, { PATH: '' })).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
