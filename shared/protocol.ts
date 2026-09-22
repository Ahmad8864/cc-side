export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  toolInput?: string
  status?: 'running' | 'done' | 'error' | 'cancelled'
}
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type Permission = { id: string; tool: string; input: Record<string, unknown> }
export type SideCommand = { name: string; description: string; argumentHint: string; aliases?: string[] }
export type SideModel = { value: string; resolvedModel?: string; displayName: string; description: string; supportedEffortLevels?: string[] }
export type ChatState = {
  revision: number
  status: 'starting' | 'ready' | 'working' | 'permission' | 'error' | 'closed'
  messages: ChatMessage[]
  permissions: Permission[]
  sessionId?: string
  error?: string
  notice?: string
  context?: 'inherited' | 'empty'
  usage?: Usage
  requests: { id: string; usage: Usage; cacheMiss?: unknown }[]
  textDeltas: number
  runtime?: string
  model?: string
  effort?: string
  cwd?: string
  commands?: SideCommand[]
  models?: SideModel[]
}
export type StartOptions = {
  parentSessionId: string
  allowEmptyParent?: boolean
  resumeSessionAt?: string
  cwd: string
  model: string
  ownerPid?: number
  settingSources?: ('user' | 'project' | 'local')[]
  isolatedTest?: boolean
}
export type Endpoint = { url: string; token: string; pid: number }
export type StartupResult = Endpoint | { error: string }
