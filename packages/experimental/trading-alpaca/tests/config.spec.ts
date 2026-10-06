import { describe, expect, it } from 'vitest'
import { Config, resolveEndpoints } from '../src/config.ts'

describe('Config', () => {
  it('defaults to paper trading on the free IEX feed with ALPACA_* credentials', () => {
    expect(Config({})).toEqual({
      mode: 'paper', apiKeyEnv: 'ALPACA_API_KEY', secretKeyEnv: 'ALPACA_SECRET_KEY', feed: 'iex',
      driftCheckMs: 60_000, requestTimeoutMs: 15_000, rateLimitRetryMs: [1_000, 2_000, 4_000],
      streamBackoffMs: [1_000, 2_000, 5_000, 10_000, 30_000], suspendRetryMs: [500, 1_000, 2_000],
      lookupConfirmMs: 2_000, closeSettleMs: 500, closeSettleChecks: 10, cryptoMinNotional: 10,
      tradingUrl: '', dataUrl: 'https://data.alpaca.markets', tradeStreamUrl: '',
    })
  })
})

describe('resolveEndpoints', () => {
  it('selects the paper hosts by default', () => {
    expect(resolveEndpoints(Config({}), undefined)).toEqual({
      tradingUrl: 'https://paper-api.alpaca.markets',
      dataUrl: 'https://data.alpaca.markets',
      tradeStreamUrl: 'wss://paper-api.alpaca.markets/stream',
      mode: 'paper',
    })
  })

  it('selects the live hosts only with DSH_TRADING_LIVE=1', () => {
    expect(resolveEndpoints(Config({ mode: 'live' }), '1')).toMatchObject({ tradingUrl: 'https://api.alpaca.markets', mode: 'live' })
    expect(() => resolveEndpoints(Config({ mode: 'live' }), undefined))
      .toThrow(new Error('trading-alpaca: trading against api.alpaca.markets (mode live) requires DSH_TRADING_LIVE=1 at launch'))
    expect(() => resolveEndpoints(Config({ mode: 'live' }), 'true')).toThrow(Error)
  })

  it('applies the live lock to any non-paper trading host, even in paper mode', () => {
    expect(() => resolveEndpoints(Config({ tradingUrl: 'https://api.alpaca.markets' }), undefined))
      .toThrow(new Error('trading-alpaca: trading against api.alpaca.markets (mode paper) requires DSH_TRADING_LIVE=1 at launch'))
    expect(resolveEndpoints(Config({ tradingUrl: 'https://api.alpaca.markets' }), '1').tradingUrl).toBe('https://api.alpaca.markets')
    expect(() => resolveEndpoints(Config({ tradingUrl: 'https://alpaca.example.com' }), undefined)).toThrow(Error)
  })

  it('reports live for a paper-mode config that trades against a non-paper host', () => {
    expect(resolveEndpoints(Config({ tradingUrl: 'https://api.alpaca.markets' }), '1').mode).toBe('live')
    expect(resolveEndpoints(Config({ tradingUrl: 'https://alpaca.example.com' }), '1').mode).toBe('live')
    expect(resolveEndpoints(Config({ mode: 'live', tradingUrl: 'http://127.0.0.1:1' }), '1').mode).toBe('live')
  })

  it('keeps explicit loopback overrides without the flag', () => {
    const config = Config({ tradingUrl: 'http://127.0.0.1:1', dataUrl: 'http://127.0.0.1:2', tradeStreamUrl: 'ws://127.0.0.1:3' })
    expect(resolveEndpoints(config, undefined)).toEqual({
      tradingUrl: 'http://127.0.0.1:1', dataUrl: 'http://127.0.0.1:2', tradeStreamUrl: 'ws://127.0.0.1:3', mode: 'paper',
    })
    expect(resolveEndpoints(Config({ tradingUrl: 'http://localhost:9' }), undefined))
      .toMatchObject({ tradingUrl: 'http://localhost:9', mode: 'paper' })
    expect(resolveEndpoints(Config({ tradingUrl: 'http://[::1]:9' }), undefined))
      .toMatchObject({ tradingUrl: 'http://[::1]:9', mode: 'paper' })
  })
})
