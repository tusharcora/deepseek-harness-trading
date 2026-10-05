import { describe, expect, it } from 'vitest'
import { parseSymbol } from '../src/symbol.ts'

describe('parseSymbol', () => {
  it('reads equities, including class shares, case- and space-insensitively', () => {
    expect(parseSymbol('aapl')).toEqual({ assetClass: 'equity', ticker: 'AAPL' })
    expect(parseSymbol(' brk.b ')).toEqual({ assetClass: 'equity', ticker: 'BRK.B' })
  })

  it('reads slash crypto pairs', () => {
    expect(parseSymbol(' btc/usd ')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(parseSymbol('eth/btc')).toEqual({ assetClass: 'crypto', ticker: 'ETH/BTC' })
  })

  it('reads joined crypto pairs by their quote currency', () => {
    expect(parseSymbol('BTCUSD')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(parseSymbol('solusdt')).toEqual({ assetClass: 'crypto', ticker: 'SOL/USDT' })
    expect(parseSymbol('1INCHUSD')).toEqual({ assetClass: 'crypto', ticker: '1INCH/USD' })
  })

  it('rejects a slash pair with an unknown quote currency or a bad base', () => {
    expect(() => parseSymbol('BTC/EUR')).toThrow(new RangeError('not a supported crypto pair: BTC/EUR'))
    expect(() => parseSymbol('B/USD')).toThrow(new RangeError('not a supported crypto pair: B/USD'))
  })

  it('rejects input that is neither an equity nor a crypto pair', () => {
    expect(() => parseSymbol('')).toThrow(new RangeError('not a symbol: '))
    expect(() => parseSymbol('NOTAPAIR')).toThrow(new RangeError('not a symbol: NOTAPAIR'))
    expect(() => parseSymbol('$$USD')).toThrow(new RangeError('not a symbol: $$USD'))
  })
})
