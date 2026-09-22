import { timingSafeEqual } from 'node:crypto'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { Conversation } from './conversation.ts'
import type { StartOptions } from '../shared/protocol.ts'

const options: StartOptions = JSON.parse(await Bun.stdin.text())
if (!/^[0-9a-f-]{36}$/i.test(options.parentSessionId) || !options.cwd.startsWith('/')) throw new Error('Invalid parent session')
const token = crypto.randomUUID() + crypto.randomUUID()
// Pin the saved conversation at pane opening, before a later parent turn.
const history = await getSessionMessages(options.parentSessionId, { dir: options.cwd, includeSystemMessages: true })
options.resumeSessionAt = history.at(-1)?.uuid
if (!options.resumeSessionAt) throw new Error('No saved conversation yet. Send a message in the main chat, then reopen /side.')
const conversation = new Conversation(options)
let touched = Date.now()
let closing = false

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const credential = Buffer.from(request.headers.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (credential.length !== expected.length || !timingSafeEqual(credential, expected)) return new Response('Unauthorized', { status: 401 })
    // This endpoint is a local process capability, never a website API.
    if (request.headers.has('origin')) return new Response('Browser requests are not accepted', { status: 403 })
    touched = Date.now()
    const path = new URL(request.url).pathname
    try {
      if (path === '/state' && request.method === 'GET') return Response.json(conversation.state)
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
      if (Number(request.headers.get('content-length') ?? 0) > 65536) return new Response('Too large', { status: 413 })
      const raw = await request.text()
      if (raw.length > 65536) return new Response('Too large', { status: 413 })
      const body = raw ? JSON.parse(raw) : {}
      if (path === '/send') {
        if (typeof body.text !== 'string') throw new Error('Missing message')
        conversation.send(body.text)
      } else if (path === '/permission') {
        if (typeof body.id !== 'string' || typeof body.allow !== 'boolean') throw new Error('Invalid decision')
        conversation?.decide(body.id, body.allow, body.answers)
      } else if (path === '/stop') await conversation?.stop()
      else if (path === '/close') setTimeout(shutdown, 20)
      else return new Response('Not found', { status: 404 })
      return Response.json({ ok: true })
    } catch (error) { return Response.json({ error: String(error) }, { status: 400 }) }
  },
})

function shutdown() {
  if (closing) return
  closing = true
  conversation?.close()
  server.stop(true)
  // This daemon is the leader of its own process group. Bound cleanup even if
  // a tool ignores normal SDK cancellation; never signal the parent group.
  setTimeout(() => {
    try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(0) }
  }, 1000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
setInterval(() => {
  if (Date.now() - touched > 30000) shutdown()
  if (options.ownerPid) { try { process.kill(options.ownerPid, 0) } catch { shutdown() } }
}, 5000)
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, pid: process.pid }) + '\n')
