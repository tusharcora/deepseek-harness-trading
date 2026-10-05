/**
 * Timeframe membership and intraday bucket lengths.
 *
 * @module @deepseek-ai/dsh-experimental-trading/timeframe
 */
import type { Timeframe } from './types.ts'

/** Every chart and bar timeframe the desk supports, shortest first. */
export const TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W']

const INTRADAY_MS: ReadonlyMap<Timeframe, number> = new Map([
  ['1m', 60_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['1h', 3_600_000],
  ['4h', 14_400_000],
])

/**
 * Whether a string names a supported timeframe.
 * @param value - candidate timeframe text.
 * @returns true when `value` is one of {@link TIMEFRAMES}.
 */
export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value)
}

/**
 * Bucket length of an intraday timeframe. Daily and weekly buckets follow the market calendar, so the provider opens them.
 * @param timeframe - supported timeframe.
 * @returns bucket length in milliseconds, or undefined for `1D` and `1W`.
 */
export function intradayMs(timeframe: Timeframe): number | undefined {
  return INTRADAY_MS.get(timeframe)
}
