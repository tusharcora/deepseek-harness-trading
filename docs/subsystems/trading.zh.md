# Trading

[English](trading.md) | 中文

实验性交易台只通过 `ctx.tradingVenue` 上的交易场所服务访问券商：账户读取、行情数据、订单提交、Halt 与订单更新。[`@deepseek-ai/dsh-experimental-trading-venue`](../../packages/experimental/trading-venue/README.md) 定义该服务、`VenueError` 与 `trading/venue-status` 事件；[`@deepseek-ai/dsh-experimental-trading-alpaca`](../../packages/experimental/trading-alpaca/README.md) 在 Alpaca 上提供它，并负责账户安全与持久化的 Halt。设计见[交易台 Agent Note](../../.agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtradingvenue--tradingvenuegateway-abstract-seam"></a>

### `ctx.tradingVenue` — `TradingVenueGateway` (abstract seam)

A trading venue. Every method that reaches the broker resolves the API keys at call time and throws VenueError on failure. `submitOrder` refuses while the venue is `halted` or `blocked`; `closePosition` and `flatten` are reduce-only and run whenever keys exist, including while halted or blocked. `halt` never fails because the broker is unreachable: it halts the desk first and keeps retrying the broker suspension.

```ts cordis-catalog
/**
 * Current readiness.
 * @returns the venue status.
 */
abstract status(): VenueStatus

/**
 * Read the account.
 * @returns equity, cash, last equity, buying power, and whether trading is blocked.
 */
abstract account(): Promise<AccountSnapshot>

/**
 * Read open positions.
 * @returns every open position.
 */
abstract positions(): Promise<PositionSnapshot[]>

/**
 * Read open orders.
 * @returns every order the broker still works.
 */
abstract openOrders(): Promise<BrokerOrder[]>

/**
 * Read broker facts for one instrument.
 * @param symbol - instrument.
 * @returns tradability, fractional support, minimum size, and price tick.
 */
abstract asset(symbol: TradingSymbol): Promise<Asset>

/**
 * Whether the instrument's market is open now.
 * @param symbol - instrument.
 * @returns true during regular hours for equities, always true for crypto.
 */
abstract marketOpen(symbol: TradingSymbol): Promise<boolean>

/**
 * Read the latest quote.
 * @param symbol - instrument.
 * @returns best bid, best ask, and quote time.
 */
abstract latestQuote(symbol: TradingSymbol): Promise<Quote>

/**
 * Read bar history, oldest first.
 * @param symbol - instrument.
 * @param timeframe - bar timeframe.
 * @param query - time range and maximum count.
 * @returns at most `query.limit` bars, oldest first.
 */
abstract bars(symbol: TradingSymbol, timeframe: Timeframe, query: BarQuery): Promise<Bar[]>

/**
 * Submit an order. A retry with the same `clientOrderId` returns the existing order instead of creating a second one.
 * @param request - approved, planned order.
 * @returns the order as the broker accepted it.
 */
abstract submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder>

/**
 * Cancel one open order.
 * @param id - broker order id.
 * @returns when the broker accepted the cancellation.
 */
abstract cancelOrder(id: BrokerOrderId): Promise<void>

/**
 * Cancel the instrument's open orders, then close the position at market; allowed while halted or blocked. Throws
 * {@link VenueError} with code `not-found` when there is no position for the instrument.
 * @param symbol - instrument.
 * @returns the closing order.
 */
abstract closePosition(symbol: TradingSymbol): Promise<BrokerOrder>

/**
 * Cancel every open order, then attempt to close every position at market; allowed while halted or blocked. When any
 * position fails to close it throws {@link VenueError} with code `rejected` naming the failed instruments; the closes
 * that succeeded still stand.
 * @returns the closing orders.
 */
abstract flatten(): Promise<BrokerOrder[]>

/**
 * Halt the desk now and persist it; then suspend trading at the broker, retrying until confirmed (a failed attempt
 * leaves the suspension pending and the drift watch retries it). Works without keys and while blocked.
 * @param reason - readable cause shown in the panel.
 * @returns when the desk is halted; the broker suspension may still be pending.
 */
abstract halt(reason: string): Promise<void>

/**
 * Re-apply the account safety settings and lift the Halt.
 * @returns when the broker confirmed.
 */
abstract resume(): Promise<void>

/**
 * Receive order updates and gaps; the venue streams only while at least one listener is registered. After a gap the
 * listener must re-read open orders and positions, because missed updates are not replayed. A gap is delivered only
 * after the stream has re-authenticated and is listening again, so a re-read made after it cannot miss updates, or
 * once when the stream stops for good.
 * @param listener - called once per event.
 * @returns a disposer that removes the listener.
 */
abstract subscribeOrderUpdates(listener: (event: OrderStreamEvent) => void): () => void
```

Source: [`packages/experimental/trading-venue/src/index.ts`](../../packages/experimental/trading-venue/src/index.ts)

<a id="trading-events"></a>

### `trading/*` events

<a id="tradingvenue-status--emit"></a>

#### `trading/venue-status` — emit

The venue's readiness changed.

```ts cordis-catalog
/**
 * The venue's readiness changed.
 * @mode emit
 * @param status - new readiness.
 * @param reason - readable cause, such as the account setting that drifted.
 */
'trading/venue-status'(status: VenueStatus, reason: string): void
```

Source: [`packages/experimental/trading-venue/src/index.ts`](../../packages/experimental/trading-venue/src/index.ts)
<!-- END GENERATED cordis-surface -->
