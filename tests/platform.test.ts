import { expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { findClaude } from '../bridge/platform.ts'

// No process has this id, so only the fallbacks can answer.
const missingPid = 2147483647

test.skipIf(process.platform !== 'darwin')(
  'the side runs the executable of the Claude that started its helper',
  async () => {
    const found = findClaude(process.pid, { PATH: dirname(process.execPath) })
    expect(found && (await realpath(found))).toBe(await realpath(process.execPath))
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
