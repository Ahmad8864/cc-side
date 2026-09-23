import type {
  ChatState,
  EffortLevel,
  Endpoint,
  Receipt,
  StartOptions,
  Submission,
} from '../shared/protocol.ts'
import { localCommands } from '../shared/commands.ts'
import { effortLevels } from '../shared/models.ts'
import type { ComposerProps } from './composer.tsx'
import type { PaneActions, PaneView } from './pane.tsx'
import type { Answers } from './permissions.tsx'

export type BridgePath = '/state' | '/send' | '/permission' | '/edit' | '/stop' | '/close'
export type StartChoices = Partial<Pick<StartOptions, 'model' | 'effort' | 'canEdit' | 'carried'>>

/** What the side chat needs from Claude. The hook module provides it, since only it may use `$`. */
type Host = {
  options: (choices: StartChoices) => Promise<StartOptions>
  start: (options: StartOptions) => Promise<Endpoint>
  request: (endpoint: Endpoint, path: BridgePath, body?: unknown) => Promise<ChatState>
  write: (path: string, text: string) => Promise<void>
  invalidate: () => void
  after: (ms: number, fn: () => void) => void
  scroll: () => void
  reveal: (key: string) => void
  focus: (key: string) => Promise<void>
  closePane: () => Promise<void>
  readEditing: () => Promise<boolean>
  saveEditing: (canEdit: boolean) => Promise<void>
  insertInMain: (text: string) => Promise<boolean>
  copy: (text: string) => Promise<boolean>
}

type ComposerPost = {
  epoch: number
  seq: number
  instance: string
  text: string
  submit?: Submission
}

const empty = (): ChatState => ({
  revision: -1,
  status: 'starting',
  messages: [],
  permissions: [],
  requests: [],
  textDeltas: 0,
})

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The pane's side chat: its helper, sends and their receipts, and what the pane shows. */
export class SideChat {
  // Set by the hook module when a session starts.
  host!: Host
  tracePath: string | undefined
  opened = false
  // generation names an opened side chat and its composer; connection names the
  // helper serving it, which a refresh replaces without disturbing the composer.
  generation = 0
  state = empty()
  // Whether the pane scrolls to new output; scrolling up stops it.
  follow = true
  mainEffort: EffortLevel | undefined
  private connection = 0
  private endpoint: Endpoint | undefined
  private connecting = false
  private sending = false
  private draft = ''
  private localError = ''
  private localNotice = ''
  private answers: Answers = {}
  private readonly expanded = new Set<string>()
  private receipt: Receipt | null = null
  private readonly receipts = new Map<string, Receipt>()
  private readonly pendingSubmissions = new Map<string, Promise<boolean>>()
  private commandSequence = 0
  private composerColumns = 70
  private composerRows = 40
  private focusedPermission: string | undefined
  private savedEditing = false
  // Main replies that finished since the side forked, and a refresh in flight.
  private mainAhead = 0
  private refreshing = false
  private readonly events: unknown[] = []
  private writes = Promise.resolve()

  readonly paneActions: PaneActions = {
    invalidate: () => this.host.invalidate(),
    setError: (message) => {
      this.localError = message
      this.host.invalidate()
    },
    decide: (id, allow, answers) =>
      this.action('/permission', { id, allow, ...(answers ? { answers } : {}) }),
    toggleEditing: () => this.action('/edit', { canEdit: !this.state.canEdit }),
    onToggle: (key) => {
      this.follow = false
      this.host.invalidate()
      this.host.after(80, () => {
        if (this.opened) this.host.reveal(key)
      })
    },
    refresh: () => this.refresh(),
    retry: () => this.connect(),
    stop: () => this.action('/stop'),
  }

  get connected() {
    return !!this.endpoint
  }

  /** What the pane shows, apart from its size and the composer. */
  paneView(): Omit<PaneView, 'width' | 'columns' | 'rows' | 'composer'> {
    return {
      state: this.state,
      answers: this.answers,
      expanded: this.expanded,
      localError: this.localError,
      localNotice: this.localNotice,
      busy: this.busy(),
      connected: this.connected,
      refreshing: this.refreshing,
      mainAhead: this.mainAhead,
    }
  }

  composerProps(): ComposerProps {
    const { state } = this
    return {
      epoch: this.generation,
      seed: this.draft,
      receipt: this.receipt,
      busy: this.busy() || this.refreshing,
      activity: state.status === 'working' ? (state.activity ?? null) : null,
      columns: this.composerColumns,
      maxRows: Math.max(2, Math.min(8, Math.floor(this.composerRows / 4))),
      commands: state.commands ?? localCommands,
      models: state.models ?? [],
      model: state.model ?? '',
      effort: state.effort ?? '',
      canEdit: state.canEdit ?? false,
    }
  }

  resizeComposer(columns: number, rows: number) {
    this.composerColumns = columns
    this.composerRows = rows
  }

  /** Moves the keyboard to Deny when Claude marks an approval as safer to refuse. */
  focusCautiousPermission() {
    const cautious = this.state.permissions.find((permission) => permission.defaultToNo)?.id
    if (cautious === this.focusedPermission) return
    this.focusedPermission = cautious
    if (cautious)
      this.host.after(80, () => {
        if (this.opened && this.state.permissions.some((permission) => permission.id === cautious))
          void this.host.focus(`deny-${cautious}`)
      })
  }

  /** Takes a composer post: its draft, and a send to acknowledge once. */
  async receive(data: unknown): Promise<{ props?: ComposerProps }> {
    if (!isPost(data, this.generation)) return {}
    const submission = data.submit
    if (!submission || !this.receipts.get(submission.id)?.accepted) this.draft = data.text
    if (submission && isSubmission(submission, this.generation, data.instance)) {
      const generation = this.generation
      const prior = this.receipts.get(submission.id)
      if (prior) this.receipt = prior
      else {
        let pending = this.pendingSubmissions.get(submission.id)
        if (!pending) {
          pending = this.send(submission.text, submission.id)
          this.pendingSubmissions.set(submission.id, pending)
        }
        let accepted = false
        try {
          accepted = await pending
        } catch (error) {
          if (generation === this.generation) this.localError = String(error)
        }
        if (generation !== this.generation) return {}
        this.pendingSubmissions.delete(submission.id)
        this.receipt = { id: submission.id, accepted }
        this.receipts.set(submission.id, this.receipt)
        if (this.receipts.size > 128) this.receipts.delete(this.receipts.keys().next().value!)
        this.host.invalidate()
      }
    }
    // Reply on the Client's own channel too; it must not depend on a later
    // pane redraw to release the pending send after an error or remount.
    return { props: this.composerProps() }
  }

  /** Sends a question given with /side, or says why it was not sent. */
  async ask(text: string): Promise<string | undefined> {
    const generation = this.generation
    const busy = this.busy()
    const accepted = this.endpoint && (await this.send(text))
    if (accepted || generation !== this.generation || !this.opened) return
    return busy
      ? 'Side chat is busy. Wait for the reply or stop it, then retry.'
      : this.localError || 'Side chat is not ready yet. Retry once it is connected.'
  }

  /** Counts a main-loop reply that the open side chat has not seen. */
  mainReplied() {
    if (!this.endpoint) return
    this.mainAhead++
    this.host.invalidate()
  }

  stats() {
    const { requests, status, textDeltas } = this.state
    const read = requests.reduce((sum, r) => sum + (r.usage.cache_read_input_tokens ?? 0), 0)
    const written = requests.reduce((sum, r) => sum + (r.usage.cache_creation_input_tokens ?? 0), 0)
    return `Side chat: ${status} · ${requests.length} model requests · cache read ${read} / write ${written} tokens · ${textDeltas} text deltas`
  }

  trace(kind: string, data: unknown) {
    if (!this.tracePath) return
    this.events.push({ at: Date.now(), kind, data })
    let json = JSON.stringify({ events: this.events }, null, 2)
    // Mods writes at most 4 MiB of UTF-8, so keep the newest events that fit.
    while (json.length > 1000000 && this.events.length > 1) {
      this.events.splice(0, Math.ceil(this.events.length / 4))
      json = JSON.stringify({ events: this.events }, null, 2)
    }
    this.writes = this.writes.then(() => this.host.write(this.tracePath!, json)).catch(() => {})
  }

  /** Resolves once the traced events so far are written. */
  flushed() {
    return this.writes
  }

  async connect() {
    if (!this.opened || this.connecting) return
    this.connecting = true
    this.mainAhead = 0
    this.state = empty()
    this.localError = ''
    this.follow = true
    this.generation++
    const connection = ++this.connection
    this.receipt = null
    this.receipts.clear()
    this.pendingSubmissions.clear()
    this.host.invalidate()
    try {
      this.savedEditing = await this.host.readEditing()
      const started = await this.host.start(
        await this.host.options({ effort: this.mainEffort, canEdit: this.savedEditing }),
      )
      if (connection !== this.connection) {
        await this.host.request(started, '/close')
        return
      }
      this.endpoint = started
      this.trace('side.opened', { pid: started.pid, placement: 'right' })
      void this.poll(connection)
    } catch (error) {
      if (connection === this.connection) {
        this.localError = errorMessage(error)
        this.state.status = 'error'
        this.host.invalidate()
      }
    } finally {
      if (connection === this.connection) this.connecting = false
    }
  }

  async close() {
    if (!this.opened && !this.endpoint && !this.connecting) return
    const old = this.endpoint
    this.generation++
    this.connection++
    this.opened = false
    this.mainAhead = 0
    this.refreshing = false
    this.endpoint = undefined
    this.state = empty()
    this.draft = ''
    this.answers = {}
    this.sending = false
    this.connecting = false
    this.localError = ''
    this.receipt = null
    this.receipts.clear()
    this.pendingSubmissions.clear()
    this.expanded.clear()
    this.host.invalidate()
    if (old) {
      try {
        await this.host.request(old, '/close')
      } catch (error) {
        this.trace('side.close-error', String(error))
      }
    }
    this.trace('side.closed', {})
  }

  // Sending, or the helper is answering or waiting on an approval.
  private busy() {
    return this.sending || this.state.status === 'working' || this.state.status === 'permission'
  }

  // Takes the helper's newer state, remembering its edit setting for new side chats.
  private update(next: ChatState) {
    this.state = next
    if (next.canEdit === undefined || next.canEdit === this.savedEditing) return
    this.savedEditing = next.canEdit
    void this.host.saveEditing(this.savedEditing)
  }

  private notify(message: string) {
    this.localNotice = message
    this.host.invalidate()
    this.host.after(5000, () => {
      if (this.localNotice !== message) return
      this.localNotice = ''
      this.host.invalidate()
    })
  }

  private async poll(connection: number, failures = 0) {
    if (connection !== this.connection || !this.endpoint) return
    try {
      const result = await this.host.request(this.endpoint, '/state')
      if (connection !== this.connection) return
      if (result.revision > this.state.revision) {
        this.update(result)
        this.trace('side.state', this.state)
        this.host.invalidate()
        if (this.follow)
          this.host.after(80, () => {
            if (this.opened && this.follow) this.host.scroll()
          })
      }
    } catch (error) {
      if (connection !== this.connection) return
      // A busy or waking machine can miss a request; a stopped helper misses them all.
      if (failures < 4) {
        this.host.after(1000, () => {
          void this.poll(connection, failures + 1)
        })
        return
      }
      this.localError = `Side process disconnected. Close and reopen /side. ${String(error)}`
      this.host.invalidate()
      return
    }
    this.host.after(this.state.status === 'working' ? 120 : 700, () => {
      void this.poll(connection)
    })
  }

  private async action(path: BridgePath, body?: unknown) {
    if (!this.endpoint) return false
    const connection = this.connection
    try {
      const result = await this.host.request(this.endpoint, path, body)
      if (connection === this.connection && result.revision >= this.state.revision)
        this.update(result)
      return connection === this.connection
    } catch (error) {
      if (connection === this.connection) this.localError = String(error)
      return false
    } finally {
      if (connection === this.connection) this.host.invalidate()
    }
  }

  private async send(
    text: string,
    id = `${this.generation}:command:${++this.commandSequence}`,
  ): Promise<boolean> {
    const trimmed = text.trim()
    if (trimmed === '/close') {
      await this.host.closePane()
      return true
    }
    if (trimmed === '/stop') return this.action('/stop')
    if (!trimmed || this.busy() || this.refreshing || !this.endpoint) return false
    if (trimmed === '/insert' || trimmed === '/copy') return this.shareReply(trimmed)
    if (trimmed === '/refresh') {
      void this.refresh()
      return true
    }
    this.sending = true
    this.localError = ''
    this.localNotice = ''
    this.answers = {}
    const connection = this.connection
    try {
      const result = await this.host.request(this.endpoint, '/send', { id, text: trimmed })
      if (connection !== this.connection) return false
      this.draft = ''
      if (result.revision >= this.state.revision) this.update(result)
      this.trace('side.state', this.state)
      this.follow = true
      this.host.after(50, () => {
        if (this.opened) this.host.scroll()
      })
      return true
    } catch (error) {
      if (connection === this.connection) this.localError = errorMessage(error)
      return false
    } finally {
      if (connection === this.connection) {
        this.sending = false
        this.host.invalidate()
      }
    }
  }

  // The host, not the side's Claude, reaches the main prompt and the clipboard.
  private async shareReply(command: string) {
    const reply = this.state.messages.findLast((message) => message.role === 'assistant')
    if (!reply?.text) this.notify('There is no reply to share yet.')
    else if (command === '/insert')
      this.notify(
        (await this.host.insertInMain(reply.text))
          ? 'Inserted the last reply in the main prompt. Esc switches to it.'
          : 'The main prompt is not available right now.',
      )
    else
      this.notify(
        (await this.host.copy(reply.text)) ? 'Copied the last reply.' : 'Could not copy the reply.',
      )
    this.draft = ''
    return true
  }

  // Re-fork at main's latest point, keeping this discussion, the composer, and the side's
  // choices. The old helper serves until the new one is up, so a failure changes nothing.
  private async refresh() {
    const old = this.endpoint
    if (!old || this.refreshing) return false
    if (this.busy()) {
      this.notify('Wait for the current reply, or stop it first.')
      return false
    }
    const generation = this.generation
    const counted = this.mainAhead
    this.refreshing = true
    this.localError = ''
    this.host.invalidate()
    try {
      const started = await this.host.start(
        await this.host.options({
          ...(this.state.model ? { model: this.state.model } : {}),
          effort: effortLevels.find((level) => level === this.state.effort),
          canEdit: this.state.canEdit,
          carried: this.state.messages,
        }),
      )
      if (generation !== this.generation || !this.opened) {
        await this.host.request(started, '/close')
        return false
      }
      this.endpoint = started
      this.mainAhead -= counted
      this.state = { ...this.state, revision: -1 }
      const connection = ++this.connection
      this.trace('side.refreshed', { pid: started.pid })
      void this.poll(connection)
      void this.host.request(old, '/close').catch(() => {})
      return true
    } catch (error) {
      if (generation === this.generation) this.localError = errorMessage(error)
      return false
    } finally {
      if (generation === this.generation) {
        this.refreshing = false
        this.host.invalidate()
      }
    }
  }
}

// Posts are input from code, not facts: accept only the shape the composer sends.
function isPost(data: unknown, generation: number): data is ComposerPost {
  const post = data as Partial<ComposerPost> | null
  return (
    !!post &&
    post.epoch === generation &&
    Number.isSafeInteger(post.seq) &&
    post.seq! >= 0 &&
    typeof post.instance === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(post.instance) &&
    typeof post.text === 'string' &&
    post.text.length <= 50000
  )
}

function isSubmission(submission: Submission, generation: number, instance: string) {
  return (
    typeof submission.id === 'string' &&
    submission.id.startsWith(`${generation}:${instance}:`) &&
    /^[a-zA-Z0-9:_-]{1,160}$/.test(submission.id) &&
    typeof submission.text === 'string' &&
    submission.text.length <= 50000
  )
}
