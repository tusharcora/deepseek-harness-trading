/**
 * Static order validation against Alpaca's order rules. Position- and
 * account-dependent rules live in the risk policy.
 *
 * @module @deepseek-ai/dsh-experimental-trading/validation
 */
import type { Asset, OrderRequest } from './types.ts'

/** Which rule an order broke. */
export type OrderViolationCode =
  | 'symbol-mismatch'
  | 'not-tradable'
  | 'size'
  | 'below-minimum'
  | 'price-fields'
  | 'notional-type'
  | 'order-type'
  | 'time-in-force'
  | 'fractional'
  | 'bracket'

/** One broken rule with a message the model and the user can read. */
export interface OrderViolation {
  /** Broken rule. */
  readonly code: OrderViolationCode
  /** Readable reason. */
  readonly message: string
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * Check an order against the broker's static rules.
 * @param order - order as proposed.
 * @param asset - broker facts for the order's instrument.
 * @returns every broken rule; an empty array means the order is valid.
 */
export function validateOrder(order: OrderRequest, asset: Asset): OrderViolation[] {
  const violations: OrderViolation[] = []
  const add = (code: OrderViolationCode, message: string): void => {
    violations.push({ code, message })
  }
  const ticker = order.symbol.ticker
  if (asset.symbol.ticker !== ticker) add('symbol-mismatch', `asset ${asset.symbol.ticker} does not describe ${ticker}`)
  if (!asset.tradable) add('not-tradable', `${ticker} is not tradable now`)

  const sizes = [order.qty, order.notional].filter(value => value !== undefined)
  if (sizes.length !== 1) add('size', 'give exactly one of qty or notional')
  else if (!sizes.every(positiveFinite)) add('size', 'size must be a finite number greater than zero')
  if (order.qty !== undefined && asset.minOrderSize !== undefined && order.qty < asset.minOrderSize) {
    add('below-minimum', `minimum order size for ${ticker} is ${asset.minOrderSize}`)
  }

  const needsLimit = order.type === 'limit' || order.type === 'stop_limit'
  const needsStop = order.type === 'stop' || order.type === 'stop_limit'
  if (needsLimit !== (order.limitPrice !== undefined)) {
    add('price-fields', needsLimit ? `${order.type} orders need limit_price` : `${order.type} orders take no limit_price`)
  }
  if (needsStop !== (order.stopPrice !== undefined)) {
    add('price-fields', needsStop ? `${order.type} orders need stop_price` : `${order.type} orders take no stop_price`)
  }
  const prices = [order.limitPrice, order.stopPrice].filter(value => value !== undefined)
  if (!prices.every(positiveFinite)) add('price-fields', 'prices must be finite numbers greater than zero')
  if (order.notional !== undefined && order.type !== 'market') add('notional-type', 'notional orders must be market orders')

  if (order.symbol.assetClass === 'crypto') {
    if (order.type === 'stop') add('order-type', 'crypto orders support market, limit, and stop_limit; use stop_limit instead of stop')
    if (order.timeInForce === 'day') add('time-in-force', 'crypto orders use gtc or ioc')
    if (order.bracket !== undefined) add('bracket', 'brackets are available for equities only')
    return violations
  }

  const fractional = order.notional !== undefined || (order.qty !== undefined && !Number.isInteger(order.qty))
  if (fractional) {
    if (!asset.fractionable) add('fractional', `${ticker} does not support fractional or notional orders`)
    else if (order.timeInForce !== 'day') add('fractional', 'fractional and notional equity orders are day orders')
  }
  if (order.bracket !== undefined) {
    if (fractional) add('bracket', 'brackets need a whole-share quantity')
    const { takeProfit, stopLoss } = order.bracket
    if (order.side === 'buy' && takeProfit <= stopLoss) add('bracket', 'take_profit must be above stop_loss for a buy')
    if (order.side === 'sell' && takeProfit >= stopLoss) add('bracket', 'take_profit must be below stop_loss for a sell')
  }
  return violations
}
