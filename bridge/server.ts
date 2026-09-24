import { randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'
import { Conversation } from './conversation.ts'
import { endProcessTree } from './platform.ts'
import { prepareStart } from './prepare.ts'
import { errorMessage } from '../shared/errors.ts'

let activeConversation: Conversation | undefined
async function main() {
  const options = await prepareStart(JSON.parse(await text(process.stdin)))
  const token = randomUUID() + randomUUID()
  const conversation = (activeConversation = new Conversation(options))
  let idleChecks = 0
  let closing = false

  async function respond(request: IncomingMessage) {
    const credential = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (credential.length !== expected.length || !timingSafeEqual(credential, expected))
      return new Response('Unauthorized', { status: 401 })
    // This endpoint is a local process capability, never a website API.
    if (request.headers.origin !== undefined)
      return new Response('Browser requests are not accepted', { status: 403 })
    idleChecks = 0
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    try {
      if (path === '/state' && request.method === 'GET') return Response.json(conversation.state)
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
      if (Number(request.headers['content-length'] ?? 0) > 65536)
        return new Response('Too large', { status: 413 })
      const raw = await text(request)
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
      } else if (path === '/edit') {
        if (typeof body.canEdit !== 'boolean') throw new Error('Invalid edit setting')
        conversation.setEditing(body.canEdit)
      } else if (path === '/stop') await conversation.stop()
      else if (path === '/close') setTimeout(shutdown, 20)
      else return new Response('Not found', { status: 404 })
      return Response.json(conversation.state)
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 })
    }
  }

  const server = createServer(async (request, response) => {
    const answer = await respond(request)
    response.writeHead(answer.status, Object.fromEntries(answer.headers))
    response.end(await answer.text())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  function shutdown() {
    if (closing) return
    closing = true
    endProcessTree(() => {
      conversation.close()
      server.close()
      server.closeAllConnections()
    })
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
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token,
      pid: process.pid,
    }) + '\n',
  )
}

export async function serve() {
  try {
    await main()
  } catch (error) {
    activeConversation?.close()
    // Startup errors are protocol data, not source excerpts in the chat UI.
    process.stdout.write(JSON.stringify({ error: errorMessage(error) }) + '\n')
    process.exitCode = 1
  }
}
