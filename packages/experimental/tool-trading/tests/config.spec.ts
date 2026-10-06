// oxlint-disable typescript/no-misused-spread -- `Config` names a plain-object interface; the rule mistakes the interface
// merged with the `Config` schema value for a class instance.
import { describe, expect, it } from 'vitest'
import { Config, riskLimitsOf, validateConfig } from '../src/config.ts'

const defaults = (): Config => Config({})

describe('tool-trading Config', () => {
  it('defaults to the spec limits', () => {
    expect(defaults()).toEqual({
      maxOrderNotional: 1_000, maxPositionPct: 0.2, dailyLossPct: 0.03, maxOrdersPerDay: 20, allowShort: false,
      allowMargin: false, allowlist: [], denylist: [], staleQuoteMs: 30_000, driftTolerance: 0.01, barsDefault: 100,
      barsCap: 500, reconcileMs: 60_000, exitRetryMs: [500, 1_000, 2_000],
    })
    expect(riskLimitsOf(defaults())).toEqual({
      maxOrderNotional: 1_000, maxPositionPct: 0.2, dailyLossPct: 0.03, maxOrdersPerDay: 20, allowShort: false,
      allowMargin: false, allowlist: [], denylist: [], staleQuoteMs: 30_000,
    })
  })

  it('canonicalizes the symbol lists', () => {
    expect(validateConfig({ ...defaults(), allowlist: ['btcusd', 'AAPL'], denylist: ['eth/usd'] }))
      .toMatchObject({ allowlist: ['BTC/USD', 'AAPL'], denylist: ['ETH/USD'] })
  })

  it.each([
    ['maxOrderNotional', Number.POSITIVE_INFINITY, 'maxOrderNotional must be a finite number >= 0'],
    ['maxOrderNotional', -1, 'maxOrderNotional must be a finite number >= 0'],
    ['maxPositionPct', 1.5, 'maxPositionPct must be a finite number >= 0 and <= 1'],
    ['dailyLossPct', Number.NaN, 'dailyLossPct must be a finite number >= 0 and <= 1'],
    ['maxOrdersPerDay', 2.5, 'maxOrdersPerDay must be a whole number >= 0'],
    ['staleQuoteMs', -5, 'staleQuoteMs must be a finite number >= 0'],
    ['driftTolerance', 1, 'driftTolerance must be a finite number >= 0 and below 1'],
    ['barsDefault', 0, 'barsDefault must be a whole number >= 1'],
    ['barsCap', 50, 'barsCap must be a whole number between barsDefault (100) and 10000'],
    ['reconcileMs', 10, 'reconcileMs must be a finite number >= 1000'],
  ] as const)('rejects %s = %s', (field, value, message) => {
    expect(() => validateConfig({ ...defaults(), [field]: value })).toThrow(new RangeError(`tool-trading: ${message}`))
  })

  it('rejects a bad retry delay and an unknown symbol in a list', () => {
    expect(() => validateConfig({ ...defaults(), exitRetryMs: [100, Number.NaN] }))
      .toThrow('tool-trading: exitRetryMs entries must be finite numbers >= 0')
    expect(() => validateConfig({ ...defaults(), denylist: ['not a symbol'] })).toThrow('tool-trading: denylist entry')
  })
})
