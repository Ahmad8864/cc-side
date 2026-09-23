import { expect, test } from 'bun:test'
import { caret, edit, layout, type Editor } from '../shared/editor.ts'

test('long lines wrap without losing characters; hard newlines and an empty last line remain', () => {
  const text = 'a'.repeat(160) + '\nline two\n'
  const lines = layout(text, 40)
  expect(lines.every((l) => l.width <= 40)).toBe(true)
  expect(
    lines
      .flatMap((l) => l.glyphs)
      .map((g) => g.text)
      .join(''),
  ).toBe(text.replaceAll('\n', ''))
  expect(lines.at(-1)?.start).toBe(text.length)
  expect(caret(lines, text.length)).toEqual({ row: 5, column: 0 })
})

test('Shift+Enter inserts a newline at the cursor, following characters stay on that line', () => {
  let s: Editor = { text: 'firsttail', cursor: 5 }
  s = edit(s, { key: 'return', shift: true }, 40)
  s = edit(s, { key: 'second' }, 40)
  expect(s).toEqual({ text: 'first\nsecondtail', cursor: 12 })
  expect(caret(layout(s.text, 40), s.cursor)).toEqual({ row: 1, column: 6 })
  s = edit(s, { key: 'home' }, 40)
  expect(s.cursor).toBe(6)
  expect(edit(s, { key: 'backspace' }, 40).text).toBe('firstsecondtail')
})

test('cursor movement and deletion preserve emoji, combining marks, and wide characters', () => {
  const text = 'a👩‍💻e\u0301界'
  let s: Editor = { text, cursor: text.length }
  s = edit(s, { key: 'backspace' }, 5)
  expect(s.text).toBe('a👩‍💻e\u0301')
  s = edit(s, { key: 'left' }, 5)
  s = edit(s, { key: 'backspace' }, 5)
  expect(s.text).toBe('ae\u0301')
  expect(layout(text, 4).every((line) => line.width <= 4)).toBe(true)
})

test('up/down keep visual column across soft wraps; pasted CRLF and tabs are normalized', () => {
  let s: Editor = { text: 'abcdefghijklmno', cursor: 13 }
  s = edit(s, { key: 'up' }, 5)
  expect(s.cursor).toBe(8)
  s = edit(s, { key: 'down' }, 5)
  expect(s.cursor).toBe(13)
  expect(edit({ text: '', cursor: 0 }, { key: 'alpha\r\nbeta\tend' }, 40).text).toBe(
    'alpha\nbeta  end',
  )
})

test('wide characters at a word-wrap boundary fit, and Home before a leading newline stays at zero', () => {
  expect(layout(' aaaaaaaaa界', 10).every((line) => line.width <= 10)).toBe(true)
  const state = { text: '\nnext', cursor: 0 }
  expect(edit(state, { key: 'home' }, 10)).toEqual(state)
  expect(edit(state, { key: 'u', ctrl: true }, 10)).toEqual(state)
})
