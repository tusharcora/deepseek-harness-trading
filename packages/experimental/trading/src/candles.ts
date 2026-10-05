/**
 * Folding live trades into the forming candle of a chart timeframe.
 * Intraday buckets are UTC-aligned; daily and weekly candles follow the market
 * calendar, so the provider opens them and trades only update the latest one.
 *
 * @module @deepseek-ai/dsh-experimental-trading/candles
 */
import { intradayMs } from './timeframe.ts'
import type { Bar, Timeframe, Trade } from './types.ts'

/** Result of folding one trade: the forming candle changed (`update`) or a new one opened (`new`). */
export interface CandleUpdate {
  /** Whether the latest candle changed or a new candle opened. */
  readonly kind: 'update' | 'new'
  /** The candle after the trade. */
  readonly bar: Bar
}

/**
 * Start of the intraday bucket containing `t`.
 * @param t - time in UTC epoch milliseconds.
 * @param timeframe - intraday timeframe.
 * @returns the bucket start in UTC epoch milliseconds.
 * @throws RangeError for `1D` and `1W`.
 */
export function bucketStart(t: number, timeframe: Timeframe): number {
  const length = intradayMs(timeframe)
  if (length === undefined) throw new RangeError(`${timeframe} candles are opened by the provider, not by trade aggregation`)
  return Math.floor(t / length) * length
}

function fold(bar: Bar, trade: Trade): Bar {
  return { t: bar.t, o: bar.o, h: Math.max(bar.h, trade.price), l: Math.min(bar.l, trade.price), c: trade.price, v: bar.v + trade.size }
}

/**
 * Fold one trade into the latest candle.
 * @param last - latest candle, or undefined before any history loaded.
 * @param trade - trade print from the stream.
 * @param timeframe - chart timeframe.
 * @returns the changed or new candle, or undefined when the trade belongs to an earlier bucket
 *   (or, for `1D`/`1W`, when no provider candle covers it).
 */
export function applyTrade(last: Bar | undefined, trade: Trade, timeframe: Timeframe): CandleUpdate | undefined {
  if (intradayMs(timeframe) === undefined) {
    if (last === undefined || trade.t < last.t) return undefined
    return { kind: 'update', bar: fold(last, trade) }
  }
  const start = bucketStart(trade.t, timeframe)
  if (last === undefined || start > last.t) {
    return { kind: 'new', bar: { t: start, o: trade.price, h: trade.price, l: trade.price, c: trade.price, v: trade.size } }
  }
  if (start === last.t) return { kind: 'update', bar: fold(last, trade) }
  return undefined
}
