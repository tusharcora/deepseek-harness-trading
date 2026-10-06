/**
 * Account state for one risk check, and the order math between a checked proposal and the broker request.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/snapshot
 */
import {
  type AccountSnapshot, type BrokerOrder, type BrokerOrderRequest, type ClientOrderId, isReduceOnly, type OrderRequest,
  planSubmission, type ProposalId, type Quote, type RiskSnapshot, type SubmissionPlan, type SymbolExposure, type TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'
import type { TradingVenueGateway } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { ProposalBook } from './book.ts'
import { tradingDay } from './ids.ts'
import type { Journal } from './journal.ts'

/** Venue reads one snapshot needs. */
export type SnapshotVenue = Pick<TradingVenueGateway, 'latestQuote' | 'marketOpen' | 'account' | 'positions' | 'openOrders' | 'status'>

/** Inputs of one snapshot. */
export interface SnapshotSources {
  /** The venue, read fresh for every snapshot. */
  readonly venue: SnapshotVenue
  /** Pending proposals and their reservations. */
  readonly book: ProposalBook
  /** Journal for today's order count. */
  readonly journal: Pick<Journal, 'submittedOn'>
  /** Check time, UTC epoch milliseconds. */
  readonly now: number
  /** Proposal to leave out of the reservations (the one being re-checked). */
  readonly excluding?: ProposalId
}

/** Everything one risk check reads. */
export interface DeskSnapshot {
  /** `checkRisk` input. */
  readonly risk: RiskSnapshot
  /** Account values. */
  readonly account: AccountSnapshot
  /** Latest quote. */
  readonly quote: Quote
  /** Whether the instrument's market is open. */
  readonly marketOpen: boolean
}

/**
 * Quantity an open order may still fill.
 * @param order - open order.
 * @param price - price to convert a notional order's remaining value; 0 when unknown.
 * @returns remaining quantity, never negative.
 */
export function remainingQty(order: BrokerOrder, price: number): number {
  if (order.qty !== undefined) return Math.max(order.qty - order.filledQty, 0)
  if (order.notional !== undefined && price > 0) return Math.max(order.notional / price - order.filledQty, 0)
  return 0
}

/**
 * Open buy and sell quantities for one instrument.
 * @param orders - open orders.
 * @param ticker - instrument ticker.
 * @param price - the instrument's current mid, for notional orders.
 * @returns open quantities as if filled.
 */
export function openExposure(orders: readonly BrokerOrder[], ticker: string, price: number): { openBuyQty: number; openSellQty: number } {
  let openBuyQty = 0
  let openSellQty = 0
  for (const order of orders) {
    if (order.symbol.ticker !== ticker) continue
    if (order.side === 'buy') openBuyQty += remainingQty(order, price)
    else openSellQty += remainingQty(order, price)
  }
  return { openBuyQty, openSellQty }
}

/**
 * Value of open buy orders across instruments: the unfilled notional, else remaining quantity at the limit or stop
 * price. An open market buy without either counts as 0.
 * @param orders - open orders.
 * @returns dollars committed to open buys.
 */
export function openBuyNotional(orders: readonly BrokerOrder[]): number {
  return orders.filter(order => order.side === 'buy').reduce((sum, order) => {
    if (order.notional !== undefined) return sum + Math.max(order.notional - order.filledQty * (order.filledAvgPrice ?? 0), 0)
    const price = order.limitPrice ?? order.stopPrice ?? 0
    return sum + remainingQty(order, price) * price
  }, 0)
}

/**
 * Read everything one risk check needs, in parallel, and add the reservations and today's count.
 * @param symbol - instrument of the order.
 * @param sources - venue, book, journal, clock, and an optional proposal to leave out.
 * @returns the snapshot.
 */
export async function takeSnapshot(symbol: TradingSymbol, sources: SnapshotSources): Promise<DeskSnapshot> {
  const { venue, book, journal, now, excluding } = sources
  const [quote, marketOpen, account, positions, orders] = await Promise.all([
    venue.latestQuote(symbol), venue.marketOpen(symbol), venue.account(), venue.positions(), venue.openOrders(),
  ])
  const position = positions.find(candidate => candidate.symbol.ticker === symbol.ticker)
  const open = openExposure(orders, symbol.ticker, (quote.bid + quote.ask) / 2)
  return {
    quote, marketOpen, account,
    risk: {
      now, quote, marketOpen, equity: account.equity, cash: account.cash, lastEquity: account.lastEquity,
      committedBuyNotional: openBuyNotional(orders) + book.pendingBuyNotional(excluding),
      exposure: { positionQty: position?.qty ?? 0, ...open, ...book.exposure(symbol.ticker, excluding) },
      ordersToday: journal.submittedOn(tradingDay(now)) + book.pendingOrders(excluding),
      halted: venue.status() === 'halted',
    },
  }
}

const qtyText = (value: number): string => String(Number(value.toFixed(8)))

/**
 * Why a sell the position would cover is not an exit: open sell orders, or sell proposals awaiting approval, already
 * claim the shares or coins it would sell. The risk check then fails it as a short sale; these reasons say what to do.
 * @param order - proposed order.
 * @param quantity - its quantity from the risk check.
 * @param exposure - holdings and in-flight quantities from the snapshot.
 * @returns one reason per claim; empty when the order is not such a sell.
 */
export function heldBySells(order: OrderRequest, quantity: number, exposure: SymbolExposure): string[] {
  if (order.side !== 'sell' || !(exposure.positionQty > 0) || quantity > exposure.positionQty) return []
  if (isReduceOnly('sell', quantity, exposure)) return []
  const ticker = order.symbol.ticker
  return [
    ...exposure.openSellQty > 0 ? [`${qtyText(exposure.openSellQty)} ${ticker} is held by open sell orders; cancel them first`] : [],
    ...exposure.pendingSellQty > 0
      ? [`${qtyText(exposure.pendingSellQty)} ${ticker} is reserved by sell proposals awaiting approval; wait for their decision first`]
      : [],
  ]
}

/**
 * Whether the price moved beyond the tolerance since approval. Unpriced sides are left to the risk check.
 * @param approved - reference price on the approved proposal.
 * @param current - reference price at the re-check.
 * @param tolerance - allowed drift as a fraction.
 * @returns true when both prices are usable and differ by more than the tolerance.
 */
export function drifted(approved: number, current: number, tolerance: number): boolean {
  return approved > 0 && current > 0 && Math.abs(current - approved) / approved > tolerance
}

/**
 * Plan the broker order, refusing an approved price that cannot cap a market order and a cap that rounds to zero.
 * @param order - approved order.
 * @param approvedPrice - reference price on the approved proposal.
 * @param tolerance - drift tolerance.
 * @param reduceOnly - whether the order only reduces a position, from the latest check.
 * @param increment - price tick.
 * @returns the broker-facing type, prices, and time in force.
 * @throws Error with a model-facing reason.
 */
export function planOrder(
  order: OrderRequest, approvedPrice: number, tolerance: number, reduceOnly: boolean, increment: number,
): SubmissionPlan {
  const caps = order.type === 'market' && order.notional === undefined && !reduceOnly
  if (caps && !(Number.isFinite(approvedPrice) && approvedPrice > 0)) {
    throw new Error('the approved price is not usable for a price cap; propose again')
  }
  const plan = planSubmission(order, approvedPrice, tolerance, reduceOnly, increment)
  if (plan.capped && !(plan.limitPrice !== undefined && plan.limitPrice > 0)) {
    throw new Error('the price cap rounds to zero at this price tick; propose a limit order instead')
  }
  return plan
}

/**
 * The request sent to the venue: exactly the one size the order carries, the planned type and prices, and the key.
 * @param order - approved order.
 * @param plan - planned broker fields.
 * @param clientOrderId - idempotency key.
 * @returns the broker request.
 */
export function brokerRequest(order: OrderRequest, plan: SubmissionPlan, clientOrderId: ClientOrderId): BrokerOrderRequest {
  return {
    symbol: order.symbol,
    side: order.side,
    ...order.qty === undefined ? {} : { qty: order.qty },
    ...order.notional === undefined ? {} : { notional: order.notional },
    type: plan.type,
    ...plan.limitPrice === undefined ? {} : { limitPrice: plan.limitPrice },
    ...plan.stopPrice === undefined ? {} : { stopPrice: plan.stopPrice },
    timeInForce: plan.timeInForce,
    ...order.bracket === undefined ? {} : { bracket: order.bracket },
    clientOrderId,
  }
}
