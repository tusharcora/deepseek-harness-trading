/**
 * Technical indicators shared by the `get_bars` tool and the chart, so both show identical values.
 * Every series is aligned to its input and holds `null` until enough values exist.
 *
 * @module @deepseek-ai/dsh-experimental-trading/indicators
 */

/** Indicator values aligned to the input series; `null` during warm-up. */
export type IndicatorSeries = (number | null)[]

/** MACD line, signal line, and histogram. */
export interface MacdSeries {
  /** Fast EMA minus slow EMA. */
  readonly macd: IndicatorSeries
  /** EMA of the MACD line. */
  readonly signal: IndicatorSeries
  /** MACD minus signal. */
  readonly histogram: IndicatorSeries
}

/** Bollinger middle band and the bands k standard deviations around it. */
export interface BollingerSeries {
  /** Simple moving average. */
  readonly middle: IndicatorSeries
  /** Middle plus k population standard deviations. */
  readonly upper: IndicatorSeries
  /** Middle minus k population standard deviations. */
  readonly lower: IndicatorSeries
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`)
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function emaStepper(period: number): (value: number) => number | null {
  const alpha = 2 / (period + 1)
  const seed: number[] = []
  let previous: number | null = null
  return (value) => {
    if (previous === null) {
      seed.push(value)
      if (seed.length === period) previous = mean(seed)
      return previous
    }
    previous = value * alpha + previous * (1 - alpha)
    return previous
  }
}

/**
 * Simple moving average.
 * @param values - input series, oldest first.
 * @param period - window length.
 * @returns the aligned average series.
 */
export function sma(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period)
  return values.map((_, index) => index < period - 1 ? null : mean(values.slice(index - period + 1, index + 1)))
}

/**
 * Exponential moving average seeded with the simple average of the first `period` values.
 * @param values - input series, oldest first.
 * @param period - smoothing length; alpha is 2 / (period + 1).
 * @returns the aligned EMA series.
 */
export function ema(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period)
  return values.map(emaStepper(period))
}

/**
 * Relative strength index with Wilder's smoothing. A window with no movement reads 50; one with only gains reads 100.
 * @param closes - closing prices, oldest first.
 * @param period - smoothing length, default 14.
 * @returns the aligned RSI series in [0, 100].
 */
export function rsi(closes: readonly number[], period = 14): IndicatorSeries {
  assertPeriod(period)
  const out: IndicatorSeries = []
  let previousClose: number | null = null
  let avgGain = 0
  let avgLoss = 0
  closes.forEach((close, index) => {
    if (previousClose === null) {
      previousClose = close
      out.push(null)
      return
    }
    const delta = close - previousClose
    previousClose = close
    const gain = Math.max(delta, 0)
    const loss = Math.max(-delta, 0)
    if (index <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (index < period) {
        out.push(null)
        return
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
    }
    if (avgLoss === 0) out.push(avgGain === 0 ? 50 : 100)
    else out.push(100 - 100 / (1 + avgGain / avgLoss))
  })
  return out
}

/**
 * Moving average convergence divergence.
 * @param closes - closing prices, oldest first.
 * @param fast - fast EMA length, default 12.
 * @param slow - slow EMA length, default 26; must exceed `fast`.
 * @param signal - signal EMA length, default 9.
 * @returns the aligned MACD, signal, and histogram series.
 */
export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9): MacdSeries {
  assertPeriod(fast)
  assertPeriod(slow)
  assertPeriod(signal)
  if (fast >= slow) throw new RangeError(`fast period ${fast} must be shorter than slow period ${slow}`)
  const fastStep = emaStepper(fast)
  const slowStep = emaStepper(slow)
  const signalStep = emaStepper(signal)
  const line: IndicatorSeries = []
  const signalLine: IndicatorSeries = []
  const histogram: IndicatorSeries = []
  for (const close of closes) {
    const fastValue = fastStep(close)
    const slowValue = slowStep(close)
    const macdValue = fastValue === null || slowValue === null ? null : fastValue - slowValue
    const signalValue = macdValue === null ? null : signalStep(macdValue)
    line.push(macdValue)
    signalLine.push(signalValue)
    histogram.push(macdValue === null || signalValue === null ? null : macdValue - signalValue)
  }
  return { macd: line, signal: signalLine, histogram }
}

/**
 * Bollinger bands over a simple moving average with population standard deviation.
 * @param closes - closing prices, oldest first.
 * @param period - window length, default 20.
 * @param k - band width in standard deviations, default 2.
 * @returns the aligned middle, upper, and lower series.
 */
export function bollinger(closes: readonly number[], period = 20, k = 2): BollingerSeries {
  assertPeriod(period)
  const middle: IndicatorSeries = []
  const upper: IndicatorSeries = []
  const lower: IndicatorSeries = []
  closes.forEach((_, index) => {
    if (index < period - 1) {
      middle.push(null)
      upper.push(null)
      lower.push(null)
      return
    }
    const window = closes.slice(index - period + 1, index + 1)
    const average = mean(window)
    const deviation = Math.sqrt(mean(window.map(value => (value - average) ** 2)))
    middle.push(average)
    upper.push(average + k * deviation)
    lower.push(average - k * deviation)
  })
  return { middle, upper, lower }
}
