import { describe, expect, it } from 'vitest'
import { planSubmission } from '../src/submission.ts'
import type { OrderRequest } from '../src/types.ts'

const btcBuy: OrderRequest = {
  symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market', timeInForce: 'gtc',
}
const ethSell: OrderRequest = {
  symbol: { assetClass: 'crypto', ticker: 'ETH/USD' }, side: 'sell', qty: 0.25, type: 'market', timeInForce: 'gtc',
}
const aaplBuy: OrderRequest = { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', qty: 3, type: 'market', timeInForce: 'gtc' }

describe('planSubmission', () => {
  it('caps an exposure-adding market buy above the approved price, rounded down to the tick', () => {
    expect(planSubmission(btcBuy, 62_832, 0.01, false, 0.01))
      .toEqual({ type: 'limit', limitPrice: 63_460.32, timeInForce: 'ioc', capped: true })
  })

  it('caps an exposure-adding market sell below the approved price, rounded up to the tick', () => {
    expect(planSubmission(ethSell, 3_401.6, 0.01, false, 0.01))
      .toEqual({ type: 'limit', limitPrice: 3_367.59, timeInForce: 'ioc', capped: true })
  })

  it('sends capped equity orders as day orders so they queue for the open', () => {
    expect(planSubmission(aaplBuy, 231.42, 0.01, false, 0.01))
      .toEqual({ type: 'limit', limitPrice: 233.73, timeInForce: 'day', capped: true })
  })

  it('sends reduce-only exits as real market orders', () => {
    expect(planSubmission(ethSell, 3_401.6, 0.01, true, 0.01)).toEqual({ type: 'market', timeInForce: 'gtc', capped: false })
  })

  it('leaves notional market orders uncapped', () => {
    const notional: OrderRequest = { symbol: btcBuy.symbol, side: 'buy', notional: 500, type: 'market', timeInForce: 'gtc' }
    expect(planSubmission(notional, 62_832, 0.01, false, 0.01)).toEqual({ type: 'market', timeInForce: 'gtc', capped: false })
  })

  it('passes limit, stop, and stop_limit orders through with their prices', () => {
    expect(planSubmission({ ...btcBuy, type: 'stop_limit', limitPrice: 64_000, stopPrice: 63_500 }, 63_500, 0.01, false, 0.01))
      .toEqual({ type: 'stop_limit', limitPrice: 64_000, stopPrice: 63_500, timeInForce: 'gtc', capped: false })
    expect(planSubmission({ ...ethSell, type: 'stop', stopPrice: 3_300 }, 3_300, 0.01, true, 0.01))
      .toEqual({ type: 'stop', stopPrice: 3_300, timeInForce: 'gtc', capped: false })
  })

  it('rounds to fine crypto ticks without float noise', () => {
    const doge: OrderRequest = {
      symbol: { assetClass: 'crypto', ticker: 'DOGE/USD' }, side: 'buy', qty: 1_000, type: 'market', timeInForce: 'gtc',
    }
    expect(planSubmission(doge, 0.123456789, 0.01, false, 0.000001).limitPrice).toBe(0.124691)
  })

  it('rejects a tolerance outside [0, 1) and a non-positive tick', () => {
    expect(() => planSubmission(btcBuy, 62_832, 1, false, 0.01)).toThrow(new RangeError('tolerance must be in [0, 1), got 1'))
    expect(() => planSubmission(btcBuy, 62_832, -0.1, false, 0.01)).toThrow(RangeError)
    expect(() => planSubmission(btcBuy, 62_832, 0.01, false, 0)).toThrow(new RangeError('price increment must be greater than zero, got 0'))
  })
})
