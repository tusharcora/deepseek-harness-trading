import type { OrderStreamEvent, OrderUpdate } from '@deepseek-ai/dsh-experimental-trading'
import type { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { TradeUpdateStream } from '../src/stream.ts'

let server: WebSocketServer
let url: string
let sockets: ServerSocket[]
let messages: unknown[]
let authorize: boolean

const order = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTCUSD', asset_class: 'crypto', side: 'buy', type: 'limit',
  time_in_force: 'ioc', qty: '0.015', filled_qty: '0.015', filled_avg_price: '62831.5', status: 'filled' }
const send = (socket: ServerSocket, payload: unknown, binary = true): void => {
  const text = JSON.stringify(payload)
  socket.send(binary ? Buffer.from(text) : text)
}
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

beforeEach(async () => {
  sockets = []; messages = []; authorize = true
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (raw) => {
      const message = JSON.parse((raw as Buffer).toString()) as { action: string }
      messages.push(message)
      const status = authorize ? 'authorized' : 'unauthorized'
      if (message.action === 'auth') send(socket, { stream: 'authorization', data: { status, action: 'authenticate' } })
      if (message.action === 'listen') send(socket, { stream: 'listening', data: { streams: ['trade_updates'] } }, false)
    })
  })
  await new Promise<void>((resolve) => { server.on('listening', () => { resolve() }) })
  const address = server.address()
  url = `ws://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
})
afterEach(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })

function stream(updates: OrderUpdate[], errors: VenueError[], gaps: string[] = []): TradeUpdateStream {
  return new TradeUpdateStream({
    url, backoffMs: [10, 20], keys: async () => ({ keyId: 'k', secret: 's' }),
    onEvent: (event: OrderStreamEvent) => { if (event.kind === 'update') updates.push(event.update); else gaps.push(event.reason) },
    onError: (error) => { errors.push(error) },
  })
}

describe('TradeUpdateStream', () => {
  it('authenticates, listens, and delivers binary and text trade updates', async () => {
    const updates: OrderUpdate[] = []
    const s = stream(updates, [])
    s.start()
    await until(() => messages.length === 2)
    expect(messages).toEqual([{ action: 'auth', key: 'k', secret: 's' }, { action: 'listen', data: { streams: ['trade_updates'] } }])
    const socket = sockets[0] as ServerSocket
    const fill = { event: 'fill', order, timestamp: '2026-10-05T14:00:01Z', price: '62831.5', qty: '0.015' }
    send(socket, { stream: 'trade_updates', data: fill })
    send(socket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } }, false)
    await until(() => updates.length === 2)
    expect(updates.map(u => u.event)).toEqual(['fill', 'new'])
    s.stop()
  })

  it('reconnects with backoff after the socket drops, authenticates again, and reports a gap', async () => {
    const updates: OrderUpdate[] = []
    const gaps: string[] = []
    const atGap: { messages: number; sockets: number }[] = []
    const s = new TradeUpdateStream({
      url, backoffMs: [10, 20], keys: async () => ({ keyId: 'k', secret: 's' }),
      onEvent: (event) => {
        if (event.kind === 'update') { updates.push(event.update); return }
        gaps.push(event.reason)
        atGap.push({ messages: messages.length, sockets: sockets.length })
      },
      onError: () => {},
    })
    s.start()
    await until(() => messages.length === 2)
    send(sockets[0] as ServerSocket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } })
    await until(() => updates.length === 1)
    expect(gaps).toEqual([])
    sockets[0]?.close()
    await until(() => gaps.length === 1)
    expect(atGap).toEqual([{ messages: 4, sockets: 2 }])
    expect(messages.slice(2)).toEqual(messages.slice(0, 2))
    send(sockets[1] as ServerSocket, { stream: 'trade_updates', data: { event: 'fill', order, timestamp: '2026-10-05T14:00:01Z' } })
    await until(() => updates.length === 2)
    expect(gaps).toEqual(['the order-update stream reconnected; updates may have been missed'])
    s.stop()
  })

  it('reports one disconnect per outage, not one per reconnect attempt', async () => {
    let drops = 0
    server.on('connection', (socket) => { if (drops > 0) { drops--; socket.terminate() } })
    const errors: VenueError[] = []
    const gaps: string[] = []
    const s = stream([], errors, gaps)
    s.start()
    await until(() => messages.length === 2)
    drops = 1
    sockets[0]?.terminate()
    await until(() => gaps.length === 1)
    expect(sockets).toHaveLength(3)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'unavailable', message: 'the order-update stream disconnected; reconnecting' })
    sockets[2]?.close()
    await until(() => gaps.length === 2)
    expect(errors.map(e => e.message)).toEqual(Array(2).fill('the order-update stream disconnected; reconnecting'))
    s.stop()
  })

  it('reports a connect failure once while it keeps retrying', async () => {
    const closed = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => { closed.on('listening', () => { resolve() }) })
    const address = closed.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    await new Promise<void>((resolve) => { closed.close(() => { resolve() }) })
    const errors: VenueError[] = []
    const s = new TradeUpdateStream({ url: `ws://127.0.0.1:${String(port)}`, backoffMs: [5],
      keys: async () => ({ keyId: 'k', secret: 's' }), onEvent: () => {}, onError: (error) => { errors.push(error) } })
    s.start()
    await until(() => errors.length === 1)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'unavailable', message: 'the order-update stream disconnected; reconnecting' })
    s.stop()
  })

  it('stops, reports auth, and reports a gap when Alpaca rejects the keys', async () => {
    authorize = false
    const errors: VenueError[] = []
    const gaps: string[] = []
    const s = stream([], errors, gaps)
    s.start()
    await until(() => errors.length === 1)
    expect(errors[0]).toMatchObject({ code: 'auth' })
    expect(gaps).toEqual(['the order-update stream stopped: Alpaca rejected the API keys'])
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(sockets).toHaveLength(1)
    s.stop()
  })

  it('reports that it stopped itself after the auth gap, and can be started again', async () => {
    authorize = false
    const order: string[] = []
    const s = new TradeUpdateStream({
      url, backoffMs: [10], keys: async () => ({ keyId: 'k', secret: 's' }),
      onEvent: (event) => { order.push(event.kind) },
      onError: (error) => { order.push(error.code) },
      onStopped: () => { order.push('stopped') },
    })
    s.start()
    await until(() => order.includes('stopped'))
    expect(order).toEqual(['auth', 'gap', 'stopped'])
    authorize = true
    s.start()
    await until(() => messages.length === 3)
    expect(messages.at(-1)).toEqual({ action: 'listen', data: { streams: ['trade_updates'] } })
    s.stop()
    expect(order).toEqual(['auth', 'gap', 'stopped'])
  })

  it('reports an in-stream error and a malformed update without stopping', async () => {
    const updates: OrderUpdate[] = []
    const errors: VenueError[] = []
    const gaps: string[] = []
    const s = stream(updates, errors, gaps)
    s.start()
    await until(() => messages.length === 2)
    const socket = sockets[0] as ServerSocket
    send(socket, { action: 'error', data: { error_message: 'slow client' } })
    send(socket, { stream: 'trade_updates', data: { event: 'fill', order: { ...order, filled_qty: 'abc' }, timestamp: 'x' } })
    send(socket, 'not json at all', false)
    socket.send('{broken')
    await until(() => errors.length === 4)
    expect(errors.map(e => e.code)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable'])
    expect(gaps).toEqual(['Alpaca reported a stream error; updates may have been missed',
      'an order update could not be read; re-read orders and positions'])
    send(socket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } })
    await until(() => updates.length === 1)
    s.stop()
  })

  it('does not reconnect after stop', async () => {
    const s = stream([], [])
    s.start()
    await until(() => messages.length === 2)
    s.stop()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(sockets).toHaveLength(1)
  })

  it('rejects an empty backoff schedule', () => {
    expect(() => new TradeUpdateStream({ url, backoffMs: [], keys: async () => ({ keyId: 'k', secret: 's' }),
      onEvent: () => {}, onError: () => {} })).toThrow(new RangeError('backoffMs must not be empty'))
  })

  it('reports a raw non-JSON frame and a failing listener as unavailable', async () => {
    const errors: VenueError[] = []
    const s = new TradeUpdateStream({ url, backoffMs: [10], keys: async () => ({ keyId: 'k', secret: 's' }),
      onEvent: () => { throw new Error('listener failed') }, onError: (error) => { errors.push(error) } })
    s.start()
    await until(() => messages.length === 2)
    const socket = sockets[0] as ServerSocket
    socket.send('{broken')
    send(socket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } })
    await until(() => errors.length === 2)
    expect(errors[1]).toMatchObject({ code: 'unavailable', message: 'listener failed' })
    s.stop()
  })

  it('reports unconfigured and closes when the keys cannot be resolved', async () => {
    const errors: VenueError[] = []
    const s = new TradeUpdateStream({ url, backoffMs: [1_000], keys: async () => { throw new Error('no keys') },
      onEvent: () => {}, onError: (error) => { errors.push(error) } })
    s.start()
    await until(() => errors.length === 2)
    expect(errors[0]).toMatchObject({ code: 'unconfigured', message: 'Alpaca keys unavailable: no keys' })
    expect(errors[1]).toMatchObject({ code: 'unavailable', message: 'the order-update stream disconnected; reconnecting' })
    s.stop()
  })

  it('ignores a second start while running', async () => {
    const s = stream([], [])
    s.start()
    s.start()
    await until(() => messages.length === 2)
    expect(sockets).toHaveLength(1)
    s.stop()
  })

  it('ignores an unrecognised frame and reports an update without an order as malformed', async () => {
    const updates: OrderUpdate[] = []
    const errors: VenueError[] = []
    const gaps: string[] = []
    const s = stream(updates, errors, gaps)
    s.start()
    await until(() => messages.length === 2)
    const socket = sockets[0] as ServerSocket
    send(socket, { stream: 'account_updates', data: {} })
    send(socket, { stream: 'trade_updates' })
    send(socket, { stream: 'trade_updates', data: { event: 'new', timestamp: '2026-10-05T14:00:00Z' } })
    await until(() => errors.length === 1)
    expect(errors[0]).toMatchObject({ code: 'unavailable' })
    expect(errors[0]?.message).toMatch(/^Alpaca sent a malformed order update: /)
    expect(gaps).toEqual(['an order update could not be read; re-read orders and positions'])
    send(socket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } })
    await until(() => updates.length === 1)
    expect(errors).toHaveLength(1)
    s.stop()
  })

  it('reports a listener that throws on a gap through onError and keeps listening', async () => {
    const errors: VenueError[] = []
    let listened = 0
    const s = new TradeUpdateStream({ url, backoffMs: [10], keys: async () => ({ keyId: 'k', secret: 's' }),
      onEvent: () => { throw new Error('gap listener failed') }, onError: (error) => { errors.push(error) } })
    server.on('connection', (socket) => { socket.on('message', () => { listened++ }) })
    s.start()
    await until(() => listened === 2)
    sockets[0]?.close()
    await until(() => errors.length === 2)
    expect(errors[0]).toMatchObject({ code: 'unavailable', message: 'the order-update stream disconnected; reconnecting' })
    expect(errors[1]).toMatchObject({ code: 'unavailable', message: 'gap listener failed' })
    expect(sockets).toHaveLength(2)
    s.stop()
  })

  it('does not report a key failure that settles after stop', async () => {
    const errors: VenueError[] = []
    let fail: (error: Error) => void = () => {}
    const s = new TradeUpdateStream({ url, backoffMs: [10],
      keys: () => new Promise<never>((_resolve, reject) => { fail = reject }),
      onEvent: () => {}, onError: (error) => { errors.push(error) } })
    s.start()
    await until(() => sockets.length === 1)
    await new Promise(resolve => setTimeout(resolve, 20))
    s.stop()
    fail(new Error('too late'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(errors).toEqual([])
  })
})
