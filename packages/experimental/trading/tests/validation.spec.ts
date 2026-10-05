import { describe, expect, it } from 'vitest'
import type { Asset, OrderRequest } from '../src/types.ts'
import { validateOrder } from '../src/validation.ts'

const btc: Asset = {
  symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, tradable: true, fractionable: true, minOrderSize: 0.0001, priceIncrement: 0.01,
}
const aapl: Asset = { symbol: { assetClass: 'equity', ticker: 'AAPL' }, tradable: true, fractionable: true, priceIncrement: 0.01 }
const cryptoBuy: OrderRequest = { symbol: btc.symbol, side: 'buy', qty: 0.015, type: 'market', timeInForce: 'gtc' }
const equityBuy: OrderRequest = { symbol: aapl.symbol, side: 'buy', qty: 2, type: 'market', timeInForce: 'day' }
const codes = (order: OrderRequest, asset: Asset): string[] => validateOrder(order, asset).map(v => v.code)

describe('validateOrder', () => {
  it('accepts well-formed crypto and equity orders', () => {
    expect(validateOrder(cryptoBuy, btc)).toEqual([])
    expect(validateOrder(equityBuy, aapl)).toEqual([])
    expect(validateOrder({ ...equityBuy, type: 'stop_limit', limitPrice: 230, stopPrice: 229, timeInForce: 'gtc' }, aapl)).toEqual([])
  })

  it('rejects a mismatched or untradable asset', () => {
    expect(codes(cryptoBuy, aapl)).toContain('symbol-mismatch')
    expect(codes(cryptoBuy, { ...btc, tradable: false })).toEqual(['not-tradable'])
  })

  it('needs exactly one positive, finite size', () => {
    expect(codes({ symbol: btc.symbol, side: 'buy', type: 'market', timeInForce: 'gtc' }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, notional: 100 }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, qty: 0 }, btc)).toEqual(['size', 'below-minimum'])
    expect(codes({ ...cryptoBuy, qty: Number.NaN }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, qty: Number.POSITIVE_INFINITY }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, qty: -1 }, btc)).toEqual(['size', 'below-minimum'])
  })

  it('enforces the broker minimum size', () => {
    expect(validateOrder({ ...cryptoBuy, qty: 0.00001 }, btc)).toEqual([
      { code: 'below-minimum', message: 'minimum order size for BTC/USD is 0.0001' },
    ])
  })

  it('matches price fields to the order type', () => {
    expect(codes({ ...cryptoBuy, type: 'limit' }, btc)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, limitPrice: 1 }, btc)).toEqual(['price-fields'])
    expect(codes({ ...equityBuy, type: 'stop', timeInForce: 'gtc' }, aapl)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, stopPrice: 1 }, btc)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, type: 'limit', limitPrice: Number.NaN }, btc)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, type: 'stop_limit', limitPrice: 1, stopPrice: -1 }, btc)).toEqual(['price-fields'])
  })

  it('allows notional only on market orders', () => {
    const notionalLimit: OrderRequest = {
      symbol: btc.symbol, side: 'buy', notional: 500, type: 'limit', limitPrice: 60_000, timeInForce: 'gtc',
    }
    expect(codes(notionalLimit, btc)).toEqual(['notional-type'])
  })

  it('applies crypto order-type, time-in-force, and bracket rules', () => {
    expect(codes({ ...cryptoBuy, type: 'stop', stopPrice: 60_000 }, btc)).toEqual(['order-type'])
    expect(codes({ ...cryptoBuy, timeInForce: 'day' }, btc)).toEqual(['time-in-force'])
    expect(codes({ ...cryptoBuy, timeInForce: 'ioc' }, btc)).toEqual([])
    expect(codes({ ...cryptoBuy, bracket: { takeProfit: 70_000, stopLoss: 60_000 } }, btc)).toEqual(['bracket'])
  })

  it('limits fractional and notional equity orders to fractionable assets and day orders', () => {
    expect(codes({ ...equityBuy, qty: 0.5 }, { ...aapl, fractionable: false })).toEqual(['fractional'])
    expect(codes({ ...equityBuy, qty: 0.5, timeInForce: 'gtc' }, aapl)).toEqual(['fractional'])
    expect(codes({ symbol: aapl.symbol, side: 'buy', notional: 100, type: 'market', timeInForce: 'gtc' }, aapl)).toEqual(['fractional'])
    expect(codes({ ...equityBuy, timeInForce: 'gtc' }, aapl)).toEqual([])
  })

  it('needs whole shares and ordered legs for equity brackets', () => {
    expect(codes({ ...equityBuy, bracket: { takeProfit: 250, stopLoss: 220 } }, aapl)).toEqual([])
    expect(codes({ ...equityBuy, side: 'sell', bracket: { takeProfit: 220, stopLoss: 250 } }, aapl)).toEqual([])
    expect(validateOrder({ ...equityBuy, bracket: { takeProfit: 220, stopLoss: 250 } }, aapl)).toEqual([
      { code: 'bracket', message: 'take_profit must be above stop_loss for a buy' },
    ])
    expect(validateOrder({ ...equityBuy, side: 'sell', bracket: { takeProfit: 250, stopLoss: 220 } }, aapl)).toEqual([
      { code: 'bracket', message: 'take_profit must be below stop_loss for a sell' },
    ])
    expect(codes({ ...equityBuy, qty: 1.5, bracket: { takeProfit: 250, stopLoss: 220 } }, aapl)).toEqual(['bracket'])
  })
})
