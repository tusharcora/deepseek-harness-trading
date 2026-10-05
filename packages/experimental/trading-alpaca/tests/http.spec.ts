import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { AlpacaHttp } from '../src/http.ts'
import { FakeAlpaca } from './fake-alpaca.ts'

let fake: FakeAlpaca
let keyCalls: number
const slept: number[] = []

function client(retryDelaysMs: number[] = [5, 10]): AlpacaHttp {
  return new AlpacaHttp({
    tradingUrl: fake.url, dataUrl: `${fake.url}/data-root`, timeoutMs: 2_000, retryDelaysMs,
    keys: async () => { keyCalls++; return { keyId: 'key-1', secret: 'secret-1' } },
    sleep: async (ms) => { slept.push(ms) },
  })
}

beforeEach(async () => { fake = new FakeAlpaca(); await fake.start(); keyCalls = 0; slept.length = 0 })
afterEach(async () => { await fake.stop() })

describe('AlpacaHttp', () => {
  it('sends the key headers, query, and JSON body, resolving keys per request', async () => {
    fake.on('POST', '/v2/orders', request => ({ status: 200, body: { echoed: request.body } }))
    const result = await client().request<{ echoed: unknown }>(
      'trading', 'POST', '/v2/orders', { body: { qty: '1' }, query: { a: 1, b: undefined } },
    )
    expect(result).toEqual({ echoed: { qty: '1' } })
    expect(fake.requests[0]).toMatchObject({ method: 'POST', keyId: 'key-1' })
    expect(fake.requests[0]?.query.toString()).toBe('a=1')
    await client().request('trading', 'POST', '/v2/orders')
    expect(keyCalls).toBe(2)
  })

  it('routes data requests to the data base URL and returns undefined for empty bodies', async () => {
    fake.on('GET', '/data-root/v2/clock', () => ({ status: 204 }))
    expect(await client().request('data', 'GET', '/v2/clock')).toBeUndefined()
    expect(fake.requests[0]?.path).toBe('/data-root/v2/clock')
  })

  it('maps broker failures to venue error codes', async () => {
    const cases: [number, unknown, string, number | undefined][] = [
      [401, { message: 'unauthorized' }, 'auth', undefined],
      [403, { message: 'forbidden' }, 'auth', undefined],
      [403, { code: 40310000, message: 'insufficient buying power' }, 'rejected', 40310000],
      [404, { message: 'order not found' }, 'not-found', undefined],
      [422, { code: 40010001, message: 'client_order_id must be unique' }, 'rejected', 40010001],
      [500, { message: 'internal' }, 'unavailable', undefined],
    ]
    for (const [status, body, code, brokerCode] of cases) {
      fake.on('GET', '/v2/x', () => ({ status, body }))
      const error = await client().request('trading', 'GET', '/v2/x').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(VenueError)
      expect(error).toMatchObject({ code, brokerCode })
    }
  })

  it('names the HTTP status when the error body is not JSON', async () => {
    fake.on('GET', '/v2/x', () => ({ status: 502, rawBody: '<html>bad gateway</html>' }))
    await expect(client().request('trading', 'GET', '/v2/x')).rejects.toMatchObject({ code: 'unavailable' })
    fake.on('GET', '/v2/y', () => ({ status: 400 }))
    await expect(client().request('trading', 'GET', '/v2/y')).rejects.toThrow('Alpaca rejected the request: HTTP 400')
  })

  it('retries rate-limited reads with the configured waits, then reports rate-limited', async () => {
    let calls = 0
    fake.on('GET', '/v2/account', () => (
      ++calls < 3 ? { status: 429, body: { message: 'slow down' } } : { status: 200, body: { ok: true } }
    ))
    expect(await client().request('trading', 'GET', '/v2/account')).toEqual({ ok: true })
    expect(slept).toEqual([5, 10])
    fake.on('GET', '/v2/account', () => ({ status: 429, body: { message: 'slow down' } }))
    await expect(client().request('trading', 'GET', '/v2/account')).rejects.toMatchObject({ code: 'rate-limited' })
  })

  it('never retries a rate-limited write', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 429, body: { message: 'slow down' } }))
    await expect(client().request('trading', 'POST', '/v2/orders', { body: {} })).rejects.toMatchObject({ code: 'rate-limited' })
    expect(fake.requests).toHaveLength(1)
  })

  it('refuses to follow a redirect, so the key headers never reach another host', async () => {
    fake.on('GET', '/v2/account', () => ({ status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere' } }))
    await expect(client().request('trading', 'GET', '/v2/account')).rejects.toMatchObject({ code: 'unavailable' })
    expect(fake.requests).toHaveLength(1)
  })

  it('reports a success with an unreadable body as unavailable', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, rawBody: '<html>proxy page</html>' }))
    await expect(client().request('trading', 'POST', '/v2/orders', { body: {} }))
      .rejects.toMatchObject({ code: 'unavailable', message: 'Alpaca returned an unreadable response' })
  })

  it('reports a connection dropped mid-body as unavailable', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: { id: 'o-1', padding: 'x'.repeat(200) }, truncate: true }))
    await expect(client().request('trading', 'POST', '/v2/orders', { body: {} })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('waits with a real timer when no sleep is injected', async () => {
    let calls = 0
    fake.on('GET', '/v2/account', () => (
      ++calls < 2 ? { status: 429, body: { message: 'slow down' } } : { status: 200, body: { ok: true } }
    ))
    const http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [1],
      keys: async () => ({ keyId: 'k', secret: 's' }) })
    expect(await http.request('trading', 'GET', '/v2/account')).toEqual({ ok: true })
  })

  it('reports an unreachable host as unavailable', async () => {
    await fake.stop()
    await expect(client().request('trading', 'GET', '/v2/account')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
