import { expect, test } from 'bun:test'
import { isSupportedClaude } from '../shared/claude-version.ts'

test('releases and development builds from 2.1.287 on are supported', () => {
  for (const version of ['2.1.287', '2.1.288', '2.2.0', '3.0.0', '2.1.287-dev.20261001.t1.sha1'])
    expect(isSupportedClaude(version)).toBe(true)
  for (const version of ['2.1.286', '2.0.999', '1.9.300', 'unknown', ''])
    expect(isSupportedClaude(version)).toBe(false)
})
