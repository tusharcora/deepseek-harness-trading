import { describe, expect, it } from 'vitest'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import {
  decimal, decimalString, mapAccount, mapAsset, mapBar, mapOrder, mapOrderUpdate, mapPosition, mapQuote, optionalDecimal, pathSymbol,
  timestamp, venueSymbol,
} from '../src/map.ts'

const order = {
  id: 'o-1', client_order_id: 'c-1', symbol: 'BTCUSD', asset_class: 'crypto', side: 'buy', type: 'limit', time_in_force: 'ioc',
  qty: '0.015', notional: null, limit_price: '63460.32', stop_price: null, filled_qty: '0.015', filled_avg_price: '62831.5',
  status: 'filled', submitted_at: '2026-10-05T14:00:00Z',
}

describe('number and time parsing', () => {
  it('reads Alpaca decimal strings and JSON numbers', () => {
    expect(decimal('100240.18', 'equity')).toBe(100_240.18)
    expect(decimal(3, 'qty')).toBe(3)
    expect(optionalDecimal(null, 'limit_price')).toBeUndefined()
    expect(optionalDecimal(undefined, 'limit_price')).toBeUndefined()
    expect(optionalDecimal('1.5', 'limit_price')).toBe(1.5)
    expect(timestamp('2026-10-05T14:00:00Z', 't')).toBe(Date.UTC(2026, 9, 5, 14))
  })

  it('refuses malformed numbers and times instead of producing NaN', () => {
    for (const bad of ['', '  ', 'abc', null, undefined, {}, Number.NaN]) {
      expect(() => decimal(bad, 'equity')).toThrow(new VenueError('Alpaca returned a malformed equity', 'unavailable'))
    }
    expect(() => timestamp('not a time', 't')).toThrow('Alpaca returned a malformed t')
    expect(() => timestamp(5, 't')).toThrow(VenueError)
  })
})

describe('outgoing values', () => {
  it('formats numbers as plain decimals, never exponent notation', () => {
    expect(decimalString(0.015)).toBe('0.015')
    expect(decimalString(63_460.32)).toBe('63460.32')
    expect(decimalString(9.5e-7)).toBe('0.00000095')
    expect(decimalString(-2.5e-8)).toBe('-0.000000025')
    expect(decimalString(1e21)).toBe('1000000000000000000000')
    expect(decimalString(1.5e21)).toBe('1500000000000000000000')
    expect(() => decimalString(Number.NaN)).toThrow(new RangeError('cannot send NaN to Alpaca'))
  })

  it('writes crypto path segments in the joined form', () => {
    expect(pathSymbol({ assetClass: 'crypto', ticker: 'BTC/USD' })).toBe('BTCUSD')
    expect(pathSymbol({ assetClass: 'equity', ticker: 'BRK.B' })).toBe('BRK.B')
  })
})

describe('venueSymbol', () => {
  it('normalizes equities and both crypto spellings', () => {
    expect(venueSymbol('AAPL', 'us_equity')).toEqual({ assetClass: 'equity', ticker: 'AAPL' })
    expect(venueSymbol('BTCUSD', 'crypto')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(venueSymbol('BTC/USD', 'crypto')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
  })

  it('refuses asset classes the desk does not trade and malformed crypto symbols', () => {
    expect(() => venueSymbol('SPY250117C00500000', 'us_option'))
      .toThrow(new VenueError('SPY250117C00500000 is a us_option asset; the desk trades US equities and crypto only', 'rejected'))
    expect(() => venueSymbol('AAPL', 'crypto')).toThrow(new VenueError('Alpaca returned a malformed crypto symbol AAPL', 'unavailable'))
  })
})

describe('required record fields', () => {
  const position = { symbol: 'AAPL', asset_class: 'us_equity', side: 'long', qty: '2', qty_available: '2', avg_entry_price: '228.10',
    current_price: '231.42', market_value: '462.84', unrealized_pl: '6.64' }
  const malformed = (field: string): VenueError => new VenueError(`Alpaca returned a malformed ${field}`, 'unavailable')
  const without = (record: Record<string, unknown>, field: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== field))

  it('refuses orders missing identity, lifecycle, or symbol fields', () => {
    for (const field of ['id', 'client_order_id', 'symbol', 'asset_class', 'time_in_force', 'type', 'status']) {
      expect(() => mapOrder(without(order, field))).toThrow(malformed(field))
    }
    expect(() => mapOrder({ ...order, id: '' })).toThrow(malformed('id'))
    expect(() => mapOrder({ ...order, status: 7 })).toThrow(malformed('status'))
    expect(mapOrder({ ...order, status: 'done_for_day', type: 'trailing_stop' })).toMatchObject({ status: 'open', type: 'other' })
  })

  it('refuses positions missing a symbol or with a side that contradicts the quantity', () => {
    expect(() => mapPosition(without(position, 'symbol'))).toThrow(malformed('symbol'))
    expect(() => mapPosition(without(position, 'asset_class'))).toThrow(malformed('asset_class'))
    expect(() => mapPosition({ ...position, side: 'shrt' })).toThrow(malformed('side'))
    expect(() => mapPosition({ ...position, qty: '-1' })).toThrow(malformed('qty'))
    expect(() => mapPosition(without(position, 'qty_available'))).toThrow(malformed('qty_available'))
    expect(() => mapPosition({ ...position, qty_available: 'x' })).toThrow(malformed('qty_available'))
    expect(() => mapPosition({ ...position, qty_available: '-1' })).toThrow(malformed('qty'))
  })

  it('refuses assets missing a symbol, class, or status, and rejects unsupported classes', () => {
    const raw = { symbol: 'AAPL', class: 'us_equity', status: 'active', tradable: true, fractionable: true }
    for (const field of ['symbol', 'class', 'status']) expect(() => mapAsset(without(raw, field), 10)).toThrow(malformed(field))
    expect(() => mapAsset({ ...raw, class: 'us_option' }, 10)).toThrow(expect.objectContaining({ code: 'rejected' }) as Error)
  })
})

describe('record mapping', () => {
  it('maps the account, treating any broker block as tradingBlocked', () => {
    const raw = { equity: '100240.18', cash: '61402.55', last_equity: '100027.78', buying_power: '61402.55',
      trading_blocked: false, account_blocked: false, trade_suspended_by_user: false }
    expect(mapAccount(raw))
      .toEqual({ equity: 100_240.18, cash: 61_402.55, lastEquity: 100_027.78, buyingPower: 61_402.55, tradingBlocked: false })
    expect(mapAccount({ ...raw, trade_suspended_by_user: true }).tradingBlocked).toBe(true)
    expect(mapAccount({ ...raw, account_blocked: true }).tradingBlocked).toBe(true)
    expect(mapAccount({ ...raw, trading_blocked: true }).tradingBlocked).toBe(true)
    expect(() => mapAccount({ ...raw, last_equity: '' })).toThrow('Alpaca returned a malformed last_equity')
  })

  it('maps positions with signed quantity and signed sellable quantity', () => {
    const raw = { symbol: 'AAPL', asset_class: 'us_equity', side: 'long', qty: '2', qty_available: '1.5', avg_entry_price: '228.10',
      current_price: '231.42', market_value: '462.84', unrealized_pl: '6.64' }
    expect(mapPosition(raw)).toEqual({ symbol: { assetClass: 'equity', ticker: 'AAPL' }, qty: 2, qtyAvailable: 1.5, avgEntryPrice: 228.1,
      currentPrice: 231.42, marketValue: 462.84, unrealizedPl: 6.64 })
    expect(mapPosition({ ...raw, side: 'short', qty: '-3' }).qty).toBe(-3)
    expect(mapPosition({ ...raw, side: 'short', qty: '3' }).qty).toBe(-3)
    expect(mapPosition({ ...raw, side: 'short', qty: '-3', qty_available: '-2' }).qtyAvailable).toBe(-2)
    expect(mapPosition({ ...raw, side: 'short', qty: '-3', qty_available: '2' }).qtyAvailable).toBe(-2)
    // Right after a fill Alpaca can report the position before its coins are sellable.
    expect(mapPosition({ ...raw, qty_available: '0' }).qtyAvailable).toBe(0)
  })

  it('maps orders, folding broker states into the desk lifecycle', () => {
    expect(mapOrder(order)).toEqual({
      id: 'o-1', clientOrderId: 'c-1', symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', type: 'limit',
      timeInForce: 'ioc', qty: 0.015, limitPrice: 63_460.32, filledQty: 0.015, filledAvgPrice: 62_831.5, status: 'filled',
      submittedAt: Date.UTC(2026, 9, 5, 14),
    })
    expect(mapOrder({ ...order, status: 'accepted' }).status).toBe('open')
    expect(mapOrder({ ...order, status: 'replaced' }).status).toBe('canceled')
    expect(mapOrder({ ...order, type: 'trailing_stop' }).type).toBe('other')
    expect(() => mapOrder({ ...order, side: 'short' })).toThrow(new VenueError('Alpaca returned a malformed side', 'unavailable'))
    expect(mapOrder({ ...order, side: 'sell', qty: null, notional: '500', filled_avg_price: null, submitted_at: null }))
      .toMatchObject({ side: 'sell', notional: 500 })
    expect(mapOrder({ ...order, qty: null, notional: '500', filled_avg_price: null, submitted_at: null })).not.toHaveProperty('qty')
    expect(mapOrder({ ...order, type: 'stop', limit_price: null, stop_price: '61000' }))
      .toMatchObject({ type: 'stop', stopPrice: 61_000 })
    expect(mapOrder({ ...order, type: 'market', limit_price: null })).not.toHaveProperty('limitPrice')
  })

  it('maps assets, using a cent tick for equities and the broker tick and given minimum value for crypto', () => {
    expect(mapAsset({ symbol: 'AAPL', class: 'us_equity', status: 'active', tradable: true, fractionable: true }, 10))
      .toEqual({ symbol: { assetClass: 'equity', ticker: 'AAPL' }, tradable: true, fractionable: true, priceIncrement: 0.01 })
    expect(mapAsset({ symbol: 'BTC/USD', class: 'crypto', status: 'active', tradable: true, fractionable: true,
      min_order_size: '0.0001', price_increment: '1' }, 10))
      .toEqual({ symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, tradable: true, fractionable: true, minOrderSize: 0.0001,
        minNotional: 10, priceIncrement: 1 })
    expect(mapAsset({ symbol: 'XYZ', class: 'us_equity', status: 'inactive', tradable: true, fractionable: false }, 10).tradable)
      .toBe(false)
  })

  it('maps bars and quotes from market-data JSON', () => {
    expect(mapBar({ t: '2026-10-05T14:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10, vw: 1.2, n: 4 }))
      .toEqual({ t: Date.UTC(2026, 9, 5, 14), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 })
    expect(mapQuote({ t: '2026-10-05T14:00:00.123456789Z', bp: 62_818, bs: 1, ap: 62_832, as: 2 }))
      .toEqual({ bid: 62_818, ask: 62_832, t: Date.UTC(2026, 9, 5, 14, 0, 0, 123) })
  })

  it('maps trade updates, keeping fill details only when present', () => {
    expect(mapOrderUpdate({ event: 'fill', order, timestamp: '2026-10-05T14:00:01Z', price: '62831.5', qty: '0.015',
      position_qty: '0.03' }))
      .toEqual({ event: 'fill', order: mapOrder(order), t: Date.UTC(2026, 9, 5, 14, 0, 1), fillPrice: 62_831.5, fillQty: 0.015,
        positionQty: 0.03 })
    expect(mapOrderUpdate({ event: 'pending_cancel', order, timestamp: '2026-10-05T14:00:01Z' }))
      .toEqual({ event: 'other', order: mapOrder(order), t: Date.UTC(2026, 9, 5, 14, 0, 1) })
  })
})
