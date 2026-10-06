/**
 * The `get_bars` report: a summary, the latest values of requested indicators, and the last N bars. Indicator values
 * come from the `trading` library's functions, the same ones the chart uses, so the agent and the user see one value.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/bars
 */
import { type Bar, bollinger, ema, macd, rsi, sma, type Timeframe, type TradingSymbol } from '@deepseek-ai/dsh-experimental-trading'
import type { BarsReport, IndicatorName, SwingPoint } from './types.ts'

/** Indicators `get_bars` accepts, in display order. */
export const INDICATORS: readonly IndicatorName[] = ['sma', 'ema', 'rsi', 'macd', 'bollinger']

/** Extra bars fetched before the shown window so MACD(12,26,9) and Bollinger(20) have values for it. */
export const WARMUP_BARS = 60

const SWING_SPAN = 2
const SWINGS_SHOWN = 3
const MISSING = 'n/a (needs more bars)'

const round = (value: number): number => Math.round(value * 1e4) / 1e4

function lastOf(series: readonly (number | null)[]): number | null {
  const value = series.at(-1)
  return value === undefined || value === null ? null : round(value)
}

function swings(bars: readonly Bar[], pick: (bar: Bar) => number, highs: boolean): SwingPoint[] {
  const values = bars.map(pick)
  return bars.flatMap((bar, index) => {
    if (index < SWING_SPAN || index >= bars.length - SWING_SPAN) return []
    const window = values.slice(index - SWING_SPAN, index + SWING_SPAN + 1)
    const extreme = highs ? Math.max(...window) : Math.min(...window)
    const value = pick(bar)
    return value === extreme && window.filter(candidate => candidate === extreme).length === 1 ? [{ t: bar.t, price: value }] : []
  }).slice(-SWINGS_SHOWN)
}

/**
 * Build the report.
 * @param symbol - instrument.
 * @param timeframe - bar timeframe.
 * @param bars - history oldest first, including warm-up bars.
 * @param limit - bars to show.
 * @param indicators - indicators to add to the summary.
 * @returns the report.
 */
export function barsReport(
  symbol: TradingSymbol, timeframe: Timeframe, bars: readonly Bar[], limit: number, indicators: readonly IndicatorName[],
): BarsReport {
  const closes = bars.map(bar => bar.c)
  const shown = bars.slice(-limit)
  const wants = new Set(indicators)
  const macdSeries = wants.has('macd') ? macd(closes) : undefined
  const bands = wants.has('bollinger') ? bollinger(closes) : undefined
  const first = shown[0]
  const last = shown.at(-1)
  return {
    symbol: symbol.ticker,
    timeframe,
    count: shown.length,
    summary: first === undefined || last === undefined ? null : {
      last: last.c,
      high: Math.max(...shown.map(bar => bar.h)),
      low: Math.min(...shown.map(bar => bar.l)),
      changePct: first.o === 0 ? 0 : round((last.c - first.o) / first.o * 100),
      swingHighs: swings(shown, bar => bar.h, true),
      swingLows: swings(shown, bar => bar.l, false),
    },
    indicators: {
      ...wants.has('sma') ? { sma20: lastOf(sma(closes, 20)) } : {},
      ...wants.has('ema') ? { ema20: lastOf(ema(closes, 20)) } : {},
      ...wants.has('rsi') ? { rsi14: lastOf(rsi(closes)) } : {},
      ...macdSeries === undefined ? {} : {
        macd: { macd: lastOf(macdSeries.macd), signal: lastOf(macdSeries.signal), histogram: lastOf(macdSeries.histogram) },
      },
      ...bands === undefined ? {} : {
        bollinger: { upper: lastOf(bands.upper), middle: lastOf(bands.middle), lower: lastOf(bands.lower) },
      },
    },
    bars: shown.map(bar => [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v]),
  }
}

function iso(t: number): string {
  return new Date(t).toISOString().replace('.000Z', 'Z')
}

function show(value: number | null): string {
  return value === null ? MISSING : String(value)
}

function indicatorLine(values: BarsReport['indicators']): string[] {
  const parts: string[] = []
  if (values.sma20 !== undefined) parts.push(`SMA(20) ${show(values.sma20)}`)
  if (values.ema20 !== undefined) parts.push(`EMA(20) ${show(values.ema20)}`)
  if (values.rsi14 !== undefined) parts.push(`RSI(14) ${show(values.rsi14)}`)
  if (values.macd !== undefined) {
    parts.push(`MACD(12,26,9) ${show(values.macd.macd)} / signal ${show(values.macd.signal)} / histogram ${show(values.macd.histogram)}`)
  }
  if (values.bollinger !== undefined) {
    const { upper, middle, lower } = values.bollinger
    parts.push(`Bollinger(20,2) upper ${show(upper)} / middle ${show(middle)} / lower ${show(lower)}`)
  }
  return parts.length === 0 ? [] : [`Indicators: ${parts.join('; ')}.`]
}

/**
 * Model-facing text for a `get_bars` report.
 * @param report - the report.
 * @returns a summary, indicator values, and a CSV table of the bars.
 */
export function renderBars(report: BarsReport): string {
  const head = `${report.symbol} ${report.timeframe}: ${report.count} bars, oldest first.`
  const summary = report.summary
  if (summary === null) return `${head} No bars in this range.`
  const points = (list: readonly SwingPoint[]): string => list.length === 0 ? 'none' : list.map(p => `${iso(p.t)} ${p.price}`).join(', ')
  return [
    head,
    `Last ${summary.last}; high ${summary.high}; low ${summary.low}; change ${summary.changePct >= 0 ? '+' : ''}${summary.changePct}%.`,
    `Swing highs: ${points(summary.swingHighs)}. Swing lows: ${points(summary.swingLows)}.`,
    ...indicatorLine(report.indicators),
    'time,open,high,low,close,volume',
    ...report.bars.map(row => row.map((value, index) => index === 0 ? iso(value) : String(value)).join(',')),
  ].join('\n')
}
