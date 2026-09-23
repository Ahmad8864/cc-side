// Pure text operations shared by the drawing-thread composer and its tests.
// UTF-16 offsets match strings; navigation and wrapping use grapheme/cell bounds.
type Glyph = { text: string; start: number; end: number; width: number }
type Line = { start: number; end: number; glyphs: Glyph[]; width: number }
export type Editor = { text: string; cursor: number; preferredColumn?: number }
type Key = { key: string; ctrl?: boolean; shift?: boolean; meta?: boolean }

export function normalizeKey(key: Key): Key {
  // Client reports physical Space by name, including enhanced terminal keys.
  const names: Record<string, string> = { space: ' ', enter: 'return', esc: 'escape' }
  return { ...key, key: names[key.key] ?? key.key }
}

function cellWidth(value: string): number {
  if (value === '\n') return 0
  const point = value.codePointAt(0)!
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value) ||
    (point >= 0x1100 &&
      (point <= 0x115f ||
        (point >= 0x2e80 && point <= 0xa4cf) ||
        (point >= 0xac00 && point <= 0xd7a3) ||
        (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xfe10 && point <= 0xfe6f) ||
        (point >= 0xff01 && point <= 0xff60) ||
        (point >= 0xffe0 && point <= 0xffe6) ||
        point >= 0x20000))
    ? 2
    : 1
}

export function glyphs(text: string): Glyph[] {
  const segments =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
          (s) => s.segment,
        )
      : Array.from(text).reduce<string[]>((out, ch) => {
          if (out.length && (/\p{Mark}|\uFE0F|\u200D/u.test(ch) || out.at(-1)!.endsWith('\u200D')))
            out[out.length - 1] += ch
          else out.push(ch)
          return out
        }, [])
  let start = 0
  return segments.map((value) => {
    const width = cellWidth(value)
    const result = { text: value, start, end: start + value.length, width }
    start = result.end
    return result
  })
}

export function layout(text: string, columns: number): Line[] {
  const limit = Math.max(2, columns)
  const result: Line[] = []
  let row: Glyph[] = [],
    width = 0,
    start = 0
  const push = (end: number) => {
    result.push({ start, end, glyphs: row, width })
    row = []
    width = 0
    start = end
  }
  for (const glyph of glyphs(text)) {
    if (glyph.text === '\n') {
      push(glyph.start)
      start = glyph.end
      continue
    }
    if (width + glyph.width > limit) {
      const space = row.findLastIndex((g) => /\s/.test(g.text))
      const rest = row.slice(space + 1)
      if (
        space >= 0 &&
        space < row.length - 1 &&
        rest.reduce((n, g) => n + g.width, 0) + glyph.width <= limit
      ) {
        row = row.slice(0, space + 1)
        width = row.reduce((n, g) => n + g.width, 0)
        push(rest[0].start)
        row = rest
        width = rest.reduce((n, g) => n + g.width, 0)
      } else push(glyph.start)
    }
    row.push(glyph)
    width += glyph.width
  }
  push(text.length)
  // Give the caret a cell at the end of an exactly full line.
  if (result.at(-1)!.width === limit)
    result.push({ start: text.length, end: text.length, glyphs: [], width: 0 })
  return result
}

export function caret(lines: Line[], cursor: number) {
  let row = lines.findLastIndex((line) => line.start <= cursor)
  row = Math.max(0, row)
  return {
    row,
    column: lines[row].glyphs.filter((g) => g.end <= cursor).reduce((n, g) => n + g.width, 0),
  }
}
export function offsetAt(line: Line, column: number) {
  let width = 0
  for (const glyph of line.glyphs) {
    if (width + glyph.width / 2 > column) return glyph.start
    width += glyph.width
  }
  return line.end
}
export function cleanInput(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
export function edit(state: Editor, key: Key, columns: number): Editor {
  key = normalizeKey(key)
  const { text, cursor } = state
  const chars = glyphs(text)
  const previous = chars.findLast((g) => g.start < cursor)?.start ?? 0
  const next = chars.find((g) => g.end > cursor)?.end ?? text.length
  const lineStart = cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1
  const lineEnd = text.indexOf('\n', cursor) < 0 ? text.length : text.indexOf('\n', cursor)
  const leftWord = () => text.slice(0, cursor).replace(/\s*\S+\s*$/, '').length
  const rightWord = () => cursor + (text.slice(cursor).match(/^\s*\S+\s*/)?.[0].length ?? 0)
  const move = (to: number): Editor => ({ text, cursor: to })
  const replace = (start: number, end: number, insert = ''): Editor => ({
    text: text.slice(0, start) + insert + text.slice(end),
    cursor: start + insert.length,
  })
  if (key.key === 'left') return move(key.ctrl || key.meta ? leftWord() : previous)
  if (key.key === 'right') return move(key.ctrl || key.meta ? rightWord() : next)
  if (key.key === 'home' || (key.ctrl && key.key === 'a'))
    return move(key.ctrl && key.key === 'home' ? 0 : lineStart)
  if (key.key === 'end' || (key.ctrl && key.key === 'e'))
    return move(key.ctrl && key.key === 'end' ? text.length : lineEnd)
  if (key.key === 'up' || key.key === 'down') {
    const lines = layout(text, columns),
      position = caret(lines, cursor)
    const column = state.preferredColumn ?? position.column
    const target = Math.max(
      0,
      Math.min(lines.length - 1, position.row + (key.key === 'up' ? -1 : 1)),
    )
    return { text, cursor: offsetAt(lines[target], column), preferredColumn: column }
  }
  if (key.key === 'backspace') return replace(key.ctrl || key.meta ? leftWord() : previous, cursor)
  if (key.key === 'delete') return replace(cursor, next)
  if (key.ctrl && key.key === 'w') return replace(leftWord(), cursor)
  if (key.ctrl && key.key === 'u') return replace(lineStart, cursor)
  if (key.ctrl && key.key === 'k')
    return replace(cursor, cursor === lineEnd ? Math.min(text.length, cursor + 1) : lineEnd)
  if (key.key === 'return' && (key.shift || key.meta)) return replace(cursor, cursor, '\n')
  if (
    !key.ctrl &&
    !key.meta &&
    ![
      'return',
      'tab',
      'pageup',
      'pagedown',
      'escape',
      'insert',
      'capslock',
      'numlock',
      'scrolllock',
      'pause',
      'printscreen',
    ].includes(key.key) &&
    !/^f\d{1,2}$/.test(key.key)
  ) {
    const value = cleanInput(key.key)
    if (text.length + value.length <= 50000) return replace(cursor, cursor, value)
  }
  return state
}
