/**
 * Opt-in Alpaca paper e2e. Runs only when ALPACA_API_KEY, ALPACA_SECRET_KEY, and DSH_ALPACA_PAPER_E2E=1 are all set;
 * the e2e config also loads the repository root `.env`, so keys placed there count. Effects on the paper account named
 * by ALPACA_API_KEY: sets no_shorting=true and max_margin_multiplier=1 (they stay set); places and cancels a
 * far-from-market BTC/USD limit order worth about $12; buys about $12 of BTC/USD (at least 0.0002 BTC) and closes the
 * whole BTC/USD position. Orders are sized above Alpaca's $10 crypto minimum order value. The second
 * test refuses to run if the account already holds BTC/USD or has open BTC/USD orders. Every order the tests place has
 * a client order id starting with a per-run prefix; cleanup cancels only open orders with that prefix and, in the
 * second test, closes any remaining BTC/USD position. Cleanup is best-effort: a failed run can leave a tiny BTC/USD
 * position or order. Tests are not retried.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientOrderId, OrderUpdate, PositionSnapshot } from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { INITIAL_SAFETY_STATE } from '../src/safety.ts'
import { TradeUpdateStream } from '../src/stream.ts'
import { orderedStore, VenueCore } from '../src/venue.ts'

const keyId = process.env.ALPACA_API_KEY
const secret = process.env.ALPACA_SECRET_KEY
const optedIn = keyId !== undefined && secret !== undefined && process.env.DSH_ALPACA_PAPER_E2E === '1'

/** The stream reports one of these per outage; the test tolerates it only alongside the events it asserts. */
const DISCONNECT = 'the order-update stream disconnected; reconnecting'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function paperVenue(): VenueCore {
  const http = new AlpacaHttp({ tradingUrl: 'https://paper-api.alpaca.markets', dataUrl: 'https://data.alpaca.markets',
    timeoutMs: 15_000, retryDelaysMs: [1_000, 2_000], keys: async () => ({ keyId: keyId ?? '', secret: secret ?? '' }) })
  return new VenueCore({ http, feed: 'iex', cryptoMinNotional: 10, now: () => Date.now(), keysPresent: async () => true,
    timing: { confirmDelayMs: 2_000, settleDelayMs: 500, settleChecks: 10, sleep },
    safetyTiming: { suspendRetryMs: [500, 1_000], sleep },
    store: orderedStore(INITIAL_SAFETY_STATE, async () => {}),
    stream: () => ({ start: () => {}, stop: () => {} }), emitStatus: () => {}, warn: () => {} })
}

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const

/** Order value the tests aim for, in dollars; above Alpaca's $10 crypto minimum with margin. */
const ORDER_DOLLARS = 12

/**
 * @param price - BTC price in dollars.
 * @returns the BTC quantity worth at least `ORDER_DOLLARS` at `price`, rounded up to 6 decimals.
 */
const btcWorth = (price: number): number => Math.ceil((ORDER_DOLLARS / price) * 1e6) / 1e6

/** @returns a client order id prefix unique to this run. */
const runPrefix = (): string => `dsh-e2e-${String(Date.now())}-`

/**
 * Cancel every open order whose client order id starts with `prefix`, including one whose submit outcome was unknown.
 * @param venue - the venue.
 * @param prefix - this run's client order id prefix.
 */
async function cancelOwnOrders(venue: VenueCore, prefix: string): Promise<void> {
  for (const order of await venue.openOrders()) if (order.clientOrderId.startsWith(prefix)) await venue.cancelOrder(order.id)
}

/**
 * Run `body`, then every cleanup step even when one throws. A body failure is rethrown with cleanup failures appended
 * to its message; when the body succeeds, cleanup failures are thrown together.
 * @param body - the test body.
 * @param cleanups - cleanup steps, in order.
 */
async function withCleanup(body: () => Promise<void>, cleanups: readonly (() => Promise<void>)[]): Promise<void> {
  let failure: unknown
  let failed = false
  try {
    await body()
  } catch (error) {
    failure = error
    failed = true
  }
  const cleanupErrors: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (failed) {
    if (cleanupErrors.length > 0 && failure instanceof Error) {
      failure.message += `\ncleanup also failed: ${cleanupErrors.map(e => (e instanceof Error ? e.message : String(e))).join('; ')}`
    }
    throw failure
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'paper e2e cleanup failed')
}

describe.skipIf(!optedIn)('Alpaca paper', { retry: 0 }, () => {
  it('sets account safety, reads the asset by its joined path, places a far limit order idempotently, sees it open, '
    + 'and cancels it', async () => {
    const prefix = runPrefix()
    const venue = paperVenue()
    await withCleanup(async () => {
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
      try {
        await sleep(3_000)
        const quote = await venue.latestQuote(btc)
        const clientOrderId = brandString<ClientOrderId>(`${prefix}far`)
        const limitPrice = Math.floor(quote.bid * 0.5)
        const request = { symbol: btc, side: 'buy', qty: btcWorth(limitPrice), type: 'limit', limitPrice,
          timeInForce: 'gtc', clientOrderId } as const
        const first = await venue.submitOrder(request)
        const again = await venue.submitOrder(request)
        expect(again.id).toBe(first.id)
        expect((await venue.openOrders()).some(o => o.id === first.id)).toBe(true)
        await venue.cancelOrder(first.id)
        const events = (): string[] => updates.filter(u => u.order.clientOrderId === clientOrderId).map(u => u.event)
        for (let i = 0; i < 20 && !events().includes('canceled'); i++) await sleep(500)
        // A disconnect error means an outage, which is acceptable only if both events still arrived.
        expect(streamErrors.filter(message => message !== DISCONNECT)).toEqual([])
        expect(events()).toContain('new')
        expect(events()).toContain('canceled')
      } finally {
        stream.stop()
      }
    }, [() => cancelOwnOrders(venue, prefix)])
  }, 60_000)

  it('closes a position whose coins are held by a resting sell order', async () => {
    const prefix = runPrefix()
    const venue = paperVenue()
    await venue.prepare()
    const holding = (await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD')
    const resting = (await venue.openOrders()).some(o => o.symbol.ticker === 'BTC/USD')
    if (holding || resting) {
      throw new Error('this paper account already holds BTC/USD or has open BTC/USD orders; use a clean paper account')
    }
    const btcPosition = async (): Promise<PositionSnapshot | undefined> =>
      (await venue.positions()).find(p => p.symbol.ticker === 'BTC/USD')
    const btcHeld = async (): Promise<number> => (await btcPosition())?.qty ?? 0
    await withCleanup(async () => {
      const quote = await venue.latestQuote(btc)
      await venue.submitOrder({ symbol: btc, side: 'buy', qty: Math.max(0.0002, btcWorth(quote.ask)), type: 'limit',
        limitPrice: Math.ceil(quote.ask * 1.02), timeInForce: 'ioc', clientOrderId: brandString<ClientOrderId>(`${prefix}buy`) })
      // Alpaca shows the filled position before its coins are sellable: qty_available stays 0 for a moment.
      let available = 0
      for (let i = 0; i < 30 && available <= 0; i++) {
        await sleep(500)
        available = (await btcPosition())?.qtyAvailable ?? 0
      }
      expect(available).toBeGreaterThan(0)
      await venue.submitOrder({ symbol: btc, side: 'sell', qty: available, type: 'limit', limitPrice: Math.ceil(quote.ask * 3),
        timeInForce: 'gtc', clientOrderId: brandString<ClientOrderId>(`${prefix}rest`) })
      const closing = await venue.closePosition(btc)
      expect(closing.side).toBe('sell')
      let remaining = await btcHeld()
      for (let i = 0; i < 20 && remaining !== 0; i++) {
        await sleep(500)
        remaining = await btcHeld()
      }
      expect(remaining).toBe(0)
    }, [
      () => cancelOwnOrders(venue, prefix),
      async () => { if (await btcHeld() !== 0) await venue.closePosition(btc) },
    ])
  }, 120_000)
})
