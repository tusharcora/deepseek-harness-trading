import { describe, expect, it } from 'vitest'
import { bollinger, ema, macd, rsi, sma, type IndicatorSeries } from '../src/indicators.ts'

/** Compare series to 9 decimal places; EMA arithmetic carries float noise. */
function expectSeries(actual: IndicatorSeries, expected: (number | null)[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((value, index) => {
    if (value === null) expect(actual[index]).toBeNull()
    else expect(actual[index]).toBeCloseTo(value, 9)
  })
}

describe('sma', () => {
  it('averages a trailing window and is null during warm-up', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('rejects a non-positive or fractional period', () => {
    expect(() => sma([1], 0)).toThrow(new RangeError('period must be a positive integer, got 0'))
    expect(() => sma([1], 1.5)).toThrow(RangeError)
  })
})

describe('ema', () => {
  it('seeds with the simple average, then smooths with alpha 2/(n+1)', () => {
    expect(ema([2, 4, 6, 8, 12], 3)).toEqual([null, null, 4, 6, 9])
  })
})

describe('rsi', () => {
  it("uses Wilder's smoothing", () => {
    expect(rsi([1, 2, 1, 2, 3], 2)).toEqual([null, null, 50, 75, 87.5])
  })

  it('reads 100 with only gains, 50 with no movement, and handles empty input', () => {
    expect(rsi([1, 2, 3], 2)).toEqual([null, null, 100])
    expect(rsi([5, 5, 5], 2)).toEqual([null, null, 50])
    expect(rsi([], 14)).toEqual([])
  })
})

describe('macd', () => {
  it('is the fast EMA minus the slow EMA with an EMA signal line', () => {
    const result = macd([1, 2, 3, 4, 5, 6], 2, 3, 2)
    expectSeries(result.macd, [null, null, 0.5, 0.5, 0.5, 0.5])
    expectSeries(result.signal, [null, null, null, 0.5, 0.5, 0.5])
    expectSeries(result.histogram, [null, null, null, 0, 0, 0])
  })

  it('stays null when the series is shorter than the slow period', () => {
    expect(macd([1, 2], 2, 3, 2)).toEqual({ macd: [null, null], signal: [null, null], histogram: [null, null] })
  })

  it('requires the fast period to be shorter than the slow period', () => {
    expect(() => macd([1, 2, 3], 3, 3, 2)).toThrow(new RangeError('fast period 3 must be shorter than slow period 3'))
  })
})

describe('bollinger', () => {
  it('brackets the simple average by k population standard deviations', () => {
    const result = bollinger([1, 2, 3], 3, 2)
    expect(result.middle).toEqual([null, null, 2])
    expect(result.upper[0]).toBeNull()
    expect(result.lower[1]).toBeNull()
    expect(result.upper[2]).toBeCloseTo(3.632993, 6)
    expect(result.lower[2]).toBeCloseTo(0.367007, 6)
  })
})
