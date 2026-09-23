import { timingSafeEqual } from 'node:crypto'
import { Conversation } from './conversation.ts'
import { prepareStart } from './prepare.ts'

let activeConversation: Conversation | undefined
async function main() {
  const options = await prepareStart(JSON.parse(await Bun.stdin.text()))
  const token = crypto.randomUUID() + crypto.randomUUID()
  const conversation = (activeConversation = new Conversation(options))
  let idleChecks = 0
  let closing = false

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const credential = Buffer.from(request.headers.get('authorization') ?? '')
      const expected = Buffer.from(`Bearer ${token}`)
      if (credential.length !== expected.length || !timingSafeEqual(credential, expected))
        return new Response('Unauthorized', { status: 401 })
      // This endpoint is a local process capability, never a website API.
      if (request.headers.has('origin'))
        return new Response('Browser requests are not accepted', { status: 403 })
      idleChecks = 0
      const path = new URL(request.url).pathname
      try {
        if (path === '/state' && request.method === 'GET') return Response.json(conversation.state)
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        if (Number(request.headers.get('content-length') ?? 0) > 65536)
          return new Response('Too large', { status: 413 })
        const raw = await request.text()
        if (raw.length > 65536) return new Response('Too large', { status: 413 })
        const body = raw ? JSON.parse(raw) : {}
        if (path === '/send') {
          if (
            typeof body.text !== 'string' ||
            typeof body.id !== 'string' ||
            !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.id)
          )
            throw new Error('Invalid message')
          await conversation.submitOnce(body.id, body.text)
        } else if (path === '/permission') {
          if (typeof body.id !== 'string' || typeof body.allow !== 'boolean')
            throw new Error('Invalid decision')
          conversation.decide(body.id, body.allow, body.answers)
        } else if (path === '/stop') await conversation.stop()
        else if (path === '/close') setTimeout(shutdown, 20)
        else return new Response('Not found', { status: 404 })
        return Response.json(conversation.state)
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        )
      }
    },
  })

  function shutdown() {
    if (closing) return
    closing = true
    conversation.close()
    server.stop(true)
    // This daemon is the leader of its own process group. Bound cleanup even if
    // a tool ignores normal SDK cancellation; never signal the parent group.
    setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL')
      } catch {
        process.exit(0)
      }
    }, 1000)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // Count missed checks, not elapsed time: a machine waking from sleep is not idle.
  setInterval(() => {
    if (++idleChecks > 6) shutdown()
    if (options.ownerPid) {
      try {
        process.kill(options.ownerPid, 0)
      } catch {
        shutdown()
      }
    }
  }, 5000)
  process.stdout.write(
    JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, pid: process.pid }) + '\n',
  )
}

export async function serve() {
  try {
    await main()
  } catch (error) {
    activeConversation?.close()
    // Startup errors are protocol data, not Bun source excerpts in the chat UI.
    process.stdout.write(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n',
    )
    process.exitCode = 1
  }
}
