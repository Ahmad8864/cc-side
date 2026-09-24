import { stripVTControlCharacters } from 'node:util'
import { cleanText } from '../shared/editor.ts'

const outputLimit = 6000
// Title and link sequences, whose text stripVTControlCharacters leaves behind.
const osc = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).join('\n')
  if (content && typeof content === 'object') {
    const block = content as Record<string, unknown>
    if (typeof block.text === 'string') return block.text
    // Binary content is useful to the model, but not as base64 in a terminal.
    if (block.type === 'image' || block.type === 'audio' || block.type === 'document')
      return `[${block.type}]`
    if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
      const resource = block.resource as Record<string, unknown>
      return typeof resource.text === 'string' ? resource.text : `[Resource: ${resource.uri ?? ''}]`
    }
  }
  return content == null ? '' : JSON.stringify(content, null, 2)
}

export function toolOutput(content: unknown) {
  const text = cleanText(stripVTControlCharacters(contentText(content).replace(osc, '')))
  const truncated = text.length > outputLimit
  return {
    text: truncated
      ? text.slice(0, outputLimit / 2) + '\n… output truncated …\n' + text.slice(-outputLimit / 2)
      : text,
    truncated,
  }
}
