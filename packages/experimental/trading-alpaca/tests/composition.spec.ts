/**
 * Real-composition and HMR guard: the storage stack, a credentials provider (or only the launch environment), and
 * `trading-alpaca` boot from a test-only cordis.yml through the actual Loader + Include path against a fake Alpaca.
 * Disposing the fiber removes `ctx.tradingVenue`; booting again over the same storage folder restores the Halt.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { BrokerOrderId, BrokerOrderRequest, ClientOrderId, OrderStreamEvent, VenueStatus } from '@deepseek-ai/dsh-experimental-trading'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import * as TradingAlpaca from '../src/index.ts'
import { accountConfig, FakeAlpaca, type FakeAccountConfig } from './fake-alpaca.ts'

const KEYS = { ALPACA_API_KEY: 'k', ALPACA_SECRET_KEY: 's' }
const order = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTC/USD', asset_class: 'crypto', side: 'buy', type: 'market',
  time_in_force: 'gtc', qty: '0.015', filled_qty: '0', status: 'accepted' }
const request: BrokerOrderRequest = { symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market',
  timeInForce: 'gtc', clientOrderId: brandString<ClientOrderId>('c-1') }

let root: string
let fake: FakeAlpaca
let config: FakeAccountConfig
let streamServer: WebSocketServer
let streamUrl: string
let contexts: Context[]
let statuses: [VenueStatus, string][]
let streamAuthorized: boolean

interface BootOptions {
  /** Where the keys come from; `none` boots without keys. */
  readonly keys: 'credentials' | 'environment' | 'none'
  /** Whether cordis.yml mounts the venue; false leaves only the storage stack (and credentials). */
  readonly venue?: boolean
}

async function boot(options: BootOptions): Promise<Context> {
  const credentialsPath = join(root, '.credentials.yaml')
  if (options.keys === 'credentials') {
    await writeFile(credentialsPath, 'version: 1\nrefs:\n  ALPACA_API_KEY: k\n  ALPACA_SECRET_KEY: s\n', { mode: 0o600 })
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    ...options.keys === 'credentials'
      ? [
        "- name: '@deepseek-ai/dsh-credentials-local'",
        '  config:',
        `    path: ${JSON.stringify(credentialsPath)}`,
        '    debounceMs: 10',
      ]
      : [],
    ...options.venue === false
      ? []
      : [
        "- name: '@deepseek-ai/dsh-experimental-trading-alpaca'",
        '  config:',
        ...Object.entries(venueConfig()).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
      ],
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: options.keys === 'environment' ? KEYS : {} },
  ]))
  ctx.on('trading/venue-status', (status, reason) => { statuses.push([status, reason]) })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-experimental-trading-alpaca', TradingAlpaca],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

const venueConfig = (): Record<string, unknown> => ({
  tradingUrl: fake.url, dataUrl: fake.url, tradeStreamUrl: streamUrl, suspendRetryMs: [1], streamBackoffMs: [5], lookupConfirmMs: 0,
  closeSettleMs: 0,
})

const venueOf = (ctx: Context): TradingAlpaca.AlpacaVenue => {
  const venue = ctx.get('tradingVenue')
  expect(venue).toBeInstanceOf(TradingAlpaca.AlpacaVenue)
  return venue as TradingAlpaca.AlpacaVenue
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-trading-alpaca-composition-'))
  await mkdir(join(root, 'storages'))
  contexts = []; statuses = []; streamAuthorized = true
  fake = new FakeAlpaca(); await fake.start()
  config = accountConfig(fake, { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false })
  fake.on('GET', '/v2/account', () => ({ status: 200, body: { equity: '10', cash: '5', last_equity: '9', buying_power: '5' } }))
  streamServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  streamServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse((raw as Buffer).toString()) as { action: string }
      const status = streamAuthorized ? 'authorized' : 'unauthorized'
      if (message.action === 'auth') socket.send(JSON.stringify({ stream: 'authorization', data: { status } }))
      if (message.action === 'listen') {
        socket.send(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }))
        socket.send(Buffer.from(JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', timestamp: '2026-10-05T14:00:00Z',
          order: { ...order, filled_qty: '0.015', filled_avg_price: '62831.5', status: 'filled' } } })))
      }
    })
  })
  await new Promise<void>((resolve) => { streamServer.on('listening', () => { resolve() }) })
  const address = streamServer.address()
  streamUrl = `ws://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
})

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  for (const client of streamServer.clients) client.terminate()
  await new Promise<void>((resolve) => { streamServer.close(() => { resolve() }) })
  await fake.stop()
  await rm(root, { recursive: true, force: true })
})

describe('trading-alpaca real composition', () => {
  it('applies the safety settings, serves every operation, and keeps a Halt across disposal and reboot', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: order }))
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
    fake.on('GET', '/v2/positions', () => ({ status: 200, body: [] }))
    fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [] }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 200, body: { ...order, side: 'sell' } }))
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    fake.on('GET', '/v2/clock', () => ({ status: 200, body: { is_open: true } }))
    fake.on('GET', '/v2/stocks/quotes/latest', () => ({ status: 200, body: { quotes: { AAPL: { t: '2026-10-05T14:00:00Z', bp: 1, ap: 2 } } } }))
    fake.on('GET', '/v2/stocks/bars', () => ({ status: 200, body: { bars: {}, next_page_token: null } }))
    fake.on('GET', '/v2/assets/AAPL', () => ({ status: 200,
      body: { symbol: 'AAPL', class: 'us_equity', status: 'active', tradable: true, fractionable: true } }))
    const ctx = await boot({ keys: 'credentials' })
    const venue = venueOf(ctx)
    // The credentials provider may start after the venue; the venue sets up once it appears.
    await vi.waitFor(() => { expect(venue.status()).toBe('ready') })
    expect(config).toMatchObject({ no_shorting: true, max_margin_multiplier: '1' })
    expect(statuses).toEqual([['ready', 'account safety settings verified']])
    expect(fake.requests.every(r => r.keyId === 'k')).toBe(true)

    const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
    expect((await venue.account()).equity).toBe(10)
    expect(await venue.positions()).toEqual([])
    expect(await venue.openOrders()).toEqual([])
    expect((await venue.asset(aapl)).tradable).toBe(true)
    expect(await venue.marketOpen(aapl)).toBe(true)
    expect((await venue.latestQuote(aapl)).ask).toBe(2)
    expect(await venue.bars(aapl, '1D', { limit: 5 })).toEqual([])
    expect((await venue.submitOrder(request)).id).toBe('o-1')
    await venue.cancelOrder(brandString<BrokerOrderId>('o-1'))
    expect((await venue.closePosition(request.symbol)).side).toBe('sell')
    expect(await venue.flatten()).toEqual([])

    const events: OrderStreamEvent[] = []
    const off = venue.subscribeOrderUpdates((event) => { events.push(event) })
    for (let i = 0; i < 200 && events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    off()
    expect(events[0]).toMatchObject({ kind: 'update', update: { event: 'fill', order: { id: 'o-1' } } })

    await venue.halt('test halt')
    expect(venue.status()).toBe('halted')
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'halted' })
    await venue.resume()
    expect(venue.status()).toBe('ready')
    await venue.halt('test halt')
    expect(config.suspend_trade).toBe(true)

    // HMR: dispose the loaded fiber; the service is gone.
    await ctx.fiber.dispose()
    expect(ctx.get('tradingVenue')).toBeUndefined()

    // Boot the same composition again against the same storage folder: the saved Halt wins.
    statuses = []
    const ctx2 = await boot({ keys: 'credentials' })
    expect(ctx2.get('tradingVenue')?.status()).toBe('halted')
    await vi.waitFor(() => { expect(statuses).toEqual([['halted', 'test halt']]) })
  })

  it('restarts the order-update stream when the keys change after Alpaca rejected them', async () => {
    const ctx = await boot({ keys: 'credentials' })
    const venue = venueOf(ctx)
    await vi.waitFor(() => { expect(venue.status()).toBe('ready') })
    streamAuthorized = false
    const events: OrderStreamEvent[] = []
    const off = venue.subscribeOrderUpdates((event) => { events.push(event) })
    await vi.waitFor(() => { expect(events).toEqual([{ kind: 'gap', reason: 'the order-update stream stopped: Alpaca rejected the API keys' }]) })
    streamAuthorized = true
    await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  ALPACA_API_KEY: k\n  ALPACA_SECRET_KEY: s2\n', { mode: 0o600 })
    await vi.waitFor(() => { expect(events[1]).toMatchObject({ kind: 'update', update: { event: 'fill' } }) })
    off()
  })

  it('keeps a Halt clicked immediately before the venue plugin reloads', async () => {
    const ctx = await boot({ keys: 'environment', venue: false })
    const plugin = ctx.plugin(TradingAlpaca.AlpacaVenue, venueConfig())
    await vi.waitFor(() => { expect(ctx.get('tradingVenue')?.status()).toBe('ready') })
    const venue = venueOf(ctx)
    // Two Halts queue two writes, then the venue plugin alone reloads (HMR) while the storage stack stays up.
    const halting = [venue.halt('first halt'), venue.halt('last-moment halt')].map(async p => p.catch((error: unknown) => error))
    await plugin.dispose()
    expect(ctx.get('tradingVenue')).toBeUndefined()
    await Promise.all(halting)
    await ctx.fiber.dispose()
    statuses = []
    const ctx2 = await boot({ keys: 'environment' })
    expect(ctx2.get('tradingVenue')?.status()).toBe('halted')
    expect(statuses).toEqual([['halted', 'last-moment halt']])
  })

  it('resolves keys from the launch environment when no credentials provider is mounted', async () => {
    const ctx = await boot({ keys: 'environment' })
    expect(venueOf(ctx).status()).toBe('ready')
    expect(fake.requests.every(r => r.keyId === 'k')).toBe(true)
  })

  it('stays unconfigured without keys, still halts, and reports the stream failure', async () => {
    const ctx = await boot({ keys: 'none' })
    const venue = venueOf(ctx)
    expect(venue.status()).toBe('unconfigured')
    await expect(venue.account()).rejects.toMatchObject({ code: 'unconfigured' })
    const events: OrderStreamEvent[] = []
    const off = venue.subscribeOrderUpdates((event) => { events.push(event) })
    await venue.halt('user halt')
    expect(venue.status()).toBe('halted')
    expect(statuses.at(-1)).toEqual(['halted', 'user halt; the Alpaca suspension is pending and will be retried'])
    expect(fake.requests).toHaveLength(0)
    off()
    expect(events).toEqual([])
  })

  it('defers setup when Alpaca is unavailable at boot and retries on the next operation', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 503, body: { message: 'busy' } }))
    const ctx = await boot({ keys: 'environment' })
    const venue = venueOf(ctx)
    expect(venue.status()).toBe('unconfigured')
    config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    expect((await venue.account()).equity).toBe(10)
    expect(venue.status()).toBe('ready')
  })
})
