/**
 * In-memory trading venue for tool-trading tests: state the test sets directly, every order request recorded, and
 * order-stream events delivered on demand. Only the broker is faked; tools, approval, sessions, and storage stay real.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, ClientOrderId, OrderStreamEvent,
  PositionSnapshot, Quote, Timeframe, TradingMode, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { TradingVenueGateway, VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'

const btc: TradingSymbol = { assetClass: 'crypto', ticker: 'BTC/USD' }
const aapl: TradingSymbol = { assetClass: 'equity', ticker: 'AAPL' }

/**
 * The order a broker accepts for a request.
 * @param request - planned request.
 * @param overrides - fields to change, such as a fill.
 * @returns an open order with the request's fields.
 */
export function acceptedOrder(request: BrokerOrderRequest, overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    id: brandString<BrokerOrderId>(`order-${request.clientOrderId.slice(0, 8)}`),
    clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, type: request.type,
    timeInForce: request.timeInForce,
    ...request.qty === undefined ? {} : { qty: request.qty },
    ...request.notional === undefined ? {} : { notional: request.notional },
    ...request.limitPrice === undefined ? {} : { limitPrice: request.limitPrice },
    ...request.stopPrice === undefined ? {} : { stopPrice: request.stopPrice },
    filledQty: 0, status: 'open', ...overrides,
  }
}

/** In-memory `ctx.tradingVenue`. */
export class FakeVenue extends TradingVenueGateway {
  current: VenueStatus = 'ready'
  keysMissing = false
  accountMode: TradingMode = 'paper'
  accountState: AccountSnapshot = { equity: 100_000, cash: 100_000, lastEquity: 100_000, buyingPower: 100_000, tradingBlocked: false }
  held: PositionSnapshot[] = []
  open: BrokerOrder[] = []
  marketIsOpen = true
  quoteAgeMs = 0
  readonly quotes = new Map<string, { bid: number; ask: number }>([
    ['BTC/USD', { bid: 62_830, ask: 62_835 }], ['AAPL', { bid: 229.9, ask: 230.1 }],
  ])
  readonly assets = new Map<string, Asset>([
    ['BTC/USD', { symbol: btc, tradable: true, fractionable: true, minOrderSize: 0.0001, minNotional: 10, priceIncrement: 0.01 }],
    ['AAPL', { symbol: aapl, tradable: true, fractionable: true, priceIncrement: 0.01 }],
  ])
  history: Bar[] = []
  readonly barQueries: BarQuery[] = []
  readonly submitted: BrokerOrderRequest[] = []
  readonly cancelled: BrokerOrderId[] = []
  readonly known = new Map<string, BrokerOrder>()
  respond: (request: BrokerOrderRequest) => BrokerOrder = request => acceptedOrder(request)
  cancelFailure: VenueError | undefined
  haltReason = ''
  haltFailure: Error | undefined
  resumeCalls = 0
  resumeFailure: VenueError | undefined
  /** A Halt that arrives during resume wins: resume resolves with the desk still halted. */
  resumeLeavesHalted = false
  private readonly listeners = new Set<(event: OrderStreamEvent) => void>()

  status(): VenueStatus { return this.current }
  mode(): TradingMode { return this.accountMode }
  statusReason(): string { return this.current === 'halted' ? this.haltReason : '' }
  async account(): Promise<AccountSnapshot> { this.keys(); return this.accountState }
  async positions(): Promise<PositionSnapshot[]> { this.keys(); return this.held }
  async openOrders(): Promise<BrokerOrder[]> { this.keys(); return this.open }
  async order(clientOrderId: ClientOrderId): Promise<BrokerOrder | undefined> { this.keys(); return this.known.get(clientOrderId) }
  async asset(symbol: TradingSymbol): Promise<Asset> {
    this.keys()
    const asset = this.assets.get(symbol.ticker)
    if (asset === undefined) throw new VenueError(`no asset ${symbol.ticker}`, 'not-found')
    return asset
  }
  async marketOpen(): Promise<boolean> { this.keys(); return this.marketIsOpen }
  async latestQuote(symbol: TradingSymbol): Promise<Quote> {
    this.keys()
    const quote = this.quotes.get(symbol.ticker)
    if (quote === undefined) throw new VenueError(`no quote for ${symbol.ticker}`, 'not-found')
    return { ...quote, t: Date.now() - this.quoteAgeMs }
  }
  async bars(_symbol: TradingSymbol, _timeframe: Timeframe, query: BarQuery): Promise<Bar[]> {
    this.keys()
    this.barQueries.push(query)
    return this.history.slice(-query.limit)
  }
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.keys()
    if (this.current === 'halted') throw new VenueError('trading is halted', 'halted')
    this.submitted.push(request)
    const order = this.respond(request)
    this.known.set(request.clientOrderId, order)
    return order
  }
  async cancelOrder(id: BrokerOrderId): Promise<void> {
    this.keys()
    if (this.cancelFailure !== undefined) throw this.cancelFailure
    this.cancelled.push(id)
  }
  async closePosition(): Promise<BrokerOrder> { throw new VenueError('tool-trading never closes positions', 'rejected') }
  async flatten(): Promise<BrokerOrder[]> { return [] }
  async halt(reason: string): Promise<void> {
    this.current = 'halted'
    this.haltReason = reason
    if (this.haltFailure !== undefined) throw this.haltFailure
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1
    if (this.resumeFailure !== undefined) throw this.resumeFailure
    if (!this.resumeLeavesHalted) this.current = 'ready'
  }
  subscribeOrderUpdates(listener: (event: OrderStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  get listenerCount(): number { return this.listeners.size }
  emit(event: OrderStreamEvent): void { for (const listener of this.listeners) listener(event) }
  private keys(): void {
    if (this.keysMissing) throw new VenueError('Alpaca keys not configured — add them in Settings → Trading', 'unconfigured')
  }
}

export default FakeVenue
