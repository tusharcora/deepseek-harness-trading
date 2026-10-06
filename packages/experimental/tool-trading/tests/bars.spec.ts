import { type Bar, sma } from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import { barsReport, renderBars } from '../src/bars.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const hour = 3_600_000
const start = Date.UTC(2026, 9, 5, 10)
const series = (count: number): Bar[] => Array.from({ length: count }, (_, i) => ({
  t: start + i * hour, o: 100 + i, h: i === 10 ? 150 : 101 + i, l: i === 20 ? 50 : 99 + i, c: 100.5 + i, v: 10 + i,
}))

describe('barsReport', () => {
  it('summarizes the last N bars and computes requested indicators over the full history', () => {
    const bars = series(30)
    const report = barsReport(btc, '1h', bars, 5, ['sma'])
    expect(report).toMatchObject({ symbol: 'BTC/USD', timeframe: '1h', count: 5, summary: { last: 129.5, high: 130, low: 124 } })
    expect(report.bars[0]).toEqual([start + 25 * hour, 125, 126, 124, 125.5, 35])
    expect(report.summary?.changePct).toBe(3.6)
    expect(report.indicators).toEqual({ sma20: Math.round((sma(bars.map(b => b.c), 20).at(-1) ?? 0) * 1e4) / 1e4 })
  })

  it('finds swing highs and lows in the shown window', () => {
    const report = barsReport(btc, '1h', series(30), 30, [])
    expect(report.summary?.swingHighs).toEqual([{ t: start + 10 * hour, price: 150 }])
    expect(report.summary?.swingLows).toEqual([{ t: start + 20 * hour, price: 50 }])
    expect(report.indicators).toEqual({})
  })

  it('reports missing indicator values and an empty window', () => {
    const short = barsReport(btc, '1h', series(3), 100, ['sma', 'ema', 'rsi', 'macd', 'bollinger'])
    expect(short.indicators).toEqual({
      sma20: null, ema20: null, rsi14: null, macd: { macd: null, signal: null, histogram: null },
      bollinger: { upper: null, middle: null, lower: null },
    })
    expect(barsReport(btc, '1D', [], 10, ['rsi'])).toMatchObject({ count: 0, summary: null, bars: [] })
    expect(barsReport(btc, '1D', [{ t: start, o: 0, h: 1, l: 0, c: 1, v: 1 }], 10, []).summary?.changePct).toBe(0)
  })
})

describe('renderBars', () => {
  it('renders a summary line, indicators, and a CSV table', () => {
    expect(renderBars(barsReport(btc, '1h', series(3), 100, ['sma', 'macd']))).toBe([
      'BTC/USD 1h: 3 bars, oldest first.',
      'Last 102.5; high 103; low 99; change +2.5%.',
      'Swing highs: none. Swing lows: none.',
      'Indicators: SMA(20) n/a (needs more bars); MACD(12,26,9) n/a (needs more bars) / signal n/a (needs more bars) / '
        + 'histogram n/a (needs more bars).',
      'time,open,high,low,close,volume',
      '2026-10-05T10:00:00Z,100,101,99,100.5,10',
      '2026-10-05T11:00:00Z,101,102,100,101.5,11',
      '2026-10-05T12:00:00Z,102,103,101,102.5,12',
    ].join('\n'))
    expect(renderBars(barsReport(btc, '1D', [], 10, []))).toBe('BTC/USD 1D: 0 bars, oldest first. No bars in this range.')
    const full = renderBars(barsReport(btc, '1h', series(60), 30, ['ema', 'rsi', 'bollinger']))
    expect(full).toMatch(/^Swing highs: none\. Swing lows: none\.$/m)
    expect(full).toMatch(/Indicators: EMA\(20\) [\d.]+; RSI\(14\) [\d.]+; Bollinger\(20,2\) /)
    expect(full).toMatch(/Bollinger\(20,2\) upper [\d.]+ \/ middle [\d.]+ \/ lower [\d.]+\./)
    expect(renderBars(barsReport(btc, '1h', [{ t: start, o: 2, h: 3, l: 1, c: 1, v: 1 }], 1, []))).toContain('change -50%.')
    expect(renderBars(barsReport(btc, '1h', series(30), 30, [])).split('\n')[2])
      .toBe('Swing highs: 2026-10-05T20:00:00Z 150. Swing lows: 2026-10-06T06:00:00Z 50.')
  })
})
