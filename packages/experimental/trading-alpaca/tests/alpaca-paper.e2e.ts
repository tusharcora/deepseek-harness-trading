/**
 * Opt-in Alpaca paper e2e. Effects on the paper account named by ALPACA_API_KEY: sets no_shorting=true and
 * max_margin_multiplier=1 (they stay set); places and cancels a far-from-market BTC/USD limit order; buys a tiny
 * amount of BTC/USD and closes the whole BTC/USD position. The second test refuses to run if the account already
 * holds BTC/USD or has open BTC/USD orders. Each test cleans up in `finally`.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientOrderId, OrderUpdate } from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { INITIAL_SAFETY_STATE } from '../src/safety.ts'
import { TradeUpdateStream } from '../src/stream.ts'
import { orderedStore, VenueCore } from '../src/venue.ts'

const keyId = process.env.ALPACA_API_KEY
const secret = process.env.ALPACA_SECRET_KEY

/** The stream reports one of these per outage; the test tolerates it only alongside the events it asserts. */
const DISCONNECT = 'the order-update stream disconnected; reconnecting'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function paperVenue(): VenueCore {
  const http = new AlpacaHttp({ tradingUrl: 'https://paper-api.alpaca.markets', dataUrl: 'https://data.alpaca.markets',
    timeoutMs: 15_000, retryDelaysMs: [1_000, 2_000], keys: async () => ({ keyId: keyId ?? '', secret: secret ?? '' }) })
  return new VenueCore({ http, feed: 'iex', now: () => Date.now(), keysPresent: async () => true,
    timing: { confirmDelayMs: 2_000, settleDelayMs: 500, settleChecks: 10, sleep },
    safetyTiming: { suspendRetryMs: [500, 1_000], sleep },
    store: orderedStore(INITIAL_SAFETY_STATE, async () => {}),
    stream: () => ({ start: () => {}, stop: () => {} }), emitStatus: () => {} })
}

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const

describe.skipIf(keyId === undefined || secret === undefined)('Alpaca paper', () => {
  it('sets account safety, reads the asset by its joined path, places a far limit order idempotently, sees it open, '
    + 'and cancels it', async () => {
    const venue = paperVenue()
    await venue.prepare()
    expect(venue.status()).toBe('ready')
    expect((await venue.asset(btc)).symbol).toEqual(btc)
    const updates: OrderUpdate[] = []
    const streamErrors: string[] = []
    const stream = new TradeUpdateStream({ url: 'wss://paper-api.alpaca.markets/stream', backoffMs: [1_000],
      keys: async () => ({ keyId: keyId ?? '', secret: secret ?? '' }),
      onEvent: (event) => { if (event.kind === 'update') updates.push(event.update) },
      onError: (error) => { streamErrors.push(error.message) } })
    stream.start()
    await sleep(3_000)
    const quote = await venue.latestQuote(btc)
    const clientOrderId = brandString<ClientOrderId>(`dsh-e2e-${String(Date.now())}`)
    const request = { symbol: btc, side: 'buy', qty: 0.0001, type: 'limit', limitPrice: Math.floor(quote.bid * 0.5),
      timeInForce: 'gtc', clientOrderId } as const
    const first = await venue.submitOrder(request)
    try {
      const again = await venue.submitOrder(request)
      expect(again.id).toBe(first.id)
      expect((await venue.openOrders()).some(o => o.id === first.id)).toBe(true)
    } finally {
      await venue.cancelOrder(first.id)
    }
    const events = (): string[] => updates.filter(u => u.order.clientOrderId === clientOrderId).map(u => u.event)
    for (let i = 0; i < 20 && !events().includes('canceled'); i++) await sleep(500)
    stream.stop()
    // stop() closes without reporting; a disconnect error means an outage, which is acceptable only if both events still arrived.
    expect(streamErrors.filter(message => message !== DISCONNECT)).toEqual([])
    expect(events()).toContain('new')
    expect(events()).toContain('canceled')
  }, 60_000)

  it('closes a position whose coins are held by a resting sell order', async () => {
    const venue = paperVenue()
    await venue.prepare()
    const holding = (await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD')
    const resting = (await venue.openOrders()).some(o => o.symbol.ticker === 'BTC/USD')
    if (holding || resting) {
      throw new Error('this paper account already holds BTC/USD or has open BTC/USD orders; use a clean paper account')
    }
    const stamp = String(Date.now())
    const quote = await venue.latestQuote(btc)
    let closed = false
    try {
      await venue.submitOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: Math.ceil(quote.ask * 1.02),
        timeInForce: 'ioc', clientOrderId: brandString<ClientOrderId>(`dsh-e2e-buy-${stamp}`) })
      let held = 0
      for (let i = 0; i < 20 && held === 0; i++) {
        await sleep(500)
        held = (await venue.positions()).find(p => p.symbol.ticker === 'BTC/USD')?.qty ?? 0
      }
      expect(held).toBeGreaterThan(0)
      await venue.submitOrder({ symbol: btc, side: 'sell', qty: held, type: 'limit', limitPrice: Math.ceil(quote.ask * 3),
        timeInForce: 'gtc', clientOrderId: brandString<ClientOrderId>(`dsh-e2e-rest-${stamp}`) })
      const closing = await venue.closePosition(btc)
      closed = true
      expect(closing.side).toBe('sell')
    } finally {
      if (!closed && (await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD')) await venue.closePosition(btc)
      for (const order of await venue.openOrders()) if (order.symbol.ticker === 'BTC/USD') await venue.cancelOrder(order.id)
    }
  }, 120_000)
})
