import type { Elements, RenderElement } from 'claude-code'
import type { ChatState } from '../shared/protocol.ts'
import { modelLabel, supportedEfforts } from '../shared/commands.ts'
import { treeLimit } from '../shared/limits.ts'
import { renderMessages, renderPermissions } from './transcript.tsx'

export type PaneView = {
  state: ChatState
  // The Pane's body, and the columns inside its padding.
  width: number
  columns: number
  rows: number
  composer: RenderElement
  answers: Record<string, Record<string, string>>
  expanded: Set<string>
  localError: string
  localNotice: string
  busy: boolean
  connected: boolean
  refreshing: boolean
  mainAhead: number
}

export type PaneActions = {
  invalidate: () => void
  setError: (message: string) => void
  decide: (id: string, allow: boolean, answers?: Record<string, string>) => Promise<boolean>
  toggleEditing: () => Promise<boolean>
  onToggle: (key: string) => void
  refresh: () => Promise<boolean>
  retry: () => Promise<void>
  stop: () => Promise<boolean>
}

export function renderPane(elements: Elements['terminal'], view: PaneView, actions: PaneActions) {
  const { Box, Text, Button } = elements
  const { state, columns, composer, mainAhead, refreshing } = view
  const notice =
    state.status === 'starting'
      ? 'Connecting…'
      : refreshing
        ? 'Refreshing…'
        : view.localNotice || state.notice
  const effort =
    state.model && state.effort && supportedEfforts(state.model, state.models).length
      ? ` (${state.effort})`
      : ''
  const permissions = renderPermissions(
    elements,
    state.permissions,
    view.answers,
    actions,
    state.cwd,
  )
  // Messages get what the rest of the pane leaves of the drawing limit.
  const budget = treeLimit - JSON.stringify([permissions, composer]).length - 5000
  return (
    <Box flexDirection="column" paddingX={1} minHeight={view.rows} width={view.width}>
      <Box gap={2} paddingRight={2}>
        <Text bold>Side chat</Text>
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {state.model ? `${modelLabel(state.model, state.models)}${effort}` : ''}
          </Text>
        </Box>
        <Box>
          {state.canEdit === undefined ? null : (
            <Button
              key="edit-side"
              plain
              dimColor={!state.canEdit}
              label={state.canEdit ? 'can edit' : 'read-only'}
              onPress={async () => {
                await actions.toggleEditing()
              }}
            />
          )}
        </Box>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingTop={1} width={columns}>
        {renderMessages(elements, state.messages, {
          columns,
          expanded: view.expanded,
          onToggle: actions.onToggle,
          cwd: state.cwd,
          budget,
        })}
      </Box>
      {/* Keep the editor's ancestor/sibling positions stable. The terminal
        focus region can remount when conditional siblings appear. */}
      {permissions}
      <Box>
        {view.localError || state.error ? (
          <Text color="error">{view.localError || state.error}</Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column" width={columns}>
        {/* Like main's own hints: one quiet line, the notice left and staleness right. */}
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            {notice ? (
              <Text dimColor wrap="truncate-end">
                {notice}
              </Text>
            ) : null}
          </Box>
          <Box>
            {mainAhead > 0 && !refreshing ? (
              <Box gap={1}>
                <Text dimColor>
                  {`main is ${mainAhead} ${mainAhead === 1 ? 'reply' : 'replies'} ahead ·`}
                </Text>
                <Button
                  key="refresh-side"
                  plain
                  label="/refresh"
                  onPress={async () => {
                    await actions.refresh()
                  }}
                />
              </Box>
            ) : null}
          </Box>
        </Box>
        <Box>
          {state.status === 'error' && !view.connected ? (
            <Button
              key="retry-side"
              label="Retry"
              onPress={async () => {
                await actions.retry()
              }}
            />
          ) : null}
        </Box>
        {composer}
        <Box gap={2} justifyContent="flex-end">
          <Text dimColor>Esc main</Text>
          {view.busy ? (
            <Button
              key="stop-side"
              plain
              label="Stop"
              onPress={async () => {
                await actions.stop()
              }}
            />
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}
