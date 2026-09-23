import { cleanText, glyphs } from './editor.ts'
import type { ChatMessage } from './protocol.ts'

const detailLimit = 6000

/** A path inside the project as the project names it; Windows paths may use either separator. */
export function projectPath(path: string, cwd?: string) {
  const inside = cwd && path.startsWith(cwd) && /^[\\/]./.test(path.slice(cwd.length))
  return inside ? path.slice(cwd.length + 1) : path
}

export function truncateLine(text: string, columns: number): string {
  const chars = glyphs(cleanText(text).replace(/\s+/g, ' ').trim())
  if (chars.reduce((width, glyph) => width + glyph.width, 0) <= columns)
    return chars.map((glyph) => glyph.text).join('')
  let result = '',
    width = 0
  for (const glyph of chars) {
    if (width + glyph.width > columns - 1) break
    result += glyph.text
    width += glyph.width
  }
  return columns > 0 ? result + '…' : ''
}

function parseInput(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function compactValue(value: unknown, cwd?: string): string {
  if (typeof value === 'string') {
    const text = cleanText(value).trim()
    const lines = text.split('\n').length
    if (lines > 1) return `${lines} lines`
    return truncateLine(projectPath(text, cwd), 60)
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  if (value !== null && typeof value === 'object') {
    const count = Object.keys(value).length
    return `${count} ${count === 1 ? 'field' : 'fields'}`
  }
  return String(value)
}

function inputSummary(input: unknown, cwd?: string): string {
  if (input === undefined) return ''
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return compactValue(input, cwd)
  const entries = Object.entries(input)
  if (entries.length === 1 && typeof entries[0][1] === 'string')
    return compactValue(entries[0][1], cwd)
  return entries.map(([key, value]) => `${key}: ${compactValue(value, cwd)}`).join(' · ')
}

export function inputDetails(input: unknown): string {
  const display = (value: unknown) =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (input === undefined) return 'Arguments not available yet.'
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return display(input)
  return (
    Object.entries(input)
      .map(([key, value]) => `${key}:\n${display(value)}`)
      .join('\n\n') || '(none)'
  )
}

/** Presentation depends on JSON shapes, never a registry of tool names. */
export function toolDisplay(message: ChatMessage, columns: number, cwd?: string) {
  const input = parseInput(message.toolInput)
  const summary = inputSummary(input, cwd)
  const name = cleanText(message.toolName || 'Tool')
  const elapsed =
    message.status !== 'running' || message.elapsedSeconds === undefined
      ? ''
      : ` · ${Math.floor(message.elapsedSeconds)}s`
  const room = Math.max(1, columns - 4 - elapsed.length)
  const title = summary ? truncateLine(name, Math.max(8, Math.floor(room / 2))) : name
  const label = truncateLine(summary ? `${title} ${summary}` : title, room) + elapsed
  const details = cleanText(inputDetails(input))
  const outputLines = message.text.split('\n').filter((line) => line.trim())
  const lineNumber = /^\s*\d+(?: {2,}|\t|→)/
  const numbered = outputLines.length > 1 && outputLines.every((line) => lineNumber.test(line))
  const lines = outputLines.filter((line) => {
    const content = (numbered ? line.replace(lineNumber, '') : line).trim()
    return content && !/^[\[\]{},]+$/.test(content)
  })
  // The end of output usually holds the result or failure; show it as written.
  const preview = lines
    .slice(-2)
    .map((line, index) =>
      truncateLine(index === 0 && lines.length > 2 ? `… ${line}` : line, columns - 2),
    )
  return {
    name,
    label,
    input: details.slice(0, detailLimit),
    inputTruncated: details.length > detailLimit,
    preview,
  }
}
