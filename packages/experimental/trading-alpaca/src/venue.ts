/**
 * All venue behavior behind AlpacaVenue: readiness, order gating by Halt and
 * block state, and listener-counted order-update streaming. Collaborators are
 * injected so the behavior is tested against the fake Alpaca server.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/venue
 */
import type {
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, OrderStreamEvent, PositionSnapshot,
  Quote, Timeframe, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'
import { asset, bars, latestQuote, marketOpen } from './market.ts'
import * as orders from './orders.ts'
import { AccountSafety, type SafetyState, type SafetyStateStore, type SafetyTiming } from './safety.ts'

/** A startable, stoppable order-update source. */
export interface UpdateSource {
  /** Begin streaming. */
  start(): void
  /** Stop streaming. */
  stop(): void
}

/** Collaborators of {@link VenueCore}. */
export interface VenueCoreDeps {
  /** REST client. */
  readonly http: AlpacaHttp
  /** Equity data feed. */
  readonly feed: 'iex' | 'sip'
  /** Minimum crypto order value in dollars, reported as each crypto asset's `minNotional`. */
  readonly cryptoMinNotional: number
  /** Current time, UTC epoch milliseconds. */
  readonly now: () => number
  /** Submission confirmation and position-close waits. */
  readonly timing: orders.OrderTiming
  /** Suspension retry schedule. */
  readonly safetyTiming: SafetyTiming
  /** Whether both API keys resolve now. */
  readonly keysPresent: () => Promise<boolean>
  /** Durable Halt state. */
  readonly store: SafetyStateStore
  /**
   * Create the order-update source that delivers to `onEvent` and calls `onStopped` when it stops itself (Alpaca
   * rejected the keys), so the venue can start a new one.
   */
  readonly stream: (onEvent: (event: OrderStreamEvent) => void, onStopped: () => void) => UpdateSource
  /** Publish a status change. */
  readonly emitStatus: (status: VenueStatus, reason: string) => void
  /** Report a failure that has no caller to reject, such as a throwing order-update listener. */
  readonly warn: (message: string) => void
}

const UNCONFIGURED = 'Alpaca keys not configured — add them in Settings → Trading'

/** Venue behavior shared by the Alpaca service. */
export class VenueCore {
  private configured = false
  private blockedReason: string | undefined
  private setup: Promise<void> | undefined
  private readonly safety: AccountSafety
  private readonly listeners = new Set<(event: OrderStreamEvent) => void>()
  private source: UpdateSource | undefined

  /** @param deps - collaborators. */
  constructor(private readonly deps: VenueCoreDeps) {
    this.safety = new AccountSafety(deps.http, deps.store, deps.safetyTiming)
  }

  /**
   * Current readiness, derived from the saved Halt flag and the setup result.
   * @returns the status.
   */
  status(): VenueStatus {
    if (this.safety.isHalted()) return 'halted'
    if (this.blockedReason !== undefined) return 'blocked'
    return this.configured ? 'ready' : 'unconfigured'
  }

  /**
   * Run setup once keys exist: apply the safety settings and restore Halt. Safe to call repeatedly.
   * @returns when setup finished or was skipped for missing keys.
   */
  async prepare(): Promise<void> {
    this.setup ??= this.runSetup().finally(() => {
      if (!this.configured && this.blockedReason === undefined) this.setup = undefined
    })
    await this.setup
  }

  /**
   * Read the account once setup has run.
   * @returns the account snapshot.
   */
  async account(): Promise<AccountSnapshot> {
    await this.readable()
    return orders.account(this.deps.http)
  }

  /**
   * Read open positions once setup has run.
   * @returns open positions.
   */
  async positions(): Promise<PositionSnapshot[]> {
    await this.readable()
    return orders.positions(this.deps.http)
  }

  /**
   * Read open orders once setup has run.
   * @returns open orders.
   */
  async openOrders(): Promise<BrokerOrder[]> {
    await this.readable()
    return orders.openOrders(this.deps.http)
  }

  /**
   * Read broker facts for one instrument once setup has run.
   * @param symbol - instrument.
   * @returns broker facts.
   */
  async asset(symbol: TradingSymbol): Promise<Asset> {
    await this.readable()
    return asset(this.deps.http, symbol, this.deps.cryptoMinNotional)
  }

  /**
   * Whether the instrument's market is open, once setup has run.
   * @param symbol - instrument.
   * @returns whether its market is open.
   */
  async marketOpen(symbol: TradingSymbol): Promise<boolean> {
    await this.readable()
    return marketOpen(this.deps.http, symbol)
  }

  /**
   * Read the latest quote from the configured feed once setup has run.
   * @param symbol - instrument.
   * @returns the latest quote.
   */
  async latestQuote(symbol: TradingSymbol): Promise<Quote> {
    await this.readable()
    return latestQuote(this.deps.http, symbol, this.deps.feed)
  }

  /**
   * Read bars from the configured feed, ending at the injected clock's now when the query has no end.
   * @param symbol - instrument.
   * @param timeframe - bar timeframe.
   * @param query - range and count.
   * @returns bars, oldest first.
   */
  async bars(symbol: TradingSymbol, timeframe: Timeframe, query: BarQuery): Promise<Bar[]> {
    await this.readable()
    return bars(this.deps.http, symbol, timeframe, query, this.deps.feed, this.deps.now())
  }

  /**
   * Submit an order; refused while blocked and whenever the saved Halt flag is set, so a pending suspension never
   * lets an order through. The Halt is checked again immediately before the POST, after the keys resolve, so a Halt
   * that arrives while the request is being prepared still stops it.
   * @param request - planned order.
   * @returns the accepted order.
   */
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    await this.orderable()
    const refuseWhenHalted = (): void => { if (this.safety.isHalted()) throw new VenueError('trading is halted', 'halted') }
    refuseWhenHalted()
    return orders.submitOrder(this.deps.http, request, this.deps.timing, refuseWhenHalted)
  }

  /**
   * Cancel one open order once setup has run.
   * @param id - broker order id.
   * @returns when cancelled.
   */
  async cancelOrder(id: BrokerOrderId): Promise<void> {
    await this.readable()
    await orders.cancelOrder(this.deps.http, id)
  }

  /**
   * Close one position; allowed while halted (inside the flatten window) or blocked.
   * @param symbol - instrument.
   * @returns the closing order.
   */
  async closePosition(symbol: TradingSymbol): Promise<BrokerOrder> {
    await this.readable()
    return this.safety.withFlattenWindow(() => orders.closePosition(this.deps.http, symbol, this.deps.timing))
  }

  /**
   * Cancel every order and close every position; allowed while halted (inside the flatten window) or blocked.
   * @returns the closing orders.
   */
  async flatten(): Promise<BrokerOrder[]> {
    await this.readable()
    return this.safety.withFlattenWindow(() => orders.flatten(this.deps.http))
  }

  /**
   * Halt in every state, including without keys: mark the desk halted first, then suspend at the broker.
   * @param reason - readable cause.
   * @returns when the desk is halted; the broker suspension may still be pending.
   * @throws the store's error when saving the Halt failed; the desk is still halted in memory and the status published.
   */
  async halt(reason: string): Promise<void> {
    // AccountSafety.halt marks the store halted synchronously, before its first await.
    const confirming = this.safety.halt(reason)
    this.publish(reason)
    let confirmed: boolean
    try {
      confirmed = await confirming
    } catch (error) {
      this.publish(`${reason}; saving the Halt failed and it may not survive a restart: ${(error as Error).message}`)
      throw error
    }
    if (!confirmed) this.publish(`${reason}; the Alpaca suspension is pending and will be retried`)
  }

  /**
   * Re-apply the safety settings and lift the Halt; a Halt requested after this call wins.
   * @returns when running again, or when a Halt that arrived meanwhile kept the desk halted.
   */
  async resume(): Promise<void> {
    const since = this.safety.haltCounter()
    await this.orderable()
    await this.safety.resume(since)
    this.publish(this.safety.isHalted() ? 'a Halt arrived while resuming' : 'trading resumed')
  }

  /**
   * Check the account settings for drift once; halts on drift.
   * @returns the drift reason, or undefined when the settings hold or the venue is not set up.
   */
  async checkDrift(): Promise<string | undefined> {
    if (!this.configured && !this.safety.isHalted()) return undefined
    const reason = await this.safety.check()
    if (reason !== undefined) this.publish(reason)
    return reason
  }

  /**
   * Check for drift every `intervalMs` until stopped; a check never overlaps the previous one.
   * @param intervalMs - interval between checks.
   * @param warn - receives a message when a check fails.
   * @returns a function that stops the checks.
   */
  watchDrift(intervalMs: number, warn: (message: string) => void): () => void {
    let checking = false
    const timer = setInterval(() => {
      if (checking) return
      checking = true
      void this.checkDrift()
        .catch((error: unknown) => { warn(`drift check failed: ${(error as Error).message}`) })
        .finally(() => { checking = false })
    }, intervalMs)
    timer.unref()
    return () => { clearInterval(timer) }
  }

  /**
   * Receive order updates and gaps; the stream runs only while at least one listener is registered.
   * @param listener - receives each update.
   * @returns a disposer; calling it again does nothing.
   */
  subscribeOrderUpdates(listener: (event: OrderStreamEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.source === undefined) this.startSource()
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.source?.stop()
      this.source = undefined
    }
  }

  /**
   * Start the order-update stream again when it stopped itself (Alpaca rejected the keys) while listeners remain;
   * otherwise do nothing. Called when credentials change.
   */
  restartStream(): void {
    if (this.source === undefined && this.listeners.size > 0) this.startSource()
  }

  /** Stop streaming; used on dispose. */
  close(): void {
    this.listeners.clear()
    this.source?.stop()
    this.source = undefined
  }

  private startSource(): void {
    const source: UpdateSource = this.deps.stream(
      (event) => { this.fanOut(event) },
      () => { if (this.source === source) this.source = undefined },
    )
    this.source = source
    source.start()
  }

  /** Deliver to every listener; a throwing listener is reported and never hides the event from the others. */
  private fanOut(event: OrderStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.deps.warn(`an order-update listener failed: ${(error as Error).message}`)
      }
    }
  }

  private async runSetup(): Promise<void> {
    if (!(await this.deps.keysPresent())) return
    try {
      const start = await this.safety.start()
      this.configured = true
      this.publish(start.halted ? start.reason : 'account safety settings verified')
    } catch (error) {
      if (!(error instanceof VenueError) || error.code !== 'blocked') throw error
      this.blockedReason = error.message
      this.publish(error.message)
    }
  }

  private async readable(): Promise<void> {
    await this.prepare()
    if (!this.configured && this.blockedReason === undefined) throw new VenueError(UNCONFIGURED, 'unconfigured')
  }

  private async orderable(): Promise<void> {
    await this.readable()
    if (this.blockedReason !== undefined) throw new VenueError(this.blockedReason, 'blocked')
  }

  private publish(reason: string): void {
    this.deps.emitStatus(this.status(), reason)
  }
}

/** A {@link SafetyStateStore} whose in-memory state can be replaced by the state read from durable storage. */
export interface OrderedStore extends SafetyStateStore {
  /**
   * Replace the in-memory state without persisting it.
   * @param state - the state read from durable storage.
   */
  load(state: SafetyState): void
  /**
   * Wait for every persist requested so far, failed ones included; call before closing the durable storage so a
   * just-saved Halt is not lost.
   * @returns when all pending persists settled; never rejects.
   */
  flush(): Promise<void>
}

/**
 * A {@link SafetyStateStore} over an asynchronous persist: `get()` returns the latest `set()` argument from the moment
 * `set()` is called, persists run one at a time in call order, and a failed persist neither stops later ones nor
 * rolls back the in-memory value.
 * @param initial - state served until the first `set()` or `load()`.
 * @param persist - durable write of one state.
 * @returns the store; each `set()` rejects only when its own persist fails.
 */
export function orderedStore(initial: SafetyState, persist: (state: SafetyState) => Promise<void>): OrderedStore {
  let state = initial
  let tail: Promise<void> = Promise.resolve()
  return {
    get: () => state,
    set: (next) => {
      state = next
      const write = tail.then(() => persist(next))
      tail = write.catch(() => undefined)
      return write
    },
    load: (loaded) => { state = loaded },
    flush: () => tail,
  }
}
