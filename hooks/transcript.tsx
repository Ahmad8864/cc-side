import type { Elements, RenderElement } from 'claude-code'
import type { ChatMessage } from '../shared/protocol.ts'
import { layout } from '../shared/editor.ts'
import { clip, splitText, treeLimit } from '../shared/limits.ts'
import { toolDisplay } from '../shared/tool-display.ts'

export type MessageView = {
  columns: number
  expanded: Set<string>
  onToggle: (key: string) => void
  cwd?: string
  // The drawing budget, in serialized characters, for the messages shown.
  budget?: number
}
const messageLimit = 40000

function toolStatus(status: ChatMessage['status']): string {
  if (status === 'done') return '✓'
  if (status === 'error' || status === 'cancelled') return '×'
  return '·'
}

export function renderMessages(
  elements: Elements['terminal'],
  messages: ChatMessage[],
  { columns, expanded, onToggle, cwd, budget = treeLimit }: MessageView,
) {
  const { Box, Text, Button, Markdown } = elements
  const draw = (message: ChatMessage) => {
    if (message.role === 'notice')
      return (
        <Box key={message.id} marginBottom={1}>
          <Text dimColor>{`↻ ${message.text}`}</Text>
        </Box>
      )
    if (message.role === 'tool') {
      const details = toolDisplay(message, columns, cwd)
      const open = expanded.has(message.id)
      const error = message.status === 'error'
      return (
        <Box key={message.id} flexDirection="column" width={columns} marginBottom={1}>
          <Box>
            <Text color={error ? 'error' : undefined}>{toolStatus(message.status)} </Text>
            <Button
              key={`tool-${message.id}`}
              plain
              label={`${details.label} ${open ? '▾' : '▸'}`}
              onPress={() => {
                if (open) expanded.delete(message.id)
                else expanded.add(message.id)
                onToggle(message.id)
              }}
            />
          </Box>
          {open ? (
            <Box
              flexDirection="column"
              marginLeft={2}
              padding={1}
              backgroundColor="bashMessageBackgroundColor"
            >
              {details.label.startsWith(details.name) ? null : <Text bold>{details.name}</Text>}
              <Text dimColor>Input{details.inputTruncated ? ' (truncated)' : ''}</Text>
              <Text wrap="wrap">{details.input}</Text>
              {message.text ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text dimColor>Output{message.outputTruncated ? ' (truncated)' : ''}</Text>
                  <Text wrap="wrap" color={error ? 'error' : undefined}>
                    {message.text}
                  </Text>
                </Box>
              ) : null}
            </Box>
          ) : details.preview.length ? (
            <Box paddingLeft={2}>
              <Text dimColor={!error} color={error ? 'error' : undefined}>
                {details.preview.join('\n')}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    const text = clip(message.text, messageLimit)
    return (
      <Box key={message.id} flexDirection="column" marginBottom={1}>
        {message.role === 'user' ? (
          <Box>
            <Text color="claude">❯ </Text>
            <Box flexDirection="column" width={columns - 2}>
              {splitText(
                layout(text, columns - 3)
                  .map((line) => line.glyphs.map((g) => g.text).join(''))
                  .join('\n'),
              ).map((part, index) => (
                <Text key={`${message.id}-${index}`} wrap="wrap">
                  {part}
                </Text>
              ))}
            </Box>
          </Box>
        ) : (
          <Box>
            <Text>⏺ </Text>
            <Box flexDirection="column" width={columns - 2}>
              {splitText(text || '…').map((part, index) => (
                <Markdown key={`${message.id}-${index}`} text={part} />
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )
  }
  // Mods refuses an oversized pane as a whole, so draw the newest messages that fit.
  const rows: RenderElement[] = []
  let hidden = messages.length
  let size = 0
  while (hidden > 0) {
    const row = draw(messages[hidden - 1])
    size += JSON.stringify(row).length
    if (size > budget) break
    rows.unshift(row)
    hidden--
  }
  if (!hidden) return rows
  return [
    <Text key="hidden-messages" dimColor>
      {`${hidden} earlier ${hidden === 1 ? 'message' : 'messages'} hidden`}
    </Text>,
    ...rows,
  ]
}
