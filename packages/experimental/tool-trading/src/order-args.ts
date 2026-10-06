/**
 * Parsing of `place_order` and `cancel_order` arguments into domain values. The pre-execute listener reads the raw
 * model JSON before the registry validates it against the tool schema, so every field is checked here.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/order-args
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  type BrokerOrderId, type OrderRequest, type OrderType, parseSymbol, type Side, type TimeInForce, type TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'

/** Longest accepted rationale, in characters. */
export const MAX_RATIONALE = 600

const SIDES: readonly Side[] = ['buy', 'sell']
const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop', 'stop_limit']
const TIME_IN_FORCE: readonly TimeInForce[] = ['day', 'gtc', 'ioc']

/** A parsed value, or every reason the input was refused. */
export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasons: readonly string[] }

/** A proposed order and its rationale. */
export interface ProposedOrder {
  /** The order. */
  readonly order: OrderRequest
  /** Trimmed rationale. */
  readonly rationale: string
}

/** A proposed cancellation and its rationale. */
export interface ProposedCancel {
  /** Broker order id to cancel. */
  readonly orderId: BrokerOrderId
  /** Trimmed rationale. */
  readonly rationale: string
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string, reasons: string[]): T | undefined {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  reasons.push(`${name} must be one of ${allowed.join(', ')}`)
  return undefined
}

function optionalNumber(args: Record<string, unknown>, key: string, reasons: string[]): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  reasons.push(`${key} must be a finite number`)
  return undefined
}

// C0 and C1 controls (CR, LF, tab, bell, …), Unicode line and paragraph separators, and the next-line character.
const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/**
 * The rationale as one line: control characters and line or paragraph separators become spaces and runs of whitespace
 * collapse, so model text cannot add lines (such as fake check results) to the approval reason. Applied before the cap.
 */
function rationaleOf(value: unknown, reasons: string[]): string {
  const text = typeof value === 'string' ? value.replace(LINE_BREAKS_AND_CONTROLS, ' ').replace(/\s+/g, ' ').trim() : ''
  if (text.length === 0) reasons.push('rationale must be one to three sentences explaining why')
  else if (text.length > MAX_RATIONALE) reasons.push(`rationale must be at most ${MAX_RATIONALE} characters`)
  return text
}

/**
 * Parse a model-typed instrument name.
 * @param value - `AAPL`, `BTC/USD`, or `BTCUSD`.
 * @returns the canonical symbol.
 * @throws Error with a model-facing reason.
 */
export function symbolOf(value: unknown): TradingSymbol {
  if (typeof value !== 'string') throw new Error('symbol must be a ticker such as AAPL or BTC/USD')
  try {
    return parseSymbol(value)
  } catch {
    // parseSymbol's RangeError names only the upper-cased input; the model needs the accepted forms.
    throw new Error(`symbol ${JSON.stringify(value)} is not a US stock ticker or a supported crypto pair such as BTC/USD`)
  }
}

/**
 * Parse `place_order` arguments.
 * @param input - raw tool arguments.
 * @returns the proposed order, or every reason it was refused.
 */
export function parsePlaceOrder(input: unknown): ParseResult<ProposedOrder> {
  const args = record(input)
  if (args === undefined) return { ok: false, reasons: ['arguments must be an object'] }
  const reasons: string[] = []
  let symbol: TradingSymbol | undefined
  try {
    symbol = symbolOf(args.symbol)
  } catch (error) {
    reasons.push((error as Error).message)
  }
  const side = oneOf(args.side, SIDES, 'side', reasons)
  const type = oneOf(args.type, ORDER_TYPES, 'type', reasons)
  const timeInForce = oneOf(args.time_in_force, TIME_IN_FORCE, 'time_in_force', reasons)
  const qty = optionalNumber(args, 'qty', reasons)
  const notional = optionalNumber(args, 'notional', reasons)
  const limitPrice = optionalNumber(args, 'limit_price', reasons)
  const stopPrice = optionalNumber(args, 'stop_price', reasons)
  const takeProfit = optionalNumber(args, 'take_profit', reasons)
  const stopLoss = optionalNumber(args, 'stop_loss', reasons)
  if ((takeProfit === undefined) !== (stopLoss === undefined)) reasons.push('a bracket needs both take_profit and stop_loss')
  const rationale = rationaleOf(args.rationale, reasons)
  if (symbol === undefined || side === undefined || type === undefined || timeInForce === undefined || reasons.length > 0) {
    return { ok: false, reasons }
  }
  const order: OrderRequest = {
    symbol, side, type, timeInForce,
    ...qty === undefined ? {} : { qty },
    ...notional === undefined ? {} : { notional },
    ...limitPrice === undefined ? {} : { limitPrice },
    ...stopPrice === undefined ? {} : { stopPrice },
    ...takeProfit === undefined || stopLoss === undefined ? {} : { bracket: { takeProfit, stopLoss } },
  }
  return { ok: true, value: { order, rationale } }
}

/**
 * Parse `cancel_order` arguments.
 * @param input - raw tool arguments.
 * @returns the proposed cancellation, or every reason it was refused.
 */
export function parseCancelOrder(input: unknown): ParseResult<ProposedCancel> {
  const args = record(input)
  if (args === undefined) return { ok: false, reasons: ['arguments must be an object'] }
  const reasons: string[] = []
  const id = typeof args.order_id === 'string' ? args.order_id.trim() : ''
  if (id.length === 0) reasons.push('order_id must be an order id from list_orders')
  const rationale = rationaleOf(args.rationale, reasons)
  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, value: { orderId: brandString<BrokerOrderId>(id), rationale } }
}

/**
 * Prices that are not a whole number of price ticks, so a sub-penny price is a tool error rather than a broker rejection.
 * @param order - order as proposed.
 * @param increment - the instrument's price tick; a non-positive tick skips the check.
 * @returns one reason per off-tick price.
 */
export function tickViolations(order: OrderRequest, increment: number): string[] {
  if (!(increment > 0)) return []
  const prices: [string, number | undefined][] = [
    ['limit_price', order.limitPrice], ['stop_price', order.stopPrice],
    ['take_profit', order.bracket?.takeProfit], ['stop_loss', order.bracket?.stopLoss],
  ]
  return prices.flatMap(([name, price]) => {
    if (price === undefined) return []
    const steps = price / increment
    return Math.abs(steps - Math.round(steps)) > 1e-6 ? [`${name} ${price} is not a multiple of the ${increment} price tick`] : []
  })
}
