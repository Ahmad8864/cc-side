import type { Elements } from 'claude-code'
import type { ChatMessage, Permission } from '../shared/protocol.ts'
import { layout } from '../shared/editor.ts'
import { questionsFor } from '../shared/questions.ts'

type Answers = Record<string, Record<string, string>>

function toolStatus(status: ChatMessage['status']): string {
  if (status === 'done') return '✓'
  if (status === 'error' || status === 'cancelled') return '×'
  return '·'
}

export function renderMessages(
  elements: Elements['terminal'],
  messages: ChatMessage[],
  columns: number,
  expanded: Set<string>,
  invalidate: () => void,
) {
  const { Box, Text, Button, Markdown } = elements
  return messages.map((message) => (
    <Box key={message.id} flexDirection="column" marginBottom={1}>
      {message.role === 'tool' ? (
        <Box flexDirection="column">
          <Button
            key={`tool-${message.id}`}
            plain
            label={`${toolStatus(message.status)} ${message.toolName} ${expanded.has(message.id) ? '▾' : '▸'}`}
            onPress={() => {
              if (expanded.has(message.id)) expanded.delete(message.id)
              else expanded.add(message.id)
              invalidate()
            }}
          />
          {expanded.has(message.id) ? (
            <Text dimColor wrap="wrap">
              {message.toolInput ?? 'Running…'}
              {message.text ? `\n${message.text}` : ''}
            </Text>
          ) : null}
        </Box>
      ) : message.role === 'user' ? (
        <Box>
          <Text color="claude">❯ </Text>
          <Box flexDirection="column" width={columns - 2}>
            <Text wrap="wrap">
              {layout(message.text, columns - 3)
                .map((line) => line.glyphs.map((g) => g.text).join(''))
                .join('\n')}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box>
          <Text>⏺ </Text>
          <Box flexDirection="column" width={columns - 2}>
            <Markdown text={message.text || '…'} />
          </Box>
        </Box>
      )}
    </Box>
  ))
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
) {
  const { Box, Text, Button, Input } = elements
  return (
    <Box flexDirection="column">
      {permissions.map((permission) => {
        const questions = questionsFor(permission)
        return (
          <Box key={permission.id} flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold color="warning">
              {permission.tool === 'AskUserQuestion'
                ? 'Claude has a question'
                : `Allow ${permission.tool}?`}
            </Text>
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
              <Text>{JSON.stringify(permission.input, null, 2)}</Text>
            )}
            <Box gap={2}>
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
              <Button
                key={`deny-${permission.id}`}
                label="Deny"
                onPress={async () => {
                  await actions.decide(permission.id, false)
                }}
              />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
