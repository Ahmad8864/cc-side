import { expect, test } from 'bun:test'
import { clip, splitText } from '../shared/limits.ts'

test('long text splits at line breaks into drawable strings without losing content', () => {
  const text = Array.from({ length: 400 }, (_, i) => `Line ${i} ${'word '.repeat(10)}`).join('\n')
  const parts = splitText(text, 2000)
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.every((part) => part.length <= 2000)).toBe(true)
  expect(parts.join('\n')).toBe(text)
  expect(splitText('short')).toEqual(['short'])
})

test('a code block split across strings is closed and reopened with its fence', () => {
  const code = Array.from({ length: 300 }, (_, i) => `const value${i} = ${i}`).join('\n')
  const parts = splitText(`Intro\n\`\`\`ts\n${code}\n\`\`\`\nDone`, 2000)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(2000)
    expect(part.match(/^```/gm)).toHaveLength(2)
  }
  expect(parts[1]).toStartWith('```ts\n')
  expect(parts.at(-1)).toEndWith('```\nDone')
})

test('an unbroken line splits without separating surrogate pairs', () => {
  const text = '😀'.repeat(3000)
  const parts = splitText(text, 2002)
  expect(parts.every((part) => part.length <= 2002)).toBe(true)
  expect(parts.join('').replaceAll('\n', '')).toBe(text)
  expect(parts.join('\n')).not.toMatch(/[\uD800-\uDBFF]\n|\n[\uDC00-\uDFFF]/)
})

test('clipped text keeps its start and says how much was left out', () => {
  expect(clip('short', 10)).toBe('short')
  expect(clip('x'.repeat(25), 10)).toBe(`${'x'.repeat(10)}\n… 15 more characters`)
})
