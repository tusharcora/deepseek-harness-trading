import { describe, expect, it } from 'vitest'
import { checkRisk, isReduceOnly, type RiskLimits, type RiskSnapshot, type SymbolExposure } from '../src/risk.ts'
import type { OrderRequest } from '../src/types.ts'

const limits: RiskLimits = {
  maxOrderNotional: 1_000, maxPositionPct: 0.2, dailyLossPct: 0.03, maxOrdersPerDay: 20,
  allowShort: false, allowMargin: false, allowlist: [], denylist: [], staleQuoteMs: 30_000,
}
const flat: SymbolExposure = { positionQty: 0, openBuyQty: 0, openSellQty: 0, pendingBuyQty: 0, pendingSellQty: 0 }
const snapshot: RiskSnapshot = {
  now: 1_000_000, quote: { bid: 62_818, ask: 62_832, t: 998_000 }, marketOpen: true,
  equity: 100_000, cash: 60_000, lastEquity: 100_000, committedBuyNotional: 0,
  exposure: flat, ordersToday: 3, halted: false,
}
const buy: OrderRequest = {
  symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market', timeInForce: 'gtc',
}
const failed = (order: OrderRequest, snap: RiskSnapshot = snapshot, lim: RiskLimits = limits): string[] =>
  checkRisk(order, snap, lim).checks.filter(c => !c.ok).map(c => c.id)

describe('checkRisk, exposure-increasing orders', () => {
  it('passes a small market buy and reports every check', () => {
    const result = checkRisk(buy, snapshot, limits)
    expect(result.ok).toBe(true)
    expect(result.reduceOnly).toBe(false)
    expect(result.referencePrice).toBe(62_832)
    expect(result.estimatedNotional).toBeCloseTo(942.48, 2)
    expect(result.checks.map(c => c.id)).toEqual([
      'halted', 'symbol-list', 'stale-quote', 'stop-type', 'shorting',
      'order-notional', 'position-size', 'cash', 'daily-loss', 'orders-per-day',
    ])
    expect(result.checks.find(c => c.id === 'order-notional')?.detail).toBe('order $942.48 vs max $1,000.00')
  })

  it('caps order notional, position size, and cash', () => {
    expect(failed({ ...buy, qty: 0.05 })).toEqual(['order-notional'])
    expect(failed(buy, { ...snapshot, exposure: { ...flat, positionQty: 0.31 } })).toEqual(['position-size'])
    expect(failed(buy, { ...snapshot, committedBuyNotional: 59_500 })).toEqual(['cash'])
    expect(failed(buy, { ...snapshot, committedBuyNotional: 59_500 }, { ...limits, allowMargin: true })).toEqual([])
  })

  it('counts open orders and pending proposals toward the position cap', () => {
    const crowded = { ...snapshot, exposure: { ...flat, positionQty: 0.2, openBuyQty: 0.05, pendingBuyQty: 0.06 } }
    expect(failed(buy, crowded)).toEqual(['position-size'])
  })

  it('uses the limit price for limit orders and the notional for notional orders', () => {
    expect(checkRisk({ ...buy, type: 'limit', limitPrice: 60_000 }, snapshot, limits).estimatedNotional).toBe(900)
    const notional = checkRisk({ symbol: buy.symbol, side: 'buy', notional: 500, type: 'market', timeInForce: 'gtc' }, snapshot, limits)
    expect(notional.estimatedNotional).toBe(500)
    expect(notional.quantity).toBeCloseTo(500 / 62_832, 10)
  })

  it('blocks exposure once the daily loss limit is hit', () => {
    expect(failed(buy, { ...snapshot, equity: 97_000, lastEquity: 100_000 })).toEqual(['daily-loss'])
    expect(failed(buy, { ...snapshot, equity: 97_001, lastEquity: 100_000 })).toEqual([])
  })

  it('caps orders per day, counting pending proposals', () => {
    expect(failed(buy, { ...snapshot, ordersToday: 20 })).toEqual(['orders-per-day'])
  })

  it('applies the allowlist and denylist', () => {
    expect(failed(buy, snapshot, { ...limits, allowlist: ['ETH/USD'] })).toEqual(['symbol-list'])
    expect(failed(buy, snapshot, { ...limits, allowlist: ['BTC/USD'], denylist: ['BTC/USD'] })).toEqual(['symbol-list'])
    expect(checkRisk(buy, snapshot, { ...limits, denylist: ['BTC/USD'] }).checks[1]?.detail).toBe('BTC/USD is on the denylist')
    expect(checkRisk(buy, snapshot, { ...limits, allowlist: ['ETH/USD'] }).checks[1]?.detail).toBe('BTC/USD is not on the allowlist')
  })

  it('refuses market orders on a stale quote only while the market is open', () => {
    const stale = { ...snapshot, quote: { ...snapshot.quote, t: 900_000 } }
    expect(failed(buy, stale)).toEqual(['stale-quote'])
    expect(failed(buy, { ...stale, marketOpen: false })).toEqual([])
    expect(failed({ ...buy, type: 'limit', limitPrice: 62_000 }, stale)).toEqual([])
  })

  it('requires stop_limit for stops that add exposure', () => {
    expect(failed({ ...buy, type: 'stop', stopPrice: 63_000 })).toEqual(['stop-type'])
  })

  it('treats a sell beyond the long position as a short sale', () => {
    expect(failed({ ...buy, side: 'sell' })).toEqual(['shorting'])
    expect(failed({ ...buy, side: 'sell' }, snapshot, { ...limits, allowShort: true })).toEqual([])
  })

  it('denies everything while halted', () => {
    expect(failed(buy, { ...snapshot, halted: true })).toEqual(['halted'])
  })
})

describe('checkRisk, reduce-only exits', () => {
  const long = { ...snapshot, exposure: { ...flat, positionQty: 0.015 } }
  const exit: OrderRequest = { ...buy, side: 'sell', qty: 0.015 }

  it('bypasses the limits but still honors halt', () => {
    const result = checkRisk(exit, { ...long, ordersToday: 99, equity: 50_000 }, limits)
    expect(result.ok).toBe(true)
    expect(result.reduceOnly).toBe(true)
    expect(result.checks.map(c => c.id)).toEqual(['halted'])
    expect(checkRisk(exit, { ...long, halted: true }, limits).ok).toBe(false)
  })

  it('allows a plain stop only as an exit', () => {
    expect(checkRisk({ ...exit, type: 'stop', stopPrice: 60_000 }, long, limits).ok).toBe(true)
  })

  it('nets the position against open and pending sells, so an exit cannot oversell', () => {
    const covered = { ...long, exposure: { ...long.exposure, openSellQty: 0.01 } }
    expect(checkRisk(exit, covered, limits).reduceOnly).toBe(false)
    expect(failed(exit, covered)).toEqual(['shorting'])
  })
})

describe('checkRisk, bad inputs', () => {
  it('fails a quote check instead of computing with a zero price', () => {
    const result = checkRisk({ ...buy, side: 'sell' }, { ...snapshot, quote: { bid: 0, ask: 62_832, t: 998_000 } }, limits)
    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([{ id: 'quote', ok: false, detail: 'no usable sell price for BTC/USD' }])
    expect(result.estimatedNotional).toBe(0)
  })

  it('reads an empty account without dividing by zero', () => {
    const empty = { ...snapshot, equity: 0, cash: 0, lastEquity: 0 }
    const result = checkRisk(buy, empty, limits)
    expect(result.checks.find(c => c.id === 'position-size')).toEqual({ id: 'position-size', ok: false, detail: 'account equity is $0.00' })
    expect(result.checks.find(c => c.id === 'daily-loss')).toEqual({ id: 'daily-loss', ok: true, detail: 'day P&L 0.0% vs limit -3.0%' })
  })
})

describe('isReduceOnly', () => {
  it('recognizes covering a short position', () => {
    expect(isReduceOnly('buy', 1, { ...flat, positionQty: -2, openBuyQty: 0.5 })).toBe(true)
    expect(isReduceOnly('buy', 2, { ...flat, positionQty: -2, pendingBuyQty: 0.5 })).toBe(false)
    expect(isReduceOnly('buy', 1, flat)).toBe(false)
    expect(isReduceOnly('sell', 1, flat)).toBe(false)
  })
})
