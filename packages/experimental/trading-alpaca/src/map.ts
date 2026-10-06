/**
 * Alpaca JSON → trading domain values. Every number is checked: a malformed
 * value raises VenueError('unavailable') instead of becoming NaN.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/map
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  parseSymbol, type AccountSnapshot, type Asset, type Bar, type BrokerOrder, type BrokerOrderId, type ClientOrderId,
  type OrderStatus, type OrderType, type OrderUpdate, type OrderUpdateEvent, type PositionSnapshot, type Quote,
  type Side, type Timeframe, type TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { RawRecord } from './types.ts'

/** Alpaca timeframe codes for each desk timeframe. */
export const ALPACA_TIMEFRAMES: Readonly<Record<Timeframe, string>> = {
  '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', '4h': '4Hour', '1D': '1Day', '1W': '1Week',
}

const ORDER_STATUS: ReadonlyMap<string, OrderStatus> = new Map([
  ['filled', 'filled'], ['partially_filled', 'partially_filled'], ['canceled', 'canceled'], ['replaced', 'canceled'],
  ['expired', 'expired'], ['rejected', 'rejected'],
])
const ORDER_TYPES: readonly string[] = ['market', 'limit', 'stop', 'stop_limit']
const UPDATE_EVENTS: readonly string[] = ['new', 'partial_fill', 'fill', 'canceled', 'expired', 'rejected']

/**
 * Read a decimal string or JSON number.
 * @param value - raw field.
 * @param field - Alpaca field name, for the error message.
 * @returns the finite number.
 * @throws VenueError when the value is not a finite number.
 */
export function decimal(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new VenueError(`Alpaca returned a malformed ${field}`, 'unavailable')
  return parsed
}

/**
 * Read a nullable decimal.
 * @param value - raw field.
 * @param field - Alpaca field name.
 * @returns the number, or undefined for null or absent.
 */
export function optionalDecimal(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : decimal(value, field)
}

/**
 * Read an RFC 3339 timestamp.
 * @param value - raw field.
 * @param field - Alpaca field name.
 * @returns UTC epoch milliseconds.
 */
export function timestamp(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new VenueError(`Alpaca returned a malformed ${field}`, 'unavailable')
  return parsed
}

/**
 * Format a number as a plain decimal string for an Alpaca request body.
 * @param value - finite number.
 * @returns the decimal text without exponent notation.
 * @throws RangeError for a non-finite value.
 */
export function decimalString(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`cannot send ${String(value)} to Alpaca`)
  const written = String(value)
  const exponentAt = written.indexOf('e')
  if (exponentAt === -1) return written
  const sign = written.startsWith('-') ? '-' : ''
  const mantissa = written.slice(sign.length, exponentAt)
  const pointAt = mantissa.indexOf('.')
  const digits = mantissa.replace('.', '')
  const point = (pointAt === -1 ? mantissa.length : pointAt) + Number(written.slice(exponentAt + 1))
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  return `${sign}${digits}${'0'.repeat(point - digits.length)}`
}

/**
 * Write a symbol as an Alpaca URL path segment; crypto pairs use the joined form Alpaca documents as accepted.
 * @param symbol - instrument.
 * @returns the path segment.
 */
export function pathSymbol(symbol: TradingSymbol): string {
  return symbol.ticker.replace('/', '')
}

/**
 * Read a required text field.
 * @param value - raw field.
 * @param field - Alpaca field name, for the error message.
 * @returns the non-empty string.
 * @throws VenueError when the value is absent, empty, or not a string.
 */
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new VenueError(`Alpaca returned a malformed ${field}`, 'unavailable')
  return value
}

function positionSign(side: unknown, qty: number): 1 | -1 {
  if (side === 'short') return -1
  if (side !== 'long') throw new VenueError('Alpaca returned a malformed side', 'unavailable')
  if (qty < 0) throw new VenueError('Alpaca returned a malformed qty', 'unavailable')
  return 1
}

function orderSide(value: unknown): Side {
  if (value === 'buy' || value === 'sell') return value
  throw new VenueError('Alpaca returned a malformed side', 'unavailable')
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : timestamp(value, field)
}

/**
 * Normalize an Alpaca symbol.
 * @param raw - symbol as Alpaca wrote it (`AAPL`, `BTCUSD`, `BTC/USD`).
 * @param assetClass - Alpaca asset class.
 * @returns the canonical symbol.
 * @throws VenueError for asset classes other than `us_equity` and `crypto`, or a malformed crypto symbol.
 */
export function venueSymbol(raw: string, assetClass: string): TradingSymbol {
  if (assetClass === 'us_equity') return { assetClass: 'equity', ticker: raw.toUpperCase() }
  if (assetClass !== 'crypto') {
    throw new VenueError(`${raw} is a ${assetClass} asset; the desk trades US equities and crypto only`, 'rejected')
  }
  const symbol = parseSymbol(raw)
  if (symbol.assetClass !== 'crypto') throw new VenueError(`Alpaca returned a malformed crypto symbol ${raw}`, 'unavailable')
  return symbol
}

/**
 * Map GET /v2/account.
 * @param raw - account JSON.
 * @returns the account snapshot.
 */
export function mapAccount(raw: RawRecord): AccountSnapshot {
  return {
    equity: decimal(raw.equity, 'equity'),
    cash: decimal(raw.cash, 'cash'),
    lastEquity: decimal(raw.last_equity, 'last_equity'),
    buyingPower: decimal(raw.buying_power, 'buying_power'),
    tradingBlocked: raw.trading_blocked === true || raw.account_blocked === true || raw.trade_suspended_by_user === true,
  }
}

/**
 * Map one position.
 * @param raw - position JSON.
 * @returns the position with signed quantity and signed sellable quantity (`qty_available`).
 */
export function mapPosition(raw: RawRecord): PositionSnapshot {
  const qty = decimal(raw.qty, 'qty')
  const qtyAvailable = decimal(raw.qty_available, 'qty_available')
  return {
    symbol: venueSymbol(text(raw.symbol, 'symbol'), text(raw.asset_class, 'asset_class')),
    qty: positionSign(raw.side, qty) * Math.abs(qty),
    qtyAvailable: positionSign(raw.side, qtyAvailable) * Math.abs(qtyAvailable),
    avgEntryPrice: decimal(raw.avg_entry_price, 'avg_entry_price'),
    currentPrice: decimal(raw.current_price, 'current_price'),
    marketValue: decimal(raw.market_value, 'market_value'),
    unrealizedPl: decimal(raw.unrealized_pl, 'unrealized_pl'),
  }
}

/**
 * Map one order.
 * @param raw - order JSON.
 * @returns the broker order.
 */
export function mapOrder(raw: RawRecord): BrokerOrder {
  const qty = optionalDecimal(raw.qty, 'qty')
  const notional = optionalDecimal(raw.notional, 'notional')
  const limitPrice = optionalDecimal(raw.limit_price, 'limit_price')
  const stopPrice = optionalDecimal(raw.stop_price, 'stop_price')
  const filledAvgPrice = optionalDecimal(raw.filled_avg_price, 'filled_avg_price')
  const submittedAt = optionalTimestamp(raw.submitted_at, 'submitted_at')
  const type = text(raw.type, 'type')
  return {
    id: brandString<BrokerOrderId>(text(raw.id, 'id')),
    clientOrderId: brandString<ClientOrderId>(text(raw.client_order_id, 'client_order_id')),
    symbol: venueSymbol(text(raw.symbol, 'symbol'), text(raw.asset_class, 'asset_class')),
    side: orderSide(raw.side),
    type: ORDER_TYPES.includes(type) ? type as OrderType : 'other',
    timeInForce: text(raw.time_in_force, 'time_in_force'),
    ...qty === undefined ? {} : { qty },
    ...notional === undefined ? {} : { notional },
    ...limitPrice === undefined ? {} : { limitPrice },
    ...stopPrice === undefined ? {} : { stopPrice },
    filledQty: decimal(raw.filled_qty, 'filled_qty'),
    ...filledAvgPrice === undefined ? {} : { filledAvgPrice },
    status: ORDER_STATUS.get(text(raw.status, 'status')) ?? 'open',
    ...submittedAt === undefined ? {} : { submittedAt },
  }
}

/**
 * Map GET /v2/assets/{symbol}.
 * @param raw - asset JSON.
 * @param cryptoMinNotional - minimum crypto order value in dollars, which Alpaca enforces but does not publish on the asset.
 * @returns broker facts for validation; equities use a one-cent tick and carry no minimum value.
 */
export function mapAsset(raw: RawRecord, cryptoMinNotional: number): Asset {
  const symbol = venueSymbol(text(raw.symbol, 'symbol'), text(raw.class, 'class'))
  const minOrderSize = optionalDecimal(raw.min_order_size, 'min_order_size')
  return {
    symbol,
    tradable: raw.tradable === true && text(raw.status, 'status') === 'active',
    fractionable: raw.fractionable === true,
    ...minOrderSize === undefined ? {} : { minOrderSize },
    ...symbol.assetClass === 'crypto' ? { minNotional: cryptoMinNotional } : {},
    priceIncrement: symbol.assetClass === 'crypto' ? decimal(raw.price_increment, 'price_increment') : 0.01,
  }
}

/**
 * Map one market-data bar.
 * @param raw - bar JSON.
 * @returns the bar.
 */
export function mapBar(raw: RawRecord): Bar {
  return {
    t: timestamp(raw.t, 't'),
    o: decimal(raw.o, 'o'),
    h: decimal(raw.h, 'h'),
    l: decimal(raw.l, 'l'),
    c: decimal(raw.c, 'c'),
    v: decimal(raw.v, 'v'),
  }
}

/**
 * Map one market-data quote.
 * @param raw - quote JSON.
 * @returns the quote.
 */
export function mapQuote(raw: RawRecord): Quote {
  return { bid: decimal(raw.bp, 'bp'), ask: decimal(raw.ap, 'ap'), t: timestamp(raw.t, 't') }
}

/**
 * Map one `trade_updates` payload.
 * @param raw - the message's `data` object.
 * @returns the order update.
 */
export function mapOrderUpdate(raw: RawRecord): OrderUpdate {
  const event = String(raw.event)
  const fillPrice = optionalDecimal(raw.price, 'price')
  const fillQty = optionalDecimal(raw.qty, 'qty')
  const positionQty = optionalDecimal(raw.position_qty, 'position_qty')
  return {
    event: UPDATE_EVENTS.includes(event) ? event as OrderUpdateEvent : 'other',
    order: mapOrder(raw.order as RawRecord),
    t: timestamp(raw.timestamp, 'timestamp'),
    ...fillPrice === undefined ? {} : { fillPrice },
    ...fillQty === undefined ? {} : { fillQty },
    ...positionQty === undefined ? {} : { positionQty },
  }
}
