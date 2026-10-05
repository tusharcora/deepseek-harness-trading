/**
 * Converting an approved order into what is sent to the broker. A
 * quantity-based market order that adds exposure becomes a marketable limit at
 * the approved price plus (buy) or minus (sell) the drift tolerance, so the
 * broker enforces the approved notional. Reduce-only exits and notional orders
 * stay market orders.
 *
 * @module @deepseek-ai/dsh-experimental-trading/submission
 */
import type { OrderRequest, OrderType, TimeInForce } from './types.ts'

/** Broker-facing order type, prices, and time in force. */
export interface SubmissionPlan {
  /** Order type sent to the broker. */
  readonly type: OrderType
  /** Limit price sent to the broker, when the type has one. */
  readonly limitPrice?: number
  /** Stop price sent to the broker, when the type has one. */
  readonly stopPrice?: number
  /** Time in force sent to the broker. */
  readonly timeInForce: TimeInForce
  /** Whether a market order was converted to a capped limit. */
  readonly capped: boolean
}

function toTick(value: number, increment: number, direction: 'down' | 'up'): number {
  const steps = direction === 'down' ? Math.floor(value / increment + 1e-9) : Math.ceil(value / increment - 1e-9)
  return Number((steps * increment).toFixed(10))
}

/**
 * Plan the broker order for an approved proposal.
 * @param order - approved order.
 * @param approvedPrice - reference price shown on the approved card.
 * @param tolerance - allowed drift as a fraction in [0, 1).
 * @param reduceOnly - whether the order only reduces a position.
 * @param priceIncrement - the instrument's price tick.
 * @returns the broker-facing order fields.
 * @throws RangeError for a tolerance outside [0, 1) or a non-positive tick.
 */
export function planSubmission(
  order: OrderRequest,
  approvedPrice: number,
  tolerance: number,
  reduceOnly: boolean,
  priceIncrement: number,
): SubmissionPlan {
  if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError(`tolerance must be in [0, 1), got ${tolerance}`)
  if (!(priceIncrement > 0)) throw new RangeError(`price increment must be greater than zero, got ${priceIncrement}`)
  if (order.type !== 'market' || order.notional !== undefined || reduceOnly) {
    return {
      type: order.type,
      ...order.limitPrice === undefined ? {} : { limitPrice: order.limitPrice },
      ...order.stopPrice === undefined ? {} : { stopPrice: order.stopPrice },
      timeInForce: order.timeInForce,
      capped: false,
    }
  }
  const limitPrice = order.side === 'buy'
    ? toTick(approvedPrice * (1 + tolerance), priceIncrement, 'down')
    : toTick(approvedPrice * (1 - tolerance), priceIncrement, 'up')
  return { type: 'limit', limitPrice, timeInForce: order.symbol.assetClass === 'crypto' ? 'ioc' : 'day', capped: true }
}
