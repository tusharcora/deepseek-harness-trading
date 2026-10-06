import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { AlpacaHttp } from '../src/http.ts'
import { TradeUpdateStream } from '../src/stream.ts'

let seen: string[] = []
let proxy: Server
let proxyUrl: string

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}

describe('alpaca egress', () => {
  it('sends REST requests through the proxy', async () => {
    const http = new AlpacaHttp({ tradingUrl: 'http://alpaca-probe.invalid', dataUrl: 'http://alpaca-probe.invalid', timeoutMs: 2_000,
      retryDelaysMs: [], keys: async () => ({ keyId: 'k', secret: 's' }) })
    expect(await observe(() => http.request('trading', 'GET', '/v2/account'))).toEqual(['REQ http://alpaca-probe.invalid/v2/account'])
  })

  it('opens the trade-updates stream through the proxy', async () => {
    const recorded = await observe(async () => {
      const done = Promise.withResolvers<undefined>()
      const stream = new TradeUpdateStream({ url: 'wss://alpaca-probe.invalid/stream', backoffMs: [60_000],
        keys: async () => ({ keyId: 'k', secret: 's' }), onEvent: () => {}, onError: () => { done.resolve(undefined) } })
      stream.start()
      await Promise.race([done.promise, new Promise(resolve => setTimeout(resolve, 2_000))])
      stream.stop()
    })
    expect(recorded).toEqual(['CONNECT alpaca-probe.invalid:443'])
  })
})
