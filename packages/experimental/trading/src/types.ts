/**
 * Trading domain values shared by the trading provider, executor, gateway, and browser UI.
 *
 * @module @deepseek-ai/dsh-experimental-trading/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Market an instrument trades in. */
export type AssetClass = 'equity' | 'crypto'

/** A canonical instrument: `AAPL`, `BRK.B`, or a crypto pair such as `BTC/USD`. */
export interface TradingSymbol {
  /** Market the instrument trades in. */
  readonly assetClass: AssetClass
  /** Upper-case ticker; crypto pairs use `BASE/QUOTE`. */
  readonly ticker: string
}

/** One supported chart and bar timeframe; `TIMEFRAMES` lists them shortest first. */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1D' | '1W'

/** One OHLCV candle; `t` is the bucket start in UTC epoch milliseconds. */
export interface Bar {
  /** Bucket start, UTC epoch milliseconds. */
  readonly t: number
  /** Open price. */
  readonly o: number
  /** High price. */
  readonly h: number
  /** Low price. */
  readonly l: number
  /** Close (latest) price. */
  readonly c: number
  /** Traded volume. */
  readonly v: number
}

/** Best bid and ask at time `t` (UTC epoch milliseconds). */
export interface Quote {
  /** Best bid price. */
  readonly bid: number
  /** Best ask price. */
  readonly ask: number
  /** Quote time, UTC epoch milliseconds. */
  readonly t: number
}

/** One executed trade print from the market-data stream. */
export interface Trade {
  /** Trade time, UTC epoch milliseconds. */
  readonly t: number
  /** Execution price. */
  readonly price: number
  /** Executed size. */
  readonly size: number
}

/** Order direction. */
export type Side = 'buy' | 'sell'

/** Order types the desk accepts. */
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'

/** Time-in-force values the desk accepts. */
export type TimeInForce = 'day' | 'gtc' | 'ioc'

/** Equity bracket legs attached to an entry order. */
export interface Bracket {
  /** Take-profit limit price. */
  readonly takeProfit: number
  /** Stop-loss stop price. */
  readonly stopLoss: number
}

/** An order as proposed by an agent, before validation and risk checks. Exactly one of `qty` and `notional` is set. */
export interface OrderRequest {
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Direction. */
  readonly side: Side
  /** Quantity in shares or coins. */
  readonly qty?: number
  /** Dollar amount for a notional market order. */
  readonly notional?: number
  /** Order type. */
  readonly type: OrderType
  /** Limit price for `limit` and `stop_limit`. */
  readonly limitPrice?: number
  /** Stop price for `stop` and `stop_limit`. */
  readonly stopPrice?: number
  /** Time in force. */
  readonly timeInForce: TimeInForce
  /** Optional equity bracket. */
  readonly bracket?: Bracket
}

/** Broker facts about one instrument that order validation needs. */
export interface Asset {
  /** Instrument these facts describe. */
  readonly symbol: TradingSymbol
  /** Whether the broker accepts orders for it now. */
  readonly tradable: boolean
  /** Whether fractional and notional orders are allowed. */
  readonly fractionable: boolean
  /** Smallest accepted quantity, when the broker publishes one. */
  readonly minOrderSize?: number
  /** Smallest price step for limit and stop prices. */
  readonly priceIncrement: number
}

/** Executor-minted id of one order proposal; keys proposals, approvals, and client order ids on both the in-app and MCP paths. */
export type ProposalId = Branded<'TradingProposalId'>

/** Broker-assigned order id. */
export type BrokerOrderId = Branded<'TradingBrokerOrderId'>

/** Idempotency key sent to the broker with an order. */
export type ClientOrderId = Branded<'TradingClientOrderId'>

/** Account values the desk reads before every order. */
export interface AccountSnapshot {
  /** Current equity. */
  readonly equity: number
  /** Cash available for buys. */
  readonly cash: number
  /** Equity at the previous close. */
  readonly lastEquity: number
  /** Broker-reported buying power. */
  readonly buyingPower: number
  /** Whether the broker blocks new orders on the account. */
  readonly tradingBlocked: boolean
}

/** One open position; `qty` is negative for a short position. */
export interface PositionSnapshot {
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Signed quantity. */
  readonly qty: number
  /** Average entry price. */
  readonly avgEntryPrice: number
  /** Latest price the broker used for valuation. */
  readonly currentPrice: number
  /** Position value at `currentPrice`. */
  readonly marketValue: number
  /** Unrealized profit or loss in dollars. */
  readonly unrealizedPl: number
}

/** Lifecycle state of a broker order; every non-terminal broker state is `open`. */
export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'

/** An order as the broker reports it. */
export interface BrokerOrder {
  /** Broker order id. */
  readonly id: BrokerOrderId
  /** Idempotency key the order was submitted with. */
  readonly clientOrderId: ClientOrderId
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Direction. */
  readonly side: Side
  /** Order type; `other` for types the desk does not place (for example a trailing stop placed elsewhere). */
  readonly type: OrderType | 'other'
  /** Broker time-in-force code. */
  readonly timeInForce: string
  /** Ordered quantity, when the order was quantity-based. */
  readonly qty?: number
  /** Ordered dollar amount, when the order was notional. */
  readonly notional?: number
  /** Limit price. */
  readonly limitPrice?: number
  /** Stop price. */
  readonly stopPrice?: number
  /** Filled quantity so far. */
  readonly filledQty: number
  /** Average fill price, once anything filled. */
  readonly filledAvgPrice?: number
  /** Lifecycle state. */
  readonly status: OrderStatus
  /** Submission time, UTC epoch milliseconds. */
  readonly submittedAt?: number
}

/** What the executor sends to the venue after approval and submission planning. */
export interface BrokerOrderRequest {
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Direction. */
  readonly side: Side
  /** Quantity; exactly one of `qty` and `notional`. */
  readonly qty?: number
  /** Dollar amount; exactly one of `qty` and `notional`. */
  readonly notional?: number
  /** Order type. */
  readonly type: OrderType
  /** Limit price. */
  readonly limitPrice?: number
  /** Stop price. */
  readonly stopPrice?: number
  /** Time in force. */
  readonly timeInForce: TimeInForce
  /** Equity bracket legs. */
  readonly bracket?: Bracket
  /** Idempotency key; the same key never creates a second order. */
  readonly clientOrderId: ClientOrderId
}

/** Kind of order update; `other` covers broker events the desk only records. */
export type OrderUpdateEvent = 'new' | 'partial_fill' | 'fill' | 'canceled' | 'expired' | 'rejected' | 'other'

/** One order-lifecycle event from the venue's stream. */
export interface OrderUpdate {
  /** Event kind. */
  readonly event: OrderUpdateEvent
  /** Order state after the event. */
  readonly order: BrokerOrder
  /** Event time, UTC epoch milliseconds. */
  readonly t: number
  /** Price of this fill, for fill events. */
  readonly fillPrice?: number
  /** Quantity of this fill, for fill events. */
  readonly fillQty?: number
  /** Position quantity after this fill, for fill events. */
  readonly positionQty?: number
}

/**
 * What an order-update subscriber receives: an update, or a gap after which updates may have been missed (the stream
 * reconnected, or stopped) and the subscriber must re-read open orders and positions. A gap is delivered only after the
 * stream has re-authenticated and is listening again, so a re-read made after it cannot miss updates, or once when the
 * stream stops for good.
 */
export type OrderStreamEvent =
  | { readonly kind: 'update'; readonly update: OrderUpdate }
  | { readonly kind: 'gap'; readonly reason: string }

/**
 * Venue readiness. `unconfigured`: the API keys are missing or setup has not completed yet. `ready`: setup verified
 * the account safety settings. `halted`: halted by the user or by drift. `blocked`: the account cannot be made safe,
 * or the broker refused the safety settings; exits still run, new orders and resume are refused.
 */
export type VenueStatus = 'unconfigured' | 'ready' | 'halted' | 'blocked'

/** Bar history request; without `start` the venue returns the most recent `limit` bars ending at `end` (default now). */
export interface BarQuery {
  /** Earliest bar start, UTC epoch milliseconds. */
  readonly start?: number
  /** Latest bar start, UTC epoch milliseconds. */
  readonly end?: number
  /** Maximum number of bars. */
  readonly limit: number
}
