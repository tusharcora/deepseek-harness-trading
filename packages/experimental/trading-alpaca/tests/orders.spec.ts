import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, BrokerOrderRequest, ClientOrderId } from '@deepseek-ai/dsh-experimental-trading'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import {
  account, cancelOrder, closePosition, flatten, openOrders, orderByClientId, positions, submitOrder, type OrderTiming,
} from '../src/orders.ts'
import { FakeAlpaca } from './fake-alpaca.ts'

let fake: FakeAlpaca
let http: AlpacaHttp
let waits: number[]
const timing = (): OrderTiming => ({ confirmDelayMs: 50, settleDelayMs: 7, settleChecks: 3, sleep: async (ms) => { waits.push(ms) } })
const clientOrderId = brandString<ClientOrderId>('c-1')
const request: BrokerOrderRequest = {
  symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'limit', limitPrice: 63_460.32,
  timeInForce: 'ioc', clientOrderId,
}
const placed = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTC/USD', asset_class: 'crypto', side: 'buy', type: 'limit',
  time_in_force: 'ioc', qty: '0.015', limit_price: '63460.32', filled_qty: '0', status: 'accepted' }
const lookups = (): number => fake.requests.filter(r => r.path === '/v2/orders:by_client_order_id').length

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start(); waits = []
  http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [],
    keys: async () => ({ keyId: 'k', secret: 's' }) })
})
afterEach(async () => { await fake.stop() })

describe('submitOrder', () => {
  it('sends Alpaca decimal strings and the client order id', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, { ...request, qty: 9.5e-7 }, timing())).id).toBe('o-1')
    expect(fake.requests[0]?.body).toEqual({ symbol: 'BTC/USD', side: 'buy', type: 'limit', time_in_force: 'ioc',
      client_order_id: 'c-1', qty: '0.00000095', limit_price: '63460.32' })
  })

  it('sends notional, stop, and bracket fields when present', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: placed }))
    await submitOrder(http, { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', notional: 100, type: 'market',
      timeInForce: 'day',
      clientOrderId }, timing())
    await submitOrder(http, { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', qty: 2, type: 'stop_limit', limitPrice: 232,
      stopPrice: 231, timeInForce: 'gtc', bracket: { takeProfit: 250, stopLoss: 220 }, clientOrderId }, timing())
    expect(fake.requests[0]?.body).toMatchObject({ notional: '100' })
    expect(fake.requests[1]?.body).toMatchObject({ stop_price: '231', order_class: 'bracket',
      take_profit: { limit_price: '250' }, stop_loss: { stop_price: '220' } })
  })

  it('returns the existing order for a duplicate client order id, and reports an unknown outcome when two lookups find none', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 40010001, message: 'client_order_id must be unique' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request, timing())).id).toBe('o-1')
    expect(fake.requests[1]?.query.get('client_order_id')).toBe('c-1')
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({
      code: 'unknown-outcome', message: expect.stringContaining('c-1') as unknown,
    })
    expect(lookups()).toBe(3)
    expect(waits).toEqual([50])
  })

  it('finds a duplicate client order id on the delayed second lookup', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 40010001, message: 'client_order_id must be unique' } }))
    let seen = 0
    fake.on('GET', '/v2/orders:by_client_order_id', () => (++seen < 2
      ? { status: 404, body: { message: 'order not found' } }
      : { status: 200, body: placed }))
    expect((await submitOrder(http, request, timing())).id).toBe('o-1')
    expect(waits).toEqual([50])
  })

  it('recognizes the duplicate client order id that Alpaca reports with its generic validation code', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 42210000, message: 'client_order_id must be unique' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request, timing())).id).toBe('o-1')
    expect(lookups()).toBe(1)
  })

  it('reports an unknown outcome when the generic-code duplicate is not found by two lookups', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 42210000, message: 'Client_Order_ID must be unique' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({
      code: 'unknown-outcome', message: expect.stringContaining('c-1') as unknown,
    })
    expect(lookups()).toBe(2)
    expect(waits).toEqual([50])
  })

  it('passes another generic validation rejection through without a lookup', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 42210000, message: 'sub-penny increment does not fulfill' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'rejected', brokerCode: 42210000 })
    expect(lookups()).toBe(0)
  })

  it('finds an order that appears only on the delayed second lookup', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    let seen = 0
    fake.on('GET', '/v2/orders:by_client_order_id', () => (++seen < 2
      ? { status: 404, body: { message: 'order not found' } }
      : { status: 200, body: placed }))
    expect((await submitOrder(http, request, timing())).id).toBe('o-1')
    expect(waits).toEqual([50])
  })

  it('reports not placed only after two lookups find nothing', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({
      code: 'unavailable', message: 'Alpaca is unavailable; the order was not placed',
    })
    expect(lookups()).toBe(2)
  })

  it('treats a connection dropped mid-response as unavailable and looks the order up', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: { ...placed, padding: 'x'.repeat(200) }, truncate: true }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request, timing())).id).toBe('o-1')
  })

  it('treats an accepted but unreadable response as an unknown outcome unless a lookup finds the order', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: { id: 'o-1' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request, timing())).id).toBe('o-1')
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'unknown-outcome' })
  })

  it('treats an accepted order carrying another client order id as unreadable and confirms by lookup', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: { ...placed, id: 'o-9', client_order_id: 'someone-else' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    const found = await submitOrder(http, request, timing())
    expect(found.id).toBe('o-1')
    expect(found.clientOrderId).toBe('c-1')
    expect(lookups()).toBe(1)
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'unknown-outcome' })
    expect(lookups()).toBe(3)
    expect(fake.requests.at(-1)?.query.get('client_order_id')).toBe('c-1')
  })

  it('reports an unknown outcome, never not placed, for a 2xx dropped mid-body that no lookup finds', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: { ...placed, padding: 'x'.repeat(200) }, truncate: true }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'unknown-outcome' })
    expect(lookups()).toBe(2)
    expect(waits).toEqual([50])
  })

  it('reports an unknown outcome, never not placed, for an unparseable 2xx that no lookup finds', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, rawBody: '<html>' }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'unknown-outcome' })
    expect(lookups()).toBe(2)
  })

  it('reports an unknown outcome when the lookup also fails', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 503, body: { message: 'busy' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'unknown-outcome' })
  })

  it('passes other rejections through without a lookup', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 403, body: { code: 40310000, message: 'insufficient buying power' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'rejected', brokerCode: 40310000 })
    expect(fake.requests).toHaveLength(1)
  })

  it('passes a key-lookup failure through untouched, because nothing was sent', async () => {
    const locked = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [],
      keys: async () => { throw new Error('vault locked') } })
    await expect(submitOrder(locked, request, timing())).rejects.toThrow('vault locked')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('orderByClientId', () => {
  it('returns undefined when Alpaca has no such order', async () => {
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    expect(await orderByClientId(http, clientOrderId)).toBeUndefined()
    expect(lookups()).toBe(1)
  })

  it('refuses an order that carries another client order id', async () => {
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: { ...placed, id: 'o-9', client_order_id: 'c-9' } }))
    await expect(orderByClientId(http, clientOrderId)).rejects.toMatchObject({
      code: 'unknown-outcome', message: 'Alpaca returned order o-9 for client order id c-1',
    })
  })

  it('makes submission report an unknown outcome when the lookup returns another order', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: { ...placed, id: 'o-9', client_order_id: 'c-9' } }))
    await expect(submitOrder(http, request, timing())).rejects.toMatchObject({ code: 'unknown-outcome' })
    expect(lookups()).toBe(1)
  })
})

describe('reads', () => {
  it('maps the account, positions, and open orders', async () => {
    fake.on('GET', '/v2/account', () => ({ status: 200, body: { equity: '10', cash: '5', last_equity: '9', buying_power: '5' } }))
    fake.on('GET', '/v2/positions', () => ({ status: 200, body: [{ symbol: 'AAPL', asset_class: 'us_equity', side: 'long', qty: '2',
      qty_available: '2', avg_entry_price: '1', current_price: '2', market_value: '4', unrealized_pl: '2' }] }))
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [placed] }))
    expect((await account(http)).equity).toBe(10)
    expect((await positions(http))[0]?.qty).toBe(2)
    expect((await openOrders(http))[0]?.status).toBe('open')
    expect(fake.requests[2]?.query.get('status')).toBe('open')
    expect(fake.requests[2]?.query.get('limit')).toBe('500')
    expect(fake.requests[2]?.query.get('symbols')).toBeNull()
    await openOrders(http, { assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(fake.requests[3]?.query.get('symbols')).toBe('BTCUSD')
  })
})

describe('cancel, close, flatten', () => {
  it('cancels one order', async () => {
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    await cancelOrder(http, brandString<BrokerOrderId>('o-1'))
    expect(fake.requests[0]?.method).toBe('DELETE')
  })

  it('cancels the symbol\'s resting orders and waits for them to clear before closing', async () => {
    let open = [placed]
    let polls = 0
    fake.on('GET', '/v2/orders', () => { if (++polls >= 3) open = []; return { status: 200, body: open } })
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 200, body: { ...placed, side: 'sell', type: 'market' } }))
    expect((await closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())).side).toBe('sell')
    expect(fake.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /v2/orders', 'DELETE /v2/orders/o-1', 'GET /v2/orders', 'GET /v2/orders', 'DELETE /v2/positions/BTCUSD',
    ])
    expect(waits).toEqual([7, 7])
  })

  it('still closes when cancelling one bracket leg already cancelled the other', async () => {
    const legs = [placed, { ...placed, id: 'o-2', client_order_id: 'c-2' }]
    let polls = 0
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: ++polls === 1 ? legs : [] }))
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    fake.on('DELETE', '/v2/orders/o-2', () => ({ status: 422, body: { message: 'order is not cancelable' } }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 200, body: { ...placed, side: 'sell' } }))
    expect((await closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())).side).toBe('sell')
    expect(fake.requests.filter(r => r.method === 'DELETE').map(r => r.path)).toEqual([
      '/v2/orders/o-1', '/v2/orders/o-2', '/v2/positions/BTCUSD',
    ])
  })

  it('closes after the settle checks run out, and closes at once when nothing rests', async () => {
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [placed] }))
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 200, body: { ...placed, side: 'sell' } }))
    await closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())
    expect(waits).toEqual([7, 7, 7])
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
    waits = []
    await closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())
    expect(waits).toEqual([])
  })

  const insufficient = { status: 403, body: { code: 40310000, message: 'insufficient balance for BTC (requested: 0.0002, available: 0)' } }
  const closes = (): number => fake.requests.filter(r => r.method === 'DELETE' && r.path === '/v2/positions/BTCUSD').length

  it('retries the close while Alpaca releases coins held by the cancelled orders', async () => {
    let polls = 0
    let attempts = 0
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: ++polls === 1 ? [placed] : [] }))
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => (++attempts <= 2 ? insufficient
      : { status: 200, body: { ...placed, side: 'sell', type: 'market' } }))
    expect((await closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())).side).toBe('sell')
    expect(closes()).toBe(3)
    expect(waits).toEqual([7, 7, 7])
  })

  it('rethrows the insufficient balance after the settle checks run out', async () => {
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => insufficient)
    const closing = closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())
    await expect(closing).rejects.toMatchObject({ code: 'rejected' })
    await expect(closing).rejects.toThrow(/insufficient balance for BTC/)
    expect(closes()).toBe(4)
    expect(waits).toEqual([7, 7, 7])
  })

  it('does not retry any other close failure', async () => {
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
    fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 422, body: { message: 'position does not exist' } }))
    await expect(closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())).rejects.toMatchObject({ code: 'rejected' })
    fake.on('DELETE', '/v2/positions/BTCUSD', () => ({ status: 404, body: { message: 'insufficient qty available' } }))
    await expect(closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' }, timing())).rejects.toMatchObject({ code: 'not-found' })
    expect(closes()).toBe(2)
    expect(waits).toEqual([])
  })

  it('flattens by cancelling orders and closing positions, failing on any item error', async () => {
    fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [
      { symbol: 'AAPL', status: 200, body: { ...placed, symbol: 'AAPL', asset_class: 'us_equity' } },
    ] }))
    expect(await flatten(http)).toHaveLength(1)
    expect(fake.requests[0]?.query.get('cancel_orders')).toBe('true')
    fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [{ symbol: 'AAPL', status: 403, body: { message: 'held' } }] }))
    await expect(flatten(http)).rejects.toMatchObject({ code: 'rejected', message: 'Alpaca could not close: AAPL (403)' })
  })

  it('skips a flatten item that closed without an order body', async () => {
    fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [{ symbol: 'AAPL', status: 200 },
      { symbol: 'MSFT', status: 200, body: { ...placed, symbol: 'MSFT', asset_class: 'us_equity' } }] }))
    expect((await flatten(http)).map(order => order.symbol.ticker)).toEqual(['MSFT'])
  })
})
