import { expect, test } from 'bun:test'
import { mentionAt, mentionText, rankPaths, withFolders } from '../shared/mentions.ts'

test('a mention is the @ word at the caret, at the start or after a space', () => {
  expect(mentionAt('@src/co', 7)).toEqual({ start: 0, end: 7, query: 'src/co' })
  expect(mentionAt('see @gui and', 8)).toEqual({ start: 4, end: 8, query: 'gui' })
  expect(mentionAt('see @src/components', 8)).toEqual({ start: 4, end: 19, query: 'src' })
  expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  expect(mentionAt('@"my notes/pl', 13)).toEqual({ start: 0, end: 13, query: 'my notes/pl' })
  expect(mentionAt('@"my notes/plan.md" next', 5)).toEqual({ start: 0, end: 19, query: 'my ' })
  expect(mentionAt('mail me@example.com', 19)).toBeUndefined()
  expect(mentionAt('@src done', 9)).toBeUndefined()
})

test('completing a mention inserts its path, quoted when it has a space', () => {
  expect(mentionText('docs/guide.md')).toBe('@docs/guide.md ')
  expect(mentionText('src/')).toBe('@src/')
  expect(mentionText('my notes/plan.md')).toBe('@"my notes/plan.md" ')
  expect(mentionText('my notes/')).toBe('@"my notes/')
})

test('the project lists every folder above its files', () => {
  expect(withFolders(['src/utils/format.ts', 'src/app.ts', 'README.md'])).toEqual([
    'src/',
    'src/utils/',
    'src/utils/format.ts',
    'src/app.ts',
    'README.md',
  ])
})

test('paths rank by where they match what was typed, then by length', () => {
  const paths = withFolders([
    'src/components/Button.tsx',
    'src/utils/format.ts',
    'docs/guide.md',
    'tests/button.test.ts',
  ])
  expect(rankPaths(paths, 'src/')).toEqual([
    'src/',
    'src/utils/',
    'src/components/',
    'src/utils/format.ts',
    'src/components/Button.tsx',
  ])
  expect(rankPaths(paths, 'but')).toEqual(['tests/button.test.ts', 'src/components/Button.tsx'])
  expect(rankPaths(paths, 'gde')).toEqual(['docs/guide.md'])
  expect(rankPaths(paths, '')).toHaveLength(paths.length)
  expect(rankPaths(paths, '', 2)).toEqual(['src/', 'docs/'])
  expect(rankPaths(paths, 'zzz')).toEqual([])
})
