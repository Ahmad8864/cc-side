import type { Elements } from 'claude-code'
import type { Permission } from '../shared/protocol.ts'
import { cleanText } from '../shared/editor.ts'
import { approvalParts } from '../shared/approval.ts'
import { questionsFor, type Question } from '../shared/questions.ts'

// Answers typed or picked so far, by permission and then by question.
export type Answers = Record<string, Record<string, string>>

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
  const { Box, Text, Button } = elements
  return (
    <Box flexDirection="column">
      {permissions.map((permission) => {
        const questions = questionsFor(permission)
        const allow = async () => {
          if (questions.some((q) => !answers[permission.id]?.[q.question]?.trim())) {
            actions.setError('Answer each question before sending.')
            return
          }
          actions.setError('')
          await actions.decide(
            permission.id,
            true,
            questions.length ? answers[permission.id] : undefined,
          )
        }
        return (
          <Box key={permission.id} flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold color="warning">
              {cleanText(
                permission.title ??
                  (permission.tool === 'AskUserQuestion'
                    ? 'Claude has a question'
                    : `Allow ${permission.tool}?`),
              )}
            </Text>
            {permission.description ? <Text>{cleanText(permission.description)}</Text> : null}
            {permission.decisionReason ? <Text>{cleanText(permission.decisionReason)}</Text> : null}
            {permission.blockedPath ? <Text>Path: {cleanText(permission.blockedPath)}</Text> : null}
            {permission.mcpServer ? (
              <Text dimColor>
                MCP: {cleanText(permission.mcpServer.name)} (
                {cleanText(permission.mcpServer.source)})
              </Text>
            ) : null}
            {questions.length ? (
              questions.map((question, index) =>
                questionView(elements, permission.id, question, index, answers, {
                  invalidate: actions.invalidate,
                  submit: allow,
                }),
              )
            ) : (
              <Box flexDirection="column">{approvalView(elements, permission, cwd)}</Box>
            )}
            <Box gap={2}>
              <Button
                key={`deny-${permission.id}`}
                label={questions.length ? 'Skip' : 'Deny'}
                autoFocus={permission.defaultToNo ? true : undefined}
                onPress={async () => {
                  await actions.decide(permission.id, false)
                }}
              />
              <Button
                key={`allow-${permission.id}`}
                label={questions.length ? 'Send answer' : 'Allow once'}
                onPress={allow}
              />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// One question: its options as buttons, marked once picked, and a field for any answer.
function questionView(
  elements: Elements['terminal'],
  id: string,
  { question, options, multiSelect }: Question,
  index: number,
  answers: Answers,
  { invalidate, submit }: { invalidate: () => void; submit: () => Promise<void> },
) {
  const { Box, Text, Button, Input } = elements
  const answer = answers[id]?.[question] ?? ''
  return (
    <Box key={`${id}-${index}`} flexDirection="column" marginBottom={1}>
      <Text bold>{question}</Text>
      {options.map((option, i) => (
        <Box key={`${id}-${index}-${i}`} flexDirection="column">
          <Button
            key={`answer-${id}-${index}-${i}`}
            label={answer.split(', ').includes(option.label) ? `✓ ${option.label}` : option.label}
            onPress={() => {
              answers[id] ??= {}
              const chosen = multiSelect
                ? (answers[id][question] ?? '').split(', ').filter(Boolean)
                : []
              answers[id][question] =
                multiSelect && chosen.includes(option.label)
                  ? chosen.filter((label) => label !== option.label).join(', ')
                  : [...chosen, option.label].join(', ')
              invalidate()
            }}
          />
          {option.description ? <Text dimColor>{option.description}</Text> : null}
        </Box>
      ))}
      <Input
        key={`answer-text-${id}-${index}`}
        label="Answer"
        value={answer}
        placeholder="Select above or type…"
        onInput={(value) => {
          answers[id] ??= {}
          answers[id][question] = value
        }}
        onSubmit={submit}
      />
    </Box>
  )
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
