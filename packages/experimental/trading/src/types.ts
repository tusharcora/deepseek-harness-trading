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
