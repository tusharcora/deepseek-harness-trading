/**
 * Alpaca provider configuration and endpoint resolution.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/config
 */
import z from '@deepseek-ai/schemastery'

/** Alpaca provider configuration. */
export interface Config {
  /** Paper or live account; live also needs `DSH_TRADING_LIVE=1` at launch. */
  mode: 'paper' | 'live'
  /** Credential name holding the Alpaca API key id. */
  apiKeyEnv: string
  /** Credential name holding the Alpaca secret key. */
  secretKeyEnv: string
  /** Equity data feed; the free plan serves only `iex`. */
  feed: 'iex' | 'sip'
  /** Interval between account-configuration drift checks, milliseconds. */
  driftCheckMs: number
  /** Per-request timeout for Alpaca REST calls, milliseconds. */
  requestTimeoutMs: number
  /** Waits before retrying a rate-limited read; one retry per entry. */
  rateLimitRetryMs: number[]
  /** Waits before trade-stream reconnect attempts; the last entry repeats. */
  streamBackoffMs: number[]
  /** Waits before retrying an unconfirmed broker suspension during Halt; one retry per entry. */
  suspendRetryMs: number[]
  /** Wait before the second confirming lookup after an order submission failed in transit or hit a used client order id, milliseconds. */
  lookupConfirmMs: number
  /** Wait between checks that a symbol's cancelled orders are gone before closing its position, milliseconds. */
  closeSettleMs: number
  /** Maximum such checks before closing anyway. */
  closeSettleChecks: number
  /** Alpaca's minimum crypto order value in dollars; Alpaca rejects smaller crypto orders but does not publish this on the asset. */
  cryptoMinNotional: number
  /** Trading API base URL; empty selects the paper or live host for `mode`. */
  tradingUrl: string
  /** Market data API base URL. */
  dataUrl: string
  /** Trade-updates stream URL; empty selects the paper or live host for `mode`. */
  tradeStreamUrl: string
}

/** Validated configuration schema. */
export const Config: z<Partial<Config>, Config> = z.object({
  mode: z.union(['paper', 'live'] as const).default('paper'),
  apiKeyEnv: z.string().role('credential-ref').default('ALPACA_API_KEY'),
  secretKeyEnv: z.string().role('credential-ref').default('ALPACA_SECRET_KEY'),
  feed: z.union(['iex', 'sip'] as const).default('iex'),
  driftCheckMs: z.number().min(5_000).default(60_000),
  requestTimeoutMs: z.number().min(1_000).default(15_000),
  rateLimitRetryMs: z.array(z.number().min(0)).default([1_000, 2_000, 4_000]),
  streamBackoffMs: z.array(z.number().min(1)).min(1).default([1_000, 2_000, 5_000, 10_000, 30_000]),
  suspendRetryMs: z.array(z.number().min(0)).default([500, 1_000, 2_000]),
  lookupConfirmMs: z.number().min(0).default(2_000),
  closeSettleMs: z.number().min(0).default(500),
  closeSettleChecks: z.number().min(0).default(10),
  cryptoMinNotional: z.number().min(0).default(10),
  tradingUrl: z.string().default(''),
  dataUrl: z.string().default('https://data.alpaca.markets'),
  tradeStreamUrl: z.string().default(''),
})

/** Resolved base URLs. */
export interface Endpoints {
  /** Trading API base URL. */
  readonly tradingUrl: string
  /** Market data API base URL. */
  readonly dataUrl: string
  /** Trade-updates WebSocket URL. */
  readonly tradeStreamUrl: string
}

const PAPER_HOST = 'paper-api.alpaca.markets'
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Resolve base URLs for the configured mode. Trading against any host other than Alpaca's paper host or loopback
 * moves real money, so it needs the launch flag whatever `mode` says.
 * @param config - provider configuration.
 * @param liveFlag - the launch environment's `DSH_TRADING_LIVE` value.
 * @returns the base URLs.
 * @throws Error when the trading host is not paper or loopback (or `mode` is `live`) and `liveFlag` is not exactly `1`.
 */
export function resolveEndpoints(config: Config, liveFlag: string | undefined): Endpoints {
  const host = config.mode === 'live' ? 'api.alpaca.markets' : PAPER_HOST
  const endpoints: Endpoints = {
    tradingUrl: config.tradingUrl === '' ? `https://${host}` : config.tradingUrl,
    dataUrl: config.dataUrl,
    tradeStreamUrl: config.tradeStreamUrl === '' ? `wss://${host}/stream` : config.tradeStreamUrl,
  }
  const tradingHost = new URL(endpoints.tradingUrl).hostname
  const paperOrLocal = config.mode === 'paper' && (tradingHost === PAPER_HOST || LOOPBACK_HOSTS.includes(tradingHost))
  if (!paperOrLocal && liveFlag !== '1') {
    throw new Error(`trading-alpaca: trading against ${tradingHost} (mode ${config.mode}) requires DSH_TRADING_LIVE=1 at launch`)
  }
  return endpoints
}
