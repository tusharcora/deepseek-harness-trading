import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One recorded request. */
export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly body: unknown
  readonly keyId: string | undefined
}

/** What a route answers; `rawBody` sends text verbatim instead of JSON. */
export interface FakeReply {
  readonly status: number
  readonly body?: unknown
  readonly rawBody?: string
  /** Delay before answering, milliseconds. */
  readonly delayMs?: number
  /** Send the headers and half the body, then drop the connection. */
  readonly truncate?: boolean
  /** Extra response headers, such as `location` for a redirect. */
  readonly headers?: Readonly<Record<string, string>>
}

type Responder = (request: RecordedRequest) => FakeReply

/** A local Alpaca stand-in: exact method + raw path routes, latest registration wins, every request recorded. */
export class FakeAlpaca {
  readonly requests: RecordedRequest[] = []
  url = ''
  private server: Server | undefined
  private routes: { method: string; path: string; respond: Responder }[] = []

  on(method: string, path: string, respond: Responder): void {
    this.routes.unshift({ method, path, respond })
  }

  async start(): Promise<void> {
    this.server = createServer((incoming, outgoing) => {
      void readBody(incoming).then((text) => { this.answer(incoming, outgoing, text) }).catch((error: unknown) => {
        // A throwing responder or an unparseable request body answers 500 instead of leaving the request hanging.
        if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ message: (error as Error).message }))
      })
    })
    const address = await new Promise<AddressInfo>((resolve) => {
      const server = this.server as Server
      server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
    })
    this.url = `http://127.0.0.1:${String(address.port)}`
  }

  private answer(incoming: IncomingMessage, outgoing: ServerResponse, text: string): void {
    const url = new URL(incoming.url ?? '/', 'http://fake')
    const keyHeader = incoming.headers['apca-api-key-id']
    const request: RecordedRequest = {
      method: incoming.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: text === '' ? undefined : JSON.parse(text) as unknown,
      keyId: typeof keyHeader === 'string' ? keyHeader : undefined,
    }
    this.requests.push(request)
    const route = this.routes.find(r => r.method === request.method && r.path === request.path)
    const reply: FakeReply = route === undefined ? { status: 404, body: { message: 'not found' } } : route.respond(request)
    setTimeout(() => {
      const text = reply.rawBody ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
      if (reply.truncate === true) {
        const length = String(text.length * 2)
        outgoing.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': length, ...reply.headers })
        outgoing.write(text.slice(0, Math.ceil(text.length / 2)))
        setTimeout(() => { outgoing.socket?.destroy() }, 5)
        return
      }
      outgoing.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
      outgoing.end(text)
    }, reply.delayMs ?? 0)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Alpaca account configuration fields the desk manages. */
export interface FakeAccountConfig {
  no_shorting: boolean
  max_margin_multiplier: string
  suspend_trade: boolean
}

/**
 * Serve GET/PATCH /v2/account/configurations from a mutable record.
 * @param fake - server to register on.
 * @param initial - starting configuration.
 * @returns the live record; tests mutate it to simulate changes made outside the desk.
 */
export function accountConfig(fake: FakeAlpaca, initial: FakeAccountConfig): FakeAccountConfig {
  const state = { ...initial }
  fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...state, fractional_trading: true } }))
  fake.on('PATCH', '/v2/account/configurations', (request) => {
    Object.assign(state, request.body)
    return { status: 200, body: { ...state, fractional_trading: true } }
  })
  return state
}
