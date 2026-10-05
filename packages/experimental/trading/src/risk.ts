/**
 * Account- and position-dependent order limits. The executor runs this before
 * asking the user and again after approval; a failed check denies the order
 * without asking. Orders that only reduce an existing position bypass every
 * limit except halt.
 *
 * @module @deepseek-ai/dsh-experimental-trading/risk
 */
import type { OrderRequest, Quote, Side } from './types.ts'

/** User-configured limits; percentages are fractions (`0.2` = 20%). */
export interface RiskLimits {
  /** Largest estimated order value in dollars. */
  readonly maxOrderNotional: number
  /** Largest position value as a fraction of equity, counting open orders and pending proposals. */
  readonly maxPositionPct: number
  /** Day loss, as a fraction of `lastEquity`, at which exposure-increasing orders stop. */
  readonly dailyLossPct: number
  /** Orders per day, counting pending proposals. */
  readonly maxOrdersPerDay: number
  /** Whether sells may open or extend a short position. */
  readonly allowShort: boolean
  /** Whether buys may exceed cash. */
  readonly allowMargin: boolean
  /** Tickers allowed; empty allows every ticker. */
  readonly allowlist: readonly string[]
  /** Tickers never allowed. */
  readonly denylist: readonly string[]
  /** Quote age above which market orders are refused while the market is open. */
  readonly staleQuoteMs: number
}

/** Holdings and in-flight quantities for the order's instrument. */
export interface SymbolExposure {
  /** Signed position quantity; negative is short. */
  readonly positionQty: number
  /** Quantity on open buy orders at the broker. */
  readonly openBuyQty: number
  /** Quantity on open sell orders at the broker. */
  readonly openSellQty: number
  /** Quantity reserved by buy proposals awaiting approval. */
  readonly pendingBuyQty: number
  /** Quantity reserved by sell proposals awaiting approval. */
  readonly pendingSellQty: number
}

/** Account state at check time. */
export interface RiskSnapshot {
  /** Check time, UTC epoch milliseconds. */
  readonly now: number
  /** Latest quote for the order's instrument. */
  readonly quote: Quote
  /** Whether the instrument's market is open (always true for crypto). */
  readonly marketOpen: boolean
  /** Current account equity. */
  readonly equity: number
  /** Cash available for buys. */
  readonly cash: number
  /** Equity at the previous close. */
  readonly lastEquity: number
  /** Value of open buy orders plus pending buy proposals, all instruments. */
  readonly committedBuyNotional: number
  /** Holdings and in-flight quantities for this instrument. */
  readonly exposure: SymbolExposure
  /** Orders submitted today plus pending proposals. */
  readonly ordersToday: number
  /** Whether trading is halted. */
  readonly halted: boolean
}

/** Identifier of one check; `quote` or `size` appears alone when the order cannot be estimated. */
export type RiskCheckId =
  | 'quote'
  | 'size'
  | 'halted'
  | 'symbol-list'
  | 'stale-quote'
  | 'stop-type'
  | 'shorting'
  | 'order-notional'
  | 'position-size'
  | 'cash'
  | 'daily-loss'
  | 'orders-per-day'

/** One check result as shown on the approval card. */
export interface RiskCheck {
  /** Which check. */
  readonly id: RiskCheckId
  /** Whether it passed. */
  readonly ok: boolean
  /** Readable values behind the result. */
  readonly detail: string
}

/** Outcome of {@link checkRisk}. */
export interface RiskResult {
  /** Whether every check passed. */
  readonly ok: boolean
  /** Whether the order only reduces an existing position. */
  readonly reduceOnly: boolean
  /** Order quantity; derived from the notional for notional orders. */
  readonly quantity: number
  /** Price used for estimates: limit, then stop, then ask (buy) or bid (sell); 0 for a reduce-only exit without a usable price. */
  readonly referencePrice: number
  /** Estimated order value in dollars. */
  readonly estimatedNotional: number
  /** Checks in display order. */
  readonly checks: readonly RiskCheck[]
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

/**
 * Whether an order only reduces an existing position, net of open orders and pending proposals on the same side.
 * @param side - order direction.
 * @param quantity - order quantity.
 * @param exposure - holdings and in-flight quantities.
 * @returns true when the order cannot open or extend a position.
 */
export function isReduceOnly(side: Side, quantity: number, exposure: SymbolExposure): boolean {
  if (side === 'sell') return exposure.positionQty > 0 && quantity <= exposure.positionQty - exposure.openSellQty - exposure.pendingSellQty
  return exposure.positionQty < 0 && quantity <= -exposure.positionQty - exposure.openBuyQty - exposure.pendingBuyQty
}

function rejected(check: RiskCheck): RiskResult {
  return { ok: false, reduceOnly: false, quantity: 0, referencePrice: 0, estimatedNotional: 0, checks: [check] }
}

function referencePrice(order: OrderRequest, quote: Quote): number {
  if (order.limitPrice !== undefined) return order.limitPrice
  if (order.stopPrice !== undefined) return order.stopPrice
  return order.side === 'buy' ? quote.ask : quote.bid
}

/**
 * Check an order against the limits.
 * @param order - validated order.
 * @param snapshot - account state at check time.
 * @param limits - configured limits.
 * @returns the decision, the estimates behind it, and every check in display order.
 */
export function checkRisk(order: OrderRequest, snapshot: RiskSnapshot, limits: RiskLimits): RiskResult {
  const ticker = order.symbol.ticker
  const price = referencePrice(order, snapshot.quote)
  const priceUsable = Number.isFinite(price) && price > 0
  const quoteFailure: RiskCheck = { id: 'quote', ok: false, detail: `no usable ${order.side} price for ${ticker}` }
  if (order.notional !== undefined && !priceUsable) return rejected(quoteFailure)
  const quantity = order.notional === undefined ? order.qty ?? 0 : order.notional / price
  if (!(Number.isFinite(quantity) && quantity > 0)) {
    return rejected({ id: 'size', ok: false, detail: 'order size must be a finite number greater than zero' })
  }
  const reduceOnly = isReduceOnly(order.side, quantity, snapshot.exposure)
  if (!priceUsable && !reduceOnly) return rejected(quoteFailure)
  const usedPrice = priceUsable ? price : 0
  const estimatedNotional = order.notional === undefined ? quantity * usedPrice : order.notional
  const checks: RiskCheck[] = []
  const add = (id: RiskCheckId, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail })
  }

  add('halted', !snapshot.halted, snapshot.halted ? 'trading is halted' : 'trading is not halted')
  if (!reduceOnly) {
    const denied = limits.denylist.includes(ticker)
    const listed = limits.allowlist.length === 0 || limits.allowlist.includes(ticker)
    const listDetail = denied ? `${ticker} is on the denylist` : listed ? `${ticker} is allowed` : `${ticker} is not on the allowlist`
    add('symbol-list', listed && !denied, listDetail)

    const age = snapshot.now - snapshot.quote.t
    const stale = order.type === 'market' && snapshot.marketOpen && !(age <= limits.staleQuoteMs)
    add('stale-quote', !stale, Number.isFinite(age) ? `quote is ${Math.round(age / 1000)} s old` : 'quote time is unknown')

    add('stop-type', order.type !== 'stop', order.type === 'stop' ? 'orders that add exposure must use stop_limit' : `${order.type} order`)

    const shortSale = order.side === 'sell'
    add('shorting', !shortSale || limits.allowShort, shortSale ? 'this sell would open or extend a short position' : 'not a short sale')

    const notionalDetail = `order ${USD.format(estimatedNotional)} vs max ${USD.format(limits.maxOrderNotional)}`
    add('order-notional', estimatedNotional <= limits.maxOrderNotional, notionalDetail)

    const exposure = snapshot.exposure
    const projected = order.side === 'buy'
      ? exposure.positionQty + exposure.openBuyQty + exposure.pendingBuyQty + quantity
      : exposure.positionQty - exposure.openSellQty - exposure.pendingSellQty - quantity
    if (snapshot.equity > 0) {
      const share = Math.abs(projected) * price / snapshot.equity
      add('position-size', share <= limits.maxPositionPct, `position ${percent(share)} of equity vs max ${percent(limits.maxPositionPct)}`)
    } else {
      add('position-size', false, `account equity is ${USD.format(snapshot.equity)}`)
    }

    const cashNeeded = order.side === 'buy' ? snapshot.committedBuyNotional + estimatedNotional : 0
    add('cash', limits.allowMargin || cashNeeded <= snapshot.cash, `needs ${USD.format(cashNeeded)} of ${USD.format(snapshot.cash)} cash`)

    const dayChange = snapshot.lastEquity === 0 ? 0 : (snapshot.equity - snapshot.lastEquity) / snapshot.lastEquity
    const dayDetail = Number.isFinite(dayChange) ? percent(dayChange) : 'unknown'
    add('daily-loss', dayChange > -limits.dailyLossPct, `day P&L ${dayDetail} vs limit -${percent(limits.dailyLossPct)}`)

    const countDetail = `${snapshot.ordersToday} of ${limits.maxOrdersPerDay} orders today`
    add('orders-per-day', snapshot.ordersToday < limits.maxOrdersPerDay, countDetail)
  }
  return { ok: checks.every(check => check.ok), reduceOnly, quantity, referencePrice: usedPrice, estimatedNotional, checks }
}
