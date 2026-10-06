/**
 * Executor configuration: risk limits, the re-check drift tolerance, `get_bars` limits, and timers. Limits change only
 * through configuration (the trading profile's defaults, later the Trading settings card), never from chat.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/config
 */
import { parseSymbol, type RiskLimits } from '@deepseek-ai/dsh-experimental-trading'
import z from '@deepseek-ai/schemastery'

/** Executor configuration. */
export interface Config {
  /** Largest estimated order value in dollars. */
  maxOrderNotional: number
  /** Largest position value as a fraction of equity (`0.2` = 20%), counting open orders and pending proposals. */
  maxPositionPct: number
  /** Day loss as a fraction of the previous close's equity at which exposure-increasing orders stop. */
  dailyLossPct: number
  /** Desk orders per trading day, counting pending proposals. */
  maxOrdersPerDay: number
  /** Whether sells may open or extend a short position. */
  allowShort: boolean
  /** Whether buys may exceed cash. */
  allowMargin: boolean
  /** Tickers allowed; empty allows every ticker. */
  allowlist: string[]
  /** Tickers never allowed. */
  denylist: string[]
  /** Quote age above which market orders are refused while the market is open, milliseconds. */
  staleQuoteMs: number
  /** Allowed price drift between approval and submission, and the market-order price cap, as a fraction. */
  driftTolerance: number
  /** Bars `get_bars` returns when the call names no limit. */
  barsDefault: number
  /** Most bars `get_bars` returns. */
  barsCap: number
  /** Interval between re-reads of open and in-flight orders, milliseconds. */
  reconcileMs: number
  /** Waits before retrying a crypto exit the broker rejected for insufficient balance right after a fill; one retry each. */
  exitRetryMs: number[]
}

/** Validated configuration schema with the spec's defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  maxOrderNotional: z.number().default(1_000),
  maxPositionPct: z.number().default(0.2),
  dailyLossPct: z.number().default(0.03),
  maxOrdersPerDay: z.number().default(20),
  allowShort: z.boolean().default(false),
  allowMargin: z.boolean().default(false),
  allowlist: z.array(z.string()).default([]),
  denylist: z.array(z.string()).default([]),
  staleQuoteMs: z.number().default(30_000),
  driftTolerance: z.number().default(0.01),
  barsDefault: z.number().default(100),
  barsCap: z.number().default(500),
  reconcileMs: z.number().default(60_000),
  exitRetryMs: z.array(z.number()).default([500, 1_000, 2_000]),
})

const MAX_BARS = 10_000

function fail(message: string): never {
  throw new RangeError(`tool-trading: ${message}`)
}

function finite(name: string, value: number, min: number, max?: number): void {
  if (Number.isFinite(value) && value >= min && (max === undefined || value <= max)) return
  fail(`${name} must be a finite number >= ${min}${max === undefined ? '' : ` and <= ${max}`}`)
}

function whole(name: string, value: number, min: number): void {
  if (!(Number.isInteger(value) && value >= min)) fail(`${name} must be a whole number >= ${min}`)
}

function tickers(name: string, values: readonly string[]): string[] {
  return values.map((value) => {
    try {
      return parseSymbol(value).ticker
    } catch (error) {
      return fail(`${name} entry ${JSON.stringify(value)}: ${(error as Error).message}`)
    }
  })
}

/**
 * Reject values the schema cannot express (non-finite, out of range, fractional counts) and canonicalize the symbol
 * lists, so a bad limit fails at load instead of silently loosening a check.
 * @param config - configuration after schema defaults.
 * @returns the configuration with canonical tickers.
 * @throws RangeError naming the first invalid field.
 */
export function validateConfig(config: Config): Config {
  finite('maxOrderNotional', config.maxOrderNotional, 0)
  finite('maxPositionPct', config.maxPositionPct, 0, 1)
  finite('dailyLossPct', config.dailyLossPct, 0, 1)
  whole('maxOrdersPerDay', config.maxOrdersPerDay, 0)
  finite('staleQuoteMs', config.staleQuoteMs, 0)
  if (!(Number.isFinite(config.driftTolerance) && config.driftTolerance >= 0 && config.driftTolerance < 1)) {
    fail('driftTolerance must be a finite number >= 0 and below 1')
  }
  whole('barsDefault', config.barsDefault, 1)
  if (!(Number.isInteger(config.barsCap) && config.barsCap >= config.barsDefault && config.barsCap <= MAX_BARS)) {
    fail(`barsCap must be a whole number between barsDefault (${config.barsDefault}) and ${MAX_BARS}`)
  }
  finite('reconcileMs', config.reconcileMs, 1_000)
  if (!config.exitRetryMs.every(delay => Number.isFinite(delay) && delay >= 0)) {
    fail('exitRetryMs entries must be finite numbers >= 0')
  }
  // `Config` names a plain-object interface; the lint rule mistakes the interface merged with the schema value for a class.
  // oxlint-disable-next-line typescript/no-misused-spread -- plain object, see above.
  return { ...config, allowlist: tickers('allowlist', config.allowlist), denylist: tickers('denylist', config.denylist) }
}

/**
 * The limits `checkRisk` reads.
 * @param config - validated configuration.
 * @returns the risk limits.
 */
export function riskLimitsOf(config: Config): RiskLimits {
  return {
    maxOrderNotional: config.maxOrderNotional, maxPositionPct: config.maxPositionPct, dailyLossPct: config.dailyLossPct,
    maxOrdersPerDay: config.maxOrdersPerDay, allowShort: config.allowShort, allowMargin: config.allowMargin,
    allowlist: config.allowlist, denylist: config.denylist, staleQuoteMs: config.staleQuoteMs,
  }
}
