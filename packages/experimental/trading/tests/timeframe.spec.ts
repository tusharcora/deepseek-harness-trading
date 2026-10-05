import { describe, expect, it } from 'vitest'
import { intradayMs, isTimeframe } from '../src/timeframe.ts'

describe('timeframes', () => {
  it('recognizes only supported timeframes', () => {
    expect(isTimeframe('4h')).toBe(true)
    expect(isTimeframe('1W')).toBe(true)
    expect(isTimeframe('2h')).toBe(false)
  })

  it('gives bucket lengths for intraday timeframes only', () => {
    expect(intradayMs('1m')).toBe(60_000)
    expect(intradayMs('15m')).toBe(900_000)
    expect(intradayMs('4h')).toBe(14_400_000)
    expect(intradayMs('1D')).toBeUndefined()
    expect(intradayMs('1W')).toBeUndefined()
  })
})
