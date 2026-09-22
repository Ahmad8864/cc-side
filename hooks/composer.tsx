import type { ClientModule, ClientSurface } from 'claude-code'
import type { Activity, Receipt, SideCommand, SideModel, Submission } from '../shared/protocol.ts'
import { completions, type Completion } from '../shared/commands.ts'
import { caret, edit, layout, normalizeKey, offsetAt, type Editor } from '../shared/editor.ts'
import { activityFrame } from '../shared/activity.ts'

export type ComposerProps = {
  epoch: number
  seed: string
  receipt: Receipt | null
  busy: boolean
  activity: Activity | null
  columns: number
  maxRows: number
  commands: SideCommand[]
  models: SideModel[]
  model: string
}
type State = Editor & {
  instance: string
  seq: number
  selected: number
  hiddenMenu: boolean
  active: boolean
  pending?: Submission
  history: string[]
  historyIndex: number
  unsent: string
}
type IO = { state: State; props: ComposerProps; menu: Completion[]; send: () => void }
const instances = new WeakMap<object, IO>()

function snapshot(io: IO, surface: ClientSurface<State>) {
  // A complete snapshot survives Client.post coalescing. The unacknowledged
  // submit stays in every subsequent snapshot, and the host handles it once.
  surface.post({
    epoch: io.props.epoch,
    seq: io.state.seq,
    text: io.state.text,
    instance: io.state.instance,
    ...(io.state.pending ? { submit: io.state.pending } : {}),
  })
}

const Composer: ClientModule<ComposerProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let io = instances.get(surface)
  if (!io) {
    const state: State = surface.state ?? {
      text: props.seed,
      cursor: props.seed.length,
      instance: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      seq: 0,
      selected: 0,
      hiddenMenu: false,
      active: false,
      history: [],
      historyIndex: -1,
      unsent: '',
    }
    io = { state, props, menu: [], send: () => {} }
    instances.set(surface, io)
    const instance = io
    let lastPost = 0
    surface.every(120, () => {
      if (instance.props.activity) surface.setState({ ...instance.state })
      if (instance.state.pending && Date.now() - lastPost >= 360) {
        lastPost = Date.now()
        snapshot(instance, surface)
      }
    })
  }
  io.props = props
  // Pane.isFocused becomes false when the drawing-thread Client takes focus.
  // Keep the insertion point visible; the host owns Escape/focus transfer.
  if (io.state.pending && props.receipt?.id === io.state.pending.id) {
    const pending = io.state.pending
    io.state.pending = undefined
    if (props.receipt.accepted) {
      io.state.history = [...io.state.history, pending.text].slice(-30)
      io.state.text = ''
      io.state.cursor = 0
      io.state.historyIndex = -1
    }
    surface.setState({ ...io.state })
  }
  const instance = io
  const width = Math.max(8, (surface.columns || props.columns) - 3)
  const redraw = () => {
    surface.setState({ ...instance.state })
    snapshot(instance, surface)
  }
  const setText = (text: string) => {
    instance.state = {
      ...instance.state,
      text,
      cursor: text.length,
      selected: 0,
      hiddenMenu: false,
      preferredColumn: undefined,
    }
    instance.state.seq++
    redraw()
  }
  instance.send = () => {
    const state = instance.state
    if (
      !state.text.trim() ||
      state.pending ||
      (instance.props.busy && !/^\/(stop|close)\s*$/.test(state.text))
    )
      return
    state.seq++
    state.pending = {
      id: `${instance.props.epoch}:${state.instance}:${state.seq}`,
      text: state.text,
    }
    redraw()
  }
  instance.menu = io.state.hiddenMenu
    ? []
    : completions(io.state.text, props.commands, props.models, props.model)
  const choose = (item: Completion, execute: boolean) => {
    setText(item.value)
    if (execute && item.execute) instance.send()
  }
  surface.onKey((key) => {
    key = normalizeKey(key) as typeof key
    const state = instance.state
    state.active = true
    if (state.pending) return
    const menu = completions(
      state.text,
      instance.props.commands,
      instance.props.models,
      instance.props.model,
    )
    const shown = state.hiddenMenu ? [] : menu
    if (key.ctrl && key.key === 'g') {
      state.hiddenMenu = true
      redraw()
      return
    }
    if (shown.length && (key.key === 'up' || key.key === 'down')) {
      state.selected = (state.selected + (key.key === 'up' ? -1 : 1) + shown.length) % shown.length
      redraw()
      return
    }
    if (shown.length && key.key === 'tab') {
      choose(shown[state.selected % shown.length], false)
      return
    }
    if (key.key === 'return' && !key.shift && !key.meta) {
      const selected = shown[state.selected % shown.length]
      if (selected) {
        choose(selected, false)
        if (!/^\/(model|effort) $/.test(selected.value)) instance.send()
      } else instance.send()
      return
    }
    if (
      !shown.length &&
      !state.text.includes('\n') &&
      (key.key === 'up' || key.key === 'down') &&
      (state.historyIndex >= 0 || (key.key === 'up' && state.cursor === 0))
    ) {
      if (state.historyIndex < 0) {
        state.unsent = state.text
        state.historyIndex = state.history.length
      }
      const index = Math.max(
        0,
        Math.min(state.history.length, state.historyIndex + (key.key === 'up' ? -1 : 1)),
      )
      state.historyIndex = index
      setText(index === state.history.length ? state.unsent : (state.history[index] ?? ''))
      return
    }
    const next = edit(state, key, width)
    if (next.text !== state.text) {
      state.selected = 0
      state.hiddenMenu = false
      state.historyIndex = -1
    }
    instance.state = { ...state, ...next, seq: state.seq + 1 }
    redraw()
  })
  const state = io.state
  const lines = layout(state.text, width),
    position = caret(lines, state.cursor)
  const count = Math.min(props.maxRows, lines.length)
  const start = Math.max(0, position.row - count + 1)
  const menuSize = Math.min(6, instance.menu.length)
  const menuStart = Math.max(
    0,
    Math.min(instance.menu.length - menuSize, state.selected - menuSize + 1),
  )
  const animation = props.activity ? activityFrame(props.activity, Date.now()) : null
  const inputTop = animation ? 2 : 1
  const menuTop = inputTop + count + 1
  surface.onPointer((event) => {
    if (event.type !== 'down' || event.button !== 'left') return
    state.active = true
    if (event.y >= inputTop && event.y < inputTop + count) {
      const line = lines[Math.min(lines.length - 1, start + event.y - inputTop)]
      state.cursor = offsetAt(line, Math.max(0, event.x - 2))
      state.preferredColumn = undefined
      redraw()
    } else if (event.y >= menuTop && event.y < menuTop + menuSize) {
      const item = instance.menu[menuStart + event.y - menuTop]
      if (item) choose(item, true)
    } else redraw()
  })
  const rule = '─'.repeat(width + 2)
  return (
    <Box flexDirection="column" width={width + 3}>
      {animation ? (
        <Box height={1}>
          <Text color="claude">
            {animation.glyph} {animation.label}…
          </Text>
          <Text dimColor>{animation.seconds ? ` (${animation.seconds}s)` : ''}</Text>
        </Box>
      ) : null}
      <Text dimColor>{rule}</Text>
      {lines.slice(start, start + count).map((line, index) => {
        const active = state.active && start + index === position.row
        const before = line.glyphs
          .filter((g) => g.end <= state.cursor)
          .map((g) => g.text)
          .join('')
        const cursorGlyph = line.glyphs.find((g) => g.start === state.cursor)
        const after = line.glyphs
          .filter((g) => g.start > state.cursor)
          .map((g) => g.text)
          .join('')
        return (
          <Box key={`line-${index}`} height={1}>
            <Text color={state.active ? 'claude' : undefined}>{index === 0 ? '❯ ' : '  '}</Text>
            {!state.text && !active ? (
              <Text dimColor>Ask anything…</Text>
            ) : active ? (
              <Text>
                {before}
                <Text inverse>{cursorGlyph?.text ?? ' '}</Text>
                {after}
              </Text>
            ) : (
              <Text>{line.glyphs.map((g) => g.text).join('') || ' '}</Text>
            )}
          </Box>
        )
      })}
      <Text dimColor>{rule}</Text>
      {instance.menu.slice(menuStart, menuStart + menuSize).map((item, index) => (
        <Box key={item.value} height={1}>
          <Text
            color={menuStart + index === state.selected ? 'claude' : undefined}
            bold={menuStart + index === state.selected}
            wrap="truncate-end"
          >
            {menuStart + index === state.selected ? '› ' : '  '}
            {item.label} <Text dimColor>{item.description}</Text>
          </Text>
        </Box>
      ))}
      {instance.menu.length > menuSize ? (
        <Box justifyContent="flex-end">
          <Text dimColor>
            {state.selected + 1}/{instance.menu.length}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}
export default Composer
