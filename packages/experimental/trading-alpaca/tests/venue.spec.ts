import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, BrokerOrderRequest, ClientOrderId, OrderStreamEvent, VenueStatus } from '@deepseek-ai/dsh-experimental-trading'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { INITIAL_SAFETY_STATE, type SafetyState, type SafetyStateStore } from '../src/safety.ts'
import { orderedStore, VenueCore } from '../src/venue.ts'
import { accountConfig, FakeAlpaca, type FakeAccountConfig } from './fake-alpaca.ts'

let fake: FakeAlpaca
let keysPresent: boolean
let saved: SafetyState
let statuses: [VenueStatus, string][]
let streams: { started: number; stopped: number }
const order = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTC/USD', asset_class: 'crypto', side: 'buy', type: 'market',
  time_in_force: 'gtc', qty: '0.015', filled_qty: '0', status: 'accepted' }
const request: BrokerOrderRequest = { symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market',
  timeInForce: 'gtc', clientOrderId: brandString<ClientOrderId>('c-1') }
const safe: FakeAccountConfig = { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false }

let warnings: string[]

function core(
  store: SafetyStateStore = { get: () => saved, set: async (state) => { saved = state } },
  keys: () => Promise<{ keyId: string; secret: string }> = async () => ({ keyId: 'k', secret: 's' }),
): {
  venue: VenueCore
  emit: (event: OrderStreamEvent) => void
  /** Each source's "I stopped myself" callback, in creation order. */
  stoppers: (() => void)[]
} {
  let deliver: (event: OrderStreamEvent) => void = () => {}
  const stoppers: (() => void)[] = []
  const http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [], keys })
  const venue = new VenueCore({
    http, feed: 'iex', cryptoMinNotional: 10, now: () => Date.UTC(2026, 9, 5),
    timing: { confirmDelayMs: 1, settleDelayMs: 1, settleChecks: 2, sleep: async () => {} },
    safetyTiming: { suspendRetryMs: [1], sleep: async () => {} },
    keysPresent: async () => keysPresent,
    store,
    stream: (onEvent, onStopped) => {
      deliver = onEvent
      stoppers.push(onStopped)
      return { start: () => { streams.started++ }, stop: () => { streams.stopped++ } }
    },
    emitStatus: (status, reason) => { statuses.push([status, reason]) },
    warn: (message) => { warnings.push(message) },
  })
  return { venue, emit: (event) => { deliver(event) }, stoppers }
}

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start()
  keysPresent = true; saved = INITIAL_SAFETY_STATE; statuses = []; streams = { started: 0, stopped: 0 }; warnings = []
  fake.on('POST', '/v2/orders', () => ({ status: 200, body: order }))
  fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 200, body: { ...order, side: 'sell' } }))
  fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
  fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [] }))
  fake.on('GET', '/v2/account', () => ({ status: 200, body: { equity: '10', cash: '5', last_equity: '9', buying_power: '5' } }))
})
afterEach(async () => { await fake.stop() })

describe('VenueCore readiness', () => {
  it('stays unconfigured without keys and retries setup once keys appear', async () => {
    accountConfig(fake, safe)
    keysPresent = false
    const { venue } = core()
    await expect(venue.account()).rejects.toMatchObject({ code: 'unconfigured', message: 'Alpaca keys not configured — add them in Settings → Trading' })
    expect(venue.status()).toBe('unconfigured')
    keysPresent = true
    expect((await venue.account()).equity).toBe(10)
    expect(venue.status()).toBe('ready')
    expect(statuses).toEqual([['ready', 'account safety settings verified']])
  })

  it('blocks new orders but allows reads and exits when the account cannot be made safe', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false } }))
    fake.on('PATCH', '/v2/account/configurations', () => ({ status: 200, body: { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false } }))
    const { venue } = core()
    await venue.prepare()
    expect(venue.status()).toBe('blocked')
    expect(venue.statusReason()).not.toBe('')
    expect((await venue.account()).equity).toBe(10)
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'blocked' })
    await expect(venue.resume()).rejects.toMatchObject({ code: 'blocked' })
    expect((await venue.closePosition(request.symbol)).side).toBe('sell')
    expect(await venue.flatten()).toEqual([])
  })

  it.each([
    [422, { code: 40310000, message: 'configuration not allowed' }, 'Alpaca rejected the request: configuration not allowed'],
    [401, { message: 'unauthorized' }, 'Alpaca rejected the API keys: unauthorized'],
  ])('blocks new orders but allows exits when Alpaca refuses the safety settings with %i', async (status, body, cause) => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false } }))
    fake.on('PATCH', '/v2/account/configurations', () => ({ status, body }))
    const { venue } = core()
    await venue.prepare()
    expect(venue.status()).toBe('blocked')
    expect(statuses).toEqual([['blocked', `Alpaca refused the safety settings; trading stays blocked (${cause})`]])
    expect((await venue.closePosition(request.symbol)).side).toBe('sell')
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'blocked' })
    expect(fake.requests.filter(r => r.method === 'POST')).toHaveLength(0)
  })

  it.each([[503, { message: 'busy' }], [429, { message: 'slow down' }]])(
    'leaves setup to retry when the safety-settings write fails with %i',
    async (status, body) => {
      fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false } }))
      fake.on('PATCH', '/v2/account/configurations', () => ({ status, body }))
      const { venue } = core()
      await expect(venue.prepare()).rejects.toMatchObject({ code: status === 429 ? 'rate-limited' : 'unavailable' })
      expect(venue.status()).toBe('unconfigured')
      accountConfig(fake, safe)
      await venue.prepare()
      expect(venue.status()).toBe('ready')
    },
  )

  it('rethrows setup failures other than blocked without changing status', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 503, body: { message: 'busy' } }))
    const { venue } = core()
    await expect(venue.prepare()).rejects.toMatchObject({ code: 'unavailable' })
    expect(venue.status()).toBe('unconfigured')
  })
})

describe('VenueCore orders and Halt', () => {
  it('submits when ready and refuses while halted, but still closes and flattens', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    expect((await venue.submitOrder(request)).id).toBe('o-1')
    await venue.halt('user halt')
    expect(venue.status()).toBe('halted')
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'halted', message: 'trading is halted' })
    expect((await venue.closePosition(request.symbol)).side).toBe('sell')
    expect(await venue.flatten()).toEqual([])
    expect(config.suspend_trade).toBe(true)
    await venue.resume()
    expect(venue.status()).toBe('ready')
    expect(statuses.map(s => s[0])).toEqual(['ready', 'halted', 'ready'])
  })

  it('sends no order when Halt arrives while the keys for its POST are still resolving', async () => {
    const config = accountConfig(fake, safe)
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let holdNext = false
    const { venue } = core(undefined, async () => {
      if (holdNext) { holdNext = false; reached.resolve(undefined); await release.promise }
      return { keyId: 'k', secret: 's' }
    })
    await venue.prepare()
    holdNext = true
    const submitting = venue.submitOrder(request)
    await reached.promise
    await venue.halt('user halt')
    release.resolve(undefined)
    await expect(submitting).rejects.toMatchObject({ code: 'halted', message: 'trading is halted' })
    expect(fake.requests.filter(r => r.method === 'POST')).toHaveLength(0)
    expect(config.suspend_trade).toBe(true)
  })

  it('halts the desk even when Alpaca cannot confirm the suspension, or without keys', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    await venue.prepare()
    fake.on('PATCH', '/v2/account/configurations', request => (
      (request.body as { suspend_trade?: boolean }).suspend_trade === true
        ? { status: 503, body: { message: 'busy' } }
        : (Object.assign(config, request.body), { status: 200, body: { ...config } })))
    await venue.halt('user halt')
    expect(venue.status()).toBe('halted')
    expect(saved.suspendPending).toBe(true)
    expect(statuses.slice(-2)).toEqual([
      ['halted', 'user halt'], ['halted', 'user halt; the Alpaca suspension is pending and will be retried'],
    ])
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'halted' })
    keysPresent = false
    const keyless = core()
    await keyless.venue.halt('user halt')
    expect(keyless.venue.status()).toBe('halted')
  })

  it('stays halted when Halt is clicked while startup setup is still running', async () => {
    const config = accountConfig(fake, safe)
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config }, delayMs: 40 }))
    const { venue } = core()
    const setup = venue.prepare()
    await new Promise(resolve => setTimeout(resolve, 10))
    const halting = venue.halt('user halt')
    await setup
    await halting
    expect(venue.status()).toBe('halted')
    expect(statuses.at(-1)?.[0]).toBe('halted')
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'halted' })
  })

  it('stays halted when Halt is clicked right after Resume', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    await venue.halt('first')
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config }, delayMs: 30 }))
    const resuming = venue.resume()
    const halting = venue.halt('second')
    await resuming
    await halting
    expect(venue.status()).toBe('halted')
    expect(statuses.at(-1)?.[0]).toBe('halted')
    expect(config.suspend_trade).toBe(true)
  })

  it('publishes the Halt and rethrows when saving it fails', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core(orderedStore(INITIAL_SAFETY_STATE, async () => { throw new Error('disk full') }))
    await expect(venue.halt('user halt')).rejects.toThrow('disk full')
    expect(venue.status()).toBe('halted')
    expect(statuses).toEqual([
      ['halted', 'user halt'], ['halted', 'user halt; saving the Halt failed and it may not survive a restart: disk full'],
    ])
    expect(config.suspend_trade).toBe(true)
    // Setup also fails to save, so the order is refused before the Halt gate.
    await expect(venue.submitOrder(request)).rejects.toThrow('disk full')
    expect(fake.requests.filter(r => r.method === 'POST')).toHaveLength(0)
  })

  it('starts halted from saved state', async () => {
    accountConfig(fake, safe)
    saved = { halted: true, haltReason: 'user halt', flattenWindowOpen: false, suspendPending: false }
    const { venue } = core()
    await venue.prepare()
    expect(venue.status()).toBe('halted')
    expect(statuses).toEqual([['halted', 'user halt']])
  })

  it('halts on drift and reports the changed settings', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    await venue.prepare()
    expect(await venue.checkDrift()).toBeUndefined()
    config.max_margin_multiplier = '2'
    expect(await venue.checkDrift()).toBe('account settings changed at Alpaca: max_margin_multiplier')
    expect(venue.status()).toBe('halted')
  })

  it('skips the drift check until the venue is set up', async () => {
    keysPresent = false
    const { venue } = core()
    expect(await venue.checkDrift()).toBeUndefined()
    expect(fake.requests).toHaveLength(0)
  })
})

describe('VenueCore drift watch', () => {
  it('halts on drift between ticks, never overlaps a slow check, and logs failures', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    await venue.prepare()
    const warnings: string[] = []
    config.no_shorting = false
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config }, delayMs: 30 }))
    const stop = venue.watchDrift(5, (message) => { warnings.push(message) })
    for (let i = 0; i < 100 && venue.status() !== 'halted'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(venue.status()).toBe('halted')
    const configReads = fake.requests.filter(r => r.method === 'GET' && r.path === '/v2/account/configurations').length
    expect(configReads).toBeLessThanOrEqual(3)
    fake.on('GET', '/v2/account/configurations', () => ({ status: 503, body: { message: 'busy' } }))
    for (let i = 0; i < 100 && warnings.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(warnings[0]).toMatch(/^drift check failed: Alpaca is unavailable/)
    stop()
  })
})

describe('VenueCore order updates', () => {
  it('streams only while someone listens', async () => {
    accountConfig(fake, safe)
    const { venue, emit } = core()
    const seen: string[] = []
    const label = (event: OrderStreamEvent): string => (event.kind === 'update' ? event.update.event : `gap ${event.reason}`)
    const off1 = venue.subscribeOrderUpdates((event) => { seen.push(`a:${label(event)}`) })
    const off2 = venue.subscribeOrderUpdates((event) => { seen.push(`b:${label(event)}`) })
    expect(streams).toEqual({ started: 1, stopped: 0 })
    emit({ kind: 'update', update: { event: 'fill', order: { id: 'o-1' } as never, t: 0 } })
    emit({ kind: 'gap', reason: 'reconnected' })
    off1()
    expect(streams.stopped).toBe(0)
    off2()
    off2()
    expect(streams).toEqual({ started: 1, stopped: 1 })
    expect(seen).toEqual(['a:fill', 'b:fill', 'a:gap reconnected', 'b:gap reconnected'])
  })
})

describe('VenueCore order-update fan-out and restart', () => {
  it('delivers every update and gap to later listeners when an earlier listener throws, and reports the failure', () => {
    const { venue, emit } = core()
    const seen: string[] = []
    venue.subscribeOrderUpdates(() => { throw new Error('listener broke') })
    venue.subscribeOrderUpdates((event) => { seen.push(event.kind) })
    emit({ kind: 'update', update: { event: 'fill', order: { id: 'o-1' } as never, t: 0 } })
    emit({ kind: 'gap', reason: 'reconnected' })
    expect(seen).toEqual(['update', 'gap'])
    expect(warnings).toEqual([
      'an order-update listener failed: listener broke', 'an order-update listener failed: listener broke',
    ])
  })

  it('starts a new stream on the next subscribe after the stream stopped itself', () => {
    const { venue, stoppers } = core()
    venue.subscribeOrderUpdates(() => {})
    stoppers[0]?.()
    venue.subscribeOrderUpdates(() => {})
    expect(streams).toEqual({ started: 2, stopped: 0 })
    // A late stop report from the first source does not drop the running one.
    stoppers[0]?.()
    venue.subscribeOrderUpdates(() => {})
    expect(streams).toEqual({ started: 2, stopped: 0 })
  })

  it('restarts a self-stopped stream while listeners remain, and otherwise does nothing', () => {
    const { venue, stoppers } = core()
    venue.restartStream()
    expect(streams.started).toBe(0)
    const off = venue.subscribeOrderUpdates(() => {})
    venue.restartStream()
    expect(streams).toEqual({ started: 1, stopped: 0 })
    stoppers[0]?.()
    venue.restartStream()
    expect(streams).toEqual({ started: 2, stopped: 0 })
    off()
    expect(streams).toEqual({ started: 2, stopped: 1 })
    stoppers[1]?.()
    venue.restartStream()
    expect(streams.started).toBe(2)
  })
})

describe('VenueCore close', () => {
  it('stops the stream and drops listeners', () => {
    const { venue, emit } = core()
    const seen: OrderStreamEvent[] = []
    venue.subscribeOrderUpdates((event) => { seen.push(event) })
    venue.close()
    emit({ kind: 'gap', reason: 'late' })
    venue.close()
    expect(streams).toEqual({ started: 1, stopped: 1 })
    expect(seen).toEqual([])
  })
})

describe('orderedStore', () => {
  const halted: SafetyState = { ...INITIAL_SAFETY_STATE, halted: true, haltReason: 'h' }
  const pending: SafetyState = { ...halted, suspendPending: true }

  it('serves the latest set value at once and persists in call order', async () => {
    const writes: SafetyState[] = []
    const releases: (() => void)[] = []
    const store = orderedStore(INITIAL_SAFETY_STATE, state => new Promise<void>((resolve) => {
      writes.push(state); releases.push(resolve)
    }))
    expect(store.get()).toBe(INITIAL_SAFETY_STATE)
    const first = store.set(halted)
    expect(store.get()).toBe(halted)
    const second = store.set(pending)
    expect(store.get()).toBe(pending)
    await Promise.resolve()
    expect(writes).toEqual([halted])
    releases[0]?.()
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual([halted, pending])
    releases[1]?.()
    await second
  })

  it('flushes: resolves once every pending persist settled, failed ones included', async () => {
    const releases: { resolve: () => void; reject: (error: Error) => void }[] = []
    const store = orderedStore(INITIAL_SAFETY_STATE, state => new Promise<void>((resolve, reject) => {
      void state
      releases.push({ resolve, reject })
    }))
    await store.flush()
    const first = store.set(halted)
    const firstFailed = expect(first).rejects.toThrow('disk full')
    const second = store.set(pending)
    let flushed = false
    const flushing = store.flush().then(() => { flushed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
    releases[0]?.reject(new Error('disk full'))
    await firstFailed
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
    releases[1]?.resolve()
    await second
    await flushing
    expect(flushed).toBe(true)
  })

  it('keeps writing after a failed write and rejects only that write', async () => {
    const writes: SafetyState[] = []
    const store = orderedStore(INITIAL_SAFETY_STATE, async (state) => {
      writes.push(state)
      if (state === halted) throw new Error('disk full')
    })
    const first = store.set(halted)
    const second = store.set(pending)
    await expect(first).rejects.toThrow('disk full')
    await expect(second).resolves.toBeUndefined()
    expect(writes).toEqual([halted, pending])
    expect(store.get()).toBe(pending)
  })
})

describe('VenueCore reads', () => {
  it('delegates reads to the REST units with the configured feed and clock', async () => {
    accountConfig(fake, safe)
    fake.on('GET', '/v2/positions', () => ({ status: 200, body: [] }))
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
    fake.on('GET', '/v2/clock', () => ({ status: 200, body: { is_open: true } }))
    fake.on('GET', '/v2/stocks/quotes/latest', () => ({ status: 200, body: { quotes: { AAPL: { t: '2026-10-05T14:00:00Z', bp: 1, ap: 2 } } } }))
    fake.on('GET', '/v2/stocks/bars', () => ({ status: 200, body: { bars: {}, next_page_token: null } }))
    fake.on('GET', '/v2/assets/AAPL', () => ({ status: 200, body: { symbol: 'AAPL', class: 'us_equity', status: 'active', tradable: true, fractionable: true } }))
    fake.on('GET', '/v2/assets/BTCUSD', () => ({ status: 200, body: { symbol: 'BTC/USD', class: 'crypto', status: 'active',
      tradable: true, fractionable: true, price_increment: '0.01' } }))
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    const { venue } = core()
    const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
    expect(await venue.positions()).toEqual([])
    expect(await venue.openOrders()).toEqual([])
    expect(await venue.marketOpen(aapl)).toBe(true)
    expect((await venue.latestQuote(aapl)).ask).toBe(2)
    expect(await venue.bars(aapl, '1D', { limit: 5 })).toEqual([])
    expect((await venue.asset(aapl)).tradable).toBe(true)
    expect((await venue.asset(request.symbol)).minNotional).toBe(10)
    await venue.cancelOrder(brandString<BrokerOrderId>('o-1'))
    expect(fake.requests.find(r => r.path === '/v2/stocks/bars')?.query.get('end')).toBe('2026-10-05T00:00:00.000Z')
  })

  it('looks up an order by client order id and reports none for an unknown id', async () => {
    accountConfig(fake, safe)
    fake.on('GET', '/v2/orders:by_client_order_id', r => r.query.get('client_order_id') === 'c-1'
      ? { status: 200, body: order }
      : { status: 404, body: { message: 'order not found' } })
    const { venue } = core()
    expect((await venue.order(brandString<ClientOrderId>('c-1')))?.id).toBe('o-1')
    expect(await venue.order(brandString<ClientOrderId>('c-2'))).toBeUndefined()
  })

  it('names the reason behind the status', async () => {
    accountConfig(fake, safe)
    keysPresent = false
    const { venue } = core()
    expect(venue.statusReason()).toBe('Alpaca keys not configured — add them in Settings → Trading')
    keysPresent = true
    await venue.prepare()
    expect(venue.statusReason()).toBe('')
    await venue.halt('market looks wrong')
    expect(venue.statusReason()).toBe('market looks wrong')
  })
})
