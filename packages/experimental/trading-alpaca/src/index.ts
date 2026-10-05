/**
 * Alpaca provider for `ctx.tradingVenue`. Paper by default; live needs
 * `mode: live` and `DSH_TRADING_LIVE=1`. Keys resolve through the
 * credentials service (or the launch environment) on every request.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, OrderStreamEvent, PositionSnapshot,
  Quote, Timeframe, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { TradingVenueGateway, VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { type Domain, defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Config, resolveEndpoints } from './config.ts'
import { AlpacaHttp } from './http.ts'
import { INITIAL_SAFETY_STATE } from './safety.ts'
import { TradeUpdateStream } from './stream.ts'
import type { AlpacaKeys } from './types.ts'
import { orderedStore, VenueCore } from './venue.ts'

export { Config } from './config.ts'

/** Storage domain holding the persisted Halt state. */
export const tradingSafetyDomainSpec = defineDomain({
  name: 'trading_alpaca_safety',
  version: 1,
  global: {
    schema: zod.object({
      halted: zod.boolean(), haltReason: zod.string(), flattenWindowOpen: zod.boolean(), suspendPending: zod.boolean(),
    }),
    initial: INITIAL_SAFETY_STATE,
  },
  tables: {},
})

/** Alpaca implementation of the trading venue. */
export class AlpacaVenue extends TradingVenueGateway {
  static inject = ['storageDomain']
  static Config: z<Partial<Config>, Config> = Config

  private readonly core: VenueCore
  /** Resolved with the Halt-state domain once init opens it; writes wait for it. */
  private readonly domain = Promise.withResolvers<Domain<typeof tradingSafetyDomainSpec>>()
  private readonly warn = (message: string): void => { this.ctx.logger.warn(`trading-alpaca: ${message}`) }
  private readonly store = orderedStore(INITIAL_SAFETY_STATE, async (state) => {
    await (await this.domain.promise).global.set(state)
  })

  /**
   * @param ctx - plugin context.
   * @param config - provider configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const environment = launchEnvironmentOf(ctx)
    const endpoints = resolveEndpoints(config, environment.get('DSH_TRADING_LIVE')?.value)
    const keys = async (): Promise<AlpacaKeys | undefined> => {
      const keyId = await resolveCredential(ctx, config.apiKeyEnv)
      const secret = await resolveCredential(ctx, config.secretKeyEnv)
      return keyId === undefined || secret === undefined ? undefined : { keyId, secret }
    }
    const requireKeys = async (): Promise<AlpacaKeys> => {
      const pair = await keys()
      if (pair === undefined) throw new VenueError('Alpaca keys not configured — add them in Settings → Trading', 'unconfigured')
      return pair
    }
    const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() })
    this.core = new VenueCore({
      http: new AlpacaHttp({ tradingUrl: endpoints.tradingUrl, dataUrl: endpoints.dataUrl, timeoutMs: config.requestTimeoutMs,
        retryDelaysMs: config.rateLimitRetryMs, keys: requireKeys }),
      feed: config.feed,
      cryptoMinNotional: config.cryptoMinNotional,
      now: Date.now,
      timing: {
        confirmDelayMs: config.lookupConfirmMs, settleDelayMs: config.closeSettleMs, settleChecks: config.closeSettleChecks, sleep,
      },
      safetyTiming: { suspendRetryMs: config.suspendRetryMs, sleep },
      keysPresent: async () => (await keys()) !== undefined,
      store: this.store,
      stream: (onEvent, onStopped) => new TradeUpdateStream({
        url: endpoints.tradeStreamUrl, backoffMs: config.streamBackoffMs,
        keys: requireKeys, onEvent, onStopped,
        onError: (error) => { this.warn(error.message) },
      }),
      emitStatus: (status, reason) => { ctx.emit('trading/venue-status', status, reason) },
      warn: this.warn,
    })
    // New keys may be accepted where the old ones were not: restart a stream that stopped on rejected keys.
    ctx.on('credentials/reference-updated', () => { this.core.restartStream() })
    const stopDrift = this.core.watchDrift(config.driftCheckMs, this.warn)
    ctx.effect(() => () => { stopDrift(); this.core.close() }, 'trading-alpaca teardown')
  }

  /**
   * Open the Halt-state domain, then set the venue up when keys exist; set up again when a credentials provider
   * starts after this service.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(tradingSafetyDomainSpec)
    // Persist every pending Halt write before closing, so a Halt clicked just before a reload survives it.
    this.ctx.effect(() => async () => { await this.store.flush(); await domain.close() }, 'trading-alpaca domain close')
    this.store.load(domain.global.get())
    this.domain.resolve(domain)
    await this.prepare()
    this.ctx.inject(['credentials'], () => { void this.prepare() })
  }

  private async prepare(): Promise<void> {
    await this.core.prepare().catch((error: unknown) => { this.warn(`setup deferred: ${(error as Error).message}`) })
  }

  /** @returns the venue status. */
  status(): VenueStatus { return this.core.status() }
  /** @returns the account snapshot. */
  account(): Promise<AccountSnapshot> { return this.core.account() }
  /** @returns open positions. */
  positions(): Promise<PositionSnapshot[]> { return this.core.positions() }
  /** @returns open orders. */
  openOrders(): Promise<BrokerOrder[]> { return this.core.openOrders() }
  /** @param symbol - instrument. @returns broker facts. */
  asset(symbol: TradingSymbol): Promise<Asset> { return this.core.asset(symbol) }
  /** @param symbol - instrument. @returns whether its market is open. */
  marketOpen(symbol: TradingSymbol): Promise<boolean> { return this.core.marketOpen(symbol) }
  /** @param symbol - instrument. @returns the latest quote. */
  latestQuote(symbol: TradingSymbol): Promise<Quote> { return this.core.latestQuote(symbol) }
  /** @param symbol - instrument. @param timeframe - timeframe. @param query - range and count. @returns bars. */
  bars(symbol: TradingSymbol, timeframe: Timeframe, query: BarQuery): Promise<Bar[]> { return this.core.bars(symbol, timeframe, query) }
  /** @param request - planned order. @returns the accepted order. */
  submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> { return this.core.submitOrder(request) }
  /** @param id - broker order id. @returns when cancelled. */
  cancelOrder(id: BrokerOrderId): Promise<void> { return this.core.cancelOrder(id) }
  /** @param symbol - instrument. @returns the closing order. */
  closePosition(symbol: TradingSymbol): Promise<BrokerOrder> { return this.core.closePosition(symbol) }
  /** @returns the closing orders. */
  flatten(): Promise<BrokerOrder[]> { return this.core.flatten() }
  /** @param reason - readable cause. @returns when halted. */
  halt(reason: string): Promise<void> { return this.core.halt(reason) }
  /** @returns when running again. */
  resume(): Promise<void> { return this.core.resume() }
  /** @param listener - receives updates and gaps. @returns a disposer. */
  subscribeOrderUpdates(listener: (event: OrderStreamEvent) => void): () => void { return this.core.subscribeOrderUpdates(listener) }
}

async function resolveCredential(ctx: Context, name: string): Promise<string | undefined> {
  const ref = credentialRef(name)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  return launchEnvironmentOf(ctx).get(ref)?.value
}

export default AlpacaVenue
