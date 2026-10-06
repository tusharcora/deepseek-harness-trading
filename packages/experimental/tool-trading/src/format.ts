/**
 * Model-facing texts of the executor and its tools: refusals, the approval summary, fill notices, result renderers, and
 * how venue failures are reported.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/format
 */
import type { BrokerOrder, OrderRequest } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type {
  AccountReport, JournalRow, OrderReport, OrderRow, OrdersReport, PositionReport, QuoteReport, TradingCancelProposal,
  TradingFillEvent, TradingOrderProposal,
} from './types.ts'

/** The venue has no keys (or setup has not completed). */
export const KEYS_MISSING = 'Alpaca keys not configured — add them in Settings → Trading'
/** Orders are refused while the desk is halted. */
export const HALTED = 'trading is halted; only the user can resume trading'
/** Orders are refused while the venue is blocked. */
export const BLOCKED = 'new orders are blocked because the account cannot be made safe; ask the user to check the trading settings'
/** The broker itself blocks trading on the account. */
export const TRADING_BLOCKED = 'the broker blocks trading on this account'
/** The tool body found no checked, approved proposal for its call. */
export const NO_CHECKED_PROPOSAL = 'no checked proposal for this call'
/** Prefix of a post-approval re-check failure. */
export const PRICE_MOVED = 'price moved; propose again'
/** Orders are never auto-approved. */
export const APPROVAL_OFF = "orders need the user's approval, and approval prompts are off in this session"
/** Order tools need a session to record the proposal in. */
export const NO_AGENT = 'placing or cancelling orders needs an agent session'
/** Alpaca's code for a client order id that was already used. */
export const DUPLICATE_CLIENT_ORDER_ID = 40010001

const MAX_MESSAGE = 300
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Drop `undefined` fields so an optional field is absent rather than undefined.
 * @param value - every field of `T`, optional ones possibly undefined.
 * @returns the value without undefined fields.
 */
export function compact<T extends object>(value: { readonly [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as unknown as T
}

/**
 * @param value - dollars.
 * @returns `$1,234.56`.
 */
export function money(value: number): string {
  return USD.format(value)
}

/**
 * Cap a broker message before it reaches the model.
 * @param text - message.
 * @returns at most 300 characters plus an ellipsis.
 */
export function bounded(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE)}…`
}

const words = (status: string): string => status.replaceAll('_', ' ')
const size = (qty: number | undefined, notional: number | undefined): string =>
  qty !== undefined ? String(qty) : `${money(notional ?? 0)} of`
const prices = (limitPrice: number | undefined, stopPrice: number | undefined): string =>
  `${limitPrice === undefined ? '' : ` at ${money(limitPrice)}`}${stopPrice === undefined ? '' : ` stop ${money(stopPrice)}`}`
const percent = (fraction: number): string => `${Number((fraction * 100).toFixed(2))}%`

/**
 * @param order - an order as proposed.
 * @returns `Buy 0.0002 BTC/USD market gtc`.
 */
export function describeOrder(order: OrderRequest): string {
  const side = `${order.side.charAt(0).toUpperCase()}${order.side.slice(1)}`
  const bracket = order.bracket === undefined
    ? ''
    : `, take profit ${money(order.bracket.takeProfit)}, stop loss ${money(order.bracket.stopLoss)}`
  return `${side} ${size(order.qty, order.notional)} ${order.symbol.ticker} ${order.type}${prices(order.limitPrice, order.stopPrice)} `
    + `${order.timeInForce}${bracket}`
}

function brokerOrderText(order: BrokerOrder): string {
  const priced = prices(order.limitPrice, order.stopPrice)
  return `${order.side} ${size(order.qty, order.notional)} ${order.symbol.ticker} ${order.type}${priced} ${order.timeInForce}, `
    + `filled ${order.filledQty}`
}

function capLine(proposal: TradingOrderProposal, tolerance: number): string {
  const { plan, order } = proposal
  if (plan.capped) {
    return `Price cap: sent as a limit order (${plan.timeInForce}) at ${money(plan.limitPrice ?? 0)} so the fill stays within `
      + `${percent(tolerance)} of the approved price.`
  }
  if (order.type !== 'market') return `No price cap needed: a ${order.type} order carries its own price.`
  if (order.notional !== undefined) return 'No price cap: the notional amount caps the cost.'
  return 'No price cap: a reduce-only exit is sent as a market order so it fills in a fast move.'
}

/**
 * The approval reason for an order proposal: mode and order, estimate and quote, the price cap, a closed-market note,
 * every passed check, and the rationale.
 * @param proposal - the checked proposal (every check passed).
 * @param tolerance - drift tolerance, for the cap line.
 * @returns one line per item.
 */
export function proposalSummary(proposal: TradingOrderProposal, tolerance: number): string {
  return [
    `${proposal.mode.toUpperCase()} ${describeOrder(proposal.order)}`,
    `Estimated ${money(proposal.estimatedNotional)} (${(proposal.equityPct * 100).toFixed(1)}% of equity); `
      + `bid ${money(proposal.quote.bid)} / ask ${money(proposal.quote.ask)}`,
    capLine(proposal, tolerance),
    ...proposal.order.symbol.assetClass === 'equity' && !proposal.marketOpen
      ? ['The market is closed: the order is queued until market open.']
      : [],
    `Checks passed: ${proposal.checks.map(check => `${check.id} (${check.detail})`).join('; ')}`,
    `Rationale: ${proposal.rationale}`,
  ].join('\n')
}

/**
 * @param proposal - the checked cancellation.
 * @returns the approval reason for a cancellation.
 */
export function cancelSummary(proposal: TradingCancelProposal): string {
  return `${proposal.mode.toUpperCase()} Cancel order ${proposal.order.id}: ${brokerOrderText(proposal.order)}\n`
    + `Rationale: ${proposal.rationale}`
}

/**
 * @param fill - one recorded fill.
 * @returns the message the proposing agent receives with its next request.
 */
export function fillText(fill: TradingFillEvent): string {
  const price = fill.fillPrice === undefined ? 'at an unreported price' : `at ${money(fill.fillPrice)}`
  return `Order update: your ${fill.side} of ${fill.ticker} (order ${fill.orderId}) filled ${fill.fillQty} ${price}; `
    + `${fill.filledQty} filled in total, order ${words(fill.status)}.`
}

/**
 * How a failed submission is reported. An unknown outcome and a reused client order id may mean the order exists, so
 * neither is reported as "not placed".
 * @param error - what the venue (or the re-check) threw.
 * @returns the journal outcome and the model-facing message.
 */
export function failureOf(error: unknown): { readonly outcome: 'failed' | 'unknown'; readonly message: string } {
  if (error instanceof VenueError) {
    if (error.code === 'unknown-outcome') {
      const message = `the order outcome is unknown: ${bounded(error.message)}. Check list_orders before proposing again.`
      return { outcome: 'unknown', message }
    }
    if (error.code === 'rejected' && error.brokerCode === DUPLICATE_CLIENT_ORDER_ID) {
      return {
        outcome: 'unknown',
        message: 'the broker reports this order id as already used but does not show the order; check list_orders before proposing again',
      }
    }
  }
  return { outcome: 'failed', message: bounded(error instanceof Error ? error.message : String(error)) }
}

/**
 * @param error - a submission failure.
 * @returns whether the broker refused for insufficient balance (coins from a fill not yet released).
 */
export function isInsufficientBalance(error: unknown): boolean {
  return error instanceof VenueError && error.code === 'rejected' && /insufficient balance/i.test(error.message)
}

/**
 * @param report - `get_quote` result.
 * @returns model-facing text.
 */
export function renderQuote(report: QuoteReport): string {
  const market = report.marketOpen ? 'market open' : 'market closed — new orders queue until it opens'
  return `${report.symbol} bid ${money(report.bid)} ask ${money(report.ask)} (mid ${money(report.mid)}); `
    + `quote ${report.ageSeconds} s old; ${market}.`
}

/**
 * @param report - `get_account` result.
 * @returns model-facing text.
 */
export function renderAccount(report: AccountReport): string {
  return `${report.mode.toUpperCase()} account, ${report.status}: equity ${money(report.equity)}, cash ${money(report.cash)}, `
    + `buying power ${money(report.buyingPower)}, day P&L ${money(report.dayPl)} (${report.dayPlPct.toFixed(2)}%).`
    + (report.tradingBlocked ? ' The broker blocks trading on this account.' : '')
}

/**
 * @param rows - `get_positions` result.
 * @returns model-facing text, one line per position.
 */
export function renderPositions(rows: readonly PositionReport[]): string {
  if (rows.length === 0) return 'No open positions.'
  return rows.map(row => `${row.symbol}: qty ${row.qty} (${row.qtyAvailable} available), average entry ${money(row.avgEntryPrice)}, `
    + `now ${money(row.currentPrice)}, value ${money(row.marketValue)}, unrealized ${money(row.unrealizedPl)}`).join('\n')
}

function openRow(row: OrderRow): string {
  return `- ${row.orderId}: ${row.side} ${size(row.qty, row.notional)} ${row.symbol} ${row.type}${prices(row.limitPrice, row.stopPrice)} `
    + `${row.timeInForce}, filled ${row.filledQty}, ${words(row.status)}`
}

function journalRow(row: JournalRow): string {
  const average = row.filledAvgPrice === undefined ? '' : ` at ${money(row.filledAvgPrice)}`
  const order = row.orderId === undefined ? '' : ` (order ${row.orderId})`
  const note = row.note === undefined ? '' : ` — ${row.note}`
  return `- ${row.proposalId}: ${row.side} ${size(row.qty, row.notional)} ${row.symbol}: ${words(row.status)}, ${row.filledQty} filled`
    + `${average}${order}${note}`
}

/**
 * @param report - `list_orders` result.
 * @returns model-facing text: open broker orders, then today's desk orders.
 */
export function renderOrders(report: OrdersReport): string {
  return [
    ...report.open.length === 0 ? ['No open orders.'] : ['Open orders:', ...report.open.map(openRow)],
    ...report.today.length === 0 ? ['No desk orders today.'] : ['Desk orders today:', ...report.today.map(journalRow)],
  ].join('\n')
}

/**
 * @param report - `place_order` or `cancel_order` result.
 * @returns model-facing text.
 */
export function renderOrderReport(report: OrderReport): string {
  if (report.status === 'cancel_requested') return `Cancellation requested for order ${report.orderId} (${report.side} ${report.symbol}).`
  const how = report.capped
    ? `as a limit${prices(report.limitPrice, undefined)} (${report.timeInForce}), capped near the approved price`
    : `${report.type}${prices(report.limitPrice, report.stopPrice)} (${report.timeInForce})`
  const fill = report.filledQty > 0
    ? `; ${report.filledQty} filled${report.filledAvgPrice === undefined ? '' : ` at ${money(report.filledAvgPrice)}`}`
    : ''
  return `Placed ${report.side} ${size(report.qty, report.notional)} ${report.symbol} ${how}; order ${report.orderId} is `
    + `${words(report.status)}${fill}.`
}
