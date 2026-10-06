/**
 * The account's trade-updates WebSocket: one owner for connect, authenticate,
 * listen, decode (Alpaca sends binary frames), reconnect with backoff, and stop.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/stream
 */
import type { OrderStreamEvent, OrderUpdate } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { mapOrderUpdate } from './map.ts'
import type { AlpacaKeys, RawRecord } from './types.ts'

/** Stream construction options. */
export interface TradeUpdateStreamOptions {
  /** Trade-updates WebSocket URL. */
  readonly url: string
  /** Waits before reconnect attempts; the last entry repeats. */
  readonly backoffMs: readonly number[]
  /** Resolve the key pair at each connection. */
  readonly keys: () => Promise<AlpacaKeys>
  /** Receives each order update and each gap after which updates may have been missed. */
  readonly onEvent: (event: OrderStreamEvent) => void
  /** Receives stream failures, including one `unavailable` per disconnect until the stream listens again; `auth` stops the stream. */
  readonly onError: (error: VenueError) => void
  /** Called after the stream stopped itself (Alpaca rejected the keys) and reported the gap; `stop()` does not call it. */
  readonly onStopped?: () => void
}

const decoder = new TextDecoder()

/** A reconnecting trade-updates stream. */
export class TradeUpdateStream {
  private socket: WebSocket | undefined
  private stopped = true
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private listenedBefore = false
  /** True from a disconnect until the next `listening`, so one outage is reported once. */
  private outage = false

  private readonly lastBackoff: number

  /**
   * @param options - URL, backoff, keys, and callbacks.
   * @throws RangeError when `backoffMs` is empty.
   */
  constructor(private readonly options: TradeUpdateStreamOptions) {
    if (options.backoffMs.length === 0) throw new RangeError('backoffMs must not be empty')
    this.lastBackoff = options.backoffMs.length - 1
  }

  /**
   * Connect and keep the stream open until {@link stop}.
   * @returns nothing; connection happens in the background.
   */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.listenedBefore = false
    this.outage = false
    this.connect()
  }

  /**
   * Close the stream and cancel any pending reconnect.
   * @returns nothing.
   */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.socket?.close()
    this.socket = undefined
  }

  private connect(): void {
    const socket = new WebSocket(this.options.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.addEventListener('open', () => {
      void this.options.keys().then((keys) => {
        socket.send(JSON.stringify({ action: 'auth', key: keys.keyId, secret: keys.secret }))
      }, (error: unknown) => {
        if (this.socket !== socket) return
        this.options.onError(new VenueError(`Alpaca keys unavailable: ${(error as Error).message}`, 'unconfigured'))
        socket.close()
      })
    })
    socket.addEventListener('message', (event) => { this.receive(socket, event.data) })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) return
      if (!this.outage) {
        this.outage = true
        this.options.onError(new VenueError('the order-update stream disconnected; reconnecting', 'unavailable'))
      }
      const delay = this.options.backoffMs[Math.min(this.attempt, this.lastBackoff)] as number
      this.attempt++
      this.timer = setTimeout(() => { this.timer = undefined; this.connect() }, delay)
      this.timer.unref()
    })
  }

  private receive(socket: WebSocket, data: unknown): void {
    let message: { stream?: unknown; action?: unknown; data?: RawRecord }
    try {
      const text = typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer)
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      message = parsed
    } catch (error) {
      this.options.onError(new VenueError(`Alpaca sent a malformed stream message: ${(error as Error).message}`, 'unavailable'))
      return
    }
    if (message.stream === 'authorization') {
      if (message.data?.status === 'authorized') {
        socket.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }))
        return
      }
      this.options.onError(new VenueError('Alpaca rejected the API keys on the trade-updates stream', 'auth'))
      this.stop()
      this.emit({ kind: 'gap', reason: 'the order-update stream stopped: Alpaca rejected the API keys' })
      this.options.onStopped?.()
      return
    }
    if (message.stream === 'listening') {
      this.attempt = 0
      this.outage = false
      if (this.listenedBefore) this.emit({ kind: 'gap', reason: 'the order-update stream reconnected; updates may have been missed' })
      this.listenedBefore = true
      return
    }
    if (message.action === 'error') {
      this.options.onError(new VenueError(`Alpaca stream error: ${String(message.data?.error_message)}`, 'unavailable'))
      this.emit({ kind: 'gap', reason: 'Alpaca reported a stream error; updates may have been missed' })
      return
    }
    if (message.stream === 'trade_updates' && message.data !== undefined) {
      let update: OrderUpdate
      try {
        update = mapOrderUpdate(message.data)
      } catch (error) {
        const reason = `Alpaca sent a malformed order update: ${(error as Error).message}`
        this.options.onError(error instanceof VenueError ? error : new VenueError(reason, 'unavailable'))
        this.emit({ kind: 'gap', reason: 'an order update could not be read; re-read orders and positions' })
        return
      }
      this.emit({ kind: 'update', update })
    }
  }

  /** Deliver an event; a throwing listener is reported through `onError` instead of escaping the socket handler. */
  private emit(event: OrderStreamEvent): void {
    try {
      this.options.onEvent(event)
    } catch (error) {
      this.options.onError(new VenueError((error as Error).message, 'unavailable'))
    }
  }
}
