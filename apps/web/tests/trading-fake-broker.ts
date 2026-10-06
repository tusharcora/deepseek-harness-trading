/**
 * Keyless Alpaca stand-in for the trading-desk snapshot: the REST routes the venue and executor call for one BTC/USD
 * order, and a trade-updates WebSocket that sends that order's fill on demand. Every value is fixed except the quote
 * time, which is always the request time so the quote is never stale.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'

/** A running fake broker. */
export interface FakeBroker {
  /** REST base URL for both `tradingUrl` and `dataUrl`. */
  readonly url: string
  /** Trade-updates WebSocket URL. */
  readonly streamUrl: string
  /** Order bodies the desk posted. */
  readonly orders: Record<string, unknown>[]
  /** Sockets that authenticated and listen to trade updates. */
  listening(): number
  /** Fill the last posted order and send the update to every listening socket. */
  fill(): void
  /** Close both servers. */
  stop(): Promise<void>
}

const HOUR = 3_600_000
const LAST_BAR = Date.UTC(2026, 9, 5, 14)
// Newest first: the venue asks for `sort=desc` and reverses.
const BARS = Array.from({ length: 5 }, (_, i) => {
  const close = 62_850 - i * 40
  return {
    t: new Date(LAST_BAR - i * HOUR).toISOString(), o: close - 20, h: close + 30, l: close - 50, c: close, v: 3 + i,
  }
})

async function body(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
}

/**
 * Start the broker on loopback ports.
 * @returns the running broker.
 */
export async function startFakeBroker(): Promise<FakeBroker> {
  const config: Record<string, unknown> = { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false }
  const orders: Record<string, unknown>[] = []
  let order: Record<string, unknown> | undefined
  let filled = false
  const route = (
    method: string, path: string, sent: Record<string, unknown> | undefined,
  ): { status: number; body: unknown } => {
    if (path === '/v2/account/configurations') {
      if (method === 'PATCH' && sent !== undefined) Object.assign(config, sent)
      return { status: 200, body: { ...config, fractional_trading: true } }
    }
    if (method === 'GET' && path === '/v2/account') {
      return { status: 200, body: { equity: '100000', cash: '100000', last_equity: '100000', buying_power: '100000' } }
    }
    if (method === 'GET' && path === '/v2/assets/BTCUSD') {
      return { status: 200, body: { symbol: 'BTC/USD', class: 'crypto', status: 'active', tradable: true, fractionable: true,
        price_increment: '0.01', min_order_size: '0.0001' } }
    }
    if (method === 'GET' && path === '/v1beta3/crypto/us/latest/quotes') {
      return { status: 200, body: { quotes: { 'BTC/USD': { t: new Date().toISOString(), bp: 62_830, ap: 62_835 } } } }
    }
    if (method === 'GET' && path === '/v1beta3/crypto/us/bars') {
      return { status: 200, body: { bars: { 'BTC/USD': BARS }, next_page_token: null } }
    }
    if (method === 'GET' && path === '/v2/positions') return { status: 200, body: [] }
    if (method === 'GET' && path === '/v2/orders') return { status: 200, body: order === undefined || filled ? [] : [order] }
    if (method === 'POST' && path === '/v2/orders' && sent !== undefined) {
      orders.push(sent)
      order = {
        id: 'order-1', client_order_id: sent.client_order_id, symbol: 'BTC/USD', asset_class: 'crypto', side: sent.side,
        type: sent.type, time_in_force: sent.time_in_force, qty: sent.qty, limit_price: sent.limit_price,
        filled_qty: '0', status: 'new',
      }
      return { status: 200, body: order }
    }
    if (method === 'GET' && path === '/v2/orders:by_client_order_id' && order !== undefined) return { status: 200, body: order }
    return { status: 404, body: { message: `no route ${method} ${path}` } }
  }
  const server: Server = createServer((request, response) => {
    void body(request).then((sent) => {
      const url = new URL(request.url ?? '/', 'http://fake')
      const answer = route(request.method ?? 'GET', url.pathname, sent)
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
  })
  const stream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  // Subscribed before the first await: the server can start listening while the HTTP server binds.
  const streamListening = new Promise<void>((resolve) => { stream.once('listening', () => { resolve() }) })
  const listeners = new Set<WebSocket>()
  stream.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse((raw as Buffer).toString()) as { action: string }
      if (message.action === 'auth') socket.send(JSON.stringify({ stream: 'authorization', data: { status: 'authorized' } }))
      if (message.action === 'listen') {
        listeners.add(socket)
        socket.send(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }))
      }
    })
    socket.on('close', () => { listeners.delete(socket) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  await streamListening
  const port = (target: Server | WebSocketServer): number => (target.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${String(port(server))}`,
    streamUrl: `ws://127.0.0.1:${String(port(stream))}`,
    orders,
    listening: () => listeners.size,
    fill() {
      if (order === undefined) throw new Error('no order to fill')
      filled = true
      order = { ...order, filled_qty: order.qty, filled_avg_price: order.limit_price, status: 'filled' }
      const frame = Buffer.from(JSON.stringify({
        stream: 'trade_updates',
        data: { event: 'fill', timestamp: '2026-10-05T14:30:00Z', price: order.limit_price, qty: order.qty,
          position_qty: order.qty, order },
      }))
      for (const socket of listeners) socket.send(frame)
    },
    async stop() {
      for (const socket of stream.clients) socket.terminate()
      await new Promise<void>((resolve) => { stream.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
