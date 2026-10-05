import { describe, expect, it } from 'vitest'
import { applyTrade, bucketStart } from '../src/candles.ts'
import type { Bar } from '../src/types.ts'

const FIVE_MIN = 300_000
const bar: Bar = { t: 10 * FIVE_MIN, o: 100, h: 101, l: 99, c: 100.5, v: 3 }

describe('bucketStart', () => {
  it('floors to the UTC-aligned intraday bucket', () => {
    expect(bucketStart(10 * FIVE_MIN + 123_456, '5m')).toBe(10 * FIVE_MIN)
  })

  it('refuses daily and weekly buckets, which the provider opens', () => {
    expect(() => bucketStart(0, '1D')).toThrow(new RangeError('1D candles are opened by the provider, not by trade aggregation'))
  })
})

describe('applyTrade, intraday', () => {
  it('opens the first candle from a trade', () => {
    expect(applyTrade(undefined, { t: 10 * FIVE_MIN + 5, price: 100, size: 2 }, '5m')).toEqual({
      kind: 'new', bar: { t: 10 * FIVE_MIN, o: 100, h: 100, l: 100, c: 100, v: 2 },
    })
  })

  it('folds a trade inside the current bucket', () => {
    expect(applyTrade(bar, { t: 10 * FIVE_MIN + 60_000, price: 102, size: 1 }, '5m')).toEqual({
      kind: 'update', bar: { t: 10 * FIVE_MIN, o: 100, h: 102, l: 99, c: 102, v: 4 },
    })
    expect(applyTrade(bar, { t: 10 * FIVE_MIN + 60_000, price: 98, size: 1 }, '5m')?.bar.l).toBe(98)
  })

  it('opens a new candle when a trade crosses the bucket boundary', () => {
    expect(applyTrade(bar, { t: 11 * FIVE_MIN, price: 103, size: 1 }, '5m')).toEqual({
      kind: 'new', bar: { t: 11 * FIVE_MIN, o: 103, h: 103, l: 103, c: 103, v: 1 },
    })
  })

  it('drops a late trade from an earlier bucket', () => {
    expect(applyTrade(bar, { t: 9 * FIVE_MIN + 1, price: 50, size: 9 }, '5m')).toBeUndefined()
  })
})

describe('applyTrade, daily and weekly', () => {
  const day: Bar = { t: 1_000_000, o: 10, h: 11, l: 9, c: 10, v: 5 }

  it('updates the provider-opened candle', () => {
    expect(applyTrade(day, { t: 1_000_500, price: 12, size: 1 }, '1D')).toEqual({
      kind: 'update', bar: { t: 1_000_000, o: 10, h: 12, l: 9, c: 12, v: 6 },
    })
  })

  it('needs a provider candle and ignores trades before it', () => {
    expect(applyTrade(undefined, { t: 1, price: 12, size: 1 }, '1W')).toBeUndefined()
    expect(applyTrade(day, { t: 999_999, price: 12, size: 1 }, '1D')).toBeUndefined()
  })
})
