import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { asset, bars, latestQuote, marketOpen } from '../src/market.ts'
import { FakeAlpaca } from './fake-alpaca.ts'

let fake: FakeAlpaca
let http: AlpacaHttp
const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const bar = (hour: number): Record<string, unknown> => ({
  t: `2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`, o: 1, h: 2, l: 0.5, c: 1.5, v: 3,
})

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start()
  http = new AlpacaHttp({
    tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [], keys: async () => ({ keyId: 'k', secret: 's' }),
  })
})
afterEach(async () => { await fake.stop() })

describe('latestQuote', () => {
  it('reads crypto and equity quotes from their endpoints', async () => {
    fake.on('GET', '/v1beta3/crypto/us/latest/quotes',
      () => ({ status: 200, body: { quotes: { 'BTC/USD': { t: '2026-10-05T14:00:00Z', bp: 1, ap: 2 } } } }))
    fake.on('GET', '/v2/stocks/quotes/latest',
      () => ({ status: 200, body: { quotes: { AAPL: { t: '2026-10-05T14:00:00Z', bp: 3, ap: 4 } } } }))
    expect(await latestQuote(http, btc, 'iex')).toEqual({ bid: 1, ask: 2, t: Date.UTC(2026, 9, 5, 14) })
    expect(await latestQuote(http, aapl, 'iex')).toEqual({ bid: 3, ask: 4, t: Date.UTC(2026, 9, 5, 14) })
    expect(fake.requests[1]?.query.get('feed')).toBe('iex')
    expect(fake.requests[0]?.query.get('symbols')).toBe('BTC/USD')
  })

  it('reports a missing quote as not-found', async () => {
    fake.on('GET', '/v2/stocks/quotes/latest', () => ({ status: 200, body: { quotes: {} } }))
    await expect(latestQuote(http, aapl, 'sip')).rejects.toMatchObject({ code: 'not-found', message: 'no quote for AAPL' })
  })
})

describe('bars', () => {
  it('requests the most recent bars newest-first across pages and returns them oldest-first', async () => {
    fake.on('GET', '/v2/stocks/bars', request => (request.query.get('page_token') === null
      ? { status: 200, body: { bars: { AAPL: [bar(3), bar(2)] }, next_page_token: 'p2' } }
      : { status: 200, body: { bars: { AAPL: [bar(1)] }, next_page_token: null } }))
    const result = await bars(http, aapl, '1h', { limit: 3 }, 'iex', Date.UTC(2026, 9, 5, 4))
    expect(result.map(b => b.t)).toEqual([1, 2, 3].map(h => Date.UTC(2026, 9, 5, h)))
    const first = fake.requests[0]?.query
    expect(first?.get('timeframe')).toBe('1Hour')
    expect(first?.get('sort')).toBe('desc')
    expect(first?.get('feed')).toBe('iex')
    expect(first?.get('adjustment')).toBe('split')
    expect(first?.get('end')).toBe('2026-10-05T04:00:00.000Z')
    expect(first?.get('limit')).toBe('3')
    expect(fake.requests[1]?.query.get('limit')).toBe('1')
  })

  it('stops at the limit, honors an explicit range, and reads crypto without feed or adjustment', async () => {
    fake.on('GET', '/v1beta3/crypto/us/bars',
      () => ({ status: 200, body: { bars: { 'BTC/USD': [bar(2), bar(1)] }, next_page_token: 'more' } }))
    const result = await bars(http, btc, '1D', { limit: 2, start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 9, 5) }, 'iex', 0)
    expect(result).toHaveLength(2)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.query.get('feed')).toBeNull()
    expect(fake.requests[0]?.query.get('start')).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns an empty series when the venue has no bars', async () => {
    fake.on('GET', '/v2/stocks/bars', () => ({ status: 200, body: { bars: {}, next_page_token: null } }))
    expect(await bars(http, aapl, '5m', { limit: 10 }, 'iex', 0)).toEqual([])
  })
})

describe('marketOpen and asset', () => {
  it('treats crypto as always open and reads the clock for equities', async () => {
    fake.on('GET', '/v2/clock', () => ({ status: 200, body: { is_open: false } }))
    expect(await marketOpen(http, btc)).toBe(true)
    expect(await marketOpen(http, aapl)).toBe(false)
    expect(fake.requests).toHaveLength(1)
  })

  it('reads a crypto asset by its joined symbol', async () => {
    fake.on('GET', '/v2/assets/BTCUSD', () => ({ status: 200, body: { symbol: 'BTC/USD', class: 'crypto', status: 'active',
      tradable: true, fractionable: true, price_increment: '1' } }))
    expect(await asset(http, btc, 12)).toMatchObject({ priceIncrement: 1, minNotional: 12 })
  })
})
