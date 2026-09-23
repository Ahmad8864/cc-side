import type { Elements, RenderElement } from 'claude-code'
import type { ChatMessage, Permission } from '../shared/protocol.ts'
import { cleanInput, layout } from '../shared/editor.ts'
import { clip, splitText, treeLimit } from '../shared/limits.ts'
import { approvalParts } from '../shared/approval.ts'
import { questionsFor } from '../shared/questions.ts'
import { toolDisplay } from '../shared/tool-display.ts'

type Answers = Record<string, Record<string, string>>
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

function approvalView(elements: Elements['terminal'], permission: Permission, cwd?: string) {
  const { Text, Code } = elements
  return approvalParts(permission, cwd).map((part, index) => {
    const key = `${permission.id}-part-${index}`
    if (part.kind === 'file')
      return (
        <Text key={key} bold>
          {part.path}
        </Text>
      )
    if (part.kind === 'code')
      return (
        <Code
          key={key}
          source={part.source}
          format={part.format}
          path={part.path}
          language={part.language}
        />
      )
    return (
      <Text key={key} dimColor wrap="wrap">
        {part.text}
      </Text>
    )
  })
}

export function renderPermissions(
  elements: Elements['terminal'],
  permissions: Permission[],
  answers: Answers,
  actions: {
    invalidate: () => void
    setError: (message: string) => void
    decide: (id: string, allow: boolean, answers?: Record<string, string>) => Promise<boolean>
  },
  cwd?: string,
) {
  const { Box, Text, Button, Input } = elements
  return (
    <Box flexDirection="column">
      {permissions.map((permission) => {
        const questions = questionsFor(permission)
        return (
          <Box key={permission.id} flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold color="warning">
              {cleanInput(
                permission.title ??
                  (permission.tool === 'AskUserQuestion'
                    ? 'Claude has a question'
                    : `Allow ${permission.tool}?`),
              )}
            </Text>
            {permission.description ? <Text>{cleanInput(permission.description)}</Text> : null}
            {permission.decisionReason ? (
              <Text>{cleanInput(permission.decisionReason)}</Text>
            ) : null}
            {permission.blockedPath ? (
              <Text>Path: {cleanInput(permission.blockedPath)}</Text>
            ) : null}
            {permission.mcpServer ? (
              <Text dimColor>
                MCP: {cleanInput(permission.mcpServer.name)} (
                {cleanInput(permission.mcpServer.source)})
              </Text>
            ) : null}
            {questions.length ? (
              questions.map((q, index) => (
                <Box key={`${permission.id}-${index}`} flexDirection="column" marginBottom={1}>
                  <Text bold>{q.question}</Text>
                  {q.options.map((option, i) => (
                    <Box key={`${permission.id}-${index}-${i}`} flexDirection="column">
                      <Button
                        key={`answer-${permission.id}-${index}-${i}`}
                        label={option.label}
                        onPress={() => {
                          answers[permission.id] ??= {}
                          const chosen = q.multiSelect
                            ? (answers[permission.id][q.question] ?? '').split(', ').filter(Boolean)
                            : []
                          answers[permission.id][q.question] =
                            q.multiSelect && chosen.includes(option.label)
                              ? chosen.filter((label) => label !== option.label).join(', ')
                              : [...chosen, option.label].join(', ')
                          actions.invalidate()
                        }}
                      />
                      {option.description ? <Text dimColor>{option.description}</Text> : null}
                    </Box>
                  ))}
                  <Input
                    key={`answer-text-${permission.id}-${index}`}
                    label="Answer"
                    value={answers[permission.id]?.[q.question] ?? ''}
                    placeholder="Select above or type…"
                    onInput={(value) => {
                      answers[permission.id] ??= {}
                      answers[permission.id][q.question] = value
                    }}
                    onSubmit={() => {
                      actions.invalidate()
                    }}
                  />
                </Box>
              ))
            ) : (
              <Box flexDirection="column">{approvalView(elements, permission, cwd)}</Box>
            )}
            <Box gap={2}>
              <Button
                key={`deny-${permission.id}`}
                label="Deny"
                autoFocus={permission.defaultToNo ? true : undefined}
                onPress={async () => {
                  await actions.decide(permission.id, false)
                }}
              />
              <Button
                key={`allow-${permission.id}`}
                label={permission.tool === 'AskUserQuestion' ? 'Send answer' : 'Allow once'}
                onPress={async () => {
                  if (questions.some((q) => !answers[permission.id]?.[q.question]?.trim())) {
                    actions.setError('Answer each question before sending.')
                    return
                  }
                  actions.setError('')
                  await actions.decide(
                    permission.id,
                    true,
                    permission.tool === 'AskUserQuestion' ? answers[permission.id] : undefined,
                  )
                }}
              />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
