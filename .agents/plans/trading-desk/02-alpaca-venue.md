# Alpaca Venue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the harness a broker connection: a `ctx.tradingVenue` service with an Alpaca provider that reads accounts, positions, orders, assets, quotes, and bars; submits, cancels, and closes orders without ever duplicating one; enforces and drift-checks the account safety settings; persists Halt across restarts; and streams order updates.

**Architecture:** Two new experimental packages. `trading-venue` is the Service Definition: one abstract Cordis `Service` (`TradingVenueGateway`, key `tradingVenue`) plus `VenueError`. `trading-alpaca` is the Service Provider: an `AlpacaVenue` service class that delegates to small, separately tested units — `AlpacaHttp` (REST client and error mapping), `map.ts` (Alpaca JSON → domain values), `market.ts` (quotes, bars, clock), `orders.ts` (idempotent submit, cancel, close), `AccountSafety` (account configuration, Halt, flatten window, drift), `TradeUpdateStream` (reconnecting WebSocket), and `VenueCore` (status machine and order gating). Venue-facing domain types go into the existing browser-safe `trading` library so the UI can use them. Tests run against a real local HTTP server and a real `ws` WebSocket server; only the network is faked.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Cordis services, schemastery `Config`, zod (storage-domain schema), global `fetch` and `WebSocket` (Node ≥ 22), Vitest, `ws` (tests only).

**Spec:** `.agents/notes/proposed/feature/2026-10-05-trading-desk.md`. Roadmap: [00-roadmap.md](00-roadmap.md). Plan 1 (done): [01-trading-domain.md](01-trading-domain.md).

## Global Constraints

- Node `^22.19 || >=24`; on this machine prefix commands with `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH &&`. The pre-commit and pre-push hooks also need it.
- npm names `@deepseek-ai/dsh-experimental-trading-venue` and `@deepseek-ai/dsh-experimental-trading-alpaca`; omit `private`; `publishConfig.access: "public"`; `version` = root `package.json` version; `@deepseek-ai/cordis` in `peerDependencies` and `devDependencies`; every dsh peer mirrored in `devDependencies`; `@deepseek-ai/schemastery` and `zod` in `dependencies` where used.
- Register each package in `tsconfig.base.json` `paths` (beside the other `dsh-experimental-*` entries) and `tsconfig.host.json` `references`.
- Service packages default-export their service class and nothing else plugin-shaped (`packages/AGENTS.md`).
- Optional services through `ctx.get(name)` (`credentials`); declared injections through `ctx.<name>` (`storageDomain`).
- Resolve API keys on every request; never cache key values.
- No `!` assertions in `src`; lines ≤ 140 columns; `src/types.ts` holds types only; every export has JSDoc with `@param`/`@returns`; typed events carry `@mode` and `@param`.
- Per-file 100% coverage on `src`. Mock only the network and the clock.
- Experimental package READMEs use `kind: "package-reference"`, have English and Chinese files plus a recorded pair, and a new package adds a line to `docs/config-catalog.md` and its `.zh.md` mirror (regenerate with `pnpm run gen-config-catalog`, mirror the line, re-record the pair).
- Commit messages carry no Claude or AI attribution lines.
- Alpaca facts this plan relies on (verified 2026-10-05 against docs.alpaca.markets): auth headers `APCA-API-KEY-ID`/`APCA-API-SECRET-KEY`; paper `https://paper-api.alpaca.markets`, live `https://api.alpaca.markets`, data `https://data.alpaca.markets`; trade stream `wss://<trading host>/stream` sends **binary** frames; account and order numbers are **strings**, market-data numbers are JSON numbers; `max_margin_multiplier` is the string `"1"`; `client_order_id` ≤ 128 chars; duplicate `client_order_id` → HTTP 422 code `40010001`; `DELETE /v2/orders` and `DELETE /v2/positions` answer 207 with per-item `status`; crypto symbols are `BTC/USD` but some responses use `BTCUSD`; bars `limit` max 10000; free-plan rate limit 200 requests/minute.

## Review Focus

1. **A network failure or 5xx during order submission** must never produce a second order and never report "not placed" when the order may exist: look up by `client_order_id` first. Pinned in Task 6.
2. **Alpaca returning a malformed number** (`""`, `null`, `"abc"`) in account, position, or order data must fail with a `VenueError`, never become `NaN` that later checks treat as a value. Pinned in Task 5.
3. **Account settings changed behind the desk's back** (`no_shorting` false, multiplier `"2"`, `suspend_trade` flipped) must halt the desk within one drift interval, while the desk's own flatten window is not mistaken for drift. Pinned in Task 7.
4. **A crash inside the flatten window** must leave the account suspended and the desk halted on the next start. Pinned in Task 7.
5. **The trade-updates socket dropping or rejecting the keys**: a drop reconnects with backoff and re-authenticates; an auth rejection stops reconnecting and reports `auth`. Pinned in Task 8.

---

### Task 1: Amend the spec for the venue seam and the streaming split

**Files:**
- Modify: `.agents/notes/proposed/feature/2026-10-05-trading-desk.md`, `.agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md`, `.agents/notes/proposed/feature/2026-10-05-trading-desk.i18n.yaml` (re-recorded)
- Modify: `.agents/plans/trading-desk/00-roadmap.md`

**Interfaces:** none.

- [ ] **Step 1: Edit the English note**

In the Package topology table, replace the `trading` row's "`MarketData` and `Broker` service interfaces" with "venue-facing types (account, position, broker order, order update)", replace the `trading-alpaca` row's "Registers `ctx.marketData` and `ctx.broker`" with "Registers `ctx.tradingVenue`", and add this row directly after the `trading` row:

```markdown
| `trading-venue` | Service Definition for a trading venue | Abstract `TradingVenueGateway` service at `ctx.tradingVenue` (account, positions, orders, assets, quotes, bars, submit, cancel, close, flatten, Halt, order-update subscription) and `VenueError` |
```

Change "built from seven `packages/experimental/` packages" to "built from eight", "composes the other six packages" to "composes the other seven packages", and "All seven packages pass the per-file 100% coverage gate" to "All eight packages pass the per-file 100% coverage gate". Replace every remaining "`MarketData` and `Broker` interfaces" with "`TradingVenueGateway` service". Append to the paragraph that begins "`tool-trading` owns the order executor":

```markdown
Market data and order execution share one Service Definition, `TradingVenueGateway` at `ctx.tradingVenue`, because a venue's data and order APIs share one account and one set of keys, and a service package default-exports exactly one service class.
```

In Market data, replace the bullet "On disconnect, the provider reconnects with backoff, backfills the gap from REST, and marks the symbol stale until a fresh tick arrives." with:

```markdown
- The live market-data WebSocket and its reference-counted subscriptions ship with the Trading panel (`trading-gateway`), which owns the chart's bar series: on disconnect it reconnects with backoff, backfills the gap from REST bars, and marks the symbol stale until a fresh tick arrives. `trading-alpaca` streams order updates from the account's trade-updates socket.
```

Run: `grep -n "ctx.marketData\|ctx.broker\|seven\|six packages" .agents/notes/proposed/feature/2026-10-05-trading-desk.md`
Expected: no output.

- [ ] **Step 2: Mirror the edits in the Chinese note and record the pair**

Apply the same changes to the `.zh.md`, following `docs/i18n/terminology.md` (row text in Chinese; code spans unchanged). New table row:

```markdown
| `trading-venue` | 交易场所的 Service Definition | 位于 `ctx.tradingVenue` 的抽象 `TradingVenueGateway` 服务（账户、持仓、订单、资产、报价、K 线、提交、撤单、平仓、清仓、暂停、订单更新订阅）以及 `VenueError` |
```

Appended sentence: `行情数据与订单执行共用一个 Service Definition，即位于 \`ctx.tradingVenue\` 的 \`TradingVenueGateway\`，因为同一交易场所的数据 API 与订单 API 共用一个账户和一组密钥，且一个服务包只默认导出一个服务类。`

Replacement bullet: `- 实时行情 WebSocket 及其引用计数订阅随 Trading 面板（\`trading-gateway\`）一起交付，由拥有图表 K 线序列的面板负责：断线时以退避方式重连，通过 REST K 线回补缺口，并在收到新的报价前将该标的标记为陈旧。\`trading-alpaca\` 从账户的成交更新 socket 推送订单更新。`

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-10-05-trading-desk.md && pnpm run verify-translation-pairing && pnpm run verify-agent-note-format`
Expected: pairing writes one record, then reports all pairs consistent; format passes.

- [ ] **Step 3: Update the roadmap**

In `00-roadmap.md`, change Plan 2's row to: packages `trading-venue`, `trading-alpaca`; ends with "`ctx.tradingVenue` against a fake Alpaca HTTP/WebSocket server: reads, idempotent submit, cancel, close, flatten, account configuration set/verified/drift-checked, persisted Halt and flatten window, order-update stream"; status "Written: [02-alpaca-venue.md](02-alpaca-venue.md)". Add to Plan 4's "Ends with": "live market-data WebSocket (one per asset class, reference-counted subscriptions, reconnect with REST backfill, stale marking) added to `trading-alpaca` and consumed by `trading-gateway`". Delete the roadmap note that begins "**Plan 2:** adds the `MarketData` and `Broker` service interfaces".

- [ ] **Step 4: Commit**

```bash
git add .agents/notes/proposed/feature/2026-10-05-trading-desk.md .agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md .agents/notes/proposed/feature/2026-10-05-trading-desk.i18n.yaml .agents/plans/trading-desk/00-roadmap.md
git commit -m "docs(notes): define the trading venue seam and move market streaming to the panel"
```

---

### Task 2: Venue-facing domain types and the `trading-venue` Service Definition

**Files:**
- Modify: `packages/experimental/trading/src/types.ts` (append types; types only)
- Create: `packages/experimental/trading-venue/package.json`, `tsconfig.json`, `src/index.ts`
- Modify: `tsconfig.base.json`, `tsconfig.host.json`
- Test: `packages/experimental/trading-venue/tests/venue.spec.ts`

**Interfaces:**
- Produces (in `@deepseek-ai/dsh-experimental-trading`): `AccountSnapshot`, `PositionSnapshot`, `OrderStatus`, `BrokerOrder`, `BrokerOrderRequest`, `OrderUpdateEvent`, `OrderUpdate`, `VenueStatus`, `BarQuery`.
- Produces (in `@deepseek-ai/dsh-experimental-trading-venue`): `TradingVenueGateway` (abstract, key `tradingVenue`), `VenueError` with `code: VenueErrorCode` and optional `brokerCode`, the `trading/venue-status` event. Method signatures exactly as in Step 3; Tasks 4–9 implement them.

- [ ] **Step 1: Append the venue types to the `trading` library**

Append to `packages/experimental/trading/src/types.ts`:

```ts
/** Account values the desk reads before every order. */
export interface AccountSnapshot {
  /** Current equity. */
  readonly equity: number
  /** Cash available for buys. */
  readonly cash: number
  /** Equity at the previous close. */
  readonly lastEquity: number
  /** Broker-reported buying power. */
  readonly buyingPower: number
  /** Whether the broker blocks new orders on the account. */
  readonly tradingBlocked: boolean
}

/** One open position; `qty` is negative for a short position. */
export interface PositionSnapshot {
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Signed quantity. */
  readonly qty: number
  /** Average entry price. */
  readonly avgEntryPrice: number
  /** Latest price the broker used for valuation. */
  readonly currentPrice: number
  /** Position value at `currentPrice`. */
  readonly marketValue: number
  /** Unrealized profit or loss in dollars. */
  readonly unrealizedPl: number
}

/** Lifecycle state of a broker order; every non-terminal broker state is `open`. */
export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'

/** An order as the broker reports it. */
export interface BrokerOrder {
  /** Broker order id. */
  readonly id: BrokerOrderId
  /** Idempotency key the order was submitted with. */
  readonly clientOrderId: ClientOrderId
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Direction. */
  readonly side: Side
  /** Order type; `other` for types the desk does not place (for example a trailing stop placed elsewhere). */
  readonly type: OrderType | 'other'
  /** Broker time-in-force code. */
  readonly timeInForce: string
  /** Ordered quantity, when the order was quantity-based. */
  readonly qty?: number
  /** Ordered dollar amount, when the order was notional. */
  readonly notional?: number
  /** Limit price. */
  readonly limitPrice?: number
  /** Stop price. */
  readonly stopPrice?: number
  /** Filled quantity so far. */
  readonly filledQty: number
  /** Average fill price, once anything filled. */
  readonly filledAvgPrice?: number
  /** Lifecycle state. */
  readonly status: OrderStatus
  /** Submission time, UTC epoch milliseconds. */
  readonly submittedAt?: number
}

/** What the executor sends to the venue after approval and submission planning. */
export interface BrokerOrderRequest {
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Direction. */
  readonly side: Side
  /** Quantity; exactly one of `qty` and `notional`. */
  readonly qty?: number
  /** Dollar amount; exactly one of `qty` and `notional`. */
  readonly notional?: number
  /** Order type. */
  readonly type: OrderType
  /** Limit price. */
  readonly limitPrice?: number
  /** Stop price. */
  readonly stopPrice?: number
  /** Time in force. */
  readonly timeInForce: TimeInForce
  /** Equity bracket legs. */
  readonly bracket?: Bracket
  /** Idempotency key; the same key never creates a second order. */
  readonly clientOrderId: ClientOrderId
}

/** Kind of order update; `other` covers broker events the desk only records. */
export type OrderUpdateEvent = 'new' | 'partial_fill' | 'fill' | 'canceled' | 'expired' | 'rejected' | 'other'

/** One order-lifecycle event from the venue's stream. */
export interface OrderUpdate {
  /** Event kind. */
  readonly event: OrderUpdateEvent
  /** Order state after the event. */
  readonly order: BrokerOrder
  /** Event time, UTC epoch milliseconds. */
  readonly t: number
  /** Price of this fill, for fill events. */
  readonly fillPrice?: number
  /** Quantity of this fill, for fill events. */
  readonly fillQty?: number
  /** Position quantity after this fill, for fill events. */
  readonly positionQty?: number
}

/** Venue readiness: no keys, ready, halted by the user or by drift, or blocked because the account cannot be made safe. */
export type VenueStatus = 'unconfigured' | 'ready' | 'halted' | 'blocked'

/** Bar history request; without `start` the venue returns the most recent `limit` bars ending at `end` (default now). */
export interface BarQuery {
  /** Earliest bar start, UTC epoch milliseconds. */
  readonly start?: number
  /** Latest bar start, UTC epoch milliseconds. */
  readonly end?: number
  /** Maximum number of bars. */
  readonly limit: number
}
```

- [ ] **Step 2: Scaffold `trading-venue` and write the failing test**

`packages/experimental/trading-venue/package.json` (version = root version):

```json
{
  "name": "@deepseek-ai/dsh-experimental-trading-venue",
  "description": "Service Definition for a trading venue: account, orders, market data, and order updates at ctx.tradingVenue",
  "version": "0.1.6-alpha.1",
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/deepseek-ai/deepseek-harness.git", "directory": "packages/experimental/trading-venue" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "dependencies": { "@deepseek-ai/dsh-experimental-trading": "workspace:^" },
  "peerDependencies": { "@deepseek-ai/cordis": "workspace:^" },
  "devDependencies": { "@deepseek-ai/cordis": "workspace:^" }
}
```

`packages/experimental/trading-venue/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../trading" }
  ]
}
```

Add the `paths` entry `"@deepseek-ai/dsh-experimental-trading-venue": ["./packages/experimental/trading-venue/src/index.ts"]` and the reference `{ "path": "./packages/experimental/trading-venue" }`.

`packages/experimental/trading-venue/tests/venue.spec.ts`:

```ts
import { Context } from '@deepseek-ai/cordis'
import type {
  AccountSnapshot, Asset, Bar, BrokerOrder, OrderUpdate, PositionSnapshot, Quote, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import TradingVenueGateway, { VenueError } from '../src/index.ts'

class FakeVenue extends TradingVenueGateway {
  status(): VenueStatus { return 'ready' }
  async account(): Promise<AccountSnapshot> { return { equity: 1, cash: 1, lastEquity: 1, buyingPower: 1, tradingBlocked: false } }
  async positions(): Promise<PositionSnapshot[]> { return [] }
  async openOrders(): Promise<BrokerOrder[]> { return [] }
  async asset(): Promise<Asset> { throw new VenueError('no assets', 'not-found') }
  async marketOpen(): Promise<boolean> { return true }
  async latestQuote(): Promise<Quote> { return { bid: 1, ask: 1, t: 0 } }
  async bars(): Promise<Bar[]> { return [] }
  async submitOrder(): Promise<BrokerOrder> { throw new VenueError('read-only fake', 'rejected') }
  async cancelOrder(): Promise<void> {}
  async closePosition(): Promise<BrokerOrder> { throw new VenueError('read-only fake', 'rejected') }
  async flatten(): Promise<BrokerOrder[]> { return [] }
  async halt(): Promise<void> {}
  async resume(): Promise<void> {}
  subscribeOrderUpdates(_listener: (update: OrderUpdate) => void): () => void { return () => {} }
}

describe('TradingVenueGateway', () => {
  it('registers an implementation at ctx.tradingVenue and removes it on dispose', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FakeVenue)
    expect(ctx.get('tradingVenue')).toBeInstanceOf(FakeVenue)
    await fiber.dispose()
    expect(ctx.get('tradingVenue')).toBeUndefined()
  })
})

describe('VenueError', () => {
  it('carries a desk code and the broker code', () => {
    const error = new VenueError('insufficient buying power', 'rejected', 40310000)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'VenueError', message: 'insufficient buying power', code: 'rejected', brokerCode: 40310000 })
    expect(new VenueError('down', 'unavailable').brokerCode).toBeUndefined()
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm install && pnpm exec vitest run packages/experimental/trading-venue`
Expected: FAIL, cannot resolve `../src/index.ts`.

- [ ] **Step 3: Implement the Service Definition**

`packages/experimental/trading-venue/src/index.ts`:

```ts
/**
 * Service Definition for a trading venue. One implementation provides
 * account reads, market data, order submission, Halt, and order updates at
 * `ctx.tradingVenue`; consumers (the order executor, the Trading panel
 * gateway, the MCP endpoint) depend only on this class.
 *
 * @module @deepseek-ai/dsh-experimental-trading-venue
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type {
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, OrderUpdate,
  PositionSnapshot, Quote, Timeframe, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tradingVenue: TradingVenueGateway
  }
  interface Events {
    /**
     * The venue's readiness changed.
     * @mode emit
     * @param status - new readiness.
     * @param reason - readable cause, such as the account setting that drifted.
     */
    'trading/venue-status'(status: VenueStatus, reason: string): void
  }
}

/** Why a venue operation failed. */
export type VenueErrorCode =
  | 'unconfigured'
  | 'auth'
  | 'blocked'
  | 'halted'
  | 'rejected'
  | 'not-found'
  | 'rate-limited'
  | 'unavailable'
  | 'unknown-outcome'

/** A venue failure with a desk-level code and, when the broker sent one, its numeric code. */
export class VenueError extends Error {
  override readonly name = 'VenueError'

  /**
   * @param message - readable reason shown to the model and the user.
   * @param code - desk-level failure kind.
   * @param brokerCode - broker's numeric error code, when present.
   */
  constructor(message: string, readonly code: VenueErrorCode, readonly brokerCode?: number) {
    super(message)
  }
}

/**
 * A trading venue. Every method that reaches the broker resolves the API keys at call time and throws
 * {@link VenueError} on failure. Order-creating methods refuse while the venue is `halted` or `blocked`,
 * except `closePosition` and `flatten`, which are reduce-only and always available to the user.
 */
export abstract class TradingVenueGateway extends Service {
  /** @param ctx - the plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'tradingVenue')
  }

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
   * Close one position at market; allowed while halted.
   * @param symbol - instrument.
   * @returns the closing order.
   */
  abstract closePosition(symbol: TradingSymbol): Promise<BrokerOrder>

  /**
   * Cancel every open order and close every position at market; allowed while halted.
   * @returns the closing orders.
   */
  abstract flatten(): Promise<BrokerOrder[]>

  /**
   * Halt trading at the broker and in the desk until {@link resume}; persists across restarts.
   * @param reason - readable cause shown in the panel.
   * @returns when the broker confirmed the suspension.
   */
  abstract halt(reason: string): Promise<void>

  /**
   * Re-apply the account safety settings and lift the Halt.
   * @returns when the broker confirmed.
   */
  abstract resume(): Promise<void>

  /**
   * Receive order-lifecycle events; the venue streams only while at least one listener is registered.
   * @param listener - called once per event.
   * @returns a disposer that removes the listener.
   */
  abstract subscribeOrderUpdates(listener: (update: OrderUpdate) => void): () => void
}

export default TradingVenueGateway
```

- [ ] **Step 4: Run the tests**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-venue packages/experimental/trading && pnpm exec tsc -b packages/experimental/trading-venue`
Expected: PASS (2 venue tests, all `trading` tests), typecheck clean. If `ctx.get('tradingVenue')` is not `undefined` after dispose in this Cordis version, assert the documented post-dispose behavior the subprocess Service Definition's own spec asserts, and ledger the ruling.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/trading/src/types.ts packages/experimental/trading-venue tsconfig.base.json tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(trading-venue): define the trading venue service and venue domain types"
```

---

### Task 3: `trading-alpaca` scaffold, Config, endpoints, and the fake Alpaca server

**Files:**
- Create: `packages/experimental/trading-alpaca/package.json`, `tsconfig.json`, `src/config.ts`, `src/types.ts`
- Create: `packages/experimental/trading-alpaca/tests/fake-alpaca.ts`
- Modify: `tsconfig.base.json`, `tsconfig.host.json`
- Test: `packages/experimental/trading-alpaca/tests/config.spec.ts`

**Interfaces:**
- Produces: `Config` (schemastery) with `mode`, `apiKeyEnv`, `secretKeyEnv`, `feed`, `driftCheckMs`, `requestTimeoutMs`, `rateLimitRetryMs`, `streamBackoffMs`, `tradingUrl`, `dataUrl`, `tradeStreamUrl`; `Endpoints`; `resolveEndpoints(config: Config, liveFlag: string | undefined): Endpoints`.
- Produces (tests): `FakeAlpaca` with `start()`, `stop()`, `url`, `on(method, path, respond)`, `requests`; `accountConfig(fake, initial)` returning a mutable config record.

- [ ] **Step 1: Manifest, tsconfig, registrations**

`packages/experimental/trading-alpaca/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-experimental-trading-alpaca",
  "description": "Alpaca provider for ctx.tradingVenue: paper and live trading, account safety, and order updates",
  "version": "0.1.6-alpha.1",
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/deepseek-ai/deepseek-harness.git", "directory": "packages/experimental/trading-alpaca" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/dsh-experimental-trading": "workspace:^",
    "@deepseek-ai/schemastery": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-venue": "workspace:^",
    "@deepseek-ai/dsh-launch-environment": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-venue": "workspace:^",
    "@deepseek-ai/dsh-http-proxy": "workspace:^",
    "@deepseek-ai/dsh-launch-environment": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^",
    "ws": "^8.21.0"
  }
}
```

Check the exact npm names of the credentials, launch-environment, storage-domain, and http-proxy packages in their `package.json` files and use those; check how other packages type `ws` in tests (`@types/ws` in root devDependencies or not) and follow them. `tsconfig.json` mirrors `trading-venue`'s with references to `../../../vendor/cordis`, `../../../vendor/schemastery`, `../trading`, `../trading-venue`, and the credentials, launch-environment, and storage-domain package directories. Register `paths` and `references` as in Task 2.

- [ ] **Step 2: Write the fake Alpaca server**

`packages/experimental/trading-alpaca/tests/fake-alpaca.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One recorded request. */
export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly body: unknown
  readonly keyId: string | undefined
}

/** What a route answers; `rawBody` sends text verbatim instead of JSON. */
export interface FakeReply {
  readonly status: number
  readonly body?: unknown
  readonly rawBody?: string
  /** Delay before answering, milliseconds. */
  readonly delayMs?: number
}

type Responder = (request: RecordedRequest) => FakeReply

/** A local Alpaca stand-in: exact method + raw path routes, latest registration wins, every request recorded. */
export class FakeAlpaca {
  readonly requests: RecordedRequest[] = []
  url = ''
  private server: Server | undefined
  private routes: { method: string; path: string; respond: Responder }[] = []

  on(method: string, path: string, respond: Responder): void {
    this.routes.unshift({ method, path, respond })
  }

  async start(): Promise<void> {
    this.server = createServer((incoming, outgoing) => {
      void readBody(incoming).then(text => {
        const url = new URL(incoming.url ?? '/', 'http://fake')
        const keyHeader = incoming.headers['apca-api-key-id']
        const request: RecordedRequest = {
          method: incoming.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          body: text === '' ? undefined : JSON.parse(text) as unknown,
          keyId: typeof keyHeader === 'string' ? keyHeader : undefined,
        }
        this.requests.push(request)
        const route = this.routes.find(r => r.method === request.method && r.path === request.path)
        const reply: FakeReply = route === undefined ? { status: 404, body: { message: 'not found' } } : route.respond(request)
        setTimeout(() => {
          outgoing.writeHead(reply.status, { 'content-type': 'application/json' })
          outgoing.end(reply.rawBody ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)))
        }, reply.delayMs ?? 0)
      })
    })
    const address = await new Promise<AddressInfo>(resolve => {
      const server = this.server as Server
      server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) })
    })
    this.url = `http://127.0.0.1:${String(address.port)}`
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Alpaca account configuration fields the desk manages. */
export interface FakeAccountConfig {
  no_shorting: boolean
  max_margin_multiplier: string
  suspend_trade: boolean
}

/**
 * Serve GET/PATCH /v2/account/configurations from a mutable record.
 * @param fake - server to register on.
 * @param initial - starting configuration.
 * @returns the live record; tests mutate it to simulate changes made outside the desk.
 */
export function accountConfig(fake: FakeAlpaca, initial: FakeAccountConfig): FakeAccountConfig {
  const state = { ...initial }
  fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...state, fractional_trading: true } }))
  fake.on('PATCH', '/v2/account/configurations', request => {
    Object.assign(state, request.body)
    return { status: 200, body: { ...state, fractional_trading: true } }
  })
  return state
}
```

- [ ] **Step 3: Write the failing config test**

`packages/experimental/trading-alpaca/tests/config.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Config, resolveEndpoints } from '../src/config.ts'

describe('Config', () => {
  it('defaults to paper trading on the free IEX feed with ALPACA_* credentials', () => {
    expect(Config({})).toEqual({
      mode: 'paper', apiKeyEnv: 'ALPACA_API_KEY', secretKeyEnv: 'ALPACA_SECRET_KEY', feed: 'iex',
      driftCheckMs: 60_000, requestTimeoutMs: 15_000, rateLimitRetryMs: [1_000, 2_000, 4_000],
      streamBackoffMs: [1_000, 2_000, 5_000, 10_000, 30_000],
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
    })
  })

  it('selects the live hosts only with DSH_TRADING_LIVE=1', () => {
    expect(resolveEndpoints(Config({ mode: 'live' }), '1').tradingUrl).toBe('https://api.alpaca.markets')
    expect(() => resolveEndpoints(Config({ mode: 'live' }), undefined))
      .toThrow(new Error('trading-alpaca: mode live requires DSH_TRADING_LIVE=1 at launch'))
    expect(() => resolveEndpoints(Config({ mode: 'live' }), 'true')).toThrow(Error)
  })

  it('keeps explicit URL overrides', () => {
    const config = Config({ tradingUrl: 'http://127.0.0.1:1', dataUrl: 'http://127.0.0.1:2', tradeStreamUrl: 'ws://127.0.0.1:3' })
    expect(resolveEndpoints(config, undefined)).toEqual({
      tradingUrl: 'http://127.0.0.1:1', dataUrl: 'http://127.0.0.1:2', tradeStreamUrl: 'ws://127.0.0.1:3',
    })
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm install && pnpm exec vitest run packages/experimental/trading-alpaca/tests/config.spec.ts`
Expected: FAIL, cannot resolve `../src/config.ts`.

- [ ] **Step 4: Implement**

`packages/experimental/trading-alpaca/src/types.ts`:

```ts
/**
 * Types shared across the Alpaca provider's units.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/types
 */

/** Alpaca API key pair resolved for one request. */
export interface AlpacaKeys {
  /** `APCA-API-KEY-ID` value. */
  readonly keyId: string
  /** `APCA-API-SECRET-KEY` value. */
  readonly secret: string
}

/** Alpaca JSON object as received; fields are read through `map.ts`. */
export type RawRecord = Readonly<Record<string, unknown>>
```

`packages/experimental/trading-alpaca/src/config.ts`:

```ts
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
  /** Trading API base URL; empty selects the paper or live host for `mode`. */
  tradingUrl: string
  /** Market data API base URL. */
  dataUrl: string
  /** Trade-updates stream URL; empty selects the paper or live host for `mode`. */
  tradeStreamUrl: string
}

/** Validated configuration schema. */
export const Config: z<Config> = z.object({
  mode: z.union(['paper', 'live'] as const).default('paper'),
  apiKeyEnv: z.string().role('credential-ref').default('ALPACA_API_KEY'),
  secretKeyEnv: z.string().role('credential-ref').default('ALPACA_SECRET_KEY'),
  feed: z.union(['iex', 'sip'] as const).default('iex'),
  driftCheckMs: z.number().min(5_000).default(60_000),
  requestTimeoutMs: z.number().min(1_000).default(15_000),
  rateLimitRetryMs: z.array(z.number().min(0)).default([1_000, 2_000, 4_000]),
  streamBackoffMs: z.array(z.number().min(1)).min(1).default([1_000, 2_000, 5_000, 10_000, 30_000]),
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

/**
 * Resolve base URLs for the configured mode.
 * @param config - provider configuration.
 * @param liveFlag - the launch environment's `DSH_TRADING_LIVE` value.
 * @returns the base URLs.
 * @throws Error when `mode` is `live` and `liveFlag` is not exactly `1`.
 */
export function resolveEndpoints(config: Config, liveFlag: string | undefined): Endpoints {
  if (config.mode === 'live' && liveFlag !== '1') throw new Error('trading-alpaca: mode live requires DSH_TRADING_LIVE=1 at launch')
  const host = config.mode === 'live' ? 'api.alpaca.markets' : 'paper-api.alpaca.markets'
  return {
    tradingUrl: config.tradingUrl === '' ? `https://${host}` : config.tradingUrl,
    dataUrl: config.dataUrl,
    tradeStreamUrl: config.tradeStreamUrl === '' ? `wss://${host}/stream` : config.tradeStreamUrl,
  }
}
```

If schemastery's API differs from these calls (`z.union`, `.role`, `z.array`, array `.min(1)`), copy the forms used in `packages/llm/llm-deepseek/src/config.ts` and `packages/web/web-search-exa/src/index.ts`.

- [ ] **Step 5: Run and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/config.spec.ts`
Expected: PASS, 5 tests.

```bash
git add packages/experimental/trading-alpaca tsconfig.base.json tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(trading-alpaca): add provider config, endpoint resolution, and a fake Alpaca server"
```

---

### Task 4: REST client and error mapping

**Files:**
- Create: `packages/experimental/trading-alpaca/src/http.ts`
- Test: `packages/experimental/trading-alpaca/tests/http.spec.ts`

**Interfaces:**
- Consumes: `VenueError` (Task 2), `AlpacaKeys` (Task 3), `FakeAlpaca` (Task 3).
- Produces: `AlpacaHttpOptions`, `RequestOptions`, `AlpacaHttp.request<T>(api: 'trading' | 'data', method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options?: RequestOptions): Promise<T>`. Errors: network/timeout and 5xx → `unavailable`; 401, or 403 without a broker code → `auth`; 404 → `not-found`; 429 → retried for GET per `retryDelaysMs`, then `rate-limited`; other 4xx → `rejected`. Each `VenueError` carries the broker's numeric `code` when present.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading-alpaca/tests/http.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { AlpacaHttp } from '../src/http.ts'
import { FakeAlpaca } from './fake-alpaca.ts'

let fake: FakeAlpaca
let keyCalls: number
const slept: number[] = []

function client(retryDelaysMs: number[] = [5, 10]): AlpacaHttp {
  return new AlpacaHttp({
    tradingUrl: fake.url, dataUrl: `${fake.url}/data-root`, timeoutMs: 2_000, retryDelaysMs,
    keys: async () => { keyCalls++; return { keyId: 'key-1', secret: 'secret-1' } },
    sleep: async ms => { slept.push(ms) },
  })
}

beforeEach(async () => { fake = new FakeAlpaca(); await fake.start(); keyCalls = 0; slept.length = 0 })
afterEach(async () => { await fake.stop() })

describe('AlpacaHttp', () => {
  it('sends the key headers, query, and JSON body, resolving keys per request', async () => {
    fake.on('POST', '/v2/orders', request => ({ status: 200, body: { echoed: request.body } }))
    const result = await client().request<{ echoed: unknown }>('trading', 'POST', '/v2/orders', { body: { qty: '1' }, query: { a: 1, b: undefined } })
    expect(result).toEqual({ echoed: { qty: '1' } })
    expect(fake.requests[0]).toMatchObject({ method: 'POST', keyId: 'key-1' })
    expect(fake.requests[0]?.query.toString()).toBe('a=1')
    await client().request('trading', 'POST', '/v2/orders')
    expect(keyCalls).toBe(2)
  })

  it('routes data requests to the data base URL and returns undefined for empty bodies', async () => {
    fake.on('GET', '/data-root/v2/clock', () => ({ status: 204 }))
    expect(await client().request('data', 'GET', '/v2/clock')).toBeUndefined()
    expect(fake.requests[0]?.path).toBe('/data-root/v2/clock')
  })

  it('maps broker failures to venue error codes', async () => {
    const cases: [number, unknown, string, number | undefined][] = [
      [401, { message: 'unauthorized' }, 'auth', undefined],
      [403, { message: 'forbidden' }, 'auth', undefined],
      [403, { code: 40310000, message: 'insufficient buying power' }, 'rejected', 40310000],
      [404, { message: 'order not found' }, 'not-found', undefined],
      [422, { code: 40010001, message: 'client_order_id must be unique' }, 'rejected', 40010001],
      [500, { message: 'internal' }, 'unavailable', undefined],
    ]
    for (const [status, body, code, brokerCode] of cases) {
      fake.on('GET', '/v2/x', () => ({ status, body }))
      const error = await client().request('trading', 'GET', '/v2/x').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(VenueError)
      expect(error).toMatchObject({ code, brokerCode })
    }
  })

  it('names the HTTP status when the error body is not JSON', async () => {
    fake.on('GET', '/v2/x', () => ({ status: 502, rawBody: '<html>bad gateway</html>' }))
    await expect(client().request('trading', 'GET', '/v2/x')).rejects.toMatchObject({ code: 'unavailable' })
    fake.on('GET', '/v2/y', () => ({ status: 400 }))
    await expect(client().request('trading', 'GET', '/v2/y')).rejects.toThrow('Alpaca rejected the request: HTTP 400')
  })

  it('retries rate-limited reads with the configured waits, then reports rate-limited', async () => {
    let calls = 0
    fake.on('GET', '/v2/account', () => (++calls < 3 ? { status: 429, body: { message: 'slow down' } } : { status: 200, body: { ok: true } }))
    expect(await client().request('trading', 'GET', '/v2/account')).toEqual({ ok: true })
    expect(slept).toEqual([5, 10])
    fake.on('GET', '/v2/account', () => ({ status: 429, body: { message: 'slow down' } }))
    await expect(client().request('trading', 'GET', '/v2/account')).rejects.toMatchObject({ code: 'rate-limited' })
  })

  it('never retries a rate-limited write', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 429, body: { message: 'slow down' } }))
    await expect(client().request('trading', 'POST', '/v2/orders', { body: {} })).rejects.toMatchObject({ code: 'rate-limited' })
    expect(fake.requests).toHaveLength(1)
  })

  it('waits with a real timer when no sleep is injected', async () => {
    let calls = 0
    fake.on('GET', '/v2/account', () => (++calls < 2 ? { status: 429, body: { message: 'slow down' } } : { status: 200, body: { ok: true } }))
    const http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [1],
      keys: async () => ({ keyId: 'k', secret: 's' }) })
    expect(await http.request('trading', 'GET', '/v2/account')).toEqual({ ok: true })
  })

  it('reports an unreachable host as unavailable', async () => {
    await fake.stop()
    await expect(client().request('trading', 'GET', '/v2/account')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
```

Note the `afterEach` calls `fake.stop()` a second time after the last test stopped it; `stop()` must tolerate a closed server (Node's `close` callback receives an error; resolve regardless).

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/http.spec.ts`
Expected: FAIL, cannot resolve `../src/http.ts`.

- [ ] **Step 2: Implement**

`packages/experimental/trading-alpaca/src/http.ts`:

```ts
/**
 * Alpaca REST client: key headers resolved per request, JSON bodies,
 * rate-limit retries for reads only, and broker failures mapped to VenueError.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/http
 */
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaKeys } from './types.ts'

/** Client construction options. */
export interface AlpacaHttpOptions {
  /** Trading API base URL. */
  readonly tradingUrl: string
  /** Market data API base URL. */
  readonly dataUrl: string
  /** Per-request timeout, milliseconds. */
  readonly timeoutMs: number
  /** Waits before each retry of a rate-limited read. */
  readonly retryDelaysMs: readonly number[]
  /** Resolve the key pair; called once per request. */
  readonly keys: () => Promise<AlpacaKeys>
  /** Wait between retries; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Query string and JSON body for one request. */
export interface RequestOptions {
  /** Query parameters; `undefined` values are omitted. */
  readonly query?: Readonly<Record<string, string | number | undefined>>
  /** JSON request body. */
  readonly body?: unknown
}

function parseBody(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (parseError) {
    // A non-JSON body (an HTML error page from a proxy) carries no broker code; keep the text as the message.
    void parseError
    return { message: text }
  }
}

function toVenueError(status: number, body: unknown): VenueError {
  const record = typeof body === 'object' && body !== null ? body as { code?: unknown; message?: unknown } : {}
  const code = typeof record.code === 'number' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : `HTTP ${String(status)}`
  if (status === 401 || (status === 403 && code === undefined)) return new VenueError(`Alpaca rejected the API keys: ${message}`, 'auth', code)
  if (status === 404) return new VenueError(`Alpaca: ${message}`, 'not-found', code)
  if (status === 429) return new VenueError('Alpaca rate limit reached; try again shortly', 'rate-limited', code)
  if (status >= 500) return new VenueError(`Alpaca is unavailable: ${message}`, 'unavailable', code)
  return new VenueError(`Alpaca rejected the request: ${message}`, 'rejected', code)
}

/** Alpaca REST client. */
export class AlpacaHttp {
  /** @param options - endpoints, timeout, retry waits, and key resolution. */
  constructor(private readonly options: AlpacaHttpOptions) {}

  /**
   * Send one request.
   * @param api - which base URL.
   * @param method - HTTP method; only `GET` is retried on 429.
   * @param path - absolute path such as `/v2/account`.
   * @param options - query and body.
   * @returns the parsed JSON body, or undefined for an empty body.
   * @throws VenueError for every failure.
   */
  async request<T>(api: 'trading' | 'data', method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const base = api === 'trading' ? this.options.tradingUrl : this.options.dataUrl
    const url = new URL(`${base.replace(/\/$/, '')}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    for (let attempt = 0; ; attempt++) {
      const keys = await this.options.keys()
      let response: Response
      try {
        response = await fetch(url, {
          method,
          headers: {
            'APCA-API-KEY-ID': keys.keyId,
            'APCA-API-SECRET-KEY': keys.secret,
            ...options.body === undefined ? {} : { 'content-type': 'application/json' },
          },
          ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        })
      } catch (error) {
        throw new VenueError(`Alpaca is unreachable: ${(error as Error).message}`, 'unavailable')
      }
      const retryDelay = method === 'GET' && response.status === 429 ? this.options.retryDelaysMs[attempt] : undefined
      if (retryDelay !== undefined) {
        await response.body?.cancel()
        await this.sleep(retryDelay)
        continue
      }
      const body = parseBody(await response.text())
      if (response.ok) return body as T
      throw toVenueError(response.status, body)
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms)
    await new Promise<void>(resolve => { setTimeout(resolve, ms).unref() })
  }
}
```

- [ ] **Step 3: Run until green with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/http.spec.ts --coverage --coverage.include='packages/experimental/trading-alpaca/src/http.ts'`
Expected: PASS; 100% for `http.ts`. Cover any remaining branch (for example `response.body?.cancel()` when the body is null) with a real-input test.

- [ ] **Step 4: Commit**

```bash
git add packages/experimental/trading-alpaca
git commit -m "feat(trading-alpaca): add the REST client with venue error mapping"
```

---

### Task 5: Mapping Alpaca JSON and REST market data

**Files:**
- Create: `packages/experimental/trading-alpaca/src/map.ts`, `packages/experimental/trading-alpaca/src/market.ts`
- Test: `packages/experimental/trading-alpaca/tests/map.spec.ts`, `packages/experimental/trading-alpaca/tests/market.spec.ts`

**Interfaces:**
- Consumes: `AlpacaHttp` (Task 4); `parseSymbol` and domain types (`trading`).
- Produces (`map.ts`): `decimal(value, field)`, `optionalDecimal(value, field)`, `timestamp(value, field)`, `venueSymbol(raw, assetClass)`, `mapAccount`, `mapPosition`, `mapOrder`, `mapAsset`, `mapBar`, `mapQuote`, `mapOrderUpdate`, `ALPACA_TIMEFRAMES`.
- Produces (`market.ts`): `latestQuote(http, symbol, feed)`, `bars(http, symbol, timeframe, query, feed, now)`, `marketOpen(http, symbol)`, `asset(http, symbol)`.

- [ ] **Step 1: Write the failing mapping tests**

`packages/experimental/trading-alpaca/tests/map.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import {
  decimal, mapAccount, mapAsset, mapBar, mapOrder, mapOrderUpdate, mapPosition, mapQuote, optionalDecimal, timestamp, venueSymbol,
} from '../src/map.ts'

const order = {
  id: 'o-1', client_order_id: 'c-1', symbol: 'BTCUSD', asset_class: 'crypto', side: 'buy', type: 'limit', time_in_force: 'ioc',
  qty: '0.015', notional: null, limit_price: '63460.32', stop_price: null, filled_qty: '0.015', filled_avg_price: '62831.5',
  status: 'filled', submitted_at: '2026-10-05T14:00:00Z',
}

describe('number and time parsing', () => {
  it('reads Alpaca decimal strings and JSON numbers', () => {
    expect(decimal('100240.18', 'equity')).toBe(100_240.18)
    expect(decimal(3, 'qty')).toBe(3)
    expect(optionalDecimal(null, 'limit_price')).toBeUndefined()
    expect(optionalDecimal(undefined, 'limit_price')).toBeUndefined()
    expect(optionalDecimal('1.5', 'limit_price')).toBe(1.5)
    expect(timestamp('2026-10-05T14:00:00Z', 't')).toBe(Date.UTC(2026, 9, 5, 14))
  })

  it('refuses malformed numbers and times instead of producing NaN', () => {
    for (const bad of ['', '  ', 'abc', null, undefined, {}, Number.NaN]) {
      expect(() => decimal(bad, 'equity')).toThrow(new VenueError('Alpaca returned a malformed equity', 'unavailable'))
    }
    expect(() => timestamp('not a time', 't')).toThrow('Alpaca returned a malformed t')
    expect(() => timestamp(5, 't')).toThrow(VenueError)
  })
})

describe('venueSymbol', () => {
  it('normalizes equities and both crypto spellings', () => {
    expect(venueSymbol('AAPL', 'us_equity')).toEqual({ assetClass: 'equity', ticker: 'AAPL' })
    expect(venueSymbol('BTCUSD', 'crypto')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(venueSymbol('BTC/USD', 'crypto')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
  })

  it('refuses asset classes the desk does not trade and malformed crypto symbols', () => {
    expect(() => venueSymbol('SPY250117C00500000', 'us_option'))
      .toThrow(new VenueError('SPY250117C00500000 is a us_option asset; the desk trades US equities and crypto only', 'rejected'))
    expect(() => venueSymbol('AAPL', 'crypto')).toThrow(new VenueError('Alpaca returned a malformed crypto symbol AAPL', 'unavailable'))
  })
})

describe('record mapping', () => {
  it('maps the account, treating any broker block as tradingBlocked', () => {
    const raw = { equity: '100240.18', cash: '61402.55', last_equity: '100027.78', buying_power: '61402.55',
      trading_blocked: false, account_blocked: false, trade_suspended_by_user: false }
    expect(mapAccount(raw)).toEqual({ equity: 100_240.18, cash: 61_402.55, lastEquity: 100_027.78, buyingPower: 61_402.55, tradingBlocked: false })
    expect(mapAccount({ ...raw, trade_suspended_by_user: true }).tradingBlocked).toBe(true)
    expect(mapAccount({ ...raw, account_blocked: true }).tradingBlocked).toBe(true)
    expect(mapAccount({ ...raw, trading_blocked: true }).tradingBlocked).toBe(true)
    expect(() => mapAccount({ ...raw, last_equity: '' })).toThrow('Alpaca returned a malformed last_equity')
  })

  it('maps positions with signed quantity', () => {
    const raw = { symbol: 'AAPL', asset_class: 'us_equity', side: 'long', qty: '2', avg_entry_price: '228.10',
      current_price: '231.42', market_value: '462.84', unrealized_pl: '6.64' }
    expect(mapPosition(raw)).toEqual({ symbol: { assetClass: 'equity', ticker: 'AAPL' }, qty: 2, avgEntryPrice: 228.1,
      currentPrice: 231.42, marketValue: 462.84, unrealizedPl: 6.64 })
    expect(mapPosition({ ...raw, side: 'short', qty: '-3' }).qty).toBe(-3)
    expect(mapPosition({ ...raw, side: 'short', qty: '3' }).qty).toBe(-3)
  })

  it('maps orders, folding broker states into the desk lifecycle', () => {
    expect(mapOrder(order)).toEqual({
      id: 'o-1', clientOrderId: 'c-1', symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', type: 'limit',
      timeInForce: 'ioc', qty: 0.015, limitPrice: 63_460.32, filledQty: 0.015, filledAvgPrice: 62_831.5, status: 'filled',
      submittedAt: Date.UTC(2026, 9, 5, 14),
    })
    expect(mapOrder({ ...order, status: 'accepted' }).status).toBe('open')
    expect(mapOrder({ ...order, status: 'replaced' }).status).toBe('canceled')
    expect(mapOrder({ ...order, type: 'trailing_stop' }).type).toBe('other')
    expect(mapOrder({ ...order, side: 'sell', qty: null, notional: '500', filled_avg_price: null, submitted_at: null }))
      .toMatchObject({ side: 'sell', notional: 500 })
    expect(mapOrder({ ...order, qty: null, notional: '500', filled_avg_price: null, submitted_at: null })).not.toHaveProperty('qty')
  })

  it('maps assets, using a cent tick for equities and the broker tick for crypto', () => {
    expect(mapAsset({ symbol: 'AAPL', class: 'us_equity', status: 'active', tradable: true, fractionable: true }))
      .toEqual({ symbol: { assetClass: 'equity', ticker: 'AAPL' }, tradable: true, fractionable: true, priceIncrement: 0.01 })
    expect(mapAsset({ symbol: 'BTC/USD', class: 'crypto', status: 'active', tradable: true, fractionable: true,
      min_order_size: '0.0001', price_increment: '1' }))
      .toEqual({ symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, tradable: true, fractionable: true, minOrderSize: 0.0001, priceIncrement: 1 })
    expect(mapAsset({ symbol: 'XYZ', class: 'us_equity', status: 'inactive', tradable: true, fractionable: false }).tradable).toBe(false)
  })

  it('maps bars and quotes from market-data JSON', () => {
    expect(mapBar({ t: '2026-10-05T14:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10, vw: 1.2, n: 4 }))
      .toEqual({ t: Date.UTC(2026, 9, 5, 14), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 })
    expect(mapQuote({ t: '2026-10-05T14:00:00.123456789Z', bp: 62_818, bs: 1, ap: 62_832, as: 2 }))
      .toEqual({ bid: 62_818, ask: 62_832, t: Date.UTC(2026, 9, 5, 14, 0, 0, 123) })
  })

  it('maps trade updates, keeping fill details only when present', () => {
    expect(mapOrderUpdate({ event: 'fill', order, timestamp: '2026-10-05T14:00:01Z', price: '62831.5', qty: '0.015', position_qty: '0.03' }))
      .toEqual({ event: 'fill', order: mapOrder(order), t: Date.UTC(2026, 9, 5, 14, 0, 1), fillPrice: 62_831.5, fillQty: 0.015, positionQty: 0.03 })
    expect(mapOrderUpdate({ event: 'pending_cancel', order, timestamp: '2026-10-05T14:00:01Z' }))
      .toEqual({ event: 'other', order: mapOrder(order), t: Date.UTC(2026, 9, 5, 14, 0, 1) })
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/map.spec.ts`
Expected: FAIL, cannot resolve `../src/map.ts`.

- [ ] **Step 2: Implement `map.ts`**

```ts
/**
 * Alpaca JSON → trading domain values. Every number is checked: a malformed
 * value raises VenueError('unavailable') instead of becoming NaN.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/map
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  parseSymbol, type AccountSnapshot, type Asset, type Bar, type BrokerOrder, type BrokerOrderId, type ClientOrderId,
  type OrderStatus, type OrderType, type OrderUpdate, type OrderUpdateEvent, type PositionSnapshot, type Quote,
  type Timeframe, type TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { RawRecord } from './types.ts'

/** Alpaca timeframe codes for each desk timeframe. */
export const ALPACA_TIMEFRAMES: Readonly<Record<Timeframe, string>> = {
  '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1Hour', '4h': '4Hour', '1D': '1Day', '1W': '1Week',
}

const ORDER_STATUS: ReadonlyMap<string, OrderStatus> = new Map([
  ['filled', 'filled'], ['partially_filled', 'partially_filled'], ['canceled', 'canceled'], ['replaced', 'canceled'],
  ['expired', 'expired'], ['rejected', 'rejected'],
])
const ORDER_TYPES: readonly string[] = ['market', 'limit', 'stop', 'stop_limit']
const UPDATE_EVENTS: readonly string[] = ['new', 'partial_fill', 'fill', 'canceled', 'expired', 'rejected']

/**
 * Read a decimal string or JSON number.
 * @param value - raw field.
 * @param field - Alpaca field name, for the error message.
 * @returns the finite number.
 * @throws VenueError when the value is not a finite number.
 */
export function decimal(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new VenueError(`Alpaca returned a malformed ${field}`, 'unavailable')
  return parsed
}

/**
 * Read a nullable decimal.
 * @param value - raw field.
 * @param field - Alpaca field name.
 * @returns the number, or undefined for null or absent.
 */
export function optionalDecimal(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : decimal(value, field)
}

/**
 * Read an RFC 3339 timestamp.
 * @param value - raw field.
 * @param field - Alpaca field name.
 * @returns UTC epoch milliseconds.
 */
export function timestamp(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new VenueError(`Alpaca returned a malformed ${field}`, 'unavailable')
  return parsed
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : timestamp(value, field)
}

/**
 * Normalize an Alpaca symbol.
 * @param raw - symbol as Alpaca wrote it (`AAPL`, `BTCUSD`, `BTC/USD`).
 * @param assetClass - Alpaca asset class.
 * @returns the canonical symbol.
 * @throws VenueError for asset classes other than `us_equity` and `crypto`, or a malformed crypto symbol.
 */
export function venueSymbol(raw: string, assetClass: string): TradingSymbol {
  if (assetClass === 'us_equity') return { assetClass: 'equity', ticker: raw.toUpperCase() }
  if (assetClass !== 'crypto') throw new VenueError(`${raw} is a ${assetClass} asset; the desk trades US equities and crypto only`, 'rejected')
  const symbol = parseSymbol(raw)
  if (symbol.assetClass !== 'crypto') throw new VenueError(`Alpaca returned a malformed crypto symbol ${raw}`, 'unavailable')
  return symbol
}

/**
 * Map GET /v2/account.
 * @param raw - account JSON.
 * @returns the account snapshot.
 */
export function mapAccount(raw: RawRecord): AccountSnapshot {
  return {
    equity: decimal(raw.equity, 'equity'),
    cash: decimal(raw.cash, 'cash'),
    lastEquity: decimal(raw.last_equity, 'last_equity'),
    buyingPower: decimal(raw.buying_power, 'buying_power'),
    tradingBlocked: raw.trading_blocked === true || raw.account_blocked === true || raw.trade_suspended_by_user === true,
  }
}

/**
 * Map one position.
 * @param raw - position JSON.
 * @returns the position with signed quantity.
 */
export function mapPosition(raw: RawRecord): PositionSnapshot {
  const size = Math.abs(decimal(raw.qty, 'qty'))
  return {
    symbol: venueSymbol(String(raw.symbol), String(raw.asset_class)),
    qty: raw.side === 'short' ? -size : size,
    avgEntryPrice: decimal(raw.avg_entry_price, 'avg_entry_price'),
    currentPrice: decimal(raw.current_price, 'current_price'),
    marketValue: decimal(raw.market_value, 'market_value'),
    unrealizedPl: decimal(raw.unrealized_pl, 'unrealized_pl'),
  }
}

/**
 * Map one order.
 * @param raw - order JSON.
 * @returns the broker order.
 */
export function mapOrder(raw: RawRecord): BrokerOrder {
  const qty = optionalDecimal(raw.qty, 'qty')
  const notional = optionalDecimal(raw.notional, 'notional')
  const limitPrice = optionalDecimal(raw.limit_price, 'limit_price')
  const stopPrice = optionalDecimal(raw.stop_price, 'stop_price')
  const filledAvgPrice = optionalDecimal(raw.filled_avg_price, 'filled_avg_price')
  const submittedAt = optionalTimestamp(raw.submitted_at, 'submitted_at')
  const type = String(raw.type)
  return {
    id: brandString<BrokerOrderId>(String(raw.id)),
    clientOrderId: brandString<ClientOrderId>(String(raw.client_order_id)),
    symbol: venueSymbol(String(raw.symbol), String(raw.asset_class)),
    side: raw.side === 'sell' ? 'sell' : 'buy',
    type: ORDER_TYPES.includes(type) ? type as OrderType : 'other',
    timeInForce: String(raw.time_in_force),
    ...qty === undefined ? {} : { qty },
    ...notional === undefined ? {} : { notional },
    ...limitPrice === undefined ? {} : { limitPrice },
    ...stopPrice === undefined ? {} : { stopPrice },
    filledQty: decimal(raw.filled_qty, 'filled_qty'),
    ...filledAvgPrice === undefined ? {} : { filledAvgPrice },
    status: ORDER_STATUS.get(String(raw.status)) ?? 'open',
    ...submittedAt === undefined ? {} : { submittedAt },
  }
}

/**
 * Map GET /v2/assets/{symbol}.
 * @param raw - asset JSON.
 * @returns broker facts for validation; equities use a one-cent tick.
 */
export function mapAsset(raw: RawRecord): Asset {
  const symbol = venueSymbol(String(raw.symbol), String(raw.class))
  const minOrderSize = optionalDecimal(raw.min_order_size, 'min_order_size')
  return {
    symbol,
    tradable: raw.tradable === true && raw.status === 'active',
    fractionable: raw.fractionable === true,
    ...minOrderSize === undefined ? {} : { minOrderSize },
    priceIncrement: symbol.assetClass === 'crypto' ? decimal(raw.price_increment, 'price_increment') : 0.01,
  }
}

/**
 * Map one market-data bar.
 * @param raw - bar JSON.
 * @returns the bar.
 */
export function mapBar(raw: RawRecord): Bar {
  return { t: timestamp(raw.t, 't'), o: decimal(raw.o, 'o'), h: decimal(raw.h, 'h'), l: decimal(raw.l, 'l'), c: decimal(raw.c, 'c'), v: decimal(raw.v, 'v') }
}

/**
 * Map one market-data quote.
 * @param raw - quote JSON.
 * @returns the quote.
 */
export function mapQuote(raw: RawRecord): Quote {
  return { bid: decimal(raw.bp, 'bp'), ask: decimal(raw.ap, 'ap'), t: timestamp(raw.t, 't') }
}

/**
 * Map one `trade_updates` payload.
 * @param raw - the message's `data` object.
 * @returns the order update.
 */
export function mapOrderUpdate(raw: RawRecord): OrderUpdate {
  const event = String(raw.event)
  const fillPrice = optionalDecimal(raw.price, 'price')
  const fillQty = optionalDecimal(raw.qty, 'qty')
  const positionQty = optionalDecimal(raw.position_qty, 'position_qty')
  return {
    event: UPDATE_EVENTS.includes(event) ? event as OrderUpdateEvent : 'other',
    order: mapOrder(raw.order as RawRecord),
    t: timestamp(raw.timestamp, 'timestamp'),
    ...fillPrice === undefined ? {} : { fillPrice },
    ...fillQty === undefined ? {} : { fillQty },
    ...positionQty === undefined ? {} : { positionQty },
  }
}
```

Add `@deepseek-ai/dsh-brand` to `dependencies` and a tsconfig reference to `../../util/brand`. `Date.parse` keeps millisecond precision for nanosecond timestamps in Node; if it returns `NaN` for nine fractional digits on this Node version, truncate the fraction to three digits before parsing and add the nanosecond quote test case's expectation unchanged.

- [ ] **Step 3: Write the failing market tests**

`packages/experimental/trading-alpaca/tests/market.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { asset, bars, latestQuote, marketOpen } from '../src/market.ts'
import { FakeAlpaca } from './fake-alpaca.ts'

let fake: FakeAlpaca
let http: AlpacaHttp
const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const bar = (hour: number): Record<string, unknown> => ({ t: `2026-10-05T${String(hour).padStart(2, '0')}:00:00Z`, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 })

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start()
  http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [], keys: async () => ({ keyId: 'k', secret: 's' }) })
})
afterEach(async () => { await fake.stop() })

describe('latestQuote', () => {
  it('reads crypto and equity quotes from their endpoints', async () => {
    fake.on('GET', '/v1beta3/crypto/us/latest/quotes', () => ({ status: 200, body: { quotes: { 'BTC/USD': { t: '2026-10-05T14:00:00Z', bp: 1, ap: 2 } } } }))
    fake.on('GET', '/v2/stocks/quotes/latest', () => ({ status: 200, body: { quotes: { AAPL: { t: '2026-10-05T14:00:00Z', bp: 3, ap: 4 } } } }))
    expect(await latestQuote(http, btc, 'iex')).toEqual({ bid: 1, ask: 2, t: Date.UTC(2026, 9, 5, 14) })
    expect(await latestQuote(http, aapl, 'iex')).toEqual({ bid: 3, ask: 4, t: Date.UTC(2026, 9, 5, 14) })
    expect(fake.requests[1]?.query.get('feed')).toBe('iex')
    expect(fake.requests[0]?.query.get('symbols')).toBe('BTC/USD')
  })

  it('reports a missing quote as not-found', async () => {
    fake.on('GET', '/v2/stocks/quotes/latest', () => ({ status: 200, body: { quotes: {} } }))
    await expect(latestQuote(http, aapl, 'sip')).rejects.toMatchObject({ code: 'not-found', message: 'no quote for AAPL' })
  })
})

describe('bars', () => {
  it('requests the most recent bars newest-first across pages and returns them oldest-first', async () => {
    fake.on('GET', '/v2/stocks/bars', request => (request.query.get('page_token') === null
      ? { status: 200, body: { bars: { AAPL: [bar(3), bar(2)] }, next_page_token: 'p2' } }
      : { status: 200, body: { bars: { AAPL: [bar(1)] }, next_page_token: null } }))
    const result = await bars(http, aapl, '1h', { limit: 3 }, 'iex', Date.UTC(2026, 9, 5, 4))
    expect(result.map(b => b.t)).toEqual([1, 2, 3].map(h => Date.UTC(2026, 9, 5, h)))
    const first = fake.requests[0]?.query
    expect(first?.get('timeframe')).toBe('1Hour')
    expect(first?.get('sort')).toBe('desc')
    expect(first?.get('feed')).toBe('iex')
    expect(first?.get('adjustment')).toBe('split')
    expect(first?.get('end')).toBe('2026-10-05T04:00:00.000Z')
    expect(first?.get('limit')).toBe('3')
    expect(fake.requests[1]?.query.get('limit')).toBe('1')
  })

  it('stops at the limit, honors an explicit range, and reads crypto without feed or adjustment', async () => {
    fake.on('GET', '/v1beta3/crypto/us/bars', () => ({ status: 200, body: { bars: { 'BTC/USD': [bar(2), bar(1)] }, next_page_token: 'more' } }))
    const result = await bars(http, btc, '1D', { limit: 2, start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 9, 5) }, 'iex', 0)
    expect(result).toHaveLength(2)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.query.get('feed')).toBeNull()
    expect(fake.requests[0]?.query.get('start')).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns an empty series when the venue has no bars', async () => {
    fake.on('GET', '/v2/stocks/bars', () => ({ status: 200, body: { bars: {}, next_page_token: null } }))
    expect(await bars(http, aapl, '5m', { limit: 10 }, 'iex', 0)).toEqual([])
  })
})

describe('marketOpen and asset', () => {
  it('treats crypto as always open and reads the clock for equities', async () => {
    fake.on('GET', '/v2/clock', () => ({ status: 200, body: { is_open: false } }))
    expect(await marketOpen(http, btc)).toBe(true)
    expect(await marketOpen(http, aapl)).toBe(false)
    expect(fake.requests).toHaveLength(1)
  })

  it('reads an asset with the crypto slash URL-encoded', async () => {
    fake.on('GET', '/v2/assets/BTC%2FUSD', () => ({ status: 200, body: { symbol: 'BTC/USD', class: 'crypto', status: 'active',
      tradable: true, fractionable: true, price_increment: '1' } }))
    expect((await asset(http, btc)).priceIncrement).toBe(1)
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/market.spec.ts`
Expected: FAIL, cannot resolve `../src/market.ts`.

- [ ] **Step 4: Implement `market.ts`**

```ts
/**
 * Alpaca REST market data: latest quotes, paged bar history, the market clock, and assets.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/market
 */
import type { Asset, Bar, BarQuery, Quote, Timeframe, TradingSymbol } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'
import { ALPACA_TIMEFRAMES, mapAsset, mapBar, mapQuote } from './map.ts'
import type { RawRecord } from './types.ts'

/** Alpaca's maximum bars per page. */
const MAX_PAGE = 10_000
/** Alpaca defaults `start` to the beginning of the current day; ask from here so a newest-first query reaches older history. */
const HISTORY_START = '2015-01-01T00:00:00.000Z'

interface QuotesBody { readonly quotes?: Readonly<Record<string, RawRecord>> }
interface BarsBody { readonly bars?: Readonly<Record<string, readonly RawRecord[]>>; readonly next_page_token?: string | null }

/**
 * Read the latest quote.
 * @param http - REST client.
 * @param symbol - instrument.
 * @param feed - equity feed.
 * @returns the quote.
 */
export async function latestQuote(http: AlpacaHttp, symbol: TradingSymbol, feed: 'iex' | 'sip'): Promise<Quote> {
  const body = symbol.assetClass === 'crypto'
    ? await http.request<QuotesBody>('data', 'GET', '/v1beta3/crypto/us/latest/quotes', { query: { symbols: symbol.ticker } })
    : await http.request<QuotesBody>('data', 'GET', '/v2/stocks/quotes/latest', { query: { symbols: symbol.ticker, feed } })
  const raw = body.quotes?.[symbol.ticker]
  if (raw === undefined) throw new VenueError(`no quote for ${symbol.ticker}`, 'not-found')
  return mapQuote(raw)
}

/**
 * Read up to `query.limit` bars, oldest first, requesting newest-first so the most recent bars come back.
 * @param http - REST client.
 * @param symbol - instrument.
 * @param timeframe - bar timeframe.
 * @param query - range and maximum count.
 * @param feed - equity feed.
 * @param now - current time, used as `end` when the query has none.
 * @returns bars, oldest first.
 */
export async function bars(
  http: AlpacaHttp, symbol: TradingSymbol, timeframe: Timeframe, query: BarQuery, feed: 'iex' | 'sip', now: number,
): Promise<Bar[]> {
  const crypto = symbol.assetClass === 'crypto'
  const path = crypto ? '/v1beta3/crypto/us/bars' : '/v2/stocks/bars'
  const collected: Bar[] = []
  let pageToken: string | undefined
  do {
    const body = await http.request<BarsBody>('data', 'GET', path, {
      query: {
        symbols: symbol.ticker,
        timeframe: ALPACA_TIMEFRAMES[timeframe],
        start: query.start === undefined ? HISTORY_START : new Date(query.start).toISOString(),
        end: new Date(query.end ?? now).toISOString(),
        limit: Math.min(query.limit - collected.length, MAX_PAGE),
        sort: 'desc',
        page_token: pageToken,
        feed: crypto ? undefined : feed,
        adjustment: crypto ? undefined : 'split',
      },
    })
    for (const raw of body.bars?.[symbol.ticker] ?? []) collected.push(mapBar(raw))
    pageToken = body.next_page_token ?? undefined
  } while (pageToken !== undefined && collected.length < query.limit)
  return collected.slice(0, query.limit).reverse()
}

/**
 * Whether the instrument's market is open now.
 * @param http - REST client.
 * @param symbol - instrument.
 * @returns true for crypto; the clock's `is_open` for equities.
 */
export async function marketOpen(http: AlpacaHttp, symbol: TradingSymbol): Promise<boolean> {
  if (symbol.assetClass === 'crypto') return true
  const clock = await http.request<RawRecord>('trading', 'GET', '/v2/clock')
  return clock.is_open === true
}

/**
 * Read broker facts for one instrument.
 * @param http - REST client.
 * @param symbol - instrument.
 * @returns the asset.
 */
export async function asset(http: AlpacaHttp, symbol: TradingSymbol): Promise<Asset> {
  return mapAsset(await http.request<RawRecord>('trading', 'GET', `/v2/assets/${encodeURIComponent(symbol.ticker)}`))
}
```

- [ ] **Step 5: Run with coverage and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/map.spec.ts packages/experimental/trading-alpaca/tests/market.spec.ts --coverage --coverage.include='packages/experimental/trading-alpaca/src/{map,market}.ts'`
Expected: PASS, 100% for both files (add real-input tests for any uncovered `??` branch, for example a bars body without `bars`).

```bash
git add packages/experimental/trading-alpaca
git commit -m "feat(trading-alpaca): map Alpaca records and read quotes, bars, clock, and assets"
```

---

### Task 6: Orders — idempotent submit, cancel, close, flatten

**Files:**
- Create: `packages/experimental/trading-alpaca/src/orders.ts`
- Test: `packages/experimental/trading-alpaca/tests/orders.spec.ts`

**Interfaces:**
- Consumes: `AlpacaHttp`, `mapOrder`, `mapPosition`, `mapAccount`.
- Produces: `submitOrder(http, request): Promise<BrokerOrder>`, `orderByClientId(http, id): Promise<BrokerOrder | undefined>`, `openOrders(http)`, `positions(http)`, `account(http)`, `cancelOrder(http, id)`, `closePosition(http, symbol)`, `flatten(http): Promise<BrokerOrder[]>`.
- Submit contract: a duplicate-id rejection (`40010001`) or an `unavailable` failure triggers a lookup by `client_order_id`; a found order is returned; a confirmed absence after `unavailable` rethrows `unavailable` with "order was not placed"; a failed lookup throws `unknown-outcome`.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading-alpaca/tests/orders.spec.ts`:

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, BrokerOrderRequest, ClientOrderId } from '@deepseek-ai/dsh-experimental-trading'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { account, cancelOrder, closePosition, flatten, openOrders, positions, submitOrder } from '../src/orders.ts'
import { FakeAlpaca } from './fake-alpaca.ts'

let fake: FakeAlpaca
let http: AlpacaHttp
const clientOrderId = brandString<ClientOrderId>('c-1')
const request: BrokerOrderRequest = {
  symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'limit', limitPrice: 63_460.32,
  timeInForce: 'ioc', clientOrderId,
}
const placed = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTC/USD', asset_class: 'crypto', side: 'buy', type: 'limit',
  time_in_force: 'ioc', qty: '0.015', limit_price: '63460.32', filled_qty: '0', status: 'accepted' }

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start()
  http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [], keys: async () => ({ keyId: 'k', secret: 's' }) })
})
afterEach(async () => { await fake.stop() })

describe('submitOrder', () => {
  it('sends Alpaca string fields and the client order id', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request)).id).toBe('o-1')
    expect(fake.requests[0]?.body).toEqual({ symbol: 'BTC/USD', side: 'buy', type: 'limit', time_in_force: 'ioc',
      client_order_id: 'c-1', qty: '0.015', limit_price: '63460.32' })
  })

  it('sends notional, stop, and bracket fields when present', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 200, body: placed }))
    await submitOrder(http, { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', notional: 100, type: 'market', timeInForce: 'day', clientOrderId })
    await submitOrder(http, { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', qty: 2, type: 'stop_limit', limitPrice: 232,
      stopPrice: 231, timeInForce: 'gtc', bracket: { takeProfit: 250, stopLoss: 220 }, clientOrderId })
    expect(fake.requests[0]?.body).toMatchObject({ notional: '100' })
    expect(fake.requests[1]?.body).toMatchObject({ stop_price: '231', order_class: 'bracket',
      take_profit: { limit_price: '250' }, stop_loss: { stop_price: '220' } })
  })

  it('returns the existing order for a duplicate client order id', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 40010001, message: 'client_order_id must be unique' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request)).id).toBe('o-1')
    expect(fake.requests[1]?.query.get('client_order_id')).toBe('c-1')
  })

  it('looks the order up after a 5xx, returning it when it exists', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: placed }))
    expect((await submitOrder(http, request)).id).toBe('o-1')
  })

  it('reports not placed only when the lookup confirms absence', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
    await expect(submitOrder(http, request)).rejects.toMatchObject({ code: 'unavailable', message: 'Alpaca is unavailable; the order was not placed' })
  })

  it('reports an unknown outcome when the lookup also fails', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 503, body: { message: 'busy' } }))
    fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 503, body: { message: 'busy' } }))
    await expect(submitOrder(http, request)).rejects.toMatchObject({ code: 'unknown-outcome' })
  })

  it('passes other rejections through without a lookup', async () => {
    fake.on('POST', '/v2/orders', () => ({ status: 403, body: { code: 40310000, message: 'insufficient buying power' } }))
    await expect(submitOrder(http, request)).rejects.toMatchObject({ code: 'rejected', brokerCode: 40310000 })
    expect(fake.requests).toHaveLength(1)
  })
})

describe('reads', () => {
  it('maps the account, positions, and open orders', async () => {
    fake.on('GET', '/v2/account', () => ({ status: 200, body: { equity: '10', cash: '5', last_equity: '9', buying_power: '5' } }))
    fake.on('GET', '/v2/positions', () => ({ status: 200, body: [{ symbol: 'AAPL', asset_class: 'us_equity', side: 'long', qty: '2',
      avg_entry_price: '1', current_price: '2', market_value: '4', unrealized_pl: '2' }] }))
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [placed] }))
    expect((await account(http)).equity).toBe(10)
    expect((await positions(http))[0]?.qty).toBe(2)
    expect((await openOrders(http))[0]?.status).toBe('open')
    expect(fake.requests[2]?.query.get('status')).toBe('open')
    expect(fake.requests[2]?.query.get('limit')).toBe('500')
  })
})

describe('cancel, close, flatten', () => {
  it('cancels one order', async () => {
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    await cancelOrder(http, brandString<BrokerOrderId>('o-1'))
    expect(fake.requests[0]?.method).toBe('DELETE')
  })

  it('closes one position with the symbol URL-encoded', async () => {
    fake.on('DELETE', '/v2/positions/BTC%2FUSD', () => ({ status: 200, body: { ...placed, side: 'sell', type: 'market' } }))
    expect((await closePosition(http, { assetClass: 'crypto', ticker: 'BTC/USD' })).side).toBe('sell')
  })

  it('flattens by cancelling orders and closing positions, failing on any item error', async () => {
    fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [{ symbol: 'AAPL', status: 200, body: { ...placed, symbol: 'AAPL', asset_class: 'us_equity' } }] }))
    expect(await flatten(http)).toHaveLength(1)
    expect(fake.requests[0]?.query.get('cancel_orders')).toBe('true')
    fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [{ symbol: 'AAPL', status: 403, body: { message: 'held' } }] }))
    await expect(flatten(http)).rejects.toMatchObject({ code: 'rejected', message: 'Alpaca could not close: AAPL (403)' })
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/orders.spec.ts`
Expected: FAIL, cannot resolve `../src/orders.ts`.

- [ ] **Step 2: Implement**

`packages/experimental/trading-alpaca/src/orders.ts`:

```ts
/**
 * Alpaca account reads and order operations. Submission never duplicates:
 * after a duplicate-id rejection or an unavailable venue it looks the order
 * up by client order id before reporting anything.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/orders
 */
import type {
  AccountSnapshot, BrokerOrder, BrokerOrderId, BrokerOrderRequest, ClientOrderId, PositionSnapshot, TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'
import { mapAccount, mapOrder, mapPosition } from './map.ts'
import type { RawRecord } from './types.ts'

/** Alpaca's error code for a reused client order id. */
const DUPLICATE_CLIENT_ORDER_ID = 40010001

interface MultiStatus { readonly symbol?: string; readonly id?: string; readonly status: number; readonly body?: RawRecord }

function orderBody(request: BrokerOrderRequest): Record<string, unknown> {
  return {
    symbol: request.symbol.ticker,
    side: request.side,
    type: request.type,
    time_in_force: request.timeInForce,
    client_order_id: request.clientOrderId,
    ...request.qty === undefined ? {} : { qty: String(request.qty) },
    ...request.notional === undefined ? {} : { notional: String(request.notional) },
    ...request.limitPrice === undefined ? {} : { limit_price: String(request.limitPrice) },
    ...request.stopPrice === undefined ? {} : { stop_price: String(request.stopPrice) },
    ...request.bracket === undefined ? {} : {
      order_class: 'bracket',
      take_profit: { limit_price: String(request.bracket.takeProfit) },
      stop_loss: { stop_price: String(request.bracket.stopLoss) },
    },
  }
}

/**
 * Find an order by its client order id.
 * @param http - REST client.
 * @param id - client order id.
 * @returns the order, or undefined when Alpaca has none.
 */
export async function orderByClientId(http: AlpacaHttp, id: ClientOrderId): Promise<BrokerOrder | undefined> {
  try {
    return mapOrder(await http.request<RawRecord>('trading', 'GET', '/v2/orders:by_client_order_id', { query: { client_order_id: id } }))
  } catch (error) {
    if (error instanceof VenueError && error.code === 'not-found') return undefined
    throw error
  }
}

/**
 * Submit an order without ever creating a duplicate.
 * @param http - REST client.
 * @param request - planned order.
 * @returns the accepted or already-existing order.
 * @throws VenueError `unknown-outcome` when neither the submission nor the lookup confirms the order's state.
 */
export async function submitOrder(http: AlpacaHttp, request: BrokerOrderRequest): Promise<BrokerOrder> {
  try {
    return mapOrder(await http.request<RawRecord>('trading', 'POST', '/v2/orders', { body: orderBody(request) }))
  } catch (error) {
    if (!(error instanceof VenueError)) throw error
    const duplicate = error.brokerCode === DUPLICATE_CLIENT_ORDER_ID
    if (!duplicate && error.code !== 'unavailable') throw error
    let existing: BrokerOrder | undefined
    try {
      existing = await orderByClientId(http, request.clientOrderId)
    } catch (lookupError) {
      throw new VenueError(
        `Alpaca did not confirm order ${request.clientOrderId}; check open orders before proposing again (${(lookupError as Error).message})`,
        'unknown-outcome',
      )
    }
    if (existing !== undefined) return existing
    if (duplicate) throw error
    throw new VenueError('Alpaca is unavailable; the order was not placed', 'unavailable')
  }
}

/**
 * Read the account.
 * @param http - REST client.
 * @returns the account snapshot.
 */
export async function account(http: AlpacaHttp): Promise<AccountSnapshot> {
  return mapAccount(await http.request<RawRecord>('trading', 'GET', '/v2/account'))
}

/**
 * Read open positions.
 * @param http - REST client.
 * @returns every open position.
 */
export async function positions(http: AlpacaHttp): Promise<PositionSnapshot[]> {
  return (await http.request<RawRecord[]>('trading', 'GET', '/v2/positions')).map(mapPosition)
}

/**
 * Read open orders.
 * @param http - REST client.
 * @returns up to 500 open orders.
 */
export async function openOrders(http: AlpacaHttp): Promise<BrokerOrder[]> {
  return (await http.request<RawRecord[]>('trading', 'GET', '/v2/orders', { query: { status: 'open', limit: 500 } })).map(mapOrder)
}

/**
 * Cancel one order.
 * @param http - REST client.
 * @param id - broker order id.
 * @returns when Alpaca accepted the cancellation.
 */
export async function cancelOrder(http: AlpacaHttp, id: BrokerOrderId): Promise<void> {
  await http.request('trading', 'DELETE', `/v2/orders/${encodeURIComponent(id)}`)
}

/**
 * Close one position at market.
 * @param http - REST client.
 * @param symbol - instrument.
 * @returns the closing order.
 */
export async function closePosition(http: AlpacaHttp, symbol: TradingSymbol): Promise<BrokerOrder> {
  return mapOrder(await http.request<RawRecord>('trading', 'DELETE', `/v2/positions/${encodeURIComponent(symbol.ticker)}`))
}

/**
 * Cancel every open order and close every position.
 * @param http - REST client.
 * @returns the closing orders.
 * @throws VenueError `rejected` naming every position Alpaca could not close.
 */
export async function flatten(http: AlpacaHttp): Promise<BrokerOrder[]> {
  const results = await http.request<MultiStatus[]>('trading', 'DELETE', '/v2/positions', { query: { cancel_orders: 'true' } })
  const failed = results.filter(result => result.status >= 400)
  if (failed.length > 0) {
    throw new VenueError(`Alpaca could not close: ${failed.map(f => `${String(f.symbol)} (${String(f.status)})`).join(', ')}`, 'rejected')
  }
  return results.flatMap(result => (result.body === undefined ? [] : [mapOrder(result.body)]))
}
```

A duplicate rejection whose lookup finds nothing rethrows the original rejection (`if (duplicate) throw error`); add a test for it:

```ts
it('rethrows a duplicate rejection when the lookup finds nothing', async () => {
  fake.on('POST', '/v2/orders', () => ({ status: 422, body: { code: 40010001, message: 'client_order_id must be unique' } }))
  fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 404, body: { message: 'order not found' } }))
  await expect(submitOrder(http, request)).rejects.toMatchObject({ code: 'rejected', brokerCode: 40010001 })
})
```

- [ ] **Step 3: Run with coverage and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/orders.spec.ts --coverage --coverage.include='packages/experimental/trading-alpaca/src/orders.ts'`
Expected: PASS, 100% for `orders.ts`. The `!(error instanceof VenueError)` branch is pinned by this test (add it to the `submitOrder` describe):

```ts
it('passes a non-venue failure through untouched', async () => {
  const locked = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [],
    keys: async () => { throw new Error('vault locked') } })
  await expect(submitOrder(locked, request)).rejects.toThrow('vault locked')
})
```

```bash
git add packages/experimental/trading-alpaca
git commit -m "feat(trading-alpaca): submit orders idempotently and add cancel, close, and flatten"
```

---

### Task 7: Account safety — configuration, Halt, flatten window, drift

**Files:**
- Create: `packages/experimental/trading-alpaca/src/safety.ts`
- Test: `packages/experimental/trading-alpaca/tests/safety.spec.ts`

**Interfaces:**
- Consumes: `AlpacaHttp`; `accountConfig` fake (Task 3).
- Produces: `SafetyState = { halted, haltReason, flattenWindowOpen }`, `SafetyStateStore = { get(): SafetyState; set(state): Promise<void> }`, `INITIAL_SAFETY_STATE`, `AccountSafety` with `start(): Promise<{ halted: boolean; reason: string }>`, `halt(reason)`, `resume()`, `withFlattenWindow<T>(run: () => Promise<T>): Promise<T>`, `check(): Promise<string | undefined>` (returns the drift reason after halting, or undefined), `isHalted(): boolean`.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading-alpaca/tests/safety.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { AccountSafety, INITIAL_SAFETY_STATE, type SafetyState, type SafetyStateStore } from '../src/safety.ts'
import { accountConfig, FakeAlpaca, type FakeAccountConfig } from './fake-alpaca.ts'

let fake: FakeAlpaca
let http: AlpacaHttp
let saved: SafetyState
const store: SafetyStateStore = { get: () => saved, set: async state => { saved = state } }
const unsafe: FakeAccountConfig = { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false }

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start(); saved = INITIAL_SAFETY_STATE
  http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [], keys: async () => ({ keyId: 'k', secret: 's' }) })
})
afterEach(async () => { await fake.stop() })

describe('start', () => {
  it('applies and verifies no shorting and a 1x margin multiplier', async () => {
    const config = accountConfig(fake, unsafe)
    expect(await new AccountSafety(http, store).start()).toEqual({ halted: false, reason: '' })
    expect(config).toMatchObject({ no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
  })

  it('skips the write when the account is already safe', async () => {
    accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    await new AccountSafety(http, store).start()
    expect(fake.requests.map(r => r.method)).toEqual(['GET'])
  })

  it('blocks when Alpaca does not keep the settings', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: unsafe }))
    fake.on('PATCH', '/v2/account/configurations', () => ({ status: 200, body: unsafe }))
    await expect(new AccountSafety(http, store).start()).rejects.toMatchObject({
      code: 'blocked', message: 'Alpaca did not accept no_shorting=true and max_margin_multiplier=1; trading stays blocked',
    })
  })

  it('starts halted when the saved flag or the broker suspension is set', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: true })
    expect(await new AccountSafety(http, store).start()).toEqual({ halted: true, reason: 'trading was suspended at Alpaca' })
    expect(saved.halted).toBe(true)
    config.suspend_trade = false
    expect((await new AccountSafety(http, store).start()).halted).toBe(true)
    expect(config.suspend_trade).toBe(true)
  })

  it('recovers from a crash inside the flatten window by re-suspending and halting', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    saved = { halted: true, haltReason: 'user halt', flattenWindowOpen: true }
    expect(await new AccountSafety(http, store).start()).toEqual({ halted: true, reason: 'the desk stopped while closing positions; trading stays halted' })
    expect(config.suspend_trade).toBe(true)
    expect(saved).toEqual({ halted: true, haltReason: 'the desk stopped while closing positions; trading stays halted', flattenWindowOpen: false })
  })
})

describe('halt, resume, flatten window', () => {
  it('halts and resumes at the broker and in saved state, re-applying settings on resume', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    await safety.halt('user halt')
    expect(config.suspend_trade).toBe(true)
    expect(saved).toMatchObject({ halted: true, haltReason: 'user halt' })
    expect(safety.isHalted()).toBe(true)
    config.no_shorting = false
    await safety.resume()
    expect(config).toMatchObject({ no_shorting: true, suspend_trade: false })
    expect(saved.halted).toBe(false)
  })

  it('lifts the suspension only inside the window and restores it even when the work fails', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    await safety.halt('user halt')
    const seen: boolean[] = []
    await safety.withFlattenWindow(async () => { seen.push(config.suspend_trade, saved.flattenWindowOpen) })
    expect(seen).toEqual([false, true])
    expect(config.suspend_trade).toBe(true)
    expect(saved.flattenWindowOpen).toBe(false)
    await expect(safety.withFlattenWindow(async () => { throw new Error('close failed') })).rejects.toThrow('close failed')
    expect(config.suspend_trade).toBe(true)
  })

  it('runs the work directly when not halted', async () => {
    accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    const before = fake.requests.length
    expect(await safety.withFlattenWindow(async () => 'done')).toBe('done')
    expect(fake.requests.length).toBe(before)
  })
})

describe('check', () => {
  it('reports nothing while the settings hold', async () => {
    accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    expect(await safety.check()).toBeUndefined()
  })

  it('halts on drift and names every changed setting', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    config.no_shorting = false
    config.max_margin_multiplier = '2'
    expect(await safety.check()).toBe('account settings changed at Alpaca: no_shorting, max_margin_multiplier')
    expect(config.suspend_trade).toBe(true)
    expect(safety.isHalted()).toBe(true)
  })

  it('treats a lifted suspension while halted as drift, but not inside the flatten window', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    await safety.halt('user halt')
    let inside: string | undefined = 'unset'
    await safety.withFlattenWindow(async () => { inside = await safety.check() })
    expect(inside).toBeUndefined()
    config.suspend_trade = false
    expect(await safety.check()).toBe('account settings changed at Alpaca: suspend_trade')
  })

  it('treats a suspension set at Alpaca while running as drift', async () => {
    const config = accountConfig(fake, { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
    const safety = new AccountSafety(http, store)
    await safety.start()
    config.suspend_trade = true
    expect(await safety.check()).toBe('account settings changed at Alpaca: suspend_trade')
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/safety.spec.ts`
Expected: FAIL, cannot resolve `../src/safety.ts`.

- [ ] **Step 2: Implement**

`packages/experimental/trading-alpaca/src/safety.ts`:

```ts
/**
 * Account safety at the broker: no shorting, a 1x margin multiplier, Halt
 * through `suspend_trade`, a journaled flatten window for closing positions
 * while halted, and drift detection. These settings bound an agent that only
 * places orders; an agent holding the keys can change them, which the drift
 * check detects and answers with a Halt.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/safety
 */
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'

/** Persisted Halt state. */
export interface SafetyState {
  /** Whether trading is halted. */
  readonly halted: boolean
  /** Readable cause of the current Halt; empty when running. */
  readonly haltReason: string
  /** Whether a flatten window is open (suspension lifted to close positions). */
  readonly flattenWindowOpen: boolean
}

/** Durable storage for {@link SafetyState}. */
export interface SafetyStateStore {
  /** Read the saved state. */
  get(): SafetyState
  /** Save the state; resolves when durable. */
  set(state: SafetyState): Promise<void>
}

/** State of a desk that has never halted. */
export const INITIAL_SAFETY_STATE: SafetyState = { halted: false, haltReason: '', flattenWindowOpen: false }

interface AccountConfiguration {
  readonly no_shorting?: unknown
  readonly max_margin_multiplier?: unknown
  readonly suspend_trade?: unknown
}

const SAFE = { no_shorting: true, max_margin_multiplier: '1' } as const
const CRASH_REASON = 'the desk stopped while closing positions; trading stays halted'
const PATH = '/v2/account/configurations'

/** Enforces and watches the account's safety settings. */
export class AccountSafety {
  /**
   * @param http - REST client.
   * @param store - durable Halt state.
   */
  constructor(private readonly http: AlpacaHttp, private readonly store: SafetyStateStore) {}

  /**
   * Whether trading is halted.
   * @returns the saved Halt flag.
   */
  isHalted(): boolean {
    return this.store.get().halted
  }

  /**
   * Apply the safety settings, then restore Halt from saved state, the broker's suspension, or an interrupted flatten window.
   * @returns whether the desk starts halted and why.
   * @throws VenueError `blocked` when Alpaca does not keep the safety settings.
   */
  async start(): Promise<{ halted: boolean; reason: string }> {
    const config = await this.applySafeSettings()
    const saved = this.store.get()
    if (saved.flattenWindowOpen) {
      await this.suspend(true)
      await this.store.set({ halted: true, haltReason: CRASH_REASON, flattenWindowOpen: false })
      return { halted: true, reason: CRASH_REASON }
    }
    if (saved.halted || config.suspend_trade === true) {
      const reason = saved.halted ? saved.haltReason : 'trading was suspended at Alpaca'
      if (config.suspend_trade !== true) await this.suspend(true)
      await this.store.set({ halted: true, haltReason: reason, flattenWindowOpen: false })
      return { halted: true, reason }
    }
    return { halted: false, reason: '' }
  }

  /**
   * Halt at the broker and in saved state.
   * @param reason - readable cause.
   * @returns when the suspension is confirmed and saved.
   */
  async halt(reason: string): Promise<void> {
    await this.suspend(true)
    await this.store.set({ halted: true, haltReason: reason, flattenWindowOpen: false })
  }

  /**
   * Re-apply the safety settings and lift the Halt.
   * @returns when the broker and saved state agree the desk is running.
   */
  async resume(): Promise<void> {
    await this.applySafeSettings()
    await this.suspend(false)
    await this.store.set(INITIAL_SAFETY_STATE)
  }

  /**
   * Run reduce-only work. While halted, the suspension is lifted only for the work and restored afterwards, and the open
   * window is saved first so a crash inside it is recovered on the next start.
   * @param run - the closing work.
   * @returns the work's result.
   */
  async withFlattenWindow<T>(run: () => Promise<T>): Promise<T> {
    const state = this.store.get()
    if (!state.halted) return run()
    await this.store.set({ ...state, flattenWindowOpen: true })
    await this.suspend(false)
    try {
      return await run()
    } finally {
      await this.suspend(true)
      await this.store.set({ ...state, flattenWindowOpen: false })
    }
  }

  /**
   * Compare the broker's settings with the expected ones and halt on any difference. The suspension is not compared
   * while a flatten window is open, because the window lifts it on purpose.
   * @returns the drift reason after halting, or undefined when the settings hold.
   */
  async check(): Promise<string | undefined> {
    const state = this.store.get()
    const config = await this.read()
    const changed: string[] = []
    if (config.no_shorting !== SAFE.no_shorting) changed.push('no_shorting')
    if (config.max_margin_multiplier !== SAFE.max_margin_multiplier) changed.push('max_margin_multiplier')
    if (!state.flattenWindowOpen && (config.suspend_trade === true) !== state.halted) changed.push('suspend_trade')
    if (changed.length === 0) return undefined
    const reason = `account settings changed at Alpaca: ${changed.join(', ')}`
    await this.halt(reason)
    return reason
  }

  private async read(): Promise<AccountConfiguration> {
    return this.http.request<AccountConfiguration>('trading', 'GET', PATH)
  }

  private async suspend(on: boolean): Promise<void> {
    await this.http.request('trading', 'PATCH', PATH, { body: { suspend_trade: on } })
  }

  private async applySafeSettings(): Promise<AccountConfiguration> {
    const current = await this.read()
    if (current.no_shorting === SAFE.no_shorting && current.max_margin_multiplier === SAFE.max_margin_multiplier) return current
    await this.http.request('trading', 'PATCH', PATH, { body: SAFE })
    const verified = await this.read()
    if (verified.no_shorting !== SAFE.no_shorting || verified.max_margin_multiplier !== SAFE.max_margin_multiplier) {
      throw new VenueError('Alpaca did not accept no_shorting=true and max_margin_multiplier=1; trading stays blocked', 'blocked')
    }
    return verified
  }
}
```

- [ ] **Step 3: Run with coverage and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/safety.spec.ts --coverage --coverage.include='packages/experimental/trading-alpaca/src/safety.ts'`
Expected: PASS, 100% for `safety.ts`.

```bash
git add packages/experimental/trading-alpaca
git commit -m "feat(trading-alpaca): enforce account safety settings with persisted halt and drift checks"
```

---

### Task 8: Trade-updates stream

**Files:**
- Create: `packages/experimental/trading-alpaca/src/stream.ts`
- Test: `packages/experimental/trading-alpaca/tests/stream.spec.ts`

**Interfaces:**
- Consumes: `mapOrderUpdate` (Task 5), `AlpacaKeys`.
- Produces: `TradeUpdateStreamOptions`, `TradeUpdateStream` with `start()`, `stop()`. One instance owns one socket lifecycle: connect → `auth` → `listen` → updates; on close it reconnects after `backoffMs[min(attempt, last)]` and resets the attempt counter on `listening`; on `unauthorized` it reports `VenueError('auth')` through `onError` and stops; `stop()` closes without reconnecting.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading-alpaca/tests/stream.spec.ts`:

```ts
import type { OrderUpdate } from '@deepseek-ai/dsh-experimental-trading'
import type { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { TradeUpdateStream } from '../src/stream.ts'

let server: WebSocketServer
let url: string
let sockets: ServerSocket[]
let messages: unknown[]
let authorize: boolean

const order = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTCUSD', asset_class: 'crypto', side: 'buy', type: 'limit',
  time_in_force: 'ioc', qty: '0.015', filled_qty: '0.015', filled_avg_price: '62831.5', status: 'filled' }
const send = (socket: ServerSocket, payload: unknown, binary = true): void => {
  const text = JSON.stringify(payload)
  socket.send(binary ? Buffer.from(text) : text)
}
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

beforeEach(async () => {
  sockets = []; messages = []; authorize = true
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', raw => {
      const message = JSON.parse(String(raw)) as { action: string }
      messages.push(message)
      if (message.action === 'auth') send(socket, { stream: 'authorization', data: { status: authorize ? 'authorized' : 'unauthorized', action: 'authenticate' } })
      if (message.action === 'listen') send(socket, { stream: 'listening', data: { streams: ['trade_updates'] } }, false)
    })
  })
  await new Promise<void>(resolve => { server.on('listening', () => { resolve() }) })
  const address = server.address()
  url = `ws://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
})
afterEach(async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) })

function stream(updates: OrderUpdate[], errors: VenueError[]): TradeUpdateStream {
  return new TradeUpdateStream({
    url, backoffMs: [10, 20], keys: async () => ({ keyId: 'k', secret: 's' }),
    onUpdate: update => { updates.push(update) }, onError: error => { errors.push(error) },
  })
}

describe('TradeUpdateStream', () => {
  it('authenticates, listens, and delivers binary and text trade updates', async () => {
    const updates: OrderUpdate[] = []
    const s = stream(updates, [])
    s.start()
    await until(() => messages.length === 2)
    expect(messages).toEqual([{ action: 'auth', key: 'k', secret: 's' }, { action: 'listen', data: { streams: ['trade_updates'] } }])
    const socket = sockets[0] as ServerSocket
    send(socket, { stream: 'trade_updates', data: { event: 'fill', order, timestamp: '2026-10-05T14:00:01Z', price: '62831.5', qty: '0.015' } })
    send(socket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } }, false)
    await until(() => updates.length === 2)
    expect(updates.map(u => u.event)).toEqual(['fill', 'new'])
    s.stop()
  })

  it('reconnects with backoff after the socket drops and authenticates again', async () => {
    const s = stream([], [])
    s.start()
    await until(() => messages.length === 2)
    sockets[0]?.close()
    await until(() => sockets.length === 2 && messages.length === 4)
    s.stop()
  })

  it('stops and reports auth when Alpaca rejects the keys', async () => {
    authorize = false
    const errors: VenueError[] = []
    const s = stream([], errors)
    s.start()
    await until(() => errors.length === 1)
    expect(errors[0]).toMatchObject({ code: 'auth' })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(sockets).toHaveLength(1)
    s.stop()
  })

  it('reports an in-stream error and a malformed update without stopping', async () => {
    const updates: OrderUpdate[] = []
    const errors: VenueError[] = []
    const s = stream(updates, errors)
    s.start()
    await until(() => messages.length === 2)
    const socket = sockets[0] as ServerSocket
    send(socket, { action: 'error', data: { error_message: 'slow client' } })
    send(socket, { stream: 'trade_updates', data: { event: 'fill', order: { ...order, filled_qty: 'abc' }, timestamp: 'x' } })
    send(socket, 'not json at all', false)
    await until(() => errors.length === 3)
    expect(errors.map(e => e.code)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    s.stop()
  })

  it('does not reconnect after stop', async () => {
    const s = stream([], [])
    s.start()
    await until(() => messages.length === 2)
    s.stop()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(sockets).toHaveLength(1)
  })
})
```

The third `send` in the in-stream-error test sends the JSON string `"not json at all"` (valid JSON, not an object); the stream must report it as malformed. Also add a test that sends a raw non-JSON text frame by calling `socket.send('{broken')` directly and expects a fourth `unavailable` error.

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/stream.spec.ts`
Expected: FAIL, cannot resolve `../src/stream.ts`.

- [ ] **Step 2: Implement**

`packages/experimental/trading-alpaca/src/stream.ts`:

```ts
/**
 * The account's trade-updates WebSocket: one owner for connect, authenticate,
 * listen, decode (Alpaca sends binary frames), reconnect with backoff, and stop.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/stream
 */
import type { OrderUpdate } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { mapOrderUpdate } from './map.ts'
import type { AlpacaKeys, RawRecord } from './types.ts'

/** Stream construction options. */
export interface TradeUpdateStreamOptions {
  /** Trade-updates WebSocket URL. */
  readonly url: string
  /** Waits before reconnect attempts; the last entry repeats. */
  readonly backoffMs: readonly number[]
  /** Resolve the key pair at each connection. */
  readonly keys: () => Promise<AlpacaKeys>
  /** Receives each order update. */
  readonly onUpdate: (update: OrderUpdate) => void
  /** Receives stream failures; `auth` stops the stream. */
  readonly onError: (error: VenueError) => void
}

const decoder = new TextDecoder()

/** A reconnecting trade-updates stream. */
export class TradeUpdateStream {
  private socket: WebSocket | undefined
  private stopped = true
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  private readonly lastBackoff: number

  /**
   * @param options - URL, backoff, keys, and callbacks.
   * @throws RangeError when `backoffMs` is empty.
   */
  constructor(private readonly options: TradeUpdateStreamOptions) {
    if (options.backoffMs.length === 0) throw new RangeError('backoffMs must not be empty')
    this.lastBackoff = options.backoffMs.length - 1
  }

  /**
   * Connect and keep the stream open until {@link stop}.
   * @returns nothing; connection happens in the background.
   */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  /**
   * Close the stream and cancel any pending reconnect.
   * @returns nothing.
   */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.socket?.close()
    this.socket = undefined
  }

  private connect(): void {
    const socket = new WebSocket(this.options.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.addEventListener('open', () => {
      void this.options.keys().then(keys => {
        socket.send(JSON.stringify({ action: 'auth', key: keys.keyId, secret: keys.secret }))
      }, (error: unknown) => {
        this.options.onError(new VenueError(`Alpaca keys unavailable: ${(error as Error).message}`, 'unconfigured'))
        socket.close()
      })
    })
    socket.addEventListener('message', event => { this.receive(socket, event.data) })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.stopped) return
      const delay = this.options.backoffMs[Math.min(this.attempt, this.lastBackoff)] as number
      this.attempt++
      this.timer = setTimeout(() => { this.timer = undefined; this.connect() }, delay)
      this.timer.unref()
    })
  }

  private receive(socket: WebSocket, data: unknown): void {
    let message: { stream?: unknown; action?: unknown; data?: RawRecord }
    try {
      const text = typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer)
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      message = parsed as typeof message
    } catch (error) {
      this.options.onError(new VenueError(`Alpaca sent a malformed stream message: ${(error as Error).message}`, 'unavailable'))
      return
    }
    if (message.stream === 'authorization') {
      if (message.data?.status === 'authorized') {
        socket.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }))
        return
      }
      this.options.onError(new VenueError('Alpaca rejected the API keys on the trade-updates stream', 'auth'))
      this.stop()
      return
    }
    if (message.stream === 'listening') {
      this.attempt = 0
      return
    }
    if (message.action === 'error') {
      this.options.onError(new VenueError(`Alpaca stream error: ${String(message.data?.error_message)}`, 'unavailable'))
      return
    }
    if (message.stream === 'trade_updates' && message.data !== undefined) {
      try {
        this.options.onUpdate(mapOrderUpdate(message.data))
      } catch (error) {
        this.options.onError(error instanceof VenueError ? error : new VenueError((error as Error).message, 'unavailable'))
      }
    }
  }
}
```

Add these tests to `stream.spec.ts`:

```ts
it('rejects an empty backoff schedule', () => {
  expect(() => new TradeUpdateStream({ url, backoffMs: [], keys: async () => ({ keyId: 'k', secret: 's' }),
    onUpdate: () => {}, onError: () => {} })).toThrow(new RangeError('backoffMs must not be empty'))
})

it('reports a raw non-JSON frame and a failing listener as unavailable', async () => {
  const errors: VenueError[] = []
  const s = new TradeUpdateStream({ url, backoffMs: [10], keys: async () => ({ keyId: 'k', secret: 's' }),
    onUpdate: () => { throw new Error('listener failed') }, onError: error => { errors.push(error) } })
  s.start()
  await until(() => messages.length === 2)
  const socket = sockets[0] as ServerSocket
  socket.send('{broken')
  send(socket, { stream: 'trade_updates', data: { event: 'new', order, timestamp: '2026-10-05T14:00:00Z' } })
  await until(() => errors.length === 2)
  expect(errors[1]).toMatchObject({ code: 'unavailable', message: 'listener failed' })
  s.stop()
})

it('reports unconfigured and closes when the keys cannot be resolved', async () => {
  const errors: VenueError[] = []
  const s = new TradeUpdateStream({ url, backoffMs: [1_000], keys: async () => { throw new Error('no keys') },
    onUpdate: () => {}, onError: error => { errors.push(error) } })
  s.start()
  await until(() => errors.length === 1)
  expect(errors[0]).toMatchObject({ code: 'unconfigured', message: 'Alpaca keys unavailable: no keys' })
  s.stop()
})

it('ignores a second start while running', async () => {
  const s = stream([], [])
  s.start()
  s.start()
  await until(() => messages.length === 2)
  expect(sockets).toHaveLength(1)
  s.stop()
})
```

- [ ] **Step 3: Run with coverage and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/stream.spec.ts --coverage --coverage.include='packages/experimental/trading-alpaca/src/stream.ts'`
Expected: PASS, 100% for `stream.ts`.

```bash
git add packages/experimental/trading-alpaca
git commit -m "feat(trading-alpaca): stream order updates with reconnect and auth handling"
```

---

### Task 9: `VenueCore` and the `AlpacaVenue` service

**Files:**
- Create: `packages/experimental/trading-alpaca/src/venue.ts`, `packages/experimental/trading-alpaca/src/index.ts`
- Test: `packages/experimental/trading-alpaca/tests/venue.spec.ts`, `packages/experimental/trading-alpaca/tests/composition.spec.ts`, `packages/experimental/trading-alpaca/tests/egress.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–8; `TradingVenueGateway`, `VenueError`.
- Produces: `VenueCore` (all venue behavior with injected collaborators), `AlpacaVenue` (default export; the `TradingVenueGateway` provider), `tradingSafetyDomainSpec`.
- `VenueCore` status machine: no keys → `unconfigured` (every broker operation throws `VenueError('unconfigured', 'Alpaca keys not configured — add them in Settings → Trading')`; the next operation retries setup); safety `blocked` → `blocked` (reads work; `submitOrder`, `closePosition`, `flatten`, `resume` throw `blocked`); halted → `halted` (`submitOrder` throws `VenueError('halted', 'trading is halted')`; `closePosition` and `flatten` run inside the flatten window). Every status change emits `trading/venue-status`.

- [ ] **Step 1: Write the failing `VenueCore` tests**

`packages/experimental/trading-alpaca/tests/venue.spec.ts`:

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderRequest, ClientOrderId, OrderUpdate, VenueStatus } from '@deepseek-ai/dsh-experimental-trading'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { INITIAL_SAFETY_STATE, type SafetyState } from '../src/safety.ts'
import { VenueCore } from '../src/venue.ts'
import { accountConfig, FakeAlpaca, type FakeAccountConfig } from './fake-alpaca.ts'

let fake: FakeAlpaca
let keysPresent: boolean
let saved: SafetyState
let statuses: [VenueStatus, string][]
let streams: { started: number; stopped: number }
const order = { id: 'o-1', client_order_id: 'c-1', symbol: 'BTC/USD', asset_class: 'crypto', side: 'buy', type: 'market',
  time_in_force: 'gtc', qty: '0.015', filled_qty: '0', status: 'accepted' }
const request: BrokerOrderRequest = { symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market',
  timeInForce: 'gtc', clientOrderId: brandString<ClientOrderId>('c-1') }
const safe: FakeAccountConfig = { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false }

function core(): { venue: VenueCore; emit: (update: OrderUpdate) => void } {
  let deliver: (update: OrderUpdate) => void = () => {}
  const http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [],
    keys: async () => ({ keyId: 'k', secret: 's' }) })
  const venue = new VenueCore({
    http, feed: 'iex', now: () => Date.UTC(2026, 9, 5),
    keysPresent: async () => keysPresent,
    store: { get: () => saved, set: async state => { saved = state } },
    stream: onUpdate => { deliver = onUpdate; return { start: () => { streams.started++ }, stop: () => { streams.stopped++ } } },
    emitStatus: (status, reason) => { statuses.push([status, reason]) },
  })
  return { venue, emit: update => { deliver(update) } }
}

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start()
  keysPresent = true; saved = INITIAL_SAFETY_STATE; statuses = []; streams = { started: 0, stopped: 0 }
  fake.on('POST', '/v2/orders', () => ({ status: 200, body: order }))
  fake.on('DELETE', '/v2/positions/BTC%2FUSD', () => ({ status: 200, body: { ...order, side: 'sell' } }))
  fake.on('DELETE', '/v2/positions', () => ({ status: 207, body: [] }))
  fake.on('GET', '/v2/account', () => ({ status: 200, body: { equity: '10', cash: '5', last_equity: '9', buying_power: '5' } }))
})
afterEach(async () => { await fake.stop() })

describe('VenueCore readiness', () => {
  it('stays unconfigured without keys and retries setup once keys appear', async () => {
    accountConfig(fake, safe)
    keysPresent = false
    const { venue } = core()
    await expect(venue.account()).rejects.toMatchObject({ code: 'unconfigured', message: 'Alpaca keys not configured — add them in Settings → Trading' })
    expect(venue.status()).toBe('unconfigured')
    keysPresent = true
    expect((await venue.account()).equity).toBe(10)
    expect(venue.status()).toBe('ready')
    expect(statuses).toEqual([['ready', 'account safety settings verified']])
  })

  it('blocks orders but allows reads when the account cannot be made safe', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false } }))
    fake.on('PATCH', '/v2/account/configurations', () => ({ status: 200, body: { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false } }))
    const { venue } = core()
    await venue.prepare()
    expect(venue.status()).toBe('blocked')
    expect((await venue.account()).equity).toBe(10)
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'blocked' })
    await expect(venue.flatten()).rejects.toMatchObject({ code: 'blocked' })
    await expect(venue.resume()).rejects.toMatchObject({ code: 'blocked' })
  })

  it('rethrows setup failures other than blocked without changing status', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 503, body: { message: 'busy' } }))
    const { venue } = core()
    await expect(venue.prepare()).rejects.toMatchObject({ code: 'unavailable' })
    expect(venue.status()).toBe('unconfigured')
  })
})

describe('VenueCore orders and Halt', () => {
  it('submits when ready and refuses while halted, but still closes and flattens', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    expect((await venue.submitOrder(request)).id).toBe('o-1')
    await venue.halt('user halt')
    expect(venue.status()).toBe('halted')
    await expect(venue.submitOrder(request)).rejects.toMatchObject({ code: 'halted', message: 'trading is halted' })
    expect((await venue.closePosition(request.symbol)).side).toBe('sell')
    expect(await venue.flatten()).toEqual([])
    expect(config.suspend_trade).toBe(true)
    await venue.resume()
    expect(venue.status()).toBe('ready')
    expect(statuses.map(s => s[0])).toEqual(['ready', 'halted', 'ready'])
  })

  it('starts halted from saved state', async () => {
    accountConfig(fake, safe)
    saved = { halted: true, haltReason: 'user halt', flattenWindowOpen: false }
    const { venue } = core()
    await venue.prepare()
    expect(venue.status()).toBe('halted')
    expect(statuses).toEqual([['halted', 'user halt']])
  })

  it('halts on drift and reports the changed settings', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    await venue.prepare()
    expect(await venue.checkDrift()).toBeUndefined()
    config.max_margin_multiplier = '2'
    expect(await venue.checkDrift()).toBe('account settings changed at Alpaca: max_margin_multiplier')
    expect(venue.status()).toBe('halted')
  })

  it('skips the drift check until the venue is set up', async () => {
    keysPresent = false
    const { venue } = core()
    expect(await venue.checkDrift()).toBeUndefined()
    expect(fake.requests).toHaveLength(0)
  })
})

describe('VenueCore drift watch', () => {
  it('halts on drift between ticks, never overlaps a slow check, and logs failures', async () => {
    const config = accountConfig(fake, safe)
    const { venue } = core()
    await venue.prepare()
    const warnings: string[] = []
    config.no_shorting = false
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config }, delayMs: 30 }))
    const stop = venue.watchDrift(5, message => { warnings.push(message) })
    for (let i = 0; i < 100 && venue.status() !== 'halted'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(venue.status()).toBe('halted')
    const configReads = fake.requests.filter(r => r.method === 'GET' && r.path === '/v2/account/configurations').length
    expect(configReads).toBeLessThanOrEqual(3)
    fake.on('GET', '/v2/account/configurations', () => ({ status: 503, body: { message: 'busy' } }))
    for (let i = 0; i < 100 && warnings.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(warnings[0]).toMatch(/^drift check failed: Alpaca is unavailable/)
    stop()
  })
})

describe('VenueCore order updates', () => {
  it('streams only while someone listens', async () => {
    accountConfig(fake, safe)
    const { venue, emit } = core()
    const seen: string[] = []
    const off1 = venue.subscribeOrderUpdates(update => { seen.push(`a:${update.event}`) })
    const off2 = venue.subscribeOrderUpdates(update => { seen.push(`b:${update.event}`) })
    expect(streams).toEqual({ started: 1, stopped: 0 })
    emit({ event: 'fill', order: { id: 'o-1' } as never, t: 0 })
    off1()
    expect(streams.stopped).toBe(0)
    off2()
    off2()
    expect(streams).toEqual({ started: 1, stopped: 1 })
    expect(seen).toEqual(['a:fill', 'b:fill'])
  })
})

describe('VenueCore reads', () => {
  it('delegates reads to the REST units with the configured feed and clock', async () => {
    accountConfig(fake, safe)
    fake.on('GET', '/v2/positions', () => ({ status: 200, body: [] }))
    fake.on('GET', '/v2/orders', () => ({ status: 200, body: [] }))
    fake.on('GET', '/v2/clock', () => ({ status: 200, body: { is_open: true } }))
    fake.on('GET', '/v2/stocks/quotes/latest', () => ({ status: 200, body: { quotes: { AAPL: { t: '2026-10-05T14:00:00Z', bp: 1, ap: 2 } } } }))
    fake.on('GET', '/v2/stocks/bars', () => ({ status: 200, body: { bars: {}, next_page_token: null } }))
    fake.on('GET', '/v2/assets/AAPL', () => ({ status: 200, body: { symbol: 'AAPL', class: 'us_equity', status: 'active', tradable: true, fractionable: true } }))
    fake.on('DELETE', '/v2/orders/o-1', () => ({ status: 204 }))
    const { venue } = core()
    const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
    expect(await venue.positions()).toEqual([])
    expect(await venue.openOrders()).toEqual([])
    expect(await venue.marketOpen(aapl)).toBe(true)
    expect((await venue.latestQuote(aapl)).ask).toBe(2)
    expect(await venue.bars(aapl, '1D', { limit: 5 })).toEqual([])
    expect((await venue.asset(aapl)).tradable).toBe(true)
    await venue.cancelOrder(brandString('o-1'))
    expect(fake.requests.find(r => r.path === '/v2/stocks/bars')?.query.get('end')).toBe('2026-10-05T00:00:00.000Z')
  })
})
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/venue.spec.ts`
Expected: FAIL, cannot resolve `../src/venue.ts`.

- [ ] **Step 2: Implement `VenueCore`**

`packages/experimental/trading-alpaca/src/venue.ts`:

```ts
/**
 * All venue behavior behind AlpacaVenue: readiness, order gating by Halt and
 * block state, and listener-counted order-update streaming. Collaborators are
 * injected so the behavior is tested against the fake Alpaca server.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/venue
 */
import type {
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, OrderUpdate, PositionSnapshot,
  Quote, Timeframe, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'
import { asset, bars, latestQuote, marketOpen } from './market.ts'
import * as orders from './orders.ts'
import { AccountSafety, type SafetyStateStore } from './safety.ts'

/** A startable, stoppable order-update source. */
export interface UpdateSource {
  /** Begin streaming. */
  start(): void
  /** Stop streaming. */
  stop(): void
}

/** Collaborators of {@link VenueCore}. */
export interface VenueCoreDeps {
  /** REST client. */
  readonly http: AlpacaHttp
  /** Equity data feed. */
  readonly feed: 'iex' | 'sip'
  /** Current time, UTC epoch milliseconds. */
  readonly now: () => number
  /** Whether both API keys resolve now. */
  readonly keysPresent: () => Promise<boolean>
  /** Durable Halt state. */
  readonly store: SafetyStateStore
  /** Create the order-update source that delivers to `onUpdate`. */
  readonly stream: (onUpdate: (update: OrderUpdate) => void) => UpdateSource
  /** Publish a status change. */
  readonly emitStatus: (status: VenueStatus, reason: string) => void
}

const UNCONFIGURED = 'Alpaca keys not configured — add them in Settings → Trading'

/** Venue behavior shared by the Alpaca service. */
export class VenueCore {
  private current: VenueStatus = 'unconfigured'
  private blockedReason = ''
  private setup: Promise<void> | undefined
  private readonly safety: AccountSafety
  private readonly listeners = new Set<(update: OrderUpdate) => void>()
  private source: UpdateSource | undefined

  /** @param deps - collaborators. */
  constructor(private readonly deps: VenueCoreDeps) {
    this.safety = new AccountSafety(deps.http, deps.store)
  }

  /**
   * Current readiness.
   * @returns the status.
   */
  status(): VenueStatus {
    return this.current
  }

  /**
   * Run setup once keys exist: apply the safety settings and restore Halt. Safe to call repeatedly.
   * @returns when setup finished or was skipped for missing keys.
   */
  async prepare(): Promise<void> {
    this.setup ??= this.runSetup().finally(() => {
      if (this.current === 'unconfigured') this.setup = undefined
    })
    await this.setup
  }

  /** @returns the account snapshot. */
  async account(): Promise<AccountSnapshot> { await this.readable(); return orders.account(this.deps.http) }
  /** @returns open positions. */
  async positions(): Promise<PositionSnapshot[]> { await this.readable(); return orders.positions(this.deps.http) }
  /** @returns open orders. */
  async openOrders(): Promise<BrokerOrder[]> { await this.readable(); return orders.openOrders(this.deps.http) }
  /** @param symbol - instrument. @returns broker facts. */
  async asset(symbol: TradingSymbol): Promise<Asset> { await this.readable(); return asset(this.deps.http, symbol) }
  /** @param symbol - instrument. @returns whether its market is open. */
  async marketOpen(symbol: TradingSymbol): Promise<boolean> { await this.readable(); return marketOpen(this.deps.http, symbol) }
  /** @param symbol - instrument. @returns the latest quote. */
  async latestQuote(symbol: TradingSymbol): Promise<Quote> { await this.readable(); return latestQuote(this.deps.http, symbol, this.deps.feed) }

  /**
   * @param symbol - instrument.
   * @param timeframe - bar timeframe.
   * @param query - range and count.
   * @returns bars, oldest first.
   */
  async bars(symbol: TradingSymbol, timeframe: Timeframe, query: BarQuery): Promise<Bar[]> {
    await this.readable()
    return bars(this.deps.http, symbol, timeframe, query, this.deps.feed, this.deps.now())
  }

  /** @param request - planned order. @returns the accepted order. */
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    await this.orderable()
    if (this.current === 'halted') throw new VenueError('trading is halted', 'halted')
    return orders.submitOrder(this.deps.http, request)
  }

  /** @param id - broker order id. @returns when cancelled. */
  async cancelOrder(id: BrokerOrderId): Promise<void> { await this.readable(); await orders.cancelOrder(this.deps.http, id) }

  /** @param symbol - instrument. @returns the closing order. */
  async closePosition(symbol: TradingSymbol): Promise<BrokerOrder> {
    await this.orderable()
    return this.safety.withFlattenWindow(() => orders.closePosition(this.deps.http, symbol))
  }

  /** @returns the closing orders. */
  async flatten(): Promise<BrokerOrder[]> {
    await this.orderable()
    return this.safety.withFlattenWindow(() => orders.flatten(this.deps.http))
  }

  /** @param reason - readable cause. @returns when halted. */
  async halt(reason: string): Promise<void> {
    await this.orderable()
    await this.safety.halt(reason)
    this.setStatus('halted', reason)
  }

  /** @returns when running again. */
  async resume(): Promise<void> {
    await this.orderable()
    await this.safety.resume()
    this.setStatus('ready', 'trading resumed')
  }

  /**
   * Check the account settings for drift once; halts on drift.
   * @returns the drift reason, or undefined when the settings hold or the venue is not set up.
   */
  async checkDrift(): Promise<string | undefined> {
    if (this.current !== 'ready' && this.current !== 'halted') return undefined
    const reason = await this.safety.check()
    if (reason !== undefined) this.setStatus('halted', reason)
    return reason
  }

  /**
   * Check for drift every `intervalMs` until stopped; a check never overlaps the previous one.
   * @param intervalMs - interval between checks.
   * @param warn - receives a message when a check fails.
   * @returns a function that stops the checks.
   */
  watchDrift(intervalMs: number, warn: (message: string) => void): () => void {
    let checking = false
    const timer = setInterval(() => {
      if (checking) return
      checking = true
      void this.checkDrift()
        .catch((error: unknown) => { warn(`drift check failed: ${(error as Error).message}`) })
        .finally(() => { checking = false })
    }, intervalMs)
    timer.unref()
    return () => { clearInterval(timer) }
  }

  /**
   * @param listener - receives each update.
   * @returns a disposer; the stream runs only while at least one listener is registered.
   */
  subscribeOrderUpdates(listener: (update: OrderUpdate) => void): () => void {
    this.listeners.add(listener)
    if (this.source === undefined) {
      this.source = this.deps.stream(update => { for (const each of [...this.listeners]) each(update) })
      this.source.start()
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.source?.stop()
      this.source = undefined
    }
  }

  /** Stop streaming; used on dispose. */
  close(): void {
    this.listeners.clear()
    this.source?.stop()
    this.source = undefined
  }

  private async runSetup(): Promise<void> {
    if (!(await this.deps.keysPresent())) return
    try {
      const start = await this.safety.start()
      if (start.halted) this.setStatus('halted', start.reason)
      else this.setStatus('ready', 'account safety settings verified')
    } catch (error) {
      if (!(error instanceof VenueError) || error.code !== 'blocked') throw error
      this.blockedReason = error.message
      this.setStatus('blocked', error.message)
    }
  }

  private async readable(): Promise<void> {
    await this.prepare()
    if (this.current === 'unconfigured') throw new VenueError(UNCONFIGURED, 'unconfigured')
  }

  private async orderable(): Promise<void> {
    await this.readable()
    if (this.current === 'blocked') throw new VenueError(this.blockedReason, 'blocked')
  }

  private setStatus(status: VenueStatus, reason: string): void {
    this.current = status
    this.deps.emitStatus(status, reason)
  }
}
```

Note: when setup rethrows a non-blocked error, `.finally` resets `setup` because status is still `unconfigured`, so the next call retries — the third readiness test pins this.

- [ ] **Step 3: Run the core tests**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/venue.spec.ts --coverage --coverage.include='packages/experimental/trading-alpaca/src/venue.ts'`
Expected: PASS, 100% for `venue.ts`.

- [ ] **Step 4: Implement the service class**

`packages/experimental/trading-alpaca/src/index.ts`:

```ts
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
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, OrderUpdate, PositionSnapshot,
  Quote, Timeframe, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { TradingVenueGateway, VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { Config, resolveEndpoints } from './config.ts'
import { AlpacaHttp } from './http.ts'
import { INITIAL_SAFETY_STATE, type SafetyState, type SafetyStateStore } from './safety.ts'
import { TradeUpdateStream } from './stream.ts'
import type { AlpacaKeys } from './types.ts'
import { VenueCore } from './venue.ts'

export { Config } from './config.ts'

/** Storage domain holding the persisted Halt state. */
export const tradingSafetyDomainSpec = defineDomain({
  name: 'trading_alpaca_safety',
  version: 1,
  global: {
    schema: zod.object({ halted: zod.boolean(), haltReason: zod.string(), flattenWindowOpen: zod.boolean() }),
    initial: INITIAL_SAFETY_STATE,
  },
  tables: {},
})

/** Alpaca implementation of the trading venue. */
export class AlpacaVenue extends TradingVenueGateway {
  static inject = ['storageDomain']
  static Config: z<Config> = Config

  private readonly core: VenueCore
  private state: SafetyState = INITIAL_SAFETY_STATE
  private persist: (state: SafetyState) => Promise<void> = async () => {}

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
    const store: SafetyStateStore = { get: () => this.state, set: async next => { this.state = next; await this.persist(next) } }
    this.core = new VenueCore({
      http: new AlpacaHttp({ tradingUrl: endpoints.tradingUrl, dataUrl: endpoints.dataUrl, timeoutMs: config.requestTimeoutMs,
        retryDelaysMs: config.rateLimitRetryMs, keys: requireKeys }),
      feed: config.feed,
      now: () => Date.now(),
      keysPresent: async () => (await keys()) !== undefined,
      store,
      stream: onUpdate => new TradeUpdateStream({
        url: endpoints.tradeStreamUrl, backoffMs: config.streamBackoffMs,
        keys: requireKeys, onUpdate,
        onError: error => { ctx.logger.warn(`trading-alpaca: ${error.message}`) },
      }),
      emitStatus: (status, reason) => { ctx.emit('trading/venue-status', status, reason) },
    })
    const stopDrift = this.core.watchDrift(config.driftCheckMs, message => { ctx.logger.warn(`trading-alpaca: ${message}`) })
    ctx.effect(() => () => { stopDrift(); this.core.close() }, 'trading-alpaca teardown')
  }

  /** Open the Halt-state domain, then set the venue up when keys exist. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(tradingSafetyDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'trading-alpaca domain close')
    this.state = domain.global.get()
    this.persist = state => domain.global.set(state)
    await this.core.prepare().catch((error: unknown) => {
      this.ctx.logger.warn(`trading-alpaca: setup deferred: ${(error as Error).message}`)
    })
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
  /** @param listener - receives updates. @returns a disposer. */
  subscribeOrderUpdates(listener: (update: OrderUpdate) => void): () => void { return this.core.subscribeOrderUpdates(listener) }
}

async function resolveCredential(ctx: Context, name: string): Promise<string | undefined> {
  const ref = credentialRef(name)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(ref))?.value
  return launchEnvironmentOf(ctx).get(ref)?.value
}

export default AlpacaVenue
```

Check `launchEnvironmentOf(...).get(name)` returns `{ value }` as in `llm-deepseek`, and the storage-domain `tables: {}` form; if the domain requires a table, add `tables: { state: domainTable<'desk', SafetyState>(schema) }` and key the record `'desk'`.

- [ ] **Step 5: Real-composition and HMR test**

`packages/experimental/trading-alpaca/tests/composition.spec.ts` — copy the Loader boot from `packages/llm/llm-pi-ai/tests/loader-composition.spec.ts` (temp `cordis.yml`, `ctx.plugin(Loader)`, `ctx.loader.builtins.include = Include`, `ctx.loader.internal = { version: 'v2', import: specifier => modules.get(specifier) }`, `ctx.loader.create({ name: 'cordis:include', config: { path } })`, `ctx.loader.await()`), and compose: the storage service with its memory or temp-directory backend and `storage-domain` (copy the rows from `packages/bundle/base/cordis.patch.yml:141-156`, pointing any directory at a `mkdtemp` folder), a credentials provider (or launch environment) carrying `ALPACA_API_KEY=k` and `ALPACA_SECRET_KEY=s`, and `trading-alpaca` with `tradingUrl`, `dataUrl`, and `tradeStreamUrl` pointing at a `FakeAlpaca` (with `accountConfig(fake, { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false })`). Assertions:

```ts
expect(ctx.get('tradingVenue')?.status()).toBe('ready')
expect(config).toMatchObject({ no_shorting: true, max_margin_multiplier: '1' })
await ctx.get('tradingVenue')?.halt('test halt')
// dispose the loaded fiber (HMR), then boot the same composition again against the same storage folder:
expect(ctx2.get('tradingVenue')?.status()).toBe('halted')
// after dispose, the service is gone:
expect(ctx.get('tradingVenue')).toBeUndefined()
```

This one spec is both the real-composition test and the HMR disposal test required by `packages/AGENTS.md`.

- [ ] **Step 6: Egress test**

`packages/experimental/trading-alpaca/tests/egress.spec.ts` — copy `packages/web/web-search-exa/tests/egress.spec.ts`'s fake proxy and `observe()` helper. Assert that `new AlpacaHttp({ tradingUrl: 'http://alpaca-probe.invalid', ... }).request('trading', 'GET', '/v2/account')` records `REQ http://alpaca-probe.invalid/v2/account`, and that a `TradeUpdateStream` with `url: 'wss://alpaca-probe.invalid/stream'` records `CONNECT alpaca-probe.invalid:443`. If the WebSocket assertion fails because Node's global WebSocket ignores the proxy dispatcher, keep the HTTP assertion, mark the WebSocket case `it.fails` with a comment naming the limitation, add it to the README's Known Limitations, and ledger the ruling.

- [ ] **Step 7: Run all package tests with coverage and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca packages/experimental/trading-venue --coverage --coverage.include='packages/experimental/trading-{alpaca,venue}/src/**'`
Expected: PASS; 100% per file. `index.ts`'s credential branches (credentials service present vs absent → launch environment) are reached by running the composition spec twice: once with a credentials provider and once with only launch-environment variables.

```bash
git add packages/experimental/trading-alpaca
git commit -m "feat(trading-alpaca): provide ctx.tradingVenue with setup, halt persistence, and drift checks"
```

---

### Task 10: Documentation, catalogs, and repository gates

**Files:**
- Create: `packages/experimental/trading-venue/README.md`, `README.zh.md`, `README.i18n.yaml`
- Create: `packages/experimental/trading-alpaca/README.md`, `README.zh.md`, `README.i18n.yaml`
- Modify: `packages/experimental/README.md`, `README.zh.md`, `README.i18n.yaml` (two rows), `docs/config-catalog.md`, `docs/config-catalog.zh.md`, `docs/config-catalog.i18n.yaml`, `scripts/verify-package-readme-model-experience.ts` (if a no-section entry is needed), subsystem page or exemption per `scripts/verify-subsystem-pages.ts` if the gate asks for one

**Interfaces:** none.

- [ ] **Step 1: Write both READMEs (English)**

Use `packages/experimental/trading/README.md` as the structural template (`kind: "package-reference"`, Summary, Table of Contents, Use this package, Understand the implementation with a Source map, Further Exploration, Known Limitations and Deferred Work, Dev Note). Required content:

- `trading-venue`: Summary of the Service Definition and its consumers; the full method list with one line each; `VenueError` codes table (`unconfigured`, `auth`, `blocked`, `halted`, `rejected`, `not-found`, `rate-limited`, `unavailable`, `unknown-outcome`) with when each occurs; the `trading/venue-status` event; source-map line stating no invariant companion is published because the definition owns no event stream or mutable state.
- `trading-alpaca`: configuration table (every `Config` field, default, meaning), how keys resolve (credentials service, else launch environment; `ALPACA_API_KEY` / `ALPACA_SECRET_KEY`), paper vs live (`DSH_TRADING_LIVE=1`), the status machine, account safety (settings applied, drift interval, Halt persistence, flatten window and crash recovery), submission idempotency, the trade-updates stream, and a source map of every `src` file; invariant companion omitted because every observable relation is checked at the operation that makes it.
- Known Limitations for `trading-alpaca`: sub-dollar equities use a one-cent tick; market-data WebSocket arrives with Plan 4; an agent holding the keys can change account settings (detected within one drift interval, not prevented); the WebSocket-through-proxy result from Task 9 Step 6.
- Model Experience: none of these packages renders model input directly; add `NO_MODEL_EXPERIENCE_SECTION` entries `'packages/experimental/trading-venue': 'The package only defines the venue service contract; tool-trading owns every model-facing rendering.'` and `'packages/experimental/trading-alpaca': 'The package only talks to Alpaca; tool-trading owns every model-facing rendering.'`.

- [ ] **Step 2: Chinese READMEs, group rows, catalogs, pairs**

Mirror each README in `README.zh.md` section for section (language line `[English](README.md) | 中文`, same anchors, code blocks, and table rows; terminology from `docs/i18n/terminology.md`). Add rows to `packages/experimental/README.md` and `.zh.md` before `tool-agent-team`:

```markdown
| [`trading-alpaca`](trading-alpaca/README.md) | Alpaca provider for the trading venue: paper and live trading, account safety, order updates | provides `ctx.tradingVenue` |
| [`trading-venue`](trading-venue/README.md) | Service Definition for a trading venue | `ctx.tradingVenue` |
```

```markdown
| [`trading-alpaca`](trading-alpaca/README.zh.md) | 交易场所的 Alpaca 提供方：模拟盘与实盘交易、账户安全、订单更新 | 提供 `ctx.tradingVenue` |
| [`trading-venue`](trading-venue/README.zh.md) | 交易场所的 Service Definition | `ctx.tradingVenue` |
```

Run `pnpm run gen-config-catalog`, mirror each new line in `docs/config-catalog.zh.md` beside its English neighbor (copy the neighbor line's format), then:

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && for f in packages/experimental/trading-venue/README.md packages/experimental/trading-alpaca/README.md packages/experimental/README.md docs/config-catalog.md; do pnpm run verify-translation-pairing --write $f; done`
Expected: four records written.

- [ ] **Step 3: Run the gates**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run constraints && pnpm run typecheck && pnpm run lint && pnpm run doc-sync && pnpm run build && pnpm run hygiene`
Expected: all exit 0. Fix what a gate names and re-run only that gate.

- [ ] **Step 4: Commit**

```bash
git add packages/experimental/trading-venue packages/experimental/trading-alpaca packages/experimental/README.md packages/experimental/README.zh.md packages/experimental/README.i18n.yaml docs/config-catalog.md docs/config-catalog.zh.md docs/config-catalog.i18n.yaml scripts
git commit -m "docs(trading-alpaca): document the trading venue and its Alpaca provider"
```

---

### Task 11: Opt-in Alpaca paper e2e

**Files:**
- Create: `packages/experimental/trading-alpaca/tests/alpaca-paper.e2e.ts`

**Interfaces:**
- Consumes: `AlpacaHttp`, `VenueCore`, `INITIAL_SAFETY_STATE`.

- [ ] **Step 1: Write the e2e test**

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientOrderId } from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { INITIAL_SAFETY_STATE, type SafetyState } from '../src/safety.ts'
import { VenueCore } from '../src/venue.ts'

const keyId = process.env.ALPACA_API_KEY
const secret = process.env.ALPACA_SECRET_KEY

describe.skipIf(keyId === undefined || secret === undefined)('Alpaca paper', () => {
  it('sets account safety, places a far-from-market crypto limit order idempotently, sees it open, and cancels it', async () => {
    let saved: SafetyState = INITIAL_SAFETY_STATE
    const http = new AlpacaHttp({ tradingUrl: 'https://paper-api.alpaca.markets', dataUrl: 'https://data.alpaca.markets',
      timeoutMs: 15_000, retryDelaysMs: [1_000, 2_000], keys: async () => ({ keyId: keyId ?? '', secret: secret ?? '' }) })
    const venue = new VenueCore({ http, feed: 'iex', now: () => Date.now(), keysPresent: async () => true,
      store: { get: () => saved, set: async s => { saved = s } },
      stream: () => ({ start: () => {}, stop: () => {} }), emitStatus: () => {} })
    await venue.prepare()
    expect(venue.status()).toBe('ready')
    const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
    const quote = await venue.latestQuote(btc)
    const clientOrderId = brandString<ClientOrderId>(`dsh-e2e-${String(Date.now())}`)
    const request = { symbol: btc, side: 'buy', qty: 0.0001, type: 'limit', limitPrice: Math.floor(quote.bid * 0.5),
      timeInForce: 'gtc', clientOrderId } as const
    const first = await venue.submitOrder(request)
    const again = await venue.submitOrder(request)
    expect(again.id).toBe(first.id)
    expect((await venue.openOrders()).some(o => o.id === first.id)).toBe(true)
    await venue.cancelOrder(first.id)
  }, 60_000)
})
```

- [ ] **Step 2: Verify it skips without keys and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && env -u ALPACA_API_KEY -u ALPACA_SECRET_KEY pnpm exec vitest run --config vitest.e2e.config.ts packages/experimental/trading-alpaca`
Expected: 1 skipped, 0 failed. (With paper keys exported it runs against Alpaca paper; that run is the user's to make.)

```bash
git add packages/experimental/trading-alpaca/tests/alpaca-paper.e2e.ts
git commit -m "test(trading-alpaca): add an opt-in Alpaca paper e2e"
```
