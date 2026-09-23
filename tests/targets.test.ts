import { expect, test } from 'bun:test'
import { helperFile, helperFor, targetOf } from '../shared/targets.ts'

test('computers are named as Bun names its compile targets', () => {
  expect(targetOf('Darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'arm64' })
  expect(targetOf('Linux', 'x86_64')).toEqual({ os: 'linux', arch: 'x64' })
  expect(targetOf('Linux', 'aarch64')).toEqual({ os: 'linux', arch: 'arm64' })
  expect(targetOf('Windows_NT', 'AMD64')).toEqual({ os: 'windows', arch: 'x64' })
  expect(targetOf()).toEqual({ os: '', arch: '' })
})

test('a computer runs its own helper, and only a shipped one', () => {
  expect(helperFor({ os: 'linux', arch: 'x64' })).toEqual({ os: 'linux', arch: 'x64' })
  expect(helperFor({ os: 'freebsd', arch: 'x64' })).toBeUndefined()
  // Windows on arm64 runs the x64 helper until Bun builds for it.
  expect(helperFor({ os: 'windows', arch: 'arm64' })).toEqual({ os: 'windows', arch: 'x64' })
  expect(helperFile({ os: 'darwin', arch: 'arm64' })).toBe('cc-side-darwin-arm64')
  expect(helperFile({ os: 'windows', arch: 'x64' })).toBe('cc-side-windows-x64.exe')
})
