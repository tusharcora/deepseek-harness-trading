# Order Executor, Trading Tools, and Trading Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app `trader` agent analyze markets and trade end to end on an Alpaca paper account through the generic approval UI, with every limit enforced by an executor service that the Plan 5 MCP endpoint will also call.

**Architecture:** `tool-trading` default-exports `TradingExecutor`, a host-plane Cordis service at `ctx.tradingExecutor` that owns the only broker path the tools offer: proposal ids, a per-account lock held for two short sections, reservations in an in-memory `ProposalBook`, a `tools/pre-execute` listener (steps 1–4), a Halt guard (`ctx.tools.guard`), a fail-closed `execute()` (steps 5–8), a durable journal in the storage service, and fill delivery from the venue's order stream (journal, `trading/fill` session event, injection into the proposing session's agent). Its `./tools` subpath is a function plugin that registers the seven model-facing tools; only the `trader` agent preset mounts it. `bundle-trading` is the profile bundle: a `cordis.patch.yml` layered over `base` + `web-app` and the `trader` preset (`agent.cordis.yml`) whose agent sees exactly nine tools.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Cordis services and function plugins, schemastery `Config`, zod (storage-domain schema), `node:crypto`, Vitest, Playwright-free web scaffold for the recorded-session snapshot, `ws` (snapshot fake broker only).

**Spec:** `.agents/notes/proposed/feature/2026-10-05-trading-desk.md` (binding). Roadmap: [00-roadmap.md](00-roadmap.md). Plan 2 (done): [02-alpaca-venue.md](02-alpaca-venue.md), ledger [02-alpaca-venue-ledger.md](02-alpaca-venue-ledger.md).

## Global Constraints

- Node `^22.19 || >=24`; on this machine prefix every command with `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH &&`. The pre-commit and pre-push hooks also need it.
- npm names `@deepseek-ai/dsh-experimental-tool-trading` and `@deepseek-ai/dsh-experimental-bundle-trading`; omit `private`; `publishConfig.access: "public"`; `version` = root `package.json` version (`0.1.6-alpha.1` at the time of writing — re-read it); `@deepseek-ai/cordis` in `peerDependencies` and `devDependencies`; every dsh peer mirrored in `devDependencies`.
- Register each package in `tsconfig.host.json` `references` beside the other `./packages/experimental/*` entries and regenerate `tsconfig.base.json` `paths` with `pnpm run gen-tsconfig-paths` (it emits subpath entries such as `/tools`).
- Service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export (`packages/AGENTS.md`). `tool-trading`'s root is a service package; its `./tools` subpath is a separate function-plugin module (precedent: `@deepseek-ai/dsh-tool-subagent-control/list-agents`).
- Optional services through `ctx.get(name)` (`approval`); declared injections through `ctx.<name>` (`tradingVenue`, `tools`, `storageDomain`, `sessions`, `agents`).
- No `!` non-null assertions in `src`; lines ≤ 140 columns; `src/types.ts` holds types and `declare module` merges only; every export has JSDoc with `@param`/`@returns`.
- No new synchronous Session history reads in `src` (`eventAt`, `snapshotEvents`, `ownEvents` are deprecated outside tests — `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`). The executor keeps its own projection by observing `session/event`.
- Per-file 100% coverage on `src`. Mock only the broker (network) and the clock; keep tools, approval, sessions, agents, and storage real.
- New package READMEs are **English only**: no `README.zh.md` or `README.i18n.yaml`; add each README path to `excluded` in `scripts/translation-pairing.manifest.json` (as Plan 2 did for `trading-venue` and `trading-alpaca`). Existing bilingual files (`packages/experimental/README.md`, `docs/subsystems/trading.md`, `docs/config-catalog.md`, persistence-change records) keep their mirrored Chinese lines and re-recorded pairs.
- Every order and cancellation asks the user; the trading tools never auto-approve. `client_order_id` = SHA-256 hex of `` `${sessionId}:${proposalId}` `` (64 characters, `node:crypto`, computed only in `tool-trading`).
- Model-facing text (tool descriptions, results, denials, the approval reason) speaks the model's language and carries no transport or UI vocabulary; pin it verbatim in tests.
- Commit messages: conventional commits, no Co-Authored-By trailer, and no Claude/AI attribution of any kind.
- Implementers may adapt repository glue (import paths, Cordis/schemastery call forms, storage-domain shapes, test harness calls, generator registrations) and ledger the change. They must not weaken a safety test in Tasks 7–10 (approval, fail-closed body, Halt guard, re-check, unknown outcome, reservations); if one does not fit, stop and report BLOCKED.

## Review Focus

1. **An approval for one call must never release another call's order.** Two `place_order` calls in one turn, the first rejected and the second approved, must submit only the second call's order with the second call's arguments; a call whose proposal event was never logged must fail closed even when an approval for its call id exists. Pinned in Task 8 (`submits only the call that was approved, with that call's arguments`) and Task 4 (`approves only a logged proposal that was asked about through its own call`).
2. **The market moves, or a limit starts failing, while the approval card is open.** Submission re-snapshots under the lock and denies with "price moved; propose again" past the tolerance or on any failing limit, and reads reduce-only from that re-check. Pinned in Task 7.
3. **Halt clicked while an approval is pending.** The guard runs after the ask resolves, so the approved call is still denied and nothing reaches the venue; the reservation is released and the journal says why. Pinned in Task 8.
4. **The desk restarts, or the order stream silently dies, with orders in flight.** Startup, timer, and gap reconciliation look orders up by client order id, record each fill exactly once, and mark an order the broker never received as not placed instead of retrying it. Pinned in Task 9.
5. **Hostile or malformed model arguments** (string numbers, `NaN`, both `qty` and `notional`, sub-tick prices, a symbol like `../../x`, an `order_id` that is not an open order, a 5 KB rationale) are refused as tool errors before any broker write. Pinned in Tasks 3 and 8.

## Plan 2 ledger items carried into this plan

| Ledger item | Where it is handled |
|---|---|
| Task 6: duplicate client order id + absent lookup reports `rejected` with broker code 40010001 — "Plan 3 must not read that as not placed" | Task 7: `failureOf` maps it to outcome `unknown` with "check list_orders before proposing again" |
| Task 8: stop() then start() emits no gap — a new subscriber must read state itself | Task 9: the executor reconciles right after subscribing at init |
| Task 8: no dead-connection detection; non-JSON frame reports an error without a gap | Task 9: timer reconciliation (`reconcileMs`, default 60 s) |
| Task 4: non-JSON error body becomes an unbounded message shown to the model | Task 7: `bounded()` caps every venue message at 300 characters |
| Task 10: `tradingVenue` seam has no consumer until tool-trading lands | Task 13: `gen-doc-graphs` lists `experimental-tool-trading` as the consumer |
| Final ruling: Halt re-saves on startup from broker `suspend_trade` | No executor work: every order path reads the venue's derived `status()`; noted in the tool-trading README |
| Task 9: keys added later do not re-run setup until a call (deferred → Plan 4) | Deferred to Plan 4. Plan 3 only makes the first executor call (`asset()` / `openOrders()`) trigger the venue's own retry, by not denying `unconfigured` before calling the venue |
| Task 2: `BrokerOrderRequest` qty/notional exclusivity only by comment | Task 7: `brokerRequest()` copies exactly the one size the validated order carries |
| Task 2: `resume()` behavior; VenueStatus cannot show a pending suspension | No tool resumes trading (spec). Deferred to Plan 4 (panel) |
| Roadmap: re-read open orders and positions on a timer and on gaps; gate on derived `status()` | Tasks 7 and 9. The executor caches no positions: every check re-reads them inside the lock, so the timer re-reads open orders and in-flight journal orders only |
| Roadmap (Plan 1 review): reject non-finite/non-positive approved price and a cap rounding to 0 before `planSubmission`; tick check; `RiskLimits` Config fields reject negative/non-finite; `reduceOnly` from the post-approval re-check | Tasks 2 (`validateConfig`), 3 (`tickViolations`), 6 (`planOrder`), 7 (re-check) |
| Roadmap (paper runs): crypto exit within ~1 s of a fill rejected "insufficient balance"; $10 crypto minimum | Task 7 (`exitRetryMs`); the minimum is already on the venue's `Asset.minNotional` and enforced by `validateOrder` |
| Remaining Plan 2 minors (fake-alpaca robustness, Config fractions, stream ping, sub-dollar equity tick, live-mode loopback test) | Not consumer-facing; stay deferred in the Plan 2 ledger |

## Rulings made while writing this plan

- **Ruling: approval decision lookup.** The tool body cannot scan history (deprecated reads). The executor observes `session/event` (post-commit feed, `packages/core/session/src/index.ts:72`) and folds `trading/proposal`, `approval/asked` (`{ id, toolName, callId? }`) and `approval/decided` (`{ id, outcome }`) (`packages/interaction/user-approval/src/types.ts`) into its `ProposalBook`. A proposal becomes submittable only after its own `trading/proposal` event was observed **and** an `allowed-once` decision arrived for an `approval/asked` carrying its call id. The book is in memory: after a restart a pending call is aborted by the loop anyway, so losing it fails closed. Evidence: `ToolRuntime.serviceAsk` (`packages/core/tools/src/index.ts:1699-1738`) calls `approval.request({ agent, toolName, callId, reason, signal })`, which appends the audit pair.
- **Ruling: approval policy read.** `ApprovalService.effectivePolicy` is private; the executor computes `approval.overrideOf(session) ?? approval.config.policy ?? 'ask'` from the two public members (`packages/interaction/user-approval/src/index.ts:148,245`). `DSH_PERMISSION_MODE=danger-full-access` selects a permission preset whose approval knob is `never` (`packages/interaction/permission-presets/src/index.ts`), which this read returns.
- **Ruling: listener placement.** The `tools/pre-execute` listener and the guard live in the host-plane executor service, so they cover every agent and survive preset remounts. The listener calls `next()` first and returns a downstream `deny`/`cancel` unchanged; a listener prepended ahead of it that answers without delegating makes the body fail closed.
- **Ruling: in-app concurrency.** The agent loop runs `prepare` (pre-execute + ask) one call at a time (`packages/core/agent-loop/src/tool-calls.ts:166-200`) and `place_order`/`cancel_order` declare no `isConcurrencySafe`, so in-app calls in one message are checked one after another; reservations still make concurrent `proposeOrder` calls (the Plan 5 MCP path) see each other. Task 7 pins the concurrent case at the executor API; Task 8 pins the in-app sequence.
- **Ruling: venue additions.** The executor needs the account mode for the proposal and a lookup by client order id for reconciliation; neither exists on `TradingVenueGateway`. Task 1 adds `mode()` and `order(clientOrderId)` (Alpaca: `orderByClientId` in `packages/experimental/trading-alpaca/src/orders.ts:67`) — "design Service Definitions for all current Consumers".
- **Ruling: stale-quote detail.** `checkRisk` prints the quote age in the `stale-quote` detail even when the check passes, which makes the approval reason and the recorded session time-dependent. Task 1 changes only that detail text (pass: `quote is at most 30 s old`; not applicable: `limit orders do not need a fresh quote` / `market closed; the quote age is not checked`; fail: `quote is 45 s old (max 30 s)`).
- **Ruling: no client order id in session events or model text.** Snapshot redaction tokenizes UUID-like values under `*Id` keys (`packages/test-support/session-snapshot/src/identity.ts`), so `proposalId` (`p-<uuid>`) is stable in fixtures but the SHA-256 client order id is not. The client order id lives only in the journal and the broker request.
- **Ruling: tool output schemas.** Tool outputs use `{ type: 'json' }` (precedent: `packages/mcp/mcp-resources/src/tools.ts:20-23`); typed output schemas wait for the Plan 4 tool views that consume them. The `trader` preset composes no PTC runtime.
- **Ruling: "today".** `ordersToday` and `list_orders` "today" use the America/New_York calendar date (Alpaca's trading day) and count this desk's journaled orders plus pending proposals; orders placed outside the desk are not counted (the broker's daily-loss check still uses `last_equity`).
- **Ruling: open market buys with no price.** `committedBuyNotional` counts open buy orders at their notional, else remaining quantity × limit (or stop) price; an open market buy without either (an equity order queued while the market is closed) counts as 0. The broker's cash check (margin multiplier 1) still applies.
- **Ruling: bars warm-up.** `get_bars` fetches `limit + 60` bars so MACD(12,26,9) and Bollinger(20) have values for the shown window, and returns only the last `limit`.
- **Ruling: preset root path.** `agent-presets` resolves a root with `resolve(expandHomePath(path))` (`packages/preset/agent-presets/src/discovery.ts:285`), so the patch must give an absolute path. Loader `!!js` expressions evaluate `with (ctx)` (`vendor/loader/src/config/utils.ts:5-9`) and see `baseUrl` (the profile directory, `apps/web/tests/scaffold.ts:706-708`; precedent `packages/preset/agent-presets/presets/cordis/agent.cordis.yml:267`). The root is `dirname(createRequire(baseUrl).resolve('@deepseek-ai/dsh-experimental-bundle-trading/package.json')) + '/presets'`: `dsh plugin --profile trading add` installs the bundle under the profile's `node_modules`, and the web scaffold links install anchors there the same way.
- **Ruling: unknown saved default.** `AgentPresets.resolve()` already throws `agent-presets: preset "<id>" not found (available: <ids>)` when the settings document's `agent-presets.default` names a preset no root supplies (`packages/preset/agent-presets/src/index.ts:372-384`), and `settings.yaml` is shared by every profile under `$DSH_HOME`. "Fails at load" is the session-load failure; Task 12 pins it with a real settings document. Changing `agent-presets` to validate at boot is out of scope.
- **Ruling: the Halt guard is permanent.** The spec says "Halt registers a `ctx.tools.guard()`". The executor registers one guard for its lifetime that denies `place_order`/`cancel_order` whenever the venue's derived `status()` is `halted`; registering and disposing a guard on each Halt would need a cached status copy (which the Plan 2 review forbids) and a `trading/venue-status` race. The observable behavior — deny-only, after every pre-execute listener, while halted — is the same.
- **Ruling: `ui-cordis`.** The spec disables the cordis Host and Client runners; the patch also disables `ui-cordis`, the browser view that needs the client runner (`packages/bundle/web-app/cordis.patch.yml:274`).
- **Ruling: keys message.** The venue already throws `Alpaca keys not configured — add them in Settings → Trading` (`packages/experimental/trading-alpaca/src/index.ts`); the Settings → Trading card arrives in Plan 4, so in Plan 3 keys go into `$DSH_HOME/.credentials.yaml` (README says so).

## File structure

```text
packages/experimental/trading/src/types.ts            (+ TradingMode)
packages/experimental/trading/src/risk.ts             (stale-quote detail)
packages/experimental/trading-venue/src/index.ts      (+ mode(), order())
packages/experimental/trading-alpaca/src/{venue,index}.ts (+ mode(), order())
packages/experimental/tool-trading/
  package.json, tsconfig.json, README.md
  src/types.ts       events, journal entry, reports, executor API types
  src/config.ts      Config schema, validateConfig, riskLimitsOf
  src/ids.ts         mintProposalId, clientOrderIdFor, tradingDay
  src/lock.ts        AccountLock (one async section at a time)
  src/order-args.ts  parse place_order / cancel_order arguments, tick check
  src/book.ts        ProposalBook: reservations, states, call and approval links
  src/journal.ts     trading_journal storage domain + Journal
  src/snapshot.ts    takeSnapshot, open-order exposure, planOrder, drifted, brokerRequest
  src/bars.ts        get_bars report and rendering
  src/format.ts      model-facing texts, summaries, renderers, failureOf
  src/executor.ts    TradingExecutor service
  src/index.ts       package root: default export TradingExecutor
  src/tools.ts       ./tools function plugin: the seven tools
  tests/fake-venue.ts, tests/harness.ts, tests/*.spec.ts, tests/executor-paper.e2e.ts
packages/experimental/bundle-trading/
  package.json, tsconfig.json, README.md, cordis.patch.yml, src/index.ts
  presets/trader/agent.cordis.yml, presets/trader/preset.yml
  tests/profile.spec.ts
apps/web/tests/trading-desk.snapshot.ts, apps/web/tests/trading-fake-broker.ts
snapshots/web/trading-desk/{snapshot.yml,session.v3.jsonl,system-prompt.expected.md,tool-schemas.expected.json}
```

## Pre-flight: gates each task runs before its commit

Every task ends with the package tests it owns plus these, in order; a gate that names a file is fixed and re-run alone:

1. `pnpm exec vitest run <the task's spec files> --coverage --coverage.include='<the task's src files>'` → every listed file at 100%.
2. `pnpm exec tsc -b packages/experimental/tool-trading` (and `bundle-trading` from Task 11) → exit 0.
3. `pnpm run lint` → exit 0 (140-column limit, no `!`).
4. From Task 2 on, after any change to exports, Config, events, or services: `pnpm run gen-tsconfig-paths`, `pnpm run gen-cordis-catalog`, `pnpm run gen-cordis-inspect-catalog`, `pnpm run gen-config-catalog`, `pnpm run gen-persistence-catalog`, `pnpm run gen-doc-graphs`, `pnpm run gen-tool-catalog`, `pnpm run gen-dependency-catalog` — commit the regenerated files with the task. Task 13 adds the prose and the final `pnpm run doc-sync`.
5. `git status` shows only the task's files and regenerated catalogs.

---
### Task 1: Venue mode and order lookup; time-free stale-quote detail

**Files:**
- Modify: `packages/experimental/trading/src/types.ts` (add `TradingMode`)
- Modify: `packages/experimental/trading/src/risk.ts` (stale-quote detail only)
- Modify: `packages/experimental/trading/tests/risk.spec.ts`
- Modify: `packages/experimental/trading-venue/src/index.ts` (two abstract methods)
- Modify: `packages/experimental/trading-venue/tests/venue.spec.ts` (FakeVenue gains them)
- Modify: `packages/experimental/trading-alpaca/src/venue.ts` (`VenueCore.order`)
- Modify: `packages/experimental/trading-alpaca/src/index.ts` (`AlpacaVenue.mode`, `AlpacaVenue.order`)
- Modify: `packages/experimental/trading-alpaca/tests/venue.spec.ts`, `packages/experimental/trading-alpaca/tests/composition.spec.ts`
- Modify: `packages/experimental/trading-venue/README.md`, `packages/experimental/trading-alpaca/README.md` (method list lines)
- Regenerate: `docs/subsystems/trading.md`, `docs/subsystems/trading.zh.md` (`pnpm run gen-cordis-catalog`), the tool-cordis api catalog (`pnpm run gen-cordis-inspect-catalog`)

**Interfaces:**
- Produces: `type TradingMode = 'paper' | 'live'` (exported from `@deepseek-ai/dsh-experimental-trading`); `TradingVenueGateway.mode(): TradingMode`; `TradingVenueGateway.order(clientOrderId: ClientOrderId): Promise<BrokerOrder | undefined>`; `stale-quote` check details `quote is at most N s old` / `quote is A s old (max N s)` / `quote time is unknown` / `<type> orders do not need a fresh quote` / `market closed; the quote age is not checked`.

- [ ] **Step 1: Write the failing risk test**

Append to the `describe('checkRisk, exposure-increasing orders', …)` block in `packages/experimental/trading/tests/risk.spec.ts`:

```ts
  it('describes the quote-age check without the clock when it passes or does not apply', () => {
    const detail = (order: OrderRequest, snap: RiskSnapshot = snapshot): string | undefined =>
      checkRisk(order, snap, limits).checks.find(c => c.id === 'stale-quote')?.detail
    expect(detail(buy)).toBe('quote is at most 30 s old')
    expect(detail(buy, { ...snapshot, quote: { ...snapshot.quote, t: 900_000 } })).toBe('quote is 100 s old (max 30 s)')
    expect(detail({ ...buy, type: 'limit', limitPrice: 62_000 })).toBe('limit orders do not need a fresh quote')
    expect(detail(buy, { ...snapshot, marketOpen: false })).toBe('market closed; the quote age is not checked')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/risk.spec.ts`
Expected: FAIL — `expected 'quote is 2 s old' to be 'quote is at most 30 s old'`.

- [ ] **Step 3: Change the detail and add `TradingMode`**

In `packages/experimental/trading/src/risk.ts`, replace the three `stale-quote` lines (`const age …`, `const stale …`, `add('stale-quote', …)`) with:

```ts
    const age = snapshot.now - snapshot.quote.t
    const timed = order.type === 'market' && snapshot.marketOpen
    const stale = timed && !(age <= limits.staleQuoteMs)
    const window = `${Math.round(limits.staleQuoteMs / 1000)} s`
    const ageDetail = !Number.isFinite(age)
      ? 'quote time is unknown'
      : stale ? `quote is ${Math.round(age / 1000)} s old (max ${window})` : `quote is at most ${window} old`
    const staleDetail = order.type !== 'market'
      ? `${order.type} orders do not need a fresh quote`
      : snapshot.marketOpen ? ageDetail : 'market closed; the quote age is not checked'
    add('stale-quote', !stale, staleDetail)
```

In `packages/experimental/trading/src/types.ts`, after the `VenueStatus` type, add:

```ts
/** Which account a venue trades in: `paper` moves no money, `live` does. */
export type TradingMode = 'paper' | 'live'
```

- [ ] **Step 4: Run the trading tests**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading --coverage --coverage.include='packages/experimental/trading/src/risk.ts'`
Expected: PASS; `risk.ts` 100% statements, branches, functions, lines.

- [ ] **Step 5: Add the two venue methods to the Service Definition**

In `packages/experimental/trading-venue/src/index.ts`, add `ClientOrderId` and `TradingMode` to the type import from `@deepseek-ai/dsh-experimental-trading`, then insert after `abstract status(): VenueStatus`:

```ts
  /**
   * Account mode this venue trades in, from provider configuration.
   * @returns `paper` or `live`.
   */
  abstract mode(): TradingMode
```

and after `abstract openOrders(): Promise<BrokerOrder[]>`:

```ts
  /**
   * Look up one order by the idempotency key it was submitted with, whether it is still open or not.
   * @param clientOrderId - idempotency key the order was submitted with.
   * @returns the order, or undefined when the broker has no order with that key.
   */
  abstract order(clientOrderId: ClientOrderId): Promise<BrokerOrder | undefined>
```

In `packages/experimental/trading-venue/tests/venue.spec.ts`, add `TradingMode` to the type import and these two members to `FakeVenue`:

```ts
  mode(): TradingMode { return 'paper' }
  async order(): Promise<BrokerOrder | undefined> { return undefined }
```

- [ ] **Step 6: Write the failing Alpaca tests**

In `packages/experimental/trading-alpaca/tests/venue.spec.ts`, inside `describe('VenueCore reads', …)`, add:

```ts
  it('looks up an order by client order id and reports none for an unknown id', async () => {
    accountConfig(fake, safe)
    fake.on('GET', '/v2/orders:by_client_order_id', r => r.query.get('client_order_id') === 'c-1'
      ? { status: 200, body: order }
      : { status: 404, body: { message: 'order not found' } })
    const { venue } = core()
    expect((await venue.order(brandString<ClientOrderId>('c-1')))?.id).toBe('o-1')
    expect(await venue.order(brandString<ClientOrderId>('c-2'))).toBeUndefined()
  })
```

In `packages/experimental/trading-alpaca/tests/composition.spec.ts`, in the first test, add `fake.on('GET', '/v2/orders:by_client_order_id', () => ({ status: 200, body: order }))` beside the other routes and, after `expect(await venue.openOrders()).toEqual([])`:

```ts
    expect(venue.mode()).toBe('paper')
    expect((await venue.order(brandString<ClientOrderId>('c-1')))?.id).toBe('o-1')
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca/tests/venue.spec.ts packages/experimental/trading-alpaca/tests/composition.spec.ts`
Expected: FAIL — `venue.order is not a function` (and a TypeScript error in the editor for `mode`).

- [ ] **Step 7: Implement in `trading-alpaca`**

In `packages/experimental/trading-alpaca/src/venue.ts`, add `ClientOrderId` to the type import and add to `VenueCore` after `openOrders()`:

```ts
  /**
   * Look up one order by client order id once setup has run.
   * @param clientOrderId - idempotency key.
   * @returns the order, or undefined when Alpaca has none with that key.
   */
  async order(clientOrderId: ClientOrderId): Promise<BrokerOrder | undefined> {
    await this.readable()
    return orders.orderByClientId(this.deps.http, clientOrderId)
  }
```

In `packages/experimental/trading-alpaca/src/index.ts`, add `ClientOrderId` and `TradingMode` to the type import, add a field `private readonly accountMode: TradingMode`, set `this.accountMode = config.mode` as the first statement after `super(ctx)`, and add beside `status()`:

```ts
  /** @returns the configured account mode. */
  mode(): TradingMode { return this.accountMode }
```

and beside `openOrders()`:

```ts
  /** @param clientOrderId - idempotency key. @returns the order, or undefined when Alpaca has none. */
  order(clientOrderId: ClientOrderId): Promise<BrokerOrder | undefined> { return this.core.order(clientOrderId) }
```

- [ ] **Step 8: Run the venue packages with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading-alpaca packages/experimental/trading-venue --coverage --coverage.include='packages/experimental/trading-{alpaca,venue}/src/**'`
Expected: PASS; every listed file 100%.

- [ ] **Step 9: README lines and regenerated catalogs**

In `packages/experimental/trading-venue/README.md`, add to the method list after `status()`: "`mode()` — `paper` or `live`, from the provider's configuration." and after `openOrders()`: "`order(clientOrderId)` — one order by its idempotency key, open or not; `undefined` when the broker has none." In `packages/experimental/trading-alpaca/README.md`, add to the operations list: "`order(clientOrderId)` reads `GET /v2/orders:by_client_order_id`; a 404 is `undefined`." Then:

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run gen-cordis-catalog && pnpm run gen-cordis-inspect-catalog && pnpm exec tsc -b packages/experimental/trading-alpaca && pnpm run lint`
Expected: the generators rewrite `docs/subsystems/trading.md`, `docs/subsystems/trading.zh.md`, and the tool-cordis api catalog; `tsc` and lint exit 0.

- [ ] **Step 10: Commit**

```bash
git add packages/experimental/trading packages/experimental/trading-venue packages/experimental/trading-alpaca docs/subsystems/trading.md docs/subsystems/trading.zh.md packages/extensions/tool-cordis
git commit -m "feat(trading-venue): add account mode and order lookup by client order id"
```

---

### Task 2: `tool-trading` scaffold — types, Config, ids, lock

**Files:**
- Create: `packages/experimental/tool-trading/package.json`, `packages/experimental/tool-trading/tsconfig.json`
- Create: `packages/experimental/tool-trading/src/types.ts`, `src/config.ts`, `src/ids.ts`, `src/lock.ts`, `src/index.ts` (interim root; Task 7 replaces it)
- Create: `packages/experimental/tool-trading/tests/config.spec.ts`, `tests/ids.spec.ts`, `tests/lock.spec.ts`
- Modify: `tsconfig.host.json` (reference), `tsconfig.base.json` (regenerated paths), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `TradingMode` (Task 1); domain types from `@deepseek-ai/dsh-experimental-trading`.
- Produces (later tasks rely on these exact names):
  - `types.ts`: `ProposalSource`, `ProposalQuote`, `TradingOrderProposal`, `TradingCancelProposal`, `TradingProposal`, `TradingOrderEvent`, `TradingFillEvent`, `JournalStatus`, `JournalEntry`, `ProposalContext`, `ProposeResult`, `QuoteReport`, `AccountReport`, `PositionReport`, `OrderRow`, `JournalRow`, `OrdersReport`, `OrderReport`, `BarsRequest`, `BarsReport`, `IndicatorName`, and `SessionEventMap` members `trading/proposal`, `trading/order`, `trading/fill`.
  - `config.ts`: `interface Config`, `const Config: z<Partial<Config>, Config>`, `validateConfig(config: Config): Config`, `riskLimitsOf(config: Config): RiskLimits`.
  - `ids.ts`: `mintProposalId(): ProposalId`, `clientOrderIdFor(sessionId: SessionId, proposalId: ProposalId): ClientOrderId`, `tradingDay(t: number): string`.
  - `lock.ts`: `class AccountLock { run<T>(section: () => Promise<T>): Promise<T> }`.

- [ ] **Step 1: Package manifest and tsconfig**

`packages/experimental/tool-trading/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-experimental-tool-trading",
  "description": "Trading order executor at ctx.tradingExecutor and the seven model-facing trading tools",
  "version": "0.1.6-alpha.1",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/experimental/tool-trading"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/dsh-brand": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading": "workspace:^",
    "@deepseek-ai/dsh-util-values": "workspace:^",
    "@deepseek-ai/schemastery": "workspace:^",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-venue": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^",
    "@deepseek-ai/dsh-user-approval": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/cordis-plugin-include": "workspace:^",
    "@deepseek-ai/cordis-plugin-loader": "workspace:^",
    "@deepseek-ai/dsh-agent": "workspace:^",
    "@deepseek-ai/dsh-agent-loop-testkit": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-alpaca": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-venue": "workspace:^",
    "@deepseek-ai/dsh-launch-environment": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-storage": "workspace:^",
    "@deepseek-ai/dsh-storage-domain": "workspace:^",
    "@deepseek-ai/dsh-storage-json": "workspace:^",
    "@deepseek-ai/dsh-system-prompt": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^",
    "@deepseek-ai/dsh-user-approval": "workspace:^"
  }
}
```

`packages/experimental/tool-trading/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../../../vendor/schemastery" },
    { "path": "../trading" },
    { "path": "../trading-venue" },
    { "path": "../../util/brand" },
    { "path": "../../util/values" },
    { "path": "../../core/agent" },
    { "path": "../../core/session" },
    { "path": "../../core/tools" },
    { "path": "../../llm/llm" },
    { "path": "../../storage/storage-domain" },
    { "path": "../../interaction/user-approval" }
  ]
}
```

In `tsconfig.host.json` `references`, beside `./packages/experimental/trading-venue`, add `{ "path": "./packages/experimental/tool-trading" },`.

- [ ] **Step 2: Write `src/types.ts`**

```ts
/**
 * Types shared by the trading executor, its tools, and the session events and journal entries it records.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/types
 */
import type {
  AssetClass, BrokerOrder, BrokerOrderId, OrderRequest, OrderStatus, ProposalId, RiskCheck, Side, SubmissionPlan, Timeframe,
  TradingMode, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Who proposed an order: the in-app dsh agent, or Claude Code over the MCP endpoint. */
export type ProposalSource = 'dsh-agent' | 'claude-code-mcp'

/** Best bid and ask shown with a proposal. */
export interface ProposalQuote {
  /** Best bid. */
  readonly bid: number
  /** Best ask. */
  readonly ask: number
}

/** A checked order proposal, recorded as `trading/proposal` before the user is asked. */
export interface TradingOrderProposal {
  /** Discriminant. */
  readonly kind: 'order'
  /** Executor-minted id; keys the approval, the journal entry, and the client order id. */
  readonly proposalId: ProposalId
  /** In-app tool call id; absent for MCP proposals. */
  readonly callId?: ToolCallId
  /** Proposing agent. */
  readonly source: ProposalSource
  /** Account mode the order would trade in. */
  readonly mode: TradingMode
  /** The order as proposed. */
  readonly order: OrderRequest
  /** The agent's one-to-three-sentence reason, shown with the approval request. */
  readonly rationale: string
  /** Bid and ask at the first check. */
  readonly quote: ProposalQuote
  /** Whether the instrument's market was open at the first check. */
  readonly marketOpen: boolean
  /** Price the estimate and the cap use (limit, stop, or the touch); 0 for an unpriced reduce-only exit. */
  readonly referencePrice: number
  /** Estimated order value in dollars. */
  readonly estimatedNotional: number
  /** Estimated value as a fraction of equity. */
  readonly equityPct: number
  /** Whether the order only reduces a position, as of the first check. */
  readonly reduceOnly: boolean
  /** Broker-facing type, prices, and time in force planned at the first check. */
  readonly plan: SubmissionPlan
  /** The instrument's price tick. */
  readonly priceIncrement: number
  /** Every risk check in display order. */
  readonly checks: readonly RiskCheck[]
}

/** A cancellation proposal for one open order. */
export interface TradingCancelProposal {
  /** Discriminant. */
  readonly kind: 'cancel'
  /** Executor-minted id. */
  readonly proposalId: ProposalId
  /** In-app tool call id; absent for MCP proposals. */
  readonly callId?: ToolCallId
  /** Proposing agent. */
  readonly source: ProposalSource
  /** Account mode. */
  readonly mode: TradingMode
  /** The open order as the broker reported it at the check. */
  readonly order: BrokerOrder
  /** The agent's reason. */
  readonly rationale: string
}

/** Payload of the `trading/proposal` session event. */
export type TradingProposal = TradingOrderProposal | TradingCancelProposal

/** Payload of the `trading/order` session event: what happened when an approved proposal was sent. */
export interface TradingOrderEvent {
  /** Proposal that was sent. */
  readonly proposalId: ProposalId
  /** Outcome; `unknown` means the order may exist and must be looked up before proposing again. */
  readonly outcome: 'submitted' | 'cancelled' | 'failed' | 'unknown'
  /** Broker order id, when known. */
  readonly orderId?: BrokerOrderId
  /** Broker order status, when submitted. */
  readonly status?: OrderStatus
  /** Readable failure reason. */
  readonly message?: string
}

/** Payload of the `trading/fill` session event: one fill of a desk order. */
export interface TradingFillEvent {
  /** Proposal the order came from. */
  readonly proposalId: ProposalId
  /** Broker order id. */
  readonly orderId: BrokerOrderId
  /** Instrument ticker. */
  readonly ticker: string
  /** Direction. */
  readonly side: Side
  /** Quantity of this fill. */
  readonly fillQty: number
  /** Price of this fill, when reported. */
  readonly fillPrice?: number
  /** Total filled quantity after this fill. */
  readonly filledQty: number
  /** Average fill price so far, when reported. */
  readonly filledAvgPrice?: number
  /** Order status after this fill. */
  readonly status: OrderStatus
  /** Fill time, UTC epoch milliseconds. */
  readonly t: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A checked order or cancellation proposal — log-only, appended before the user is asked. The tool body
     * submits only a proposal whose own event was committed and whose tool call received an `allowed-once` decision.
     */
    'trading/proposal': TradingProposal
    /** The outcome of sending an approved proposal to the broker — log-only. */
    'trading/order': TradingOrderEvent
    /** One fill of a desk order from the broker's order stream or reconciliation — log-only. */
    'trading/fill': TradingFillEvent
  }
}

/** Lifecycle of a journaled proposal. */
export type JournalStatus =
  | 'proposed' | 'denied' | 'rejected' | 'submitted' | 'partially_filled' | 'filled' | 'canceled' | 'expired' | 'failed' | 'unknown'

/** One proposal in the trading journal (storage domain `trading_journal`, table `entries`, keyed by proposal id). */
export interface JournalEntry {
  /** Proposal id; the table key. */
  readonly proposalId: ProposalId
  /** Session whose log records the proposal; links the entry to the proposing message. */
  readonly sessionId: SessionId
  /** In-app tool call id. */
  readonly callId?: ToolCallId
  /** Proposing agent. */
  readonly source: ProposalSource
  /** Order or cancellation. */
  readonly kind: 'order' | 'cancel'
  /** Instrument ticker. */
  readonly ticker: string
  /** Direction. */
  readonly side: Side
  /** Ordered quantity. */
  readonly qty?: number
  /** Ordered dollar amount. */
  readonly notional?: number
  /** The agent's reason. */
  readonly rationale: string
  /** Idempotency key sent to the broker (order proposals only). */
  readonly clientOrderId?: string
  /** Broker order id once known. */
  readonly orderId?: string
  /** Current lifecycle status. */
  readonly status: JournalStatus
  /** Filled quantity so far. */
  readonly filledQty: number
  /** Average fill price so far. */
  readonly filledAvgPrice?: number
  /** Trading day of the proposal, `YYYY-MM-DD` in America/New_York. */
  readonly day: string
  /** Creation time, UTC epoch milliseconds. */
  readonly createdAt: number
  /** Last update time, UTC epoch milliseconds. */
  readonly updatedAt: number
  /** Readable reason for the current status. */
  readonly note?: string
}

/** Who is proposing and where the proposal is recorded. */
export interface ProposalContext {
  /** Session whose log records the proposal, its order, and its fills. */
  readonly session: Session
  /** Proposing agent. */
  readonly source: ProposalSource
  /** In-app tool call id; MCP calls have none. */
  readonly callId?: ToolCallId
}

/**
 * Outcome of a proposal's first check. `duplicate` returns the pending proposal an identical MCP proposal from the same
 * session already created.
 */
export type ProposeResult =
  | { readonly kind: 'denied'; readonly reasons: readonly string[] }
  | { readonly kind: 'pending'; readonly proposalId: ProposalId; readonly summary: string }
  | { readonly kind: 'duplicate'; readonly proposalId: ProposalId; readonly summary: string }

/** `get_quote` result. */
export interface QuoteReport {
  readonly symbol: string
  readonly assetClass: AssetClass
  readonly bid: number
  readonly ask: number
  readonly mid: number
  readonly ageSeconds: number
  readonly marketOpen: boolean
}

/** `get_account` result. */
export interface AccountReport {
  readonly mode: TradingMode
  readonly status: VenueStatus
  readonly equity: number
  readonly cash: number
  readonly buyingPower: number
  readonly dayPl: number
  readonly dayPlPct: number
  readonly tradingBlocked: boolean
}

/** One `get_positions` row. */
export interface PositionReport {
  readonly symbol: string
  readonly qty: number
  readonly qtyAvailable: number
  readonly avgEntryPrice: number
  readonly currentPrice: number
  readonly marketValue: number
  readonly unrealizedPl: number
}

/** One open broker order in `list_orders`. */
export interface OrderRow {
  readonly orderId: string
  readonly symbol: string
  readonly side: Side
  readonly type: string
  readonly qty?: number
  readonly notional?: number
  readonly limitPrice?: number
  readonly stopPrice?: number
  readonly timeInForce: string
  readonly filledQty: number
  readonly status: OrderStatus
}

/** One desk order proposed today, in `list_orders`. */
export interface JournalRow {
  readonly proposalId: string
  readonly symbol: string
  readonly side: Side
  readonly qty?: number
  readonly notional?: number
  readonly status: JournalStatus
  readonly filledQty: number
  readonly filledAvgPrice?: number
  readonly orderId?: string
  readonly note?: string
}

/** `list_orders` result. */
export interface OrdersReport {
  readonly open: readonly OrderRow[]
  readonly today: readonly JournalRow[]
}

/** `place_order` / `cancel_order` result. */
export interface OrderReport {
  readonly proposalId: string
  readonly orderId: string
  readonly symbol: string
  readonly side: Side
  readonly type: string
  readonly qty?: number
  readonly notional?: number
  readonly limitPrice?: number
  readonly stopPrice?: number
  readonly timeInForce: string
  /** Broker status, or `cancel_requested` for an accepted cancellation. */
  readonly status: string
  readonly filledQty: number
  readonly filledAvgPrice?: number
  /** Whether a market order was sent as a capped limit. */
  readonly capped: boolean
}

/** Indicators `get_bars` can add to its summary. */
export type IndicatorName = 'sma' | 'ema' | 'rsi' | 'macd' | 'bollinger'

/** `get_bars` request after argument validation. */
export interface BarsRequest {
  readonly symbol: string
  readonly timeframe: string
  readonly limit?: number
  readonly indicators?: readonly IndicatorName[]
}

/** One swing high or low. */
export interface SwingPoint {
  readonly t: number
  readonly price: number
}

/** `get_bars` result. `bars` rows are `[t, open, high, low, close, volume]`, oldest first. */
export interface BarsReport {
  readonly symbol: string
  readonly timeframe: Timeframe
  readonly count: number
  readonly summary: {
    readonly last: number
    readonly high: number
    readonly low: number
    readonly changePct: number
    readonly swingHighs: readonly SwingPoint[]
    readonly swingLows: readonly SwingPoint[]
  } | null
  readonly indicators: {
    readonly sma20?: number | null
    readonly ema20?: number | null
    readonly rsi14?: number | null
    readonly macd?: { readonly macd: number | null; readonly signal: number | null; readonly histogram: number | null }
    readonly bollinger?: { readonly upper: number | null; readonly middle: number | null; readonly lower: number | null }
  }
  readonly bars: readonly (readonly number[])[]
}
```

- [ ] **Step 3: Write the failing Config, ids, and lock tests**

`packages/experimental/tool-trading/tests/config.spec.ts`:

```ts
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
```

`packages/experimental/tool-trading/tests/ids.spec.ts`:

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { clientOrderIdFor, mintProposalId, tradingDay } from '../src/ids.ts'

describe('ids', () => {
  it('mints distinct proposal ids', () => {
    const first = mintProposalId()
    expect(first).toMatch(/^p-[0-9a-f-]{36}$/)
    expect(mintProposalId()).not.toBe(first)
  })

  it('derives the client order id as SHA-256 hex of the session and proposal ids', () => {
    expect(clientOrderIdFor(SessionId('session-1'), brandString<ProposalId>('p-1')))
      .toBe('9d2adc3b6e9a8cc41407ecfd874ea5bc82954bee8dc099a80d3ac8f7c727cee8')
  })

  it('names the trading day in New York time', () => {
    expect(tradingDay(Date.UTC(2026, 9, 5, 2))).toBe('2026-10-04')
    expect(tradingDay(Date.UTC(2026, 9, 5, 14))).toBe('2026-10-05')
  })
})
```

`packages/experimental/tool-trading/tests/lock.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AccountLock } from '../src/lock.ts'

describe('AccountLock', () => {
  it('runs one section at a time in call order and keeps going after a failure', async () => {
    const lock = new AccountLock()
    const log: string[] = []
    const gate = Promise.withResolvers<undefined>()
    const first = lock.run(async () => { log.push('first start'); await gate.promise; log.push('first end'); return 1 })
    const second = lock.run(async () => { log.push('second'); throw new Error('boom') })
    const third = lock.run(async () => { log.push('third'); return 3 })
    await Promise.resolve()
    expect(log).toEqual(['first start'])
    gate.resolve(undefined)
    expect(await first).toBe(1)
    await expect(second).rejects.toThrow('boom')
    expect(await third).toBe(3)
    expect(log).toEqual(['first start', 'first end', 'second', 'third'])
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm install && pnpm exec vitest run packages/experimental/tool-trading`
Expected: FAIL — `Cannot find module '../src/config.ts'` (and `ids.ts`, `lock.ts`).

- [ ] **Step 5: Write `src/config.ts`, `src/ids.ts`, `src/lock.ts`**

`src/config.ts`:

```ts
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
```

`src/ids.ts`:

```ts
/**
 * Proposal ids, client order ids, and the trading day.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/ids
 */
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import type { SessionId } from '@deepseek-ai/dsh-session'

const NEW_YORK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * Mint a fresh proposal id at the first step of a proposal.
 * @returns `p-<uuid>`.
 */
export function mintProposalId(): ProposalId {
  return brandString<ProposalId>(`p-${randomUUID()}`)
}

/**
 * The broker idempotency key for one proposal. Provider call ids repeat across sessions and MCP calls have none, so the
 * key hashes the session id and the proposal id.
 * @param sessionId - session that recorded the proposal.
 * @param proposalId - proposal id.
 * @returns 64 lowercase hex characters (Alpaca accepts up to 128).
 */
export function clientOrderIdFor(sessionId: SessionId, proposalId: ProposalId): ClientOrderId {
  return brandString<ClientOrderId>(createHash('sha256').update(`${sessionId}:${proposalId}`).digest('hex'))
}

/**
 * The broker's trading day for a time.
 * @param t - UTC epoch milliseconds.
 * @returns `YYYY-MM-DD` in America/New_York.
 */
export function tradingDay(t: number): string {
  return NEW_YORK_DAY.format(t)
}
```

`src/lock.ts`:

```ts
/**
 * The per-account lock: one async section at a time, in call order.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/lock
 */

/** Serializes async sections; a failed section does not block the next one. */
export class AccountLock {
  private tail: Promise<void> = Promise.resolve()

  /**
   * Run a section after every earlier one settled.
   * @param section - work that must not overlap other sections.
   * @returns the section's result.
   */
  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(section)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
```

- [ ] **Step 6: Interim package root, paths, and the tests with coverage**

`src/index.ts` (Task 7 replaces it with the service default export; Task 8 adds the `./tools` subpath export):

```ts
/**
 * Trading order executor and model-facing trading tools (interim root: configuration and types only).
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading
 */
export { Config } from './config.ts'
export type * from './types.ts'
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run gen-tsconfig-paths && pnpm exec vitest run packages/experimental/tool-trading --coverage --coverage.include='packages/experimental/tool-trading/src/{config,ids,lock}.ts'`
Expected: `tsconfig.base.json` gains `"@deepseek-ai/dsh-experimental-tool-trading": ["./packages/experimental/tool-trading/src/index.ts"]`; tests PASS; the three files at 100%.

- [ ] **Step 7: Typecheck and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec tsc -b packages/experimental/tool-trading && pnpm run lint`
Expected: exit 0.

```bash
git add packages/experimental/tool-trading tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(tool-trading): scaffold the executor package with config, ids, and the account lock"
```

---
### Task 3: Order arguments — parsing and the price-tick check

**Files:**
- Create: `packages/experimental/tool-trading/src/order-args.ts`
- Test: `packages/experimental/tool-trading/tests/order-args.spec.ts`

**Interfaces:**
- Consumes: `parseSymbol`, `OrderRequest`, `BrokerOrderId` from `@deepseek-ai/dsh-experimental-trading`.
- Produces: `MAX_RATIONALE = 600`; `type ParseResult<T>`; `interface ProposedOrder { order: OrderRequest; rationale: string }`; `interface ProposedCancel { orderId: BrokerOrderId; rationale: string }`; `symbolOf(value: unknown): TradingSymbol` (throws `Error`); `parsePlaceOrder(input: unknown): ParseResult<ProposedOrder>`; `parseCancelOrder(input: unknown): ParseResult<ProposedCancel>`; `tickViolations(order: OrderRequest, increment: number): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
import type { OrderRequest } from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import { parseCancelOrder, parsePlaceOrder, symbolOf, tickViolations } from '../src/order-args.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const base = { symbol: 'btcusd', side: 'buy', qty: 0.0002, type: 'market', time_in_force: 'gtc', rationale: '  Momentum is up.  ' }

describe('parsePlaceOrder', () => {
  it('builds an order from valid arguments, ignoring null optional fields', () => {
    expect(parsePlaceOrder(base)).toEqual({
      ok: true,
      value: { order: { symbol: btc, side: 'buy', type: 'market', timeInForce: 'gtc', qty: 0.0002 }, rationale: 'Momentum is up.' },
    })
    expect(parsePlaceOrder({
      symbol: 'AAPL', side: 'buy', qty: 2, type: 'stop_limit', limit_price: 231, stop_price: 230, time_in_force: 'day',
      take_profit: 250, stop_loss: 220, rationale: 'Breakout.',
    })).toEqual({
      ok: true,
      value: {
        order: {
          symbol: aapl, side: 'buy', type: 'stop_limit', timeInForce: 'day', qty: 2, limitPrice: 231, stopPrice: 230,
          bracket: { takeProfit: 250, stopLoss: 220 },
        },
        rationale: 'Breakout.',
      },
    })
    expect(parsePlaceOrder({ ...base, qty: null, notional: 25 })).toMatchObject({ ok: true, value: { order: { notional: 25 } } })
  })

  it('collects every problem with hostile or malformed arguments', () => {
    expect(parsePlaceOrder({
      symbol: '../../x', side: 'hold', qty: '5', notional: Number.NaN, type: 'bracket', time_in_force: 'fok',
      limit_price: 'cheap', stop_price: {}, take_profit: 10, rationale: 'x'.repeat(601),
    })).toEqual({
      ok: false,
      reasons: [
        'symbol "../../x" is not a US stock ticker or a supported crypto pair such as BTC/USD',
        'side must be one of buy, sell',
        'type must be one of market, limit, stop, stop_limit',
        'time_in_force must be one of day, gtc, ioc',
        'qty must be a finite number',
        'notional must be a finite number',
        'limit_price must be a finite number',
        'stop_price must be a finite number',
        'a bracket needs both take_profit and stop_loss',
        'rationale must be at most 600 characters',
      ],
    })
    expect(parsePlaceOrder({ ...base, symbol: 42, rationale: '   ' })).toEqual({
      ok: false,
      reasons: ['symbol must be a ticker such as AAPL or BTC/USD', 'rationale must be one to three sentences explaining why'],
    })
    expect(parsePlaceOrder('buy bitcoin')).toEqual({ ok: false, reasons: ['arguments must be an object'] })
    expect(parsePlaceOrder([base])).toEqual({ ok: false, reasons: ['arguments must be an object'] })
  })
})

describe('parseCancelOrder', () => {
  it('accepts an order id and a rationale', () => {
    expect(parseCancelOrder({ order_id: ' order-9 ', rationale: 'Stale.' }))
      .toEqual({ ok: true, value: { orderId: 'order-9', rationale: 'Stale.' } })
  })

  it('refuses a missing order id, a missing rationale, and non-objects', () => {
    expect(parseCancelOrder({ order_id: 7 })).toEqual({
      ok: false,
      reasons: ['order_id must be an order id from list_orders', 'rationale must be one to three sentences explaining why'],
    })
    expect(parseCancelOrder(null)).toEqual({ ok: false, reasons: ['arguments must be an object'] })
  })
})

describe('symbolOf', () => {
  it('parses either spelling and explains a bad one', () => {
    expect(symbolOf('BTCUSD')).toEqual(btc)
    expect(() => symbolOf('BTC/EUR')).toThrow('symbol "BTC/EUR" is not a US stock ticker or a supported crypto pair such as BTC/USD')
  })
})

describe('tickViolations', () => {
  it('names every price that is not on the instrument tick', () => {
    const stopLimit: OrderRequest = {
      symbol: btc, side: 'buy', qty: 1, type: 'stop_limit', limitPrice: 62_000.123, stopPrice: 62_000.1, timeInForce: 'gtc',
    }
    expect(tickViolations(stopLimit, 0.01)).toEqual(['limit_price 62000.123 is not a multiple of the 0.01 price tick'])
    const bracket: OrderRequest = {
      symbol: aapl, side: 'buy', qty: 2, type: 'limit', limitPrice: 231, timeInForce: 'day',
      bracket: { takeProfit: 250.005, stopLoss: 220 },
    }
    expect(tickViolations(bracket, 0.01)).toEqual(['take_profit 250.005 is not a multiple of the 0.01 price tick'])
    expect(tickViolations({ ...bracket, bracket: { takeProfit: 250, stopLoss: 219.999 } }, 0.01))
      .toEqual(['stop_loss 219.999 is not a multiple of the 0.01 price tick'])
    expect(tickViolations({ symbol: btc, side: 'buy', qty: 1, type: 'market', timeInForce: 'gtc' }, 0.01)).toEqual([])
    expect(tickViolations(stopLimit, 0)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/order-args.spec.ts`
Expected: FAIL — `Cannot find module '../src/order-args.ts'`.

- [ ] **Step 3: Write `src/order-args.ts`**

```ts
/**
 * Parsing of `place_order` and `cancel_order` arguments into domain values. The pre-execute listener reads the raw
 * model JSON before the registry validates it against the tool schema, so every field is checked here.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/order-args
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  type BrokerOrderId, type OrderRequest, type OrderType, parseSymbol, type Side, type TimeInForce, type TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'

/** Longest accepted rationale, in characters. */
export const MAX_RATIONALE = 600

const SIDES: readonly Side[] = ['buy', 'sell']
const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop', 'stop_limit']
const TIME_IN_FORCE: readonly TimeInForce[] = ['day', 'gtc', 'ioc']

/** A parsed value, or every reason the input was refused. */
export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasons: readonly string[] }

/** A proposed order and its rationale. */
export interface ProposedOrder {
  /** The order. */
  readonly order: OrderRequest
  /** Trimmed rationale. */
  readonly rationale: string
}

/** A proposed cancellation and its rationale. */
export interface ProposedCancel {
  /** Broker order id to cancel. */
  readonly orderId: BrokerOrderId
  /** Trimmed rationale. */
  readonly rationale: string
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string, reasons: string[]): T | undefined {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  reasons.push(`${name} must be one of ${allowed.join(', ')}`)
  return undefined
}

function optionalNumber(args: Record<string, unknown>, key: string, reasons: string[]): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  reasons.push(`${key} must be a finite number`)
  return undefined
}

function rationaleOf(value: unknown, reasons: string[]): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) reasons.push('rationale must be one to three sentences explaining why')
  else if (text.length > MAX_RATIONALE) reasons.push(`rationale must be at most ${MAX_RATIONALE} characters`)
  return text
}

/**
 * Parse a model-typed instrument name.
 * @param value - `AAPL`, `BTC/USD`, or `BTCUSD`.
 * @returns the canonical symbol.
 * @throws Error with a model-facing reason.
 */
export function symbolOf(value: unknown): TradingSymbol {
  if (typeof value !== 'string') throw new Error('symbol must be a ticker such as AAPL or BTC/USD')
  try {
    return parseSymbol(value)
  } catch {
    // parseSymbol's RangeError names only the upper-cased input; the model needs the accepted forms.
    throw new Error(`symbol ${JSON.stringify(value)} is not a US stock ticker or a supported crypto pair such as BTC/USD`)
  }
}

/**
 * Parse `place_order` arguments.
 * @param input - raw tool arguments.
 * @returns the proposed order, or every reason it was refused.
 */
export function parsePlaceOrder(input: unknown): ParseResult<ProposedOrder> {
  const args = record(input)
  if (args === undefined) return { ok: false, reasons: ['arguments must be an object'] }
  const reasons: string[] = []
  let symbol: TradingSymbol | undefined
  try {
    symbol = symbolOf(args.symbol)
  } catch (error) {
    reasons.push((error as Error).message)
  }
  const side = oneOf(args.side, SIDES, 'side', reasons)
  const type = oneOf(args.type, ORDER_TYPES, 'type', reasons)
  const timeInForce = oneOf(args.time_in_force, TIME_IN_FORCE, 'time_in_force', reasons)
  const qty = optionalNumber(args, 'qty', reasons)
  const notional = optionalNumber(args, 'notional', reasons)
  const limitPrice = optionalNumber(args, 'limit_price', reasons)
  const stopPrice = optionalNumber(args, 'stop_price', reasons)
  const takeProfit = optionalNumber(args, 'take_profit', reasons)
  const stopLoss = optionalNumber(args, 'stop_loss', reasons)
  if ((takeProfit === undefined) !== (stopLoss === undefined)) reasons.push('a bracket needs both take_profit and stop_loss')
  const rationale = rationaleOf(args.rationale, reasons)
  if (symbol === undefined || side === undefined || type === undefined || timeInForce === undefined || reasons.length > 0) {
    return { ok: false, reasons }
  }
  const order: OrderRequest = {
    symbol, side, type, timeInForce,
    ...qty === undefined ? {} : { qty },
    ...notional === undefined ? {} : { notional },
    ...limitPrice === undefined ? {} : { limitPrice },
    ...stopPrice === undefined ? {} : { stopPrice },
    ...takeProfit === undefined || stopLoss === undefined ? {} : { bracket: { takeProfit, stopLoss } },
  }
  return { ok: true, value: { order, rationale } }
}

/**
 * Parse `cancel_order` arguments.
 * @param input - raw tool arguments.
 * @returns the proposed cancellation, or every reason it was refused.
 */
export function parseCancelOrder(input: unknown): ParseResult<ProposedCancel> {
  const args = record(input)
  if (args === undefined) return { ok: false, reasons: ['arguments must be an object'] }
  const reasons: string[] = []
  const id = typeof args.order_id === 'string' ? args.order_id.trim() : ''
  if (id.length === 0) reasons.push('order_id must be an order id from list_orders')
  const rationale = rationaleOf(args.rationale, reasons)
  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, value: { orderId: brandString<BrokerOrderId>(id), rationale } }
}

/**
 * Prices that are not a whole number of price ticks, so a sub-penny price is a tool error rather than a broker rejection.
 * @param order - order as proposed.
 * @param increment - the instrument's price tick; a non-positive tick skips the check.
 * @returns one reason per off-tick price.
 */
export function tickViolations(order: OrderRequest, increment: number): string[] {
  if (!(increment > 0)) return []
  const prices: [string, number | undefined][] = [
    ['limit_price', order.limitPrice], ['stop_price', order.stopPrice],
    ['take_profit', order.bracket?.takeProfit], ['stop_loss', order.bracket?.stopLoss],
  ]
  return prices.flatMap(([name, price]) => {
    if (price === undefined) return []
    const steps = price / increment
    return Math.abs(steps - Math.round(steps)) > 1e-6 ? [`${name} ${price} is not a multiple of the ${increment} price tick`] : []
  })
}
```

- [ ] **Step 4: Run it with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/order-args.spec.ts --coverage --coverage.include='packages/experimental/tool-trading/src/order-args.ts'`
Expected: PASS; `order-args.ts` 100%.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/tool-trading/src/order-args.ts packages/experimental/tool-trading/tests/order-args.spec.ts
git commit -m "feat(tool-trading): parse order and cancel arguments and check prices against the tick"
```

---

### Task 4: The proposal book — reservations, approval links, settlement

**Files:**
- Create: `packages/experimental/tool-trading/src/book.ts`
- Test: `packages/experimental/tool-trading/tests/book.spec.ts`

**Interfaces:**
- Consumes: `TradingProposal`, `TradingOrderProposal` (Task 2); `ApprovalOutcome`, `ApprovalRequestId` from `@deepseek-ai/dsh-user-approval`.
- Produces: `interface Reservation { ticker; side; qty; notional }`; `type ProposalState = 'checked' | 'asked' | 'approved' | 'submitting'`; `interface BookEntry { proposal; sessionId; reservation?; state; approvalId? }`; `class ProposalBook` with `add(proposal, sessionId, reservation?)`, `get(id)`, `forCall(sessionId, callId)`, `markLogged(sessionId, id)`, `linkApproval(sessionId, callId | undefined, approvalId)`, `decide(approvalId, outcome): BookEntry | undefined` (returns the settled entry for a non-grant), `settle(id)`, `settleCall(sessionId, callId)`, `exposure(ticker, excluding?)`, `pendingBuyNotional(excluding?)`, `pendingOrders(excluding?)`, `findDuplicate(sessionId, order): TradingOrderProposal | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OrderRequest, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { ProposalBook } from '../src/book.ts'
import type { TradingCancelProposal, TradingOrderProposal } from '../src/types.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const session = SessionId('s-1')
const pid = (id: string): ProposalId => brandString<ProposalId>(id)
const order = (overrides: Partial<OrderRequest> = {}): OrderRequest =>
  ({ symbol: btc, side: 'buy', qty: 0.1, type: 'market', timeInForce: 'gtc', ...overrides })

function proposal(id: string, callId?: string, o: OrderRequest = order()): TradingOrderProposal {
  return {
    kind: 'order', proposalId: pid(id), ...callId === undefined ? {} : { callId: ToolCallId(callId) }, source: 'dsh-agent',
    mode: 'paper', order: o, rationale: 'r', quote: { bid: 1, ask: 1 }, marketOpen: true, referencePrice: 100,
    estimatedNotional: 10, equityPct: 0, reduceOnly: false, plan: { type: 'market', timeInForce: 'gtc', capped: false },
    priceIncrement: 0.01, checks: [],
  }
}

const cancel = (id: string): TradingCancelProposal => ({
  kind: 'cancel', proposalId: pid(id), source: 'dsh-agent', mode: 'paper', rationale: 'r',
  order: {
    id: brandString('o-1'), clientOrderId: brandString('c-1'), symbol: btc, side: 'buy', type: 'limit', timeInForce: 'gtc',
    qty: 0.1, limitPrice: 60_000, filledQty: 0, status: 'open',
  },
})

describe('ProposalBook exposure', () => {
  it('sums reservations per ticker and side, excluding one proposal', () => {
    const book = new ProposalBook()
    book.add(proposal('p1'), session, { ticker: 'BTC/USD', side: 'buy', qty: 0.1, notional: 10 })
    book.add(proposal('p2'), session, { ticker: 'BTC/USD', side: 'sell', qty: 0.05, notional: 5 })
    book.add(proposal('p3'), session, { ticker: 'AAPL', side: 'buy', qty: 2, notional: 460 })
    book.add(cancel('p4'), session)
    expect(book.exposure('BTC/USD')).toEqual({ pendingBuyQty: 0.1, pendingSellQty: 0.05 })
    expect(book.exposure('BTC/USD', pid('p1'))).toEqual({ pendingBuyQty: 0, pendingSellQty: 0.05 })
    expect(book.pendingBuyNotional()).toBe(470)
    expect(book.pendingBuyNotional(pid('p3'))).toBe(10)
    expect(book.pendingOrders()).toBe(3)
    expect(book.pendingOrders(pid('p2'))).toBe(2)
  })
})

describe('ProposalBook approval', () => {
  it('approves only a logged proposal that was asked about through its own call', () => {
    const book = new ProposalBook()
    book.add(proposal('p1', 'call-1'), session, { ticker: 'BTC/USD', side: 'buy', qty: 0.1, notional: 10 })
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('early'))
    expect(book.decide(ApprovalRequestId('early'), 'allowed-once')).toBeUndefined()
    expect(book.get(pid('p1'))?.state).toBe('checked')
    book.markLogged(SessionId('other'), pid('p1'))
    expect(book.get(pid('p1'))?.state).toBe('checked')
    book.markLogged(session, pid('p1'))
    expect(book.get(pid('p1'))?.state).toBe('asked')
    book.linkApproval(session, undefined, ApprovalRequestId('no-call'))
    book.linkApproval(session, ToolCallId('call-x'), ApprovalRequestId('other-call'))
    expect(book.decide(ApprovalRequestId('other-call'), 'allowed-once')).toBeUndefined()
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('a-1'))
    expect(book.decide(ApprovalRequestId('a-1'), 'allowed-once')).toBeUndefined()
    expect(book.get(pid('p1'))?.state).toBe('approved')
    expect(book.decide(ApprovalRequestId('a-1'), 'allowed-once')).toBeUndefined()
    expect(book.forCall(session, ToolCallId('call-1'))).toBe('p1')
  })

  it('settles a refused proposal, drops its links, and frees its reservation', () => {
    const book = new ProposalBook()
    book.add(proposal('p1', 'call-1'), session, { ticker: 'BTC/USD', side: 'buy', qty: 0.1, notional: 10 })
    book.markLogged(session, pid('p1'))
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('a-1'))
    expect(book.decide(ApprovalRequestId('a-1'), 'rejected')?.proposal.proposalId).toBe('p1')
    expect(book.get(pid('p1'))).toBeUndefined()
    expect(book.forCall(session, ToolCallId('call-1'))).toBeUndefined()
    expect(book.exposure('BTC/USD')).toEqual({ pendingBuyQty: 0, pendingSellQty: 0 })
  })

  it('settles by call id once', () => {
    const book = new ProposalBook()
    book.add(proposal('p1', 'call-1'), session)
    book.markLogged(session, pid('p1'))
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('a-1'))
    expect(book.settleCall(session, ToolCallId('call-1'))?.proposal.proposalId).toBe('p1')
    expect(book.settleCall(session, ToolCallId('call-1'))).toBeUndefined()
    expect(book.decide(ApprovalRequestId('a-1'), 'allowed-once')).toBeUndefined()
    expect(book.settle(pid('missing'))).toBeUndefined()
    book.add(proposal('p2'), session)
    expect(book.settle(pid('p2'))?.proposal.proposalId).toBe('p2')
  })
})

describe('ProposalBook duplicates', () => {
  it('finds an identical unsent order proposal from the same session only', () => {
    const book = new ProposalBook()
    book.add(cancel('p0'), session)
    book.add(proposal('p1', undefined, order({ type: 'limit', limitPrice: 60_000 })), session)
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_000 }))?.proposalId).toBe('p1')
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_001 }))).toBeUndefined()
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_000, qty: 0.2 }))).toBeUndefined()
    expect(book.findDuplicate(SessionId('other'), order({ type: 'limit', limitPrice: 60_000 }))).toBeUndefined()
    const entry = book.get(pid('p1'))
    if (entry === undefined) throw new Error('p1 missing')
    entry.state = 'submitting'
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_000 }))).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/book.spec.ts`
Expected: FAIL — `Cannot find module '../src/book.ts'`.

- [ ] **Step 3: Write `src/book.ts`**

```ts
/**
 * Proposals between their first check and settlement: reserved exposure, approval state, and the links from tool call
 * ids and approval request ids to proposal ids. The executor maintains it from its own commits and the session events
 * it observes; nothing survives a restart, and a lost entry fails closed.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/book
 */
import type { OrderRequest, ProposalId, Side } from '@deepseek-ai/dsh-experimental-trading'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { TradingOrderProposal, TradingProposal } from './types.ts'

/** Exposure a pending order proposal holds until it settles. */
export interface Reservation {
  /** Instrument ticker. */
  readonly ticker: string
  /** Direction. */
  readonly side: Side
  /** Quantity, derived from the notional for notional orders. */
  readonly qty: number
  /** Estimated value in dollars. */
  readonly notional: number
}

/**
 * `checked`: reserved; its `trading/proposal` event not yet observed. `asked`: the event committed. `approved`: its call
 * received `allowed-once`. `submitting`: the tool body is sending it.
 */
export type ProposalState = 'checked' | 'asked' | 'approved' | 'submitting'

/** One unsettled proposal. */
export interface BookEntry {
  /** The proposal as recorded. */
  readonly proposal: TradingProposal
  /** Session that records it. */
  readonly sessionId: SessionId
  /** Held exposure; absent for cancellations. */
  readonly reservation?: Reservation
  /** Current state. */
  state: ProposalState
  /** Approval request linked to its call. */
  approvalId?: ApprovalRequestId
}

function callKey(sessionId: SessionId, callId: ToolCallId): string {
  return `${sessionId}\u0000${callId}`
}

/** The executor's in-memory proposal book. */
export class ProposalBook {
  private readonly entries = new Map<ProposalId, BookEntry>()
  private readonly calls = new Map<string, ProposalId>()
  private readonly approvals = new Map<ApprovalRequestId, BookEntry>()

  /**
   * Add a checked proposal.
   * @param proposal - the checked proposal.
   * @param sessionId - session that records it.
   * @param reservation - exposure to hold until it settles; cancellations hold none.
   */
  add(proposal: TradingProposal, sessionId: SessionId, reservation?: Reservation): void {
    this.entries.set(proposal.proposalId, { proposal, sessionId, ...reservation === undefined ? {} : { reservation }, state: 'checked' })
    if (proposal.callId !== undefined) this.calls.set(callKey(sessionId, proposal.callId), proposal.proposalId)
  }

  /**
   * @param id - proposal id.
   * @returns the unsettled entry.
   */
  get(id: ProposalId): BookEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * @param sessionId - session of the call.
   * @param callId - in-app tool call id.
   * @returns the unsettled proposal created for that call.
   */
  forCall(sessionId: SessionId, callId: ToolCallId): ProposalId | undefined {
    return this.calls.get(callKey(sessionId, callId))
  }

  /**
   * Record that a proposal's own `trading/proposal` event committed in its session.
   * @param sessionId - session whose log committed the event.
   * @param id - proposal id in the event.
   */
  markLogged(sessionId: SessionId, id: ProposalId): void {
    const entry = this.entries.get(id)
    if (entry?.sessionId === sessionId && entry.state === 'checked') entry.state = 'asked'
  }

  /**
   * Link an `approval/asked` event to the logged proposal of the same call.
   * @param sessionId - session whose log committed the event.
   * @param callId - the event's call id, when it has one.
   * @param approvalId - the event's request id.
   */
  linkApproval(sessionId: SessionId, callId: ToolCallId | undefined, approvalId: ApprovalRequestId): void {
    if (callId === undefined) return
    const id = this.forCall(sessionId, callId)
    const entry = id === undefined ? undefined : this.entries.get(id)
    if (entry?.state !== 'asked') return
    entry.approvalId = approvalId
    this.approvals.set(approvalId, entry)
  }

  /**
   * Apply an `approval/decided` outcome: `allowed-once` approves the linked proposal; any other outcome settles it.
   * @param approvalId - the decided request.
   * @param outcome - the decision.
   * @returns the settled entry for a refusal, cancellation, or unavailable answer; otherwise undefined.
   */
  decide(approvalId: ApprovalRequestId, outcome: ApprovalOutcome): BookEntry | undefined {
    const entry = this.approvals.get(approvalId)
    if (entry === undefined) return undefined
    this.approvals.delete(approvalId)
    if (outcome === 'allowed-once') {
      entry.state = 'approved'
      return undefined
    }
    return this.settle(entry.proposal.proposalId)
  }

  /**
   * Remove a proposal, its reservation, and its links.
   * @param id - proposal id.
   * @returns the removed entry.
   */
  settle(id: ProposalId): BookEntry | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    if (entry.proposal.callId !== undefined) this.calls.delete(callKey(entry.sessionId, entry.proposal.callId))
    if (entry.approvalId !== undefined) this.approvals.delete(entry.approvalId)
    return entry
  }

  /**
   * Settle whatever proposal a finished tool call left behind.
   * @param sessionId - session of the call.
   * @param callId - tool call id.
   * @returns the removed entry, when one was still unsettled.
   */
  settleCall(sessionId: SessionId, callId: ToolCallId): BookEntry | undefined {
    const id = this.forCall(sessionId, callId)
    return id === undefined ? undefined : this.settle(id)
  }

  private reservations(excluding?: ProposalId): Reservation[] {
    return [...this.entries.values()].flatMap(entry =>
      entry.reservation === undefined || entry.proposal.proposalId === excluding ? [] : [entry.reservation])
  }

  /**
   * Quantities reserved by pending proposals for one instrument.
   * @param ticker - instrument ticker.
   * @param excluding - proposal to leave out (the one being re-checked).
   * @returns pending buy and sell quantities.
   */
  exposure(ticker: string, excluding?: ProposalId): { pendingBuyQty: number; pendingSellQty: number } {
    let pendingBuyQty = 0
    let pendingSellQty = 0
    for (const reservation of this.reservations(excluding)) {
      if (reservation.ticker !== ticker) continue
      if (reservation.side === 'buy') pendingBuyQty += reservation.qty
      else pendingSellQty += reservation.qty
    }
    return { pendingBuyQty, pendingSellQty }
  }

  /**
   * @param excluding - proposal to leave out.
   * @returns the estimated value of pending buy proposals, all instruments.
   */
  pendingBuyNotional(excluding?: ProposalId): number {
    return this.reservations(excluding).filter(r => r.side === 'buy').reduce((sum, r) => sum + r.notional, 0)
  }

  /**
   * @param excluding - proposal to leave out.
   * @returns the number of pending order proposals.
   */
  pendingOrders(excluding?: ProposalId): number {
    return this.reservations(excluding).length
  }

  /**
   * An unsent order proposal from the same session with the same instrument, side, size, type, and prices.
   * @param sessionId - proposing session.
   * @param order - the new order.
   * @returns the matching proposal.
   */
  findDuplicate(sessionId: SessionId, order: OrderRequest): TradingOrderProposal | undefined {
    for (const entry of this.entries.values()) {
      const { proposal } = entry
      if (proposal.kind !== 'order' || entry.sessionId !== sessionId || entry.state === 'submitting') continue
      const pending = proposal.order
      if (pending.symbol.ticker === order.symbol.ticker && pending.side === order.side && pending.qty === order.qty
        && pending.notional === order.notional && pending.type === order.type && pending.limitPrice === order.limitPrice
        && pending.stopPrice === order.stopPrice) return proposal
    }
    return undefined
  }
}
```

- [ ] **Step 4: Run it with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/book.spec.ts --coverage --coverage.include='packages/experimental/tool-trading/src/book.ts'`
Expected: PASS; `book.ts` 100%.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/tool-trading/src/book.ts packages/experimental/tool-trading/tests/book.spec.ts
git commit -m "feat(tool-trading): track proposals, reservations, and approval links in a proposal book"
```

---

### Task 5: The trading journal in the storage service

**Files:**
- Create: `packages/experimental/tool-trading/src/journal.ts`
- Test: `packages/experimental/tool-trading/tests/journal.spec.ts`

**Interfaces:**
- Consumes: `JournalEntry`, `JournalStatus` (Task 2); `defineDomain`, `domainTable`, `Domain` from `@deepseek-ai/dsh-storage-domain`.
- Produces: `tradingJournalSpec` (domain `trading_journal`, version 1, table `entries` keyed by proposal id); `type JournalPatch`; `type InFlightEntry = JournalEntry & { clientOrderId: string }`; `class Journal` with `get(id)`, `byClientOrderId(id)`, `put(entry): Promise<void>`, `update(id, patch, now): Promise<JournalEntry>`, `inFlight(): InFlightEntry[]`, `on(day): JournalEntry[]`, `submittedOn(day): number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Journal, tradingJournalSpec } from '../src/journal.ts'
import type { JournalEntry, JournalStatus } from '../src/types.ts'

let root: string
let contexts: Context[]

async function openJournal(): Promise<{ journal: Journal; close: () => Promise<void> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(tradingJournalSpec)
  return { journal: new Journal(domain), close: () => domain.close() }
}

const entry = (id: string, overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  proposalId: brandString<ProposalId>(id), sessionId: SessionId('s-1'), source: 'dsh-agent', kind: 'order', ticker: 'BTC/USD',
  side: 'buy', qty: 0.0002, rationale: 'r', clientOrderId: `client-${id}`, status: 'proposed', filledQty: 0,
  day: '2026-10-05', createdAt: 1, updatedAt: 1, ...overrides,
})

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-journal-')); contexts = [] })
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('Journal', () => {
  it('persists entries across a reopen and finds them by client order id', async () => {
    const first = await openJournal()
    await first.journal.put(entry('p1'))
    const updated = await first.journal.update(brandString<ProposalId>('p1'), { status: 'submitted', orderId: 'o-1' }, 5)
    expect(updated).toMatchObject({ status: 'submitted', orderId: 'o-1', updatedAt: 5 })
    await first.close()
    const second = await openJournal()
    expect(second.journal.get(brandString<ProposalId>('p1'))).toMatchObject({ status: 'submitted' })
    expect(second.journal.byClientOrderId(brandString<ClientOrderId>('client-p1'))?.proposalId).toBe('p1')
    expect(second.journal.byClientOrderId(brandString<ClientOrderId>('nope'))).toBeUndefined()
    expect(second.journal.inFlight().map(e => e.proposalId)).toEqual(['p1'])
  })

  it('counts and lists a trading day', async () => {
    const { journal } = await openJournal()
    await journal.put(entry('p3', { status: 'canceled', kind: 'cancel', createdAt: 3 }))
    await journal.put(entry('p1', { status: 'filled', createdAt: 1 }))
    await journal.put(entry('p2', { status: 'denied', createdAt: 2 }))
    await journal.put(entry('p4', { status: 'unknown', day: '2026-10-04', createdAt: 4 }))
    await journal.put({
      proposalId: brandString<ProposalId>('p5'), sessionId: SessionId('s-1'), source: 'dsh-agent', kind: 'order', ticker: 'BTC/USD',
      side: 'buy', rationale: 'r', status: 'submitted', filledQty: 0, day: '2026-10-05', createdAt: 5, updatedAt: 5,
    })
    expect(journal.submittedOn('2026-10-05')).toBe(2)
    expect(journal.on('2026-10-05').map(e => e.proposalId)).toEqual(['p1', 'p2', 'p3', 'p5'])
    expect(journal.inFlight().map(e => e.proposalId)).toEqual(['p4'])
  })

  it('refuses an entry outside the schema', async () => {
    const { journal } = await openJournal()
    await expect(journal.put(entry('p1', { status: 'bogus' as JournalStatus }))).rejects.toMatchObject({ code: 'invalid-record' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/journal.spec.ts`
Expected: FAIL — `Cannot find module '../src/journal.ts'`.

- [ ] **Step 3: Write `src/journal.ts`**

```ts
/**
 * The trading journal: one durable entry per proposal in the storage service (domain `trading_journal`), from proposal
 * to final order state. It maps broker client order ids back to the proposing session, survives restarts, and backs
 * `list_orders` and the daily order count.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/journal
 */
import type { ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { type Domain, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { type ZodType, z as zod } from 'zod'
import type { JournalEntry, JournalStatus } from './types.ts'

const STATUSES = [
  'proposed', 'denied', 'rejected', 'submitted', 'partially_filled', 'filled', 'canceled', 'expired', 'failed', 'unknown',
] as const satisfies readonly JournalStatus[]

// Branded ids are plain strings on disk; the cast restores the brands the executor wrote.
const entrySchema = zod.object({
  proposalId: zod.string(),
  sessionId: zod.string(),
  callId: zod.string().optional(),
  source: zod.enum(['dsh-agent', 'claude-code-mcp']),
  kind: zod.enum(['order', 'cancel']),
  ticker: zod.string(),
  side: zod.enum(['buy', 'sell']),
  qty: zod.number().optional(),
  notional: zod.number().optional(),
  rationale: zod.string(),
  clientOrderId: zod.string().optional(),
  orderId: zod.string().optional(),
  status: zod.enum(STATUSES),
  filledQty: zod.number(),
  filledAvgPrice: zod.number().optional(),
  day: zod.string(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  note: zod.string().optional(),
}).strict() as unknown as ZodType<JournalEntry>

/** Storage domain holding the trading journal. */
export const tradingJournalSpec = defineDomain({
  name: 'trading_journal',
  version: 1,
  tables: { entries: domainTable<string, JournalEntry>(entrySchema) },
})

/** Fields a lifecycle update may change. */
export interface JournalPatch {
  readonly status?: JournalStatus
  readonly orderId?: string
  readonly filledQty?: number
  readonly filledAvgPrice?: number
  readonly note?: string
}

/** A journaled order whose broker state is not final yet. */
export type InFlightEntry = JournalEntry & { readonly clientOrderId: string }

const IN_FLIGHT: ReadonlySet<JournalStatus> = new Set(['submitted', 'partially_filled', 'unknown'])
const COUNTED: ReadonlySet<JournalStatus> = new Set(['submitted', 'partially_filled', 'filled', 'canceled', 'expired', 'unknown'])

/** Reads and writes over the open journal domain. Reads are synchronous; writes resolve once durable. */
export class Journal {
  private readonly byClientOrder = new Map<string, ProposalId>()

  /** @param domain - the open `trading_journal` domain; the caller closes it. */
  constructor(private readonly domain: Domain<typeof tradingJournalSpec>) {
    for (const [, entry] of domain.table('entries').entries()) this.index(entry)
  }

  /**
   * @param id - proposal id.
   * @returns the entry.
   */
  get(id: ProposalId): JournalEntry | undefined {
    return this.domain.table('entries').get(id)
  }

  /**
   * @param id - client order id sent to the broker.
   * @returns the entry of the proposal that sent it.
   */
  byClientOrderId(id: ClientOrderId): JournalEntry | undefined {
    const proposalId = this.byClientOrder.get(id)
    return proposalId === undefined ? undefined : this.get(proposalId)
  }

  /**
   * Write a new entry.
   * @param entry - the entry.
   * @returns when the write is durable.
   */
  async put(entry: JournalEntry): Promise<void> {
    await this.domain.table('entries').put(entry.proposalId, entry)
    this.index(entry)
  }

  /**
   * Change an entry's lifecycle fields.
   * @param id - proposal id.
   * @param patch - fields to change.
   * @param now - update time, UTC epoch milliseconds.
   * @returns the updated entry once durable.
   */
  async update(id: ProposalId, patch: JournalPatch, now: number): Promise<JournalEntry> {
    return this.domain.table('entries').update(id, current => ({ ...current, ...patch, updatedAt: now }))
  }

  /** @returns order entries the broker may still be working: submitted, partially filled, or of unknown outcome. */
  inFlight(): InFlightEntry[] {
    return [...this.domain.table('entries').entries()].flatMap(([, entry]) =>
      entry.kind === 'order' && entry.clientOrderId !== undefined && IN_FLIGHT.has(entry.status)
        ? [{ ...entry, clientOrderId: entry.clientOrderId }]
        : [])
  }

  /**
   * @param day - trading day, `YYYY-MM-DD`.
   * @returns that day's entries, oldest first.
   */
  on(day: string): JournalEntry[] {
    return [...this.domain.table('entries').entries()].map(([, entry]) => entry)
      .filter(entry => entry.day === day)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * @param day - trading day, `YYYY-MM-DD`.
   * @returns how many desk orders reached the broker that day.
   */
  submittedOn(day: string): number {
    return this.on(day).filter(entry => entry.kind === 'order' && COUNTED.has(entry.status)).length
  }

  private index(entry: JournalEntry): void {
    if (entry.clientOrderId !== undefined) this.byClientOrder.set(entry.clientOrderId, entry.proposalId)
  }
}
```

- [ ] **Step 4: Run it with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/journal.spec.ts --coverage --coverage.include='packages/experimental/tool-trading/src/journal.ts'`
Expected: PASS; `journal.ts` 100%.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/tool-trading/src/journal.ts packages/experimental/tool-trading/tests/journal.spec.ts
git commit -m "feat(tool-trading): journal proposals and orders in the storage service"
```

---

### Task 6: Desk snapshot, order math, the in-memory test venue, and the `get_bars` report

**Files:**
- Create: `packages/experimental/tool-trading/src/snapshot.ts`, `packages/experimental/tool-trading/src/bars.ts`
- Create: `packages/experimental/tool-trading/tests/fake-venue.ts`
- Test: `packages/experimental/tool-trading/tests/snapshot.spec.ts`, `packages/experimental/tool-trading/tests/bars.spec.ts`

**Interfaces:**
- Consumes: `ProposalBook` (Task 4), `Journal.submittedOn` (Task 5), `tradingDay` (Task 2), `planSubmission`, indicator functions from `trading`.
- Produces:
  - `snapshot.ts`: `interface DeskSnapshot { risk: RiskSnapshot; account; quote; marketOpen }`; `interface SnapshotSources { venue: SnapshotVenue; book: ProposalBook; journal: Pick<Journal, 'submittedOn'>; now: number; excluding?: ProposalId }`; `takeSnapshot(symbol, sources): Promise<DeskSnapshot>`; `remainingQty(order, price)`; `openExposure(orders, ticker, price)`; `openBuyNotional(orders)`; `drifted(approved, current, tolerance): boolean`; `planOrder(order, approvedPrice, tolerance, reduceOnly, increment): SubmissionPlan` (throws `Error`); `brokerRequest(order, plan, clientOrderId): BrokerOrderRequest`.
  - `bars.ts`: `INDICATORS`, `WARMUP_BARS = 60`, `barsReport(symbol, timeframe, bars, limit, indicators): BarsReport`, `renderBars(report): string`.
  - `tests/fake-venue.ts`: `class FakeVenue extends TradingVenueGateway` (default export) with public test state `current`, `keysMissing`, `accountMode`, `accountState`, `held`, `open`, `marketIsOpen`, `quoteAgeMs`, `quotes`, `assets`, `history`, `submitted`, `cancelled`, `known`, `respond`, `cancelFailure`, `listenerCount`, `emit(event)`; and `acceptedOrder(request, overrides?)`.

- [ ] **Step 1: Write the in-memory venue used by every executor test**

`packages/experimental/tool-trading/tests/fake-venue.ts`:

```ts
/**
 * In-memory trading venue for tool-trading tests: state the test sets directly, every order request recorded, and
 * order-stream events delivered on demand. Only the broker is faked; tools, approval, sessions, and storage stay real.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AccountSnapshot, Asset, Bar, BarQuery, BrokerOrder, BrokerOrderId, BrokerOrderRequest, ClientOrderId, OrderStreamEvent,
  PositionSnapshot, Quote, Timeframe, TradingMode, TradingSymbol, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { TradingVenueGateway, VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'

const btc: TradingSymbol = { assetClass: 'crypto', ticker: 'BTC/USD' }
const aapl: TradingSymbol = { assetClass: 'equity', ticker: 'AAPL' }

/**
 * The order a broker accepts for a request.
 * @param request - planned request.
 * @param overrides - fields to change, such as a fill.
 * @returns an open order with the request's fields.
 */
export function acceptedOrder(request: BrokerOrderRequest, overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    id: brandString<BrokerOrderId>(`order-${request.clientOrderId.slice(0, 8)}`),
    clientOrderId: request.clientOrderId, symbol: request.symbol, side: request.side, type: request.type,
    timeInForce: request.timeInForce,
    ...request.qty === undefined ? {} : { qty: request.qty },
    ...request.notional === undefined ? {} : { notional: request.notional },
    ...request.limitPrice === undefined ? {} : { limitPrice: request.limitPrice },
    ...request.stopPrice === undefined ? {} : { stopPrice: request.stopPrice },
    filledQty: 0, status: 'open', ...overrides,
  }
}

/** In-memory `ctx.tradingVenue`. */
export class FakeVenue extends TradingVenueGateway {
  current: VenueStatus = 'ready'
  keysMissing = false
  accountMode: TradingMode = 'paper'
  accountState: AccountSnapshot = { equity: 100_000, cash: 100_000, lastEquity: 100_000, buyingPower: 100_000, tradingBlocked: false }
  held: PositionSnapshot[] = []
  open: BrokerOrder[] = []
  marketIsOpen = true
  quoteAgeMs = 0
  readonly quotes = new Map<string, { bid: number; ask: number }>([
    ['BTC/USD', { bid: 62_830, ask: 62_835 }], ['AAPL', { bid: 229.9, ask: 230.1 }],
  ])
  readonly assets = new Map<string, Asset>([
    ['BTC/USD', { symbol: btc, tradable: true, fractionable: true, minOrderSize: 0.0001, minNotional: 10, priceIncrement: 0.01 }],
    ['AAPL', { symbol: aapl, tradable: true, fractionable: true, priceIncrement: 0.01 }],
  ])
  history: Bar[] = []
  readonly barQueries: BarQuery[] = []
  readonly submitted: BrokerOrderRequest[] = []
  readonly cancelled: BrokerOrderId[] = []
  readonly known = new Map<string, BrokerOrder>()
  respond: (request: BrokerOrderRequest) => BrokerOrder = request => acceptedOrder(request)
  cancelFailure: VenueError | undefined
  private readonly listeners = new Set<(event: OrderStreamEvent) => void>()

  status(): VenueStatus { return this.current }
  mode(): TradingMode { return this.accountMode }
  async account(): Promise<AccountSnapshot> { this.keys(); return this.accountState }
  async positions(): Promise<PositionSnapshot[]> { this.keys(); return this.held }
  async openOrders(): Promise<BrokerOrder[]> { this.keys(); return this.open }
  async order(clientOrderId: ClientOrderId): Promise<BrokerOrder | undefined> { this.keys(); return this.known.get(clientOrderId) }
  async asset(symbol: TradingSymbol): Promise<Asset> {
    this.keys()
    const asset = this.assets.get(symbol.ticker)
    if (asset === undefined) throw new VenueError(`no asset ${symbol.ticker}`, 'not-found')
    return asset
  }
  async marketOpen(): Promise<boolean> { this.keys(); return this.marketIsOpen }
  async latestQuote(symbol: TradingSymbol): Promise<Quote> {
    this.keys()
    const quote = this.quotes.get(symbol.ticker)
    if (quote === undefined) throw new VenueError(`no quote for ${symbol.ticker}`, 'not-found')
    return { ...quote, t: Date.now() - this.quoteAgeMs }
  }
  async bars(_symbol: TradingSymbol, _timeframe: Timeframe, query: BarQuery): Promise<Bar[]> {
    this.keys()
    this.barQueries.push(query)
    return this.history.slice(-query.limit)
  }
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.keys()
    if (this.current === 'halted') throw new VenueError('trading is halted', 'halted')
    this.submitted.push(request)
    const order = this.respond(request)
    this.known.set(request.clientOrderId, order)
    return order
  }
  async cancelOrder(id: BrokerOrderId): Promise<void> {
    this.keys()
    if (this.cancelFailure !== undefined) throw this.cancelFailure
    this.cancelled.push(id)
  }
  async closePosition(): Promise<BrokerOrder> { throw new VenueError('tool-trading never closes positions', 'rejected') }
  async flatten(): Promise<BrokerOrder[]> { return [] }
  async halt(): Promise<void> { this.current = 'halted' }
  async resume(): Promise<void> { this.current = 'ready' }
  subscribeOrderUpdates(listener: (event: OrderStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  get listenerCount(): number { return this.listeners.size }
  emit(event: OrderStreamEvent): void { for (const listener of this.listeners) listener(event) }
  private keys(): void {
    if (this.keysMissing) throw new VenueError('Alpaca keys not configured — add them in Settings → Trading', 'unconfigured')
  }
}

export default FakeVenue
```

- [ ] **Step 2: Write the failing snapshot tests**

`packages/experimental/tool-trading/tests/snapshot.spec.ts`:

```ts
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderRequest, ClientOrderId, OrderRequest, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalBook } from '../src/book.ts'
import {
  brokerRequest, drifted, openBuyNotional, openExposure, planOrder, remainingQty, takeSnapshot,
} from '../src/snapshot.ts'
import type { TradingOrderProposal } from '../src/types.ts'
import FakeVenue, { acceptedOrder } from './fake-venue.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const cid = brandString<ClientOrderId>('c')
const request = (overrides: Partial<BrokerOrderRequest>): BrokerOrderRequest =>
  ({ symbol: btc, side: 'buy', type: 'limit', timeInForce: 'gtc', clientOrderId: cid, ...overrides })

let ctx: Context
let venue: FakeVenue
beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(FakeVenue)
  venue = ctx.get('tradingVenue') as FakeVenue
})
afterEach(async () => { await ctx.fiber.dispose() })

describe('takeSnapshot', () => {
  it('reads account, position, open orders, reservations, and the day count in one snapshot', async () => {
    venue.held = [{ symbol: btc, qty: 0.01, qtyAvailable: 0.01, avgEntryPrice: 60_000, currentPrice: 62_830, marketValue: 628.3,
      unrealizedPl: 28.3 }]
    venue.open = [
      acceptedOrder(request({ qty: 0.002, limitPrice: 60_000 }), { filledQty: 0.001 }),
      acceptedOrder(request({ side: 'sell', qty: 0.003, limitPrice: 70_000 })),
      acceptedOrder(request({ symbol: aapl, type: 'market', notional: 500, timeInForce: 'day' })),
      acceptedOrder(request({ symbol: aapl, type: 'market', qty: 1, timeInForce: 'day' })),
    ]
    const book = new ProposalBook()
    const pending: TradingOrderProposal = {
      kind: 'order', proposalId: brandString<ProposalId>('p1'), source: 'dsh-agent', mode: 'paper',
      order: { symbol: btc, side: 'buy', qty: 0.004, type: 'market', timeInForce: 'gtc' }, rationale: 'r',
      quote: { bid: 1, ask: 1 }, marketOpen: true, referencePrice: 62_500, estimatedNotional: 250, equityPct: 0,
      reduceOnly: false, plan: { type: 'market', timeInForce: 'gtc', capped: false }, priceIncrement: 0.01, checks: [],
    }
    book.add(pending, SessionId('s'), { ticker: 'BTC/USD', side: 'buy', qty: 0.004, notional: 250 })
    const days: string[] = []
    const journal = { submittedOn: (day: string) => { days.push(day); return 2 } }
    const now = Date.UTC(2026, 9, 5, 14)
    const snapshot = await takeSnapshot(btc, { venue, book, journal, now })
    expect(days).toEqual(['2026-10-05'])
    expect(snapshot.risk).toMatchObject({
      now, marketOpen: true, equity: 100_000, cash: 100_000, lastEquity: 100_000, ordersToday: 3, halted: false,
      exposure: { positionQty: 0.01, openSellQty: 0.003, pendingBuyQty: 0.004, pendingSellQty: 0 },
    })
    expect(snapshot.risk.exposure.openBuyQty).toBeCloseTo(0.001, 10)
    expect(snapshot.risk.committedBuyNotional).toBeCloseTo(60 + 500 + 250, 6)
    const excluded = await takeSnapshot(btc, { venue, book, journal, now, excluding: brandString<ProposalId>('p1') })
    expect(excluded.risk).toMatchObject({ ordersToday: 2, exposure: { pendingBuyQty: 0 } })
    venue.current = 'halted'
    expect((await takeSnapshot(aapl, { venue, book, journal, now })).risk).toMatchObject({ halted: true, exposure: { positionQty: 0 } })
  })
})

describe('order math', () => {
  it('measures remaining quantity and open buy value', () => {
    const notional = acceptedOrder(request({ type: 'market', notional: 100 }), { filledQty: 0.5 })
    expect(remainingQty(acceptedOrder(request({ qty: 3 }), { filledQty: 1 }), 0)).toBe(2)
    expect(remainingQty(notional, 50)).toBe(1.5)
    expect(remainingQty(notional, 0)).toBe(0)
    expect(openExposure([acceptedOrder(request({ qty: 1, limitPrice: 10 }))], 'AAPL', 10)).toEqual({ openBuyQty: 0, openSellQty: 0 })
    expect(openBuyNotional([
      acceptedOrder(request({ type: 'market', notional: 100 }), { filledQty: 1, filledAvgPrice: 40 }),
      acceptedOrder(request({ type: 'stop', qty: 2, stopPrice: 30 })),
      acceptedOrder(request({ side: 'sell', qty: 5, limitPrice: 1_000 })),
    ])).toBe(60 + 60)
  })

  it('detects drift only between two usable prices', () => {
    expect(drifted(100, 101.5, 0.01)).toBe(true)
    expect(drifted(100, 100.9, 0.01)).toBe(false)
    expect(drifted(0, 150, 0.01)).toBe(false)
    expect(drifted(100, 0, 0.01)).toBe(false)
  })

  it('caps a market order at the approved price and refuses an unusable price or a zero cap', () => {
    const market: OrderRequest = { symbol: btc, side: 'buy', qty: 0.0002, type: 'market', timeInForce: 'gtc' }
    expect(planOrder(market, 62_835, 0.01, false, 0.01)).toEqual({ type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', capped: true })
    expect(planOrder({ ...market, side: 'sell' }, 0, 0.01, true, 0.01)).toEqual({ type: 'market', timeInForce: 'gtc', capped: false })
    expect(() => planOrder(market, Number.NaN, 0.01, false, 0.01)).toThrow('the approved price is not usable for a price cap; propose again')
    expect(() => planOrder(market, 0.001, 0.01, false, 0.01))
      .toThrow('the price cap rounds to zero at this price tick; propose a limit order instead')
  })

  it('copies exactly one size and the bracket into the broker request', () => {
    const order: OrderRequest = {
      symbol: aapl, side: 'buy', qty: 2, type: 'stop_limit', limitPrice: 231, stopPrice: 230, timeInForce: 'day',
      bracket: { takeProfit: 250, stopLoss: 220 },
    }
    expect(brokerRequest(order, { type: 'stop_limit', limitPrice: 231, stopPrice: 230, timeInForce: 'day', capped: false }, cid))
      .toEqual({ ...order, clientOrderId: cid })
    expect(brokerRequest({ symbol: btc, side: 'buy', notional: 50, type: 'market', timeInForce: 'gtc' },
      { type: 'market', timeInForce: 'gtc', capped: false }, cid))
      .toEqual({ symbol: btc, side: 'buy', notional: 50, type: 'market', timeInForce: 'gtc', clientOrderId: cid })
  })
})
```

- [ ] **Step 3: Write the failing bars tests**

`packages/experimental/tool-trading/tests/bars.spec.ts`:

```ts
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
    expect(full).toMatch(/Indicators: EMA\(20\) [\d.]+; RSI\(14\) [\d.]+; Bollinger\(20,2\) upper [\d.]+ \/ middle [\d.]+ \/ lower [\d.]+\./)
    expect(renderBars(barsReport(btc, '1h', [{ t: start, o: 2, h: 3, l: 1, c: 1, v: 1 }], 1, []))).toContain('change -50%.')
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/snapshot.spec.ts packages/experimental/tool-trading/tests/bars.spec.ts`
Expected: FAIL — `Cannot find module '../src/snapshot.ts'` and `'../src/bars.ts'`.

- [ ] **Step 5: Write `src/snapshot.ts`**

```ts
/**
 * Account state for one risk check, and the order math between a checked proposal and the broker request.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/snapshot
 */
import {
  type AccountSnapshot, type BrokerOrder, type BrokerOrderRequest, type ClientOrderId, type OrderRequest, planSubmission,
  type ProposalId, type Quote, type RiskSnapshot, type SubmissionPlan, type TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'
import type { TradingVenueGateway } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { ProposalBook } from './book.ts'
import { tradingDay } from './ids.ts'
import type { Journal } from './journal.ts'

/** Venue reads one snapshot needs. */
export type SnapshotVenue = Pick<TradingVenueGateway, 'latestQuote' | 'marketOpen' | 'account' | 'positions' | 'openOrders' | 'status'>

/** Inputs of one snapshot. */
export interface SnapshotSources {
  /** The venue, read fresh for every snapshot. */
  readonly venue: SnapshotVenue
  /** Pending proposals and their reservations. */
  readonly book: ProposalBook
  /** Journal for today's order count. */
  readonly journal: Pick<Journal, 'submittedOn'>
  /** Check time, UTC epoch milliseconds. */
  readonly now: number
  /** Proposal to leave out of the reservations (the one being re-checked). */
  readonly excluding?: ProposalId
}

/** Everything one risk check reads. */
export interface DeskSnapshot {
  /** `checkRisk` input. */
  readonly risk: RiskSnapshot
  /** Account values. */
  readonly account: AccountSnapshot
  /** Latest quote. */
  readonly quote: Quote
  /** Whether the instrument's market is open. */
  readonly marketOpen: boolean
}

/**
 * Quantity an open order may still fill.
 * @param order - open order.
 * @param price - price to convert a notional order's remaining value; 0 when unknown.
 * @returns remaining quantity, never negative.
 */
export function remainingQty(order: BrokerOrder, price: number): number {
  if (order.qty !== undefined) return Math.max(order.qty - order.filledQty, 0)
  if (order.notional !== undefined && price > 0) return Math.max(order.notional / price - order.filledQty, 0)
  return 0
}

/**
 * Open buy and sell quantities for one instrument.
 * @param orders - open orders.
 * @param ticker - instrument ticker.
 * @param price - the instrument's current mid, for notional orders.
 * @returns open quantities as if filled.
 */
export function openExposure(orders: readonly BrokerOrder[], ticker: string, price: number): { openBuyQty: number; openSellQty: number } {
  let openBuyQty = 0
  let openSellQty = 0
  for (const order of orders) {
    if (order.symbol.ticker !== ticker) continue
    if (order.side === 'buy') openBuyQty += remainingQty(order, price)
    else openSellQty += remainingQty(order, price)
  }
  return { openBuyQty, openSellQty }
}

/**
 * Value of open buy orders across instruments: the unfilled notional, else remaining quantity at the limit or stop
 * price. An open market buy without either counts as 0.
 * @param orders - open orders.
 * @returns dollars committed to open buys.
 */
export function openBuyNotional(orders: readonly BrokerOrder[]): number {
  return orders.filter(order => order.side === 'buy').reduce((sum, order) => {
    if (order.notional !== undefined) return sum + Math.max(order.notional - order.filledQty * (order.filledAvgPrice ?? 0), 0)
    const price = order.limitPrice ?? order.stopPrice ?? 0
    return sum + remainingQty(order, price) * price
  }, 0)
}

/**
 * Read everything one risk check needs, in parallel, and add the reservations and today's count.
 * @param symbol - instrument of the order.
 * @param sources - venue, book, journal, clock, and an optional proposal to leave out.
 * @returns the snapshot.
 */
export async function takeSnapshot(symbol: TradingSymbol, sources: SnapshotSources): Promise<DeskSnapshot> {
  const { venue, book, journal, now, excluding } = sources
  const [quote, marketOpen, account, positions, orders] = await Promise.all([
    venue.latestQuote(symbol), venue.marketOpen(symbol), venue.account(), venue.positions(), venue.openOrders(),
  ])
  const position = positions.find(candidate => candidate.symbol.ticker === symbol.ticker)
  const open = openExposure(orders, symbol.ticker, (quote.bid + quote.ask) / 2)
  return {
    quote, marketOpen, account,
    risk: {
      now, quote, marketOpen, equity: account.equity, cash: account.cash, lastEquity: account.lastEquity,
      committedBuyNotional: openBuyNotional(orders) + book.pendingBuyNotional(excluding),
      exposure: { positionQty: position?.qty ?? 0, ...open, ...book.exposure(symbol.ticker, excluding) },
      ordersToday: journal.submittedOn(tradingDay(now)) + book.pendingOrders(excluding),
      halted: venue.status() === 'halted',
    },
  }
}

/**
 * Whether the price moved beyond the tolerance since approval. Unpriced sides are left to the risk check.
 * @param approved - reference price on the approved proposal.
 * @param current - reference price at the re-check.
 * @param tolerance - allowed drift as a fraction.
 * @returns true when both prices are usable and differ by more than the tolerance.
 */
export function drifted(approved: number, current: number, tolerance: number): boolean {
  return approved > 0 && current > 0 && Math.abs(current - approved) / approved > tolerance
}

/**
 * Plan the broker order, refusing an approved price that cannot cap a market order and a cap that rounds to zero.
 * @param order - approved order.
 * @param approvedPrice - reference price on the approved proposal.
 * @param tolerance - drift tolerance.
 * @param reduceOnly - whether the order only reduces a position, from the latest check.
 * @param increment - price tick.
 * @returns the broker-facing type, prices, and time in force.
 * @throws Error with a model-facing reason.
 */
export function planOrder(
  order: OrderRequest, approvedPrice: number, tolerance: number, reduceOnly: boolean, increment: number,
): SubmissionPlan {
  const caps = order.type === 'market' && order.notional === undefined && !reduceOnly
  if (caps && !(Number.isFinite(approvedPrice) && approvedPrice > 0)) {
    throw new Error('the approved price is not usable for a price cap; propose again')
  }
  const plan = planSubmission(order, approvedPrice, tolerance, reduceOnly, increment)
  if (plan.capped && !(plan.limitPrice !== undefined && plan.limitPrice > 0)) {
    throw new Error('the price cap rounds to zero at this price tick; propose a limit order instead')
  }
  return plan
}

/**
 * The request sent to the venue: exactly the one size the order carries, the planned type and prices, and the key.
 * @param order - approved order.
 * @param plan - planned broker fields.
 * @param clientOrderId - idempotency key.
 * @returns the broker request.
 */
export function brokerRequest(order: OrderRequest, plan: SubmissionPlan, clientOrderId: ClientOrderId): BrokerOrderRequest {
  return {
    symbol: order.symbol,
    side: order.side,
    ...order.qty === undefined ? {} : { qty: order.qty },
    ...order.notional === undefined ? {} : { notional: order.notional },
    type: plan.type,
    ...plan.limitPrice === undefined ? {} : { limitPrice: plan.limitPrice },
    ...plan.stopPrice === undefined ? {} : { stopPrice: plan.stopPrice },
    timeInForce: plan.timeInForce,
    ...order.bracket === undefined ? {} : { bracket: order.bracket },
    clientOrderId,
  }
}
```

- [ ] **Step 6: Write `src/bars.ts`**

```ts
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
```

- [ ] **Step 7: Run both with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/snapshot.spec.ts packages/experimental/tool-trading/tests/bars.spec.ts --coverage --coverage.include='packages/experimental/tool-trading/src/{snapshot,bars}.ts'`
Expected: PASS; both files 100%. If a pinned number differs (`changePct` 3.6 is `(129.5 - 125) / 125 * 100`), recompute it from the series above rather than loosening the assertion.

- [ ] **Step 8: Commit**

```bash
git add packages/experimental/tool-trading/src/snapshot.ts packages/experimental/tool-trading/src/bars.ts packages/experimental/tool-trading/tests
git commit -m "feat(tool-trading): add the desk snapshot, order planning, and the get_bars report"
```

---
### Task 7: The executor service — proposals, approval projection, fail-closed execution

**Files:**
- Create: `packages/experimental/tool-trading/src/format.ts`, `packages/experimental/tool-trading/src/executor.ts`
- Modify: `packages/experimental/tool-trading/src/index.ts` (replace the interim root)
- Create: `packages/experimental/tool-trading/tests/harness.ts`
- Test: `packages/experimental/tool-trading/tests/format.spec.ts`, `packages/experimental/tool-trading/tests/executor.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6; `ctx.tradingVenue` (Task 1 methods); `ctx.storageDomain.open`; `ctx.sessions.get(id)`; `session.append(type, data)`; `ctx.on('session/event', (session, event) => …)` (`packages/core/session/src/index.ts:72`).
- Produces (Tasks 8–14 and Plan 5 rely on these):
  - `format.ts`: constants `KEYS_MISSING`, `HALTED`, `BLOCKED`, `TRADING_BLOCKED`, `NO_CHECKED_PROPOSAL`, `PRICE_MOVED`, `APPROVAL_OFF`, `NO_AGENT`, `DUPLICATE_CLIENT_ORDER_ID = 40010001`; `compact<T>(value)`, `money`, `bounded`, `describeOrder`, `proposalSummary(p, tolerance)`, `cancelSummary(p)`, `fillText(fill)`, `failureOf(error): { outcome: 'failed' | 'unknown'; message }`, `isInsufficientBalance(error)`, `renderQuote`, `renderAccount`, `renderPositions`, `renderOrders`, `renderOrderReport`.
  - `class TradingExecutor extends Service` at `ctx.tradingExecutor` (default export of the package root) with `static inject = ['tradingVenue', 'tools', 'storageDomain', 'sessions', 'agents']`, `static Config`, and public methods `status(): VenueStatus`, `barWindow(): { defaultCount: number; cap: number }`, `quote(symbol: string): Promise<QuoteReport>`, `bars(request: BarsRequest): Promise<BarsReport>`, `account(): Promise<AccountReport>`, `positions(): Promise<PositionReport[]>`, `orders(): Promise<OrdersReport>`, `proposeOrder(input: ProposedOrder, context: ProposalContext): Promise<ProposeResult>`, `proposeCancel(input: ProposedCancel, context: ProposalContext): Promise<ProposeResult>`, `proposalForCall(sessionId: SessionId, callId: ToolCallId): ProposalId | undefined`, `execute(proposalId: ProposalId, sessionId: SessionId): Promise<OrderReport>`.
  - `tests/harness.ts`: `TEST_CONFIG`, `interface DeskOptions { config?; approval?: 'ask' | 'never' | 'none'; root?; sessionId?; prepare?(venue) }`, `interface Desk { ctx; venue; executor; session; agent; injected; answer; events(type); close() }`, `bootDesk(options?): Promise<Desk>`.

- [ ] **Step 1: Write the failing format tests**

`packages/experimental/tool-trading/tests/format.spec.ts`:

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrder, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { describe, expect, it } from 'vitest'
import {
  bounded, cancelSummary, compact, describeOrder, failureOf, fillText, isInsufficientBalance, proposalSummary, renderAccount,
  renderOrderReport, renderOrders, renderPositions, renderQuote,
} from '../src/format.ts'
import type { TradingOrderProposal } from '../src/types.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const pid = brandString<ProposalId>('p-1')

const proposal = (overrides: Partial<TradingOrderProposal>): TradingOrderProposal => ({
  kind: 'order', proposalId: pid, source: 'dsh-agent', mode: 'paper',
  order: { symbol: btc, side: 'buy', qty: 0.0002, type: 'market', timeInForce: 'gtc' }, rationale: 'Because.',
  quote: { bid: 62_830, ask: 62_835 }, marketOpen: true, referencePrice: 62_835, estimatedNotional: 12.567, equityPct: 0.000126,
  reduceOnly: false, plan: { type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', capped: true }, priceIncrement: 0.01,
  checks: [{ id: 'halted', ok: true, detail: 'trading is not halted' }], ...overrides,
})

describe('order descriptions and summaries', () => {
  it('describes sizes, prices, and brackets', () => {
    expect(describeOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'market', timeInForce: 'gtc' })).toBe('Buy 0.0002 BTC/USD market gtc')
    expect(describeOrder({ symbol: btc, side: 'sell', notional: 25, type: 'market', timeInForce: 'ioc' })).toBe('Sell $25.00 of BTC/USD market ioc')
    expect(describeOrder({
      symbol: aapl, side: 'buy', qty: 2, type: 'stop_limit', limitPrice: 231, stopPrice: 230, timeInForce: 'day',
      bracket: { takeProfit: 250, stopLoss: 220 },
    })).toBe('Buy 2 AAPL stop_limit at $231.00 stop $230.00 day, take profit $250.00, stop loss $220.00')
  })

  it('states the price cap or why there is none, and a closed market', () => {
    const line = (p: TradingOrderProposal): string | undefined => proposalSummary(p, 0.01).split('\n')[2]
    expect(line(proposal({}))).toBe('Price cap: sent as a limit order (ioc) at $63,463.35 so the fill stays within 1% of the approved price.')
    expect(line(proposal({ order: { symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 62_000, timeInForce: 'gtc' },
      plan: { type: 'limit', limitPrice: 62_000, timeInForce: 'gtc', capped: false } })))
      .toBe('No price cap needed: a limit order carries its own price.')
    expect(line(proposal({ order: { symbol: btc, side: 'buy', notional: 25, type: 'market', timeInForce: 'gtc' },
      plan: { type: 'market', timeInForce: 'gtc', capped: false } }))).toBe('No price cap: the notional amount caps the cost.')
    expect(line(proposal({ order: { symbol: btc, side: 'sell', qty: 0.001, type: 'market', timeInForce: 'gtc' }, reduceOnly: true,
      plan: { type: 'market', timeInForce: 'gtc', capped: false } })))
      .toBe('No price cap: a reduce-only exit is sent as a market order so it fills in a fast move.')
    expect(proposalSummary(proposal({ order: { symbol: aapl, side: 'buy', qty: 1, type: 'limit', limitPrice: 230, timeInForce: 'day' },
      plan: { type: 'limit', limitPrice: 230, timeInForce: 'day', capped: false }, marketOpen: false }), 0.01).split('\n'))
      .toEqual([
        'PAPER Buy 1 AAPL limit at $230.00 day',
        'Estimated $12.57 (0.0% of equity); bid $62,830.00 / ask $62,835.00',
        'No price cap needed: a limit order carries its own price.',
        'The market is closed: the order is queued until market open.',
        'Checks passed: halted (trading is not halted)',
        'Rationale: Because.',
      ])
  })

  it('summarizes a cancellation and a fill', () => {
    const order: BrokerOrder = {
      id: brandString('order-9'), clientOrderId: brandString('c'), symbol: btc, side: 'buy', type: 'limit', timeInForce: 'gtc',
      qty: 0.0002, limitPrice: 62_000, filledQty: 0, status: 'open',
    }
    expect(cancelSummary({ kind: 'cancel', proposalId: pid, source: 'dsh-agent', mode: 'live', order, rationale: 'Stale.' }))
      .toBe('LIVE Cancel order order-9: buy 0.0002 BTC/USD limit at $62,000.00 gtc, filled 0\nRationale: Stale.')
    const fill = { proposalId: pid, orderId: order.id, ticker: 'BTC/USD', side: 'buy', fillQty: 0.0001, filledQty: 0.0001,
      status: 'partially_filled', t: 1 } as const
    expect(fillText({ ...fill, fillPrice: 62_000 }))
      .toBe('Order update: your buy of BTC/USD (order order-9) filled 0.0001 at $62,000.00; 0.0001 filled in total, order partially filled.')
    expect(fillText(fill)).toContain('filled 0.0001 at an unreported price;')
  })
})

describe('failures', () => {
  it('maps venue failures to what the model is told', () => {
    expect(failureOf(new VenueError('lost', 'unknown-outcome')))
      .toEqual({ outcome: 'unknown', message: 'the order outcome is unknown: lost. Check list_orders before proposing again.' })
    expect(failureOf(new VenueError('client_order_id must be unique', 'rejected', 40010001))).toEqual({
      outcome: 'unknown',
      message: 'the broker reports this order id as already used but does not show the order; check list_orders before proposing again',
    })
    expect(failureOf(new VenueError('insufficient buying power', 'rejected', 40310000)))
      .toEqual({ outcome: 'failed', message: 'insufficient buying power' })
    expect(failureOf('plain text')).toEqual({ outcome: 'failed', message: 'plain text' })
    expect(bounded('short')).toBe('short')
    expect(bounded('y'.repeat(301))).toBe(`${'y'.repeat(300)}…`)
    expect(isInsufficientBalance(new VenueError('insufficient balance for BTC', 'rejected'))).toBe(true)
    expect(isInsufficientBalance(new VenueError('insufficient balance for BTC', 'unavailable'))).toBe(false)
    expect(isInsufficientBalance(new Error('insufficient balance'))).toBe(false)
  })

  it('drops undefined fields', () => {
    expect(compact<{ a: number; b?: number }>({ a: 1, b: undefined })).toEqual({ a: 1 })
  })
})

describe('renderers', () => {
  it('renders quotes, the account, positions, orders, and order reports', () => {
    const quote = { symbol: 'BTC/USD', assetClass: 'crypto', bid: 62_830, ask: 62_835, mid: 62_832.5, ageSeconds: 0, marketOpen: true } as const
    expect(renderQuote(quote)).toBe('BTC/USD bid $62,830.00 ask $62,835.00 (mid $62,832.50); quote 0 s old; market open.')
    expect(renderQuote({ ...quote, marketOpen: false })).toContain('market closed — new orders queue until it opens.')
    const account = { mode: 'paper', status: 'ready', equity: 100_000, cash: 100_000, buyingPower: 100_000, dayPl: 0, dayPlPct: 0,
      tradingBlocked: false } as const
    expect(renderAccount(account))
      .toBe('PAPER account, ready: equity $100,000.00, cash $100,000.00, buying power $100,000.00, day P&L $0.00 (0.00%).')
    expect(renderAccount({ ...account, tradingBlocked: true })).toMatch(/ The broker blocks trading on this account\.$/)
    expect(renderPositions([])).toBe('No open positions.')
    expect(renderPositions([{ symbol: 'BTC/USD', qty: 0.001, qtyAvailable: 0.0005, avgEntryPrice: 60_000, currentPrice: 62_830,
      marketValue: 62.83, unrealizedPl: 2.83 }])).toBe(
      'BTC/USD: qty 0.001 (0.0005 available), average entry $60,000.00, now $62,830.00, value $62.83, unrealized $2.83')
    expect(renderOrders({ open: [], today: [] })).toBe('No open orders.\nNo desk orders today.')
    expect(renderOrders({
      open: [{ orderId: 'order-9', symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', qty: 0.001, limitPrice: 59_000, stopPrice: 59_500,
        timeInForce: 'gtc', filledQty: 0, status: 'open' }],
      today: [
        { proposalId: 'p-1', symbol: 'BTC/USD', side: 'buy', qty: 0.0002, status: 'filled', filledQty: 0.0002, filledAvgPrice: 62_831.5,
          orderId: 'order-1' },
        { proposalId: 'p-2', symbol: 'AAPL', side: 'buy', notional: 50, status: 'denied', filledQty: 0, note: 'cash: needs more' },
      ],
    })).toBe([
      'Open orders:',
      '- order-9: sell 0.001 BTC/USD stop_limit at $59,000.00 stop $59,500.00 gtc, filled 0, open',
      'Desk orders today:',
      '- p-1: buy 0.0002 BTC/USD: filled, 0.0002 filled at $62,831.50 (order order-1)',
      '- p-2: buy $50.00 of AAPL: denied, 0 filled — cash: needs more',
    ].join('\n'))
    const report = { proposalId: 'p-1', orderId: 'order-1', symbol: 'BTC/USD', side: 'buy', type: 'limit', qty: 0.0002,
      limitPrice: 63_463.35, timeInForce: 'ioc', status: 'open', filledQty: 0, capped: true } as const
    expect(renderOrderReport(report))
      .toBe('Placed buy 0.0002 BTC/USD as a limit at $63,463.35 (ioc), capped near the approved price; order order-1 is open.')
    expect(renderOrderReport({ proposalId: 'p-1', orderId: 'order-1', symbol: 'BTC/USD', side: 'buy', type: 'market', notional: 50,
      timeInForce: 'ioc', status: 'filled', filledQty: 0.0008, filledAvgPrice: 62_500, capped: false }))
      .toBe('Placed buy $50.00 of BTC/USD market (ioc); order order-1 is filled; 0.0008 filled at $62,500.00.')
    expect(renderOrderReport({ proposalId: 'p-1', orderId: 'order-1', symbol: 'BTC/USD', side: 'sell', type: 'stop', qty: 1,
      stopPrice: 60_000, timeInForce: 'gtc', status: 'partially_filled', filledQty: 0.5, capped: false }))
      .toBe('Placed sell 1 BTC/USD stop stop $60,000.00 (gtc); order order-1 is partially filled; 0.5 filled.')
    expect(renderOrderReport({ ...report, status: 'cancel_requested' })).toBe('Cancellation requested for order order-1 (buy BTC/USD).')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/format.spec.ts`
Expected: FAIL — `Cannot find module '../src/format.ts'`.

- [ ] **Step 3: Write `src/format.ts`**

```ts
/**
 * Model-facing texts of the executor and its tools: refusals, the approval summary, fill notices, result renderers, and
 * how venue failures are reported.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/format
 */
import type { BrokerOrder, OrderRequest } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type {
  AccountReport, JournalRow, OrderReport, OrderRow, OrdersReport, PositionReport, QuoteReport, TradingCancelProposal,
  TradingFillEvent, TradingOrderProposal,
} from './types.ts'

/** The venue has no keys (or setup has not completed). */
export const KEYS_MISSING = 'Alpaca keys not configured — add them in Settings → Trading'
/** Orders are refused while the desk is halted. */
export const HALTED = 'trading is halted; only the user can resume trading'
/** Orders are refused while the venue is blocked. */
export const BLOCKED = 'new orders are blocked because the account cannot be made safe; ask the user to check the trading settings'
/** The broker itself blocks trading on the account. */
export const TRADING_BLOCKED = 'the broker blocks trading on this account'
/** The tool body found no checked, approved proposal for its call. */
export const NO_CHECKED_PROPOSAL = 'no checked proposal for this call'
/** Prefix of a post-approval re-check failure. */
export const PRICE_MOVED = 'price moved; propose again'
/** Orders are never auto-approved. */
export const APPROVAL_OFF = "orders need the user's approval, and approval prompts are off in this session"
/** Order tools need a session to record the proposal in. */
export const NO_AGENT = 'placing or cancelling orders needs an agent session'
/** Alpaca's code for a client order id that was already used. */
export const DUPLICATE_CLIENT_ORDER_ID = 40010001

const MAX_MESSAGE = 300
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Drop `undefined` fields so an optional field is absent rather than undefined.
 * @param value - every field of `T`, optional ones possibly undefined.
 * @returns the value without undefined fields.
 */
export function compact<T extends object>(value: { readonly [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as unknown as T
}

/**
 * @param value - dollars.
 * @returns `$1,234.56`.
 */
export function money(value: number): string {
  return USD.format(value)
}

/**
 * Cap a broker message before it reaches the model.
 * @param text - message.
 * @returns at most 300 characters plus an ellipsis.
 */
export function bounded(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE)}…`
}

const words = (status: string): string => status.replaceAll('_', ' ')
const size = (qty: number | undefined, notional: number | undefined): string =>
  qty !== undefined ? String(qty) : `${money(notional ?? 0)} of`
const prices = (limitPrice: number | undefined, stopPrice: number | undefined): string =>
  `${limitPrice === undefined ? '' : ` at ${money(limitPrice)}`}${stopPrice === undefined ? '' : ` stop ${money(stopPrice)}`}`
const percent = (fraction: number): string => `${Number((fraction * 100).toFixed(2))}%`

/**
 * @param order - an order as proposed.
 * @returns `Buy 0.0002 BTC/USD market gtc`.
 */
export function describeOrder(order: OrderRequest): string {
  const side = `${order.side.charAt(0).toUpperCase()}${order.side.slice(1)}`
  const bracket = order.bracket === undefined
    ? ''
    : `, take profit ${money(order.bracket.takeProfit)}, stop loss ${money(order.bracket.stopLoss)}`
  return `${side} ${size(order.qty, order.notional)} ${order.symbol.ticker} ${order.type}${prices(order.limitPrice, order.stopPrice)} `
    + `${order.timeInForce}${bracket}`
}

function brokerOrderText(order: BrokerOrder): string {
  const priced = prices(order.limitPrice, order.stopPrice)
  return `${order.side} ${size(order.qty, order.notional)} ${order.symbol.ticker} ${order.type}${priced} ${order.timeInForce}, `
    + `filled ${order.filledQty}`
}

function capLine(proposal: TradingOrderProposal, tolerance: number): string {
  const { plan, order } = proposal
  if (plan.capped) {
    return `Price cap: sent as a limit order (${plan.timeInForce}) at ${money(plan.limitPrice ?? 0)} so the fill stays within `
      + `${percent(tolerance)} of the approved price.`
  }
  if (order.type !== 'market') return `No price cap needed: a ${order.type} order carries its own price.`
  if (order.notional !== undefined) return 'No price cap: the notional amount caps the cost.'
  return 'No price cap: a reduce-only exit is sent as a market order so it fills in a fast move.'
}

/**
 * The approval reason for an order proposal: mode and order, estimate and quote, the price cap, a closed-market note,
 * every passed check, and the rationale.
 * @param proposal - the checked proposal (every check passed).
 * @param tolerance - drift tolerance, for the cap line.
 * @returns one line per item.
 */
export function proposalSummary(proposal: TradingOrderProposal, tolerance: number): string {
  return [
    `${proposal.mode.toUpperCase()} ${describeOrder(proposal.order)}`,
    `Estimated ${money(proposal.estimatedNotional)} (${(proposal.equityPct * 100).toFixed(1)}% of equity); `
      + `bid ${money(proposal.quote.bid)} / ask ${money(proposal.quote.ask)}`,
    capLine(proposal, tolerance),
    ...proposal.order.symbol.assetClass === 'equity' && !proposal.marketOpen
      ? ['The market is closed: the order is queued until market open.']
      : [],
    `Checks passed: ${proposal.checks.map(check => `${check.id} (${check.detail})`).join('; ')}`,
    `Rationale: ${proposal.rationale}`,
  ].join('\n')
}

/**
 * @param proposal - the checked cancellation.
 * @returns the approval reason for a cancellation.
 */
export function cancelSummary(proposal: TradingCancelProposal): string {
  return `${proposal.mode.toUpperCase()} Cancel order ${proposal.order.id}: ${brokerOrderText(proposal.order)}\n`
    + `Rationale: ${proposal.rationale}`
}

/**
 * @param fill - one recorded fill.
 * @returns the message the proposing agent receives with its next request.
 */
export function fillText(fill: TradingFillEvent): string {
  const price = fill.fillPrice === undefined ? 'at an unreported price' : `at ${money(fill.fillPrice)}`
  return `Order update: your ${fill.side} of ${fill.ticker} (order ${fill.orderId}) filled ${fill.fillQty} ${price}; `
    + `${fill.filledQty} filled in total, order ${words(fill.status)}.`
}

/**
 * How a failed submission is reported. An unknown outcome and a reused client order id may mean the order exists, so
 * neither is reported as "not placed".
 * @param error - what the venue (or the re-check) threw.
 * @returns the journal outcome and the model-facing message.
 */
export function failureOf(error: unknown): { readonly outcome: 'failed' | 'unknown'; readonly message: string } {
  if (error instanceof VenueError) {
    if (error.code === 'unknown-outcome') {
      const message = `the order outcome is unknown: ${bounded(error.message)}. Check list_orders before proposing again.`
      return { outcome: 'unknown', message }
    }
    if (error.code === 'rejected' && error.brokerCode === DUPLICATE_CLIENT_ORDER_ID) {
      return {
        outcome: 'unknown',
        message: 'the broker reports this order id as already used but does not show the order; check list_orders before proposing again',
      }
    }
  }
  return { outcome: 'failed', message: bounded(error instanceof Error ? error.message : String(error)) }
}

/**
 * @param error - a submission failure.
 * @returns whether the broker refused for insufficient balance (coins from a fill not yet released).
 */
export function isInsufficientBalance(error: unknown): boolean {
  return error instanceof VenueError && error.code === 'rejected' && /insufficient balance/i.test(error.message)
}

/**
 * @param report - `get_quote` result.
 * @returns model-facing text.
 */
export function renderQuote(report: QuoteReport): string {
  const market = report.marketOpen ? 'market open' : 'market closed — new orders queue until it opens'
  return `${report.symbol} bid ${money(report.bid)} ask ${money(report.ask)} (mid ${money(report.mid)}); `
    + `quote ${report.ageSeconds} s old; ${market}.`
}

/**
 * @param report - `get_account` result.
 * @returns model-facing text.
 */
export function renderAccount(report: AccountReport): string {
  return `${report.mode.toUpperCase()} account, ${report.status}: equity ${money(report.equity)}, cash ${money(report.cash)}, `
    + `buying power ${money(report.buyingPower)}, day P&L ${money(report.dayPl)} (${report.dayPlPct.toFixed(2)}%).`
    + `${report.tradingBlocked ? ' The broker blocks trading on this account.' : ''}`
}

/**
 * @param rows - `get_positions` result.
 * @returns model-facing text, one line per position.
 */
export function renderPositions(rows: readonly PositionReport[]): string {
  if (rows.length === 0) return 'No open positions.'
  return rows.map(row => `${row.symbol}: qty ${row.qty} (${row.qtyAvailable} available), average entry ${money(row.avgEntryPrice)}, `
    + `now ${money(row.currentPrice)}, value ${money(row.marketValue)}, unrealized ${money(row.unrealizedPl)}`).join('\n')
}

function openRow(row: OrderRow): string {
  return `- ${row.orderId}: ${row.side} ${size(row.qty, row.notional)} ${row.symbol} ${row.type}${prices(row.limitPrice, row.stopPrice)} `
    + `${row.timeInForce}, filled ${row.filledQty}, ${words(row.status)}`
}

function journalRow(row: JournalRow): string {
  const average = row.filledAvgPrice === undefined ? '' : ` at ${money(row.filledAvgPrice)}`
  const order = row.orderId === undefined ? '' : ` (order ${row.orderId})`
  const note = row.note === undefined ? '' : ` — ${row.note}`
  return `- ${row.proposalId}: ${row.side} ${size(row.qty, row.notional)} ${row.symbol}: ${words(row.status)}, ${row.filledQty} filled`
    + `${average}${order}${note}`
}

/**
 * @param report - `list_orders` result.
 * @returns model-facing text: open broker orders, then today's desk orders.
 */
export function renderOrders(report: OrdersReport): string {
  return [
    ...report.open.length === 0 ? ['No open orders.'] : ['Open orders:', ...report.open.map(openRow)],
    ...report.today.length === 0 ? ['No desk orders today.'] : ['Desk orders today:', ...report.today.map(journalRow)],
  ].join('\n')
}

/**
 * @param report - `place_order` or `cancel_order` result.
 * @returns model-facing text.
 */
export function renderOrderReport(report: OrderReport): string {
  if (report.status === 'cancel_requested') return `Cancellation requested for order ${report.orderId} (${report.side} ${report.symbol}).`
  const how = report.capped
    ? `as a limit${prices(report.limitPrice, undefined)} (${report.timeInForce}), capped near the approved price`
    : `${report.type}${prices(report.limitPrice, report.stopPrice)} (${report.timeInForce})`
  const fill = report.filledQty > 0
    ? `; ${report.filledQty} filled${report.filledAvgPrice === undefined ? '' : ` at ${money(report.filledAvgPrice)}`}`
    : ''
  return `Placed ${report.side} ${size(report.qty, report.notional)} ${report.symbol} ${how}; order ${report.orderId} is `
    + `${words(report.status)}${fill}.`
}
```

- [ ] **Step 4: Run the format tests with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/format.spec.ts --coverage --coverage.include='packages/experimental/tool-trading/src/format.ts'`
Expected: PASS; `format.ts` 100%.

- [ ] **Step 5: Write the test harness**

`packages/experimental/tool-trading/tests/harness.ts`:

```ts
/**
 * Boots the executor over a real storage stack, session store, agent registry, tool registry, and approval service,
 * with the in-memory venue as the only fake. One registered agent owns one session with an open turn.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent, type SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { vi } from 'vitest'
import TradingExecutor, { type Config } from '../src/index.ts'
import FakeVenue from './fake-venue.ts'

/** Timers long enough that tests drive reconciliation themselves; one-millisecond exit retries. */
export const TEST_CONFIG: Partial<Config> = { reconcileMs: 3_600_000, exitRetryMs: [1, 1] }

/** How to boot a desk. */
export interface DeskOptions {
  /** Executor configuration over {@link TEST_CONFIG}. */
  readonly config?: Partial<Config>
  /** Approval service policy, or `none` to compose no approval service. */
  readonly approval?: 'ask' | 'never' | 'none'
  /** Storage folder to reuse (restart tests); the caller removes it. */
  readonly root?: string
  /** Session id of the desk's agent. */
  readonly sessionId?: string
  /** Set venue state before the executor starts. */
  readonly prepare?: (venue: FakeVenue) => void
}

/** A booted desk. */
export interface Desk {
  readonly ctx: Context
  readonly venue: FakeVenue
  readonly executor: TradingExecutor
  readonly session: Session
  readonly agent: Agent
  /** Messages injected into the agent. */
  readonly injected: UserMessage[]
  /** What the approval answerer returns next. */
  answer: ApprovalOutcome
  /** Events of one type appended to the desk session. */
  events<T extends SessionEventType>(type: T): SessionEvent<T>[]
  /** Dispose everything; safe to call twice. */
  close(): Promise<void>
}

/**
 * Boot a desk.
 * @param options - configuration, approval policy, storage folder, session id, venue preparation.
 * @returns the desk.
 */
export async function bootDesk(options: DeskOptions = {}): Promise<Desk> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-tool-trading-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.approval !== 'none') await ctx.plugin(ApprovalService, { policy: options.approval ?? 'ask' })
  await ctx.plugin(FakeVenue)
  const venue = ctx.get('tradingVenue')
  if (!(venue instanceof FakeVenue)) throw new Error('the fake venue did not start')
  options.prepare?.(venue)
  // The session and its agent exist before the executor starts, so startup reconciliation can reach them.
  const session = ctx.sessions.create(SessionId(options.sessionId ?? 'trading-session'))
  const injected: UserMessage[] = []
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: (message) => { injected.push(message) }, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  await ctx.plugin(TradingExecutor, { ...TEST_CONFIG, ...options.config })
  await vi.waitFor(() => { if (ctx.get('tradingExecutor') === undefined) throw new Error('the executor did not start') })
  const executor = ctx.get('tradingExecutor')
  if (executor === undefined) throw new Error('the executor did not start')
  let closed = false
  const desk: Desk = {
    ctx, venue, executor, session, agent, injected, answer: 'allowed-once',
    events<T extends SessionEventType>(type: T): SessionEvent<T>[] {
      return session.snapshotEvents().filter((event): event is SessionEvent<T> => event.type === type)
    },
    async close() {
      if (closed) return
      closed = true
      await ctx.fiber.dispose()
      if (options.root === undefined) await rm(root, { recursive: true, force: true })
    },
  }
  ctx.on('approval/request', async () => desk.answer)
  return desk
}
```

- [ ] **Step 6: Write the failing executor tests**

`packages/experimental/tool-trading/tests/executor.spec.ts`:

```ts
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, OrderRequest, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOCKED, HALTED, KEYS_MISSING, NO_CHECKED_PROPOSAL, TRADING_BLOCKED } from '../src/format.ts'
import { Journal } from '../src/journal.ts'
import type { ProposedOrder } from '../src/order-args.ts'
import type { ProposalContext, ProposeResult } from '../src/types.ts'
import { acceptedOrder } from './fake-venue.ts'
import { bootDesk, type Desk } from './harness.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const buy = (qty = 0.0002, overrides: Partial<OrderRequest> = {}): ProposedOrder =>
  ({ order: { symbol: btc, side: 'buy', qty, type: 'market', timeInForce: 'gtc', ...overrides }, rationale: 'Testing the desk.' })
const sell: ProposedOrder = { order: { symbol: btc, side: 'sell', qty: 0.001, type: 'market', timeInForce: 'gtc' }, rationale: 'Take profit.' }
const position = { symbol: btc, qty: 0.001, qtyAvailable: 0.001, avgEntryPrice: 60_000, currentPrice: 62_830, marketValue: 62.83,
  unrealizedPl: 2.83 }

let desk: Desk
afterEach(async () => {
  vi.restoreAllMocks()
  await desk.close()
})

const context = (callId = 'call-1'): ProposalContext => ({ session: desk.session, source: 'dsh-agent', callId: ToolCallId(callId) })

function approve(callId: string, outcome: ApprovalOutcome = 'allowed-once', toolName = 'place_order'): void {
  const id = ApprovalRequestId(`approval-${callId}`)
  desk.session.append('approval/asked', { id, toolName, callId: ToolCallId(callId) })
  desk.session.append('approval/decided', { id, outcome })
}

function idOf(result: ProposeResult): ProposalId {
  if (result.kind === 'denied') throw new Error(`denied: ${result.reasons.join('; ')}`)
  return result.proposalId
}

const today = async (): Promise<readonly unknown[]> => (await desk.executor.orders()).today

describe('proposing an order', () => {
  it('checks, reserves, records, and summarizes a passing proposal', async () => {
    desk = await bootDesk()
    const result = await desk.executor.proposeOrder(buy(), context())
    if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`)
    expect(result.summary.split('\n')).toEqual([
      'PAPER Buy 0.0002 BTC/USD market gtc',
      'Estimated $12.57 (0.0% of equity); bid $62,830.00 / ask $62,835.00',
      'Price cap: sent as a limit order (ioc) at $63,463.35 so the fill stays within 1% of the approved price.',
      'Checks passed: halted (trading is not halted); symbol-list (BTC/USD is allowed); stale-quote (quote is at most 30 s old); '
        + 'stop-type (market order); shorting (not a short sale); order-notional (order $12.57 vs max $1,000.00); '
        + 'position-size (position 0.0% of equity vs max 20.0%); cash (needs $12.57 of $100,000.00 cash); '
        + 'daily-loss (day P&L 0.0% vs limit -3.0%); orders-per-day (0 of 20 orders today)',
      'Rationale: Testing the desk.',
    ])
    expect(desk.events('trading/proposal').map(event => event.data)).toMatchObject([{
      kind: 'order', proposalId: result.proposalId, callId: 'call-1', source: 'dsh-agent', mode: 'paper', reduceOnly: false,
      quote: { bid: 62_830, ask: 62_835 }, plan: { type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', capped: true },
    }])
    expect(desk.executor.proposalForCall(desk.session.id, ToolCallId('call-1'))).toBe(result.proposalId)
    expect(await today()).toEqual([
      { proposalId: result.proposalId, symbol: 'BTC/USD', side: 'buy', qty: 0.0002, status: 'proposed', filledQty: 0 },
    ])
  })

  it('denies a proposal that breaks a limit without recording it, and journals the risk result', async () => {
    desk = await bootDesk()
    const reasons = ['order-notional: order $62,835.00 vs max $1,000.00', 'position-size: position 62.8% of equity vs max 20.0%']
    expect(await desk.executor.proposeOrder(buy(1), context())).toEqual({ kind: 'denied', reasons })
    expect(desk.events('trading/proposal')).toEqual([])
    expect(await today()).toMatchObject([{ status: 'denied', note: reasons.join('; ') }])
  })

  it("checks concurrent proposals against each other's reservations", async () => {
    desk = await bootDesk({ config: { maxOrderNotional: 20_000 } })
    const results = await Promise.all([
      desk.executor.proposeOrder(buy(0.2), context('call-1')),
      desk.executor.proposeOrder(buy(0.2), context('call-2')),
    ])
    expect(results.map(result => result.kind).sort()).toEqual(['denied', 'pending'])
    expect(results.find(result => result.kind === 'denied'))
      .toEqual({ kind: 'denied', reasons: ['position-size: position 25.1% of equity vs max 20.0%'] })
  })

  it('validates broker rules and the price tick before checking risk', async () => {
    desk = await bootDesk()
    expect(await desk.executor.proposeOrder(buy(0.0002, { type: 'limit', limitPrice: 62_000.123 }), context()))
      .toEqual({ kind: 'denied', reasons: ['limit_price 62000.123 is not a multiple of the 0.01 price tick'] })
    expect(await desk.executor.proposeOrder(buy(0.0002, { type: 'stop', stopPrice: 63_000, timeInForce: 'day' }), context()))
      .toEqual({ kind: 'denied', reasons: [
        'crypto orders support market, limit, and stop_limit; use stop_limit instead of stop', 'crypto orders use gtc or ioc',
      ] })
    const stopBuy: ProposedOrder = {
      order: { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', qty: 1, type: 'stop', stopPrice: 231, timeInForce: 'day' },
      rationale: 'Breakout entry.',
    }
    expect(await desk.executor.proposeOrder(stopBuy, context()))
      .toEqual({ kind: 'denied', reasons: ['stop-type: orders that add exposure must use stop_limit'] })
    expect(desk.events('trading/proposal')).toEqual([])
  })

  it('refuses while halted or blocked, before setup completed, and when the broker blocks the account', async () => {
    desk = await bootDesk()
    desk.venue.current = 'halted'
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [HALTED] })
    desk.venue.current = 'blocked'
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [BLOCKED] })
    desk.venue.current = 'unconfigured'
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [KEYS_MISSING] })
    desk.venue.current = 'ready'
    desk.venue.accountState = { ...desk.venue.accountState, tradingBlocked: true }
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [TRADING_BLOCKED] })
    desk.venue.keysMissing = true
    await expect(desk.executor.proposeOrder(buy(), context())).rejects.toThrow(KEYS_MISSING)
    expect(desk.executor.status()).toBe('ready')
  })

  it('frees the reservation when the proposal cannot be recorded', async () => {
    desk = await bootDesk({ config: { maxOrderNotional: 20_000 } })
    vi.spyOn(Journal.prototype, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(desk.executor.proposeOrder(buy(0.2), context('call-1'))).rejects.toThrow('disk full')
    expect((await desk.executor.proposeOrder(buy(0.2), context('call-2'))).kind).toBe('pending')
  })

  it('returns the pending proposal for an identical MCP proposal, but not for the in-app agent', async () => {
    desk = await bootDesk()
    const mcp: ProposalContext = { session: desk.session, source: 'claude-code-mcp' }
    const first = idOf(await desk.executor.proposeOrder(buy(), mcp))
    expect(await desk.executor.proposeOrder(buy(), mcp)).toMatchObject({ kind: 'duplicate', proposalId: first })
    expect((await desk.executor.proposeOrder(buy(0.0003), mcp)).kind).toBe('pending')
    expect((await desk.executor.proposeOrder(buy(), context('call-1'))).kind).toBe('pending')
    expect((await desk.executor.proposeOrder(buy(), context('call-2'))).kind).toBe('pending')
  })
})

describe('executing a proposal', () => {
  it('submits only an approved, logged proposal, as a capped limit keyed by session and proposal', async () => {
    desk = await bootDesk()
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
    approve('call-1')
    await expect(desk.executor.execute(id, SessionId('another-session'))).rejects.toThrow(NO_CHECKED_PROPOSAL)
    const report = await desk.executor.execute(id, desk.session.id)
    const clientOrderId = createHash('sha256').update(`${desk.session.id}:${id}`).digest('hex')
    expect(desk.venue.submitted).toEqual([
      { symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', clientOrderId },
    ])
    expect(report).toEqual({
      proposalId: id, orderId: `order-${clientOrderId.slice(0, 8)}`, symbol: 'BTC/USD', side: 'buy', type: 'limit', qty: 0.0002,
      limitPrice: 63_463.35, timeInForce: 'ioc', status: 'open', filledQty: 0, capped: true,
    })
    expect(desk.events('trading/order').map(event => event.data))
      .toEqual([{ proposalId: id, outcome: 'submitted', orderId: report.orderId, status: 'open' }])
    expect(await today()).toMatchObject([{ status: 'submitted', orderId: report.orderId }])
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
  })

  it('releases the reservation and journals the refusal when the user says no', async () => {
    desk = await bootDesk({ config: { maxOrderNotional: 20_000 } })
    const first = idOf(await desk.executor.proposeOrder(buy(0.2), context('call-1')))
    approve('call-1', 'rejected')
    await vi.waitFor(async () => { expect(await today()).toMatchObject([{ status: 'rejected', note: 'approval rejected' }]) })
    expect((await desk.executor.proposeOrder(buy(0.2), context('call-2'))).kind).toBe('pending')
    await expect(desk.executor.execute(first, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
  })

  it('denies submission when the price moved past the tolerance or a limit fails after approval', async () => {
    desk = await bootDesk()
    const moved = idOf(await desk.executor.proposeOrder(buy(), context('call-1')))
    approve('call-1')
    desk.venue.quotes.set('BTC/USD', { bid: 63_700, ask: 63_705 })
    await expect(desk.executor.execute(moved, desk.session.id)).rejects.toThrow(/^price moved; propose again$/)
    desk.venue.quotes.set('BTC/USD', { bid: 62_830, ask: 62_835 })
    const losing = idOf(await desk.executor.proposeOrder(buy(), context('call-2')))
    approve('call-2')
    desk.venue.accountState = { ...desk.venue.accountState, equity: 96_000 }
    await expect(desk.executor.execute(losing, desk.session.id))
      .rejects.toThrow('price moved; propose again; daily-loss: day P&L -4.0% vs limit -3.0%')
    desk.venue.accountState = { ...desk.venue.accountState, equity: 100_000 }
    const halted = idOf(await desk.executor.proposeOrder(buy(), context('call-3')))
    approve('call-3')
    desk.venue.current = 'halted'
    await expect(desk.executor.execute(halted, desk.session.id)).rejects.toThrow(HALTED)
    expect(desk.venue.submitted).toEqual([])
    expect(desk.events('trading/order').map(event => event.data.outcome)).toEqual(['failed', 'failed', 'failed'])
  })

  it('sends a reduce-only exit as a market order and reads reduce-only from the re-check', async () => {
    desk = await bootDesk()
    desk.venue.held = [position]
    const exit = idOf(await desk.executor.proposeOrder(sell, context('call-1')))
    expect(desk.events('trading/proposal')[0]?.data).toMatchObject({ reduceOnly: true, plan: { type: 'market', capped: false } })
    approve('call-1')
    expect(await desk.executor.execute(exit, desk.session.id)).toMatchObject({ type: 'market', capped: false })
    const again = idOf(await desk.executor.proposeOrder(sell, context('call-2')))
    approve('call-2')
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'sell', qty: 0.001, type: 'limit', limitPrice: 70_000, timeInForce: 'gtc',
      clientOrderId: brandString('resting') })]
    await expect(desk.executor.execute(again, desk.session.id))
      .rejects.toThrow('price moved; propose again; shorting: this sell would open or extend a short position')
    // A reduce-only exit skips the position-size check, so equity can be 0; the share of equity must stay finite.
    desk.venue.open = []
    desk.venue.accountState = { ...desk.venue.accountState, equity: 0 }
    idOf(await desk.executor.proposeOrder(sell, context('call-3')))
    expect(desk.events('trading/proposal').at(-1)?.data).toMatchObject({ reduceOnly: true, equityPct: 0 })
  })

  it('retries a crypto exit rejected for insufficient balance with the same client order id, and only an exit', async () => {
    desk = await bootDesk()
    desk.venue.held = [position]
    let failures = 1
    desk.venue.respond = (request) => {
      if (failures > 0) {
        failures -= 1
        throw new VenueError('insufficient balance for BTC (requested: 0.001, available: 0)', 'rejected')
      }
      return acceptedOrder(request)
    }
    const exit = idOf(await desk.executor.proposeOrder(sell, context('call-1')))
    approve('call-1')
    await desk.executor.execute(exit, desk.session.id)
    expect(desk.venue.submitted).toHaveLength(2)
    expect(desk.venue.submitted[0]?.clientOrderId).toBe(desk.venue.submitted[1]?.clientOrderId)
    failures = 5
    const stuck = idOf(await desk.executor.proposeOrder(sell, context('call-2')))
    approve('call-2')
    await expect(desk.executor.execute(stuck, desk.session.id)).rejects.toThrow('insufficient balance for BTC')
    expect(desk.venue.submitted).toHaveLength(5)
    failures = 1
    const entry = idOf(await desk.executor.proposeOrder(buy(), context('call-3')))
    approve('call-3')
    await expect(desk.executor.execute(entry, desk.session.id)).rejects.toThrow('insufficient balance for BTC')
    expect(desk.venue.submitted).toHaveLength(6)
  })

  it.each([
    [new VenueError('Alpaca did not confirm order x', 'unknown-outcome'), 'unknown',
      'the order outcome is unknown: Alpaca did not confirm order x. Check list_orders before proposing again.'],
    [new VenueError('client_order_id must be unique', 'rejected', 40010001), 'unknown',
      'the broker reports this order id as already used but does not show the order; check list_orders before proposing again'],
    [new VenueError('insufficient buying power', 'rejected', 40310000), 'failed', 'insufficient buying power'],
  ] as const)('reports %s without claiming the order was not placed', async (error, outcome, message) => {
    desk = await bootDesk()
    desk.venue.respond = () => { throw error }
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(message)
    expect(desk.events('trading/order').map(event => event.data)).toEqual([{ proposalId: id, outcome, message }])
    expect(await today()).toMatchObject([{ status: outcome, note: message }])
  })

  it('keeps a placed order reported as placed when the journal or session write afterwards fails', async () => {
    desk = await bootDesk()
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    vi.spyOn(Journal.prototype, 'update').mockRejectedValueOnce(new Error('disk full'))
    vi.spyOn(desk.session, 'append').mockImplementationOnce(() => { throw new Error('log closed') })
    await expect(desk.executor.execute(id, desk.session.id)).resolves.toMatchObject({ status: 'open' })
    expect(desk.venue.submitted).toHaveLength(1)
  })

  it('cancels an open order only after approval', async () => {
    desk = await bootDesk()
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 62_000, timeInForce: 'gtc',
      clientOrderId: brandString('resting') }, { id: brandString<BrokerOrderId>('order-9') })]
    expect(await desk.executor.proposeCancel({ orderId: brandString('missing'), rationale: 'Stale.' }, context()))
      .toEqual({ kind: 'denied', reasons: ['no open order has id missing; call list_orders for the current ids'] })
    const result = await desk.executor.proposeCancel({ orderId: brandString('order-9'), rationale: 'Stale.' }, context('call-1'))
    if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`)
    expect(result.summary).toBe('PAPER Cancel order order-9: buy 0.0002 BTC/USD limit at $62,000.00 gtc, filled 0\nRationale: Stale.')
    approve('call-1', 'allowed-once', 'cancel_order')
    expect(await desk.executor.execute(result.proposalId, desk.session.id))
      .toMatchObject({ orderId: 'order-9', status: 'cancel_requested', capped: false })
    expect(desk.venue.cancelled).toEqual(['order-9'])
    expect(desk.events('trading/order').map(event => event.data))
      .toEqual([{ proposalId: result.proposalId, outcome: 'cancelled', orderId: 'order-9' }])
    const failing = idOf(await desk.executor.proposeCancel({ orderId: brandString('order-9'), rationale: 'Again.' }, context('call-2')))
    approve('call-2', 'allowed-once', 'cancel_order')
    desk.venue.cancelFailure = new VenueError('order is not cancelable', 'rejected')
    await expect(desk.executor.execute(failing, desk.session.id)).rejects.toThrow('order is not cancelable')
    desk.venue.cancelFailure = undefined
    const late = idOf(await desk.executor.proposeCancel({ orderId: brandString('order-9'), rationale: 'Late.' }, context('call-3')))
    approve('call-3', 'allowed-once', 'cancel_order')
    desk.venue.current = 'halted'
    await expect(desk.executor.execute(late, desk.session.id)).rejects.toThrow(HALTED)
    expect(await desk.executor.proposeCancel({ orderId: brandString('order-9'), rationale: 'Halted.' }, context('call-4')))
      .toEqual({ kind: 'denied', reasons: [HALTED] })
    desk.venue.current = 'blocked'
    expect(await desk.executor.proposeCancel({ orderId: brandString('order-9'), rationale: 'Blocked.' }, context('call-5')))
      .toEqual({ kind: 'denied', reasons: [BLOCKED] })
  })
})

describe('reads', () => {
  it('serves quotes, the account, positions, and orders', async () => {
    desk = await bootDesk()
    expect(await desk.executor.quote('btcusd'))
      .toEqual({ symbol: 'BTC/USD', assetClass: 'crypto', bid: 62_830, ask: 62_835, mid: 62_832.5, ageSeconds: 0, marketOpen: true })
    desk.venue.quoteAgeMs = 5_000
    expect((await desk.executor.quote('AAPL')).ageSeconds).toBe(5)
    await expect(desk.executor.quote('??')).rejects.toThrow('symbol "??" is not a US stock ticker')
    expect(await desk.executor.account()).toEqual({
      mode: 'paper', status: 'ready', equity: 100_000, cash: 100_000, buyingPower: 100_000, dayPl: 0, dayPlPct: 0, tradingBlocked: false,
    })
    desk.venue.accountState = { equity: 101_000, cash: 50_000, lastEquity: 100_000, buyingPower: 50_000, tradingBlocked: false }
    expect(await desk.executor.account()).toMatchObject({ dayPl: 1_000, dayPlPct: 1 })
    desk.venue.accountState = { ...desk.venue.accountState, lastEquity: 0 }
    expect((await desk.executor.account()).dayPlPct).toBe(0)
    desk.venue.held = [{ ...position, qtyAvailable: 0.0005 }]
    expect(await desk.executor.positions()).toEqual([{ symbol: 'BTC/USD', qty: 0.001, qtyAvailable: 0.0005, avgEntryPrice: 60_000,
      currentPrice: 62_830, marketValue: 62.83, unrealizedPl: 2.83 }])
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'sell', qty: 0.001, type: 'stop_limit', limitPrice: 59_000, stopPrice: 59_500,
      timeInForce: 'gtc', clientOrderId: brandString('c-9') }, { id: brandString<BrokerOrderId>('order-9') })]
    await desk.executor.proposeOrder(buy(1), context())
    expect(await desk.executor.orders()).toEqual({
      open: [{ orderId: 'order-9', symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', qty: 0.001, limitPrice: 59_000,
        stopPrice: 59_500, timeInForce: 'gtc', filledQty: 0, status: 'open' }],
      today: [expect.objectContaining({ symbol: 'BTC/USD', side: 'buy', qty: 1, status: 'denied', filledQty: 0 })],
    })
  })

  it('returns bars with warm-up, caps the window, and refuses a bad timeframe or limit', async () => {
    desk = await bootDesk()
    desk.venue.history = Array.from({ length: 3 }, (_, i) => ({ t: Date.UTC(2026, 9, 5, 10 + i), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }))
    expect(desk.executor.barWindow()).toEqual({ defaultCount: 100, cap: 500 })
    expect(await desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h', limit: 2 })).toMatchObject({ symbol: 'BTC/USD', count: 2 })
    await desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h' })
    await desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h', limit: 5_000, indicators: ['rsi'] })
    expect(desk.venue.barQueries.map(query => query.limit)).toEqual([62, 160, 560])
    await expect(desk.executor.bars({ symbol: 'BTC/USD', timeframe: '2h' })).rejects.toThrow('timeframe must be one of 1m, 5m, 15m, 1h, 4h, 1D, 1W')
    await expect(desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h', limit: 0 })).rejects.toThrow('limit must be a whole number of at least 1')
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/executor.spec.ts`
Expected: FAIL — `Cannot find module '../src/index.ts'` exports (`default` is not a constructor).

- [ ] **Step 8: Write `src/executor.ts`**

```ts
/**
 * The trading order executor at `ctx.tradingExecutor`: the only broker path the trading tools offer. A proposal is
 * validated, checked against the limits and reserved under the account lock, journaled, and recorded as
 * `trading/proposal`; the user is asked; after an `allowed-once` decision it is re-checked and submitted under the lock
 * again. The in-app tools and the MCP endpoint call the same methods in the same order.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/executor
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import {
  type BrokerOrder, type BrokerOrderRequest, checkRisk, isTimeframe, type OrderRequest, type OrderStatus, type ProposalId,
  type RiskLimits, TIMEFRAMES, validateOrder, type VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type z from '@deepseek-ai/schemastery'
import { barsReport, WARMUP_BARS } from './bars.ts'
import { ProposalBook } from './book.ts'
import { Config, riskLimitsOf, validateConfig } from './config.ts'
import {
  BLOCKED, cancelSummary, compact, failureOf, HALTED, isInsufficientBalance, KEYS_MISSING, NO_CHECKED_PROPOSAL, PRICE_MOVED,
  proposalSummary, TRADING_BLOCKED,
} from './format.ts'
import { clientOrderIdFor, mintProposalId, tradingDay } from './ids.ts'
import { Journal, type JournalPatch, tradingJournalSpec } from './journal.ts'
import { AccountLock } from './lock.ts'
import { type ProposedCancel, type ProposedOrder, symbolOf, tickViolations } from './order-args.ts'
import { brokerRequest, drifted, planOrder, takeSnapshot } from './snapshot.ts'
import type {
  AccountReport, BarsReport, BarsRequest, JournalEntry, JournalRow, JournalStatus, OrderReport, OrderRow, OrdersReport,
  PositionReport, ProposalContext, ProposeResult, QuoteReport, TradingCancelProposal, TradingOrderEvent, TradingOrderProposal,
  TradingProposal,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tradingExecutor: TradingExecutor
  }
}

type FirstCheck =
  | { readonly kind: 'denied'; readonly reasons: readonly string[]; readonly journal: boolean }
  | { readonly kind: 'checked'; readonly proposal: TradingOrderProposal }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

function refusal(status: VenueStatus): string | undefined {
  switch (status) {
    case 'ready': return undefined
    case 'halted': return HALTED
    case 'blocked': return BLOCKED
    case 'unconfigured': return KEYS_MISSING
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(status, 'VenueStatus')
  }
}

function denied(reasons: readonly string[]): ProposeResult {
  return { kind: 'denied', reasons }
}

function journalStatus(status: OrderStatus): JournalStatus {
  return status === 'open' ? 'submitted' : status
}

function orderEntry(
  proposalId: ProposalId, order: OrderRequest, rationale: string, context: ProposalContext, now: number, status: JournalStatus,
  clientOrderId: string | undefined, note: string | undefined,
): JournalEntry {
  return compact<JournalEntry>({
    proposalId, sessionId: context.session.id, callId: context.callId, source: context.source, kind: 'order',
    ticker: order.symbol.ticker, side: order.side, qty: order.qty, notional: order.notional, rationale, clientOrderId,
    orderId: undefined, status, filledQty: 0, filledAvgPrice: undefined, day: tradingDay(now), createdAt: now, updatedAt: now, note,
  })
}

function orderReport(proposalId: ProposalId, order: BrokerOrder, status: string, capped: boolean): OrderReport {
  return compact<OrderReport>({
    proposalId, orderId: order.id, symbol: order.symbol.ticker, side: order.side, type: order.type, qty: order.qty,
    notional: order.notional, limitPrice: order.limitPrice, stopPrice: order.stopPrice, timeInForce: order.timeInForce, status,
    filledQty: order.filledQty, filledAvgPrice: order.filledAvgPrice, capped,
  })
}

/** The order executor service. */
export class TradingExecutor extends Service {
  static inject = ['tradingVenue', 'tools', 'storageDomain', 'sessions', 'agents']
  static Config: z<Partial<Config>, Config> = Config

  private readonly settings: Config
  private readonly limits: RiskLimits
  private readonly book = new ProposalBook()
  private readonly lock = new AccountLock()
  private readonly journalReady = Promise.withResolvers<Journal>()

  /**
   * @param ctx - plugin context.
   * @param config - risk limits, drift tolerance, `get_bars` limits, and timers.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tradingExecutor')
    this.settings = validateConfig(config)
    this.limits = riskLimitsOf(this.settings)
    ctx.on('session/event', (session, event) => { this.observe(session.id, event) })
  }

  /** Open the trading journal. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(tradingJournalSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'tool-trading journal close')
    this.journalReady.resolve(new Journal(domain))
  }

  /** @returns the venue's derived status. */
  status(): VenueStatus {
    return this.ctx.tradingVenue.status()
  }

  /** @returns how many bars `get_bars` shows by default and at most. */
  barWindow(): { readonly defaultCount: number; readonly cap: number } {
    return { defaultCount: this.settings.barsDefault, cap: this.settings.barsCap }
  }

  /**
   * @param symbolText - instrument name as typed.
   * @returns the latest quote, its age, and whether the market is open.
   */
  async quote(symbolText: string): Promise<QuoteReport> {
    const symbol = symbolOf(symbolText)
    const venue = this.ctx.tradingVenue
    const [quote, marketOpen] = await Promise.all([venue.latestQuote(symbol), venue.marketOpen(symbol)])
    return {
      symbol: symbol.ticker, assetClass: symbol.assetClass, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2,
      ageSeconds: Math.max(0, Math.round((Date.now() - quote.t) / 1000)), marketOpen,
    }
  }

  /**
   * @param request - symbol, timeframe, optional count and indicators.
   * @returns the bars report over at most `barsCap` bars.
   */
  async bars(request: BarsRequest): Promise<BarsReport> {
    const symbol = symbolOf(request.symbol)
    const timeframe = request.timeframe
    if (!isTimeframe(timeframe)) throw new Error(`timeframe must be one of ${TIMEFRAMES.join(', ')}`)
    const limit = request.limit ?? this.settings.barsDefault
    if (!(Number.isInteger(limit) && limit >= 1)) throw new Error('limit must be a whole number of at least 1')
    const shown = Math.min(limit, this.settings.barsCap)
    const bars = await this.ctx.tradingVenue.bars(symbol, timeframe, { limit: shown + WARMUP_BARS })
    return barsReport(symbol, timeframe, bars, shown, request.indicators ?? [])
  }

  /** @returns the account with day profit or loss against the previous close. */
  async account(): Promise<AccountReport> {
    const venue = this.ctx.tradingVenue
    const account = await venue.account()
    const dayPl = account.equity - account.lastEquity
    return {
      mode: venue.mode(), status: venue.status(), equity: account.equity, cash: account.cash, buyingPower: account.buyingPower,
      dayPl, dayPlPct: account.lastEquity > 0 ? dayPl / account.lastEquity * 100 : 0, tradingBlocked: account.tradingBlocked,
    }
  }

  /** @returns open positions. */
  async positions(): Promise<PositionReport[]> {
    return (await this.ctx.tradingVenue.positions()).map(position => ({
      symbol: position.symbol.ticker, qty: position.qty, qtyAvailable: position.qtyAvailable, avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice, marketValue: position.marketValue, unrealizedPl: position.unrealizedPl,
    }))
  }

  /** @returns the broker's open orders and today's desk orders. */
  async orders(): Promise<OrdersReport> {
    const [open, journal] = await Promise.all([this.ctx.tradingVenue.openOrders(), this.journalReady.promise])
    return {
      open: open.map(order => compact<OrderRow>({
        orderId: order.id, symbol: order.symbol.ticker, side: order.side, type: order.type, qty: order.qty, notional: order.notional,
        limitPrice: order.limitPrice, stopPrice: order.stopPrice, timeInForce: order.timeInForce, filledQty: order.filledQty,
        status: order.status,
      })),
      today: journal.on(tradingDay(Date.now())).filter(entry => entry.kind === 'order').map(entry => compact<JournalRow>({
        proposalId: entry.proposalId, symbol: entry.ticker, side: entry.side, qty: entry.qty, notional: entry.notional,
        status: entry.status, filledQty: entry.filledQty, filledAvgPrice: entry.filledAvgPrice, orderId: entry.orderId, note: entry.note,
      })),
    }
  }

  /**
   * Steps 1–4 for an order: validate, then under the account lock snapshot, check, and reserve; journal the proposal and
   * append `trading/proposal`. A risk denial is journaled; an identical pending MCP proposal is returned instead.
   * @param input - the order and its rationale.
   * @param context - proposing session, source, and call id.
   * @returns the denial, or the pending proposal and its approval summary.
   */
  async proposeOrder(input: ProposedOrder, context: ProposalContext): Promise<ProposeResult> {
    const venue = this.ctx.tradingVenue
    const early = venue.status()
    if (early === 'halted') return denied([HALTED])
    if (early === 'blocked') return denied([BLOCKED])
    const { order, rationale } = input
    const sessionId = context.session.id
    if (context.source === 'claude-code-mcp') {
      const duplicate = this.book.findDuplicate(sessionId, order)
      if (duplicate !== undefined) {
        return { kind: 'duplicate', proposalId: duplicate.proposalId, summary: proposalSummary(duplicate, this.settings.driftTolerance) }
      }
    }
    // The first venue call also runs the venue's own setup when it has not completed (keys added, broker back).
    const asset = await venue.asset(order.symbol)
    const invalid = [...validateOrder(order, asset).map(violation => violation.message), ...tickViolations(order, asset.priceIncrement)]
    if (invalid.length > 0) return denied(invalid)
    const journal = await this.journalReady.promise
    const proposalId = mintProposalId()
    const now = Date.now()
    const checked = await this.lock.run(async (): Promise<FirstCheck> => {
      const gate = refusal(venue.status())
      if (gate !== undefined) return { kind: 'denied', reasons: [gate], journal: false }
      const snapshot = await takeSnapshot(order.symbol, { venue, book: this.book, journal, now })
      if (snapshot.account.tradingBlocked) return { kind: 'denied', reasons: [TRADING_BLOCKED], journal: false }
      const risk = checkRisk(order, snapshot.risk, this.limits)
      if (!risk.ok) {
        const reasons = risk.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`)
        return { kind: 'denied', reasons, journal: true }
      }
      const plan = planOrder(order, risk.referencePrice, this.settings.driftTolerance, risk.reduceOnly, asset.priceIncrement)
      const proposal = compact<TradingOrderProposal>({
        kind: 'order', proposalId, callId: context.callId, source: context.source, mode: venue.mode(), order, rationale,
        quote: { bid: snapshot.quote.bid, ask: snapshot.quote.ask }, marketOpen: snapshot.marketOpen,
        referencePrice: risk.referencePrice, estimatedNotional: risk.estimatedNotional,
        equityPct: snapshot.account.equity > 0 ? risk.estimatedNotional / snapshot.account.equity : 0,
        reduceOnly: risk.reduceOnly, plan, priceIncrement: asset.priceIncrement, checks: risk.checks,
      })
      const reservation = { ticker: order.symbol.ticker, side: order.side, qty: risk.quantity, notional: risk.estimatedNotional }
      this.book.add(proposal, sessionId, reservation)
      return { kind: 'checked', proposal }
    })
    if (checked.kind === 'denied') {
      if (checked.journal) {
        await journal.put(orderEntry(proposalId, order, rationale, context, now, 'denied', undefined, checked.reasons.join('; ')))
      }
      return denied(checked.reasons)
    }
    const entry = orderEntry(proposalId, order, rationale, context, now, 'proposed', clientOrderIdFor(sessionId, proposalId), undefined)
    await this.record(journal, checked.proposal, entry, context)
    return { kind: 'pending', proposalId, summary: proposalSummary(checked.proposal, this.settings.driftTolerance) }
  }

  /**
   * Steps 1–4 for a cancellation: the order must be open at the broker.
   * @param input - broker order id and rationale.
   * @param context - proposing session, source, and call id.
   * @returns the denial, or the pending proposal and its approval summary.
   */
  async proposeCancel(input: ProposedCancel, context: ProposalContext): Promise<ProposeResult> {
    const venue = this.ctx.tradingVenue
    const open = await venue.openOrders()
    const gate = refusal(venue.status())
    if (gate !== undefined) return denied([gate])
    const order = open.find(candidate => candidate.id === input.orderId)
    if (order === undefined) return denied([`no open order has id ${input.orderId}; call list_orders for the current ids`])
    const journal = await this.journalReady.promise
    const proposalId = mintProposalId()
    const now = Date.now()
    const proposal = compact<TradingCancelProposal>({
      kind: 'cancel', proposalId, callId: context.callId, source: context.source, mode: venue.mode(), order, rationale: input.rationale,
    })
    this.book.add(proposal, context.session.id)
    await this.record(journal, proposal, compact<JournalEntry>({
      proposalId, sessionId: context.session.id, callId: context.callId, source: context.source, kind: 'cancel',
      ticker: order.symbol.ticker, side: order.side, qty: order.qty, notional: order.notional, rationale: input.rationale,
      clientOrderId: undefined, orderId: order.id, status: 'proposed', filledQty: 0, filledAvgPrice: undefined, day: tradingDay(now),
      createdAt: now, updatedAt: now, note: undefined,
    }), context)
    return { kind: 'pending', proposalId, summary: cancelSummary(proposal) }
  }

  /**
   * @param sessionId - session of the tool call.
   * @param callId - in-app tool call id.
   * @returns the unsettled proposal the pre-execute listener created for that call.
   */
  proposalForCall(sessionId: SessionId, callId: ToolCallId): ProposalId | undefined {
    return this.book.forCall(sessionId, callId)
  }

  /**
   * Steps 5–8. Fails closed: only a proposal whose own `trading/proposal` event committed and whose call received an
   * `allowed-once` decision is sent; under the account lock it is re-snapshotted, re-checked, planned with the
   * post-approval reduce-only answer, and submitted with its client order id. The proposal settles whatever happens.
   * @param proposalId - the proposal.
   * @param sessionId - the session that proposed it.
   * @returns the submitted order or accepted cancellation.
   * @throws Error with a model-facing reason.
   */
  async execute(proposalId: ProposalId, sessionId: SessionId): Promise<OrderReport> {
    const entry = this.book.get(proposalId)
    if (entry === undefined || entry.sessionId !== sessionId || entry.state !== 'approved') throw new Error(NO_CHECKED_PROPOSAL)
    entry.state = 'submitting'
    try {
      return entry.proposal.kind === 'order'
        ? await this.submitOrder(entry.proposal, sessionId)
        : await this.submitCancel(entry.proposal, sessionId)
    } finally {
      this.book.settle(proposalId)
    }
  }

  private async submitOrder(proposal: TradingOrderProposal, sessionId: SessionId): Promise<OrderReport> {
    const venue = this.ctx.tradingVenue
    const journal = await this.journalReady.promise
    const tolerance = this.settings.driftTolerance
    let sent: { readonly order: BrokerOrder; readonly capped: boolean }
    try {
      sent = await this.lock.run(async () => {
        const gate = refusal(venue.status())
        if (gate !== undefined) throw new Error(gate)
        const snapshot = await takeSnapshot(proposal.order.symbol, {
          venue, book: this.book, journal, now: Date.now(), excluding: proposal.proposalId,
        })
        const recheck = checkRisk(proposal.order, snapshot.risk, this.limits)
        const failing = recheck.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`)
        if (failing.length > 0 || drifted(proposal.referencePrice, recheck.referencePrice, tolerance)) {
          throw new Error([PRICE_MOVED, ...failing].join('; '))
        }
        const plan = planOrder(proposal.order, proposal.referencePrice, tolerance, recheck.reduceOnly, proposal.priceIncrement)
        const request = brokerRequest(proposal.order, plan, clientOrderIdFor(sessionId, proposal.proposalId))
        return { order: await this.send(request, recheck.reduceOnly), capped: plan.capped }
      })
    } catch (error) {
      const failure = failureOf(error)
      await this.updateJournal(journal, proposal.proposalId, { status: failure.outcome, note: failure.message })
      this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: failure.outcome, message: failure.message })
      throw new Error(failure.message)
    }
    const { order, capped } = sent
    await this.updateJournal(journal, proposal.proposalId, compact<JournalPatch>({
      status: journalStatus(order.status), orderId: order.id, filledQty: order.filledQty, filledAvgPrice: order.filledAvgPrice,
      note: undefined,
    }))
    this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: 'submitted', orderId: order.id, status: order.status })
    return orderReport(proposal.proposalId, order, order.status, capped)
  }

  private async submitCancel(proposal: TradingCancelProposal, sessionId: SessionId): Promise<OrderReport> {
    const venue = this.ctx.tradingVenue
    const journal = await this.journalReady.promise
    try {
      const gate = refusal(venue.status())
      if (gate !== undefined) throw new Error(gate)
      await venue.cancelOrder(proposal.order.id)
    } catch (error) {
      const failure = failureOf(error)
      await this.updateJournal(journal, proposal.proposalId, { status: 'failed', note: failure.message })
      this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: 'failed', message: failure.message })
      throw new Error(failure.message)
    }
    await this.updateJournal(journal, proposal.proposalId, { status: 'canceled' })
    this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: 'cancelled', orderId: proposal.order.id })
    return orderReport(proposal.proposalId, proposal.order, 'cancel_requested', false)
  }

  /** Submit; a crypto exit refused for insufficient balance right after a fill is retried with the same client order id. */
  private async send(request: BrokerOrderRequest, reduceOnly: boolean): Promise<BrokerOrder> {
    const retries = reduceOnly && request.symbol.assetClass === 'crypto' ? this.settings.exitRetryMs : []
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.ctx.tradingVenue.submitOrder(request)
      } catch (error) {
        const delay = retries[attempt]
        if (delay === undefined || !isInsufficientBalance(error)) throw error
        await sleep(delay)
      }
    }
  }

  /** Journal a proposal and append its session event; a failure settles the reservation before rethrowing. */
  private async record(journal: Journal, proposal: TradingProposal, entry: JournalEntry, context: ProposalContext): Promise<void> {
    try {
      await journal.put(entry)
      context.session.append('trading/proposal', proposal)
    } catch (error) {
      this.book.settle(proposal.proposalId)
      throw error
    }
  }

  /** Fold the session events the book projects: the proposal's own event and the approval pair of its call. */
  private observe(sessionId: SessionId, event: SessionEvent): void {
    switch (event.type) {
      case 'trading/proposal':
        this.book.markLogged(sessionId, event.data.proposalId)
        break
      case 'approval/asked':
        this.book.linkApproval(sessionId, event.data.callId, event.data.id)
        break
      case 'approval/decided': {
        const settled = this.book.decide(event.data.id, event.data.outcome)
        if (settled === undefined) break
        this.journalLater(settled.proposal.proposalId, { status: 'rejected', note: `approval ${event.data.outcome}` })
        break
      }
      default:
        // SessionEventMap is merge-extensible; no other event changes the book.
        break
    }
  }

  /** Record a submission outcome in the proposing session; a failed append never turns a placed order into a failure. */
  private recordOrder(sessionId: SessionId, event: TradingOrderEvent): void {
    try {
      this.ctx.sessions.get(sessionId)?.append('trading/order', compact<TradingOrderEvent>({
        proposalId: event.proposalId, outcome: event.outcome, orderId: event.orderId, status: event.status, message: event.message,
      }))
    } catch (error) {
      this.warn(`could not record the order outcome: ${(error as Error).message}`)
    }
  }

  private async updateJournal(journal: Journal, id: ProposalId, patch: JournalPatch): Promise<void> {
    try {
      await journal.update(id, patch, Date.now())
    } catch (error) {
      this.warn(`journal update for ${id} failed: ${(error as Error).message}`)
    }
  }

  private journalLater(id: ProposalId, patch: JournalPatch): void {
    void this.journalReady.promise.then(journal => this.updateJournal(journal, id, patch))
  }

  private warn(message: string): void {
    this.ctx.logger.warn(`tool-trading: ${message}`)
  }
}
```

- [ ] **Step 9: Replace `src/index.ts`**

```ts
/**
 * Trading order executor and model-facing trading tools. The package root default-exports the executor service at
 * `ctx.tradingExecutor`; `@deepseek-ai/dsh-experimental-tool-trading/tools` registers the seven tools.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading
 */
import { TradingExecutor } from './executor.ts'

export { Config } from './config.ts'
export { TradingExecutor } from './executor.ts'
export type { ProposedCancel, ProposedOrder } from './order-args.ts'
export type * from './types.ts'

export default TradingExecutor
```

- [ ] **Step 10: Run the executor tests with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/executor.spec.ts packages/experimental/tool-trading/tests/format.spec.ts --coverage --coverage.include='packages/experimental/tool-trading/src/{executor,format,index}.ts'`
Expected: PASS; all three files 100%. `executor.ts` lines added by Tasks 8–9 do not exist yet. If `ctx.plugin(SessionStore)` does not announce sessions created with `ctx.sessions.create()` (so `session/event` never fires), create the session through the API the store documents for announced sessions and ledger it; do not observe events any other way.

- [ ] **Step 11: Typecheck, catalogs, commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec tsc -b packages/experimental/tool-trading && pnpm run lint && pnpm run gen-persistence-catalog && pnpm run gen-cordis-catalog`
Expected: exit 0; `docs/persistence-catalog.md` (+ `.zh.md`) and `packages/core/session/src/known-event-types.ts` gain `trading/fill`, `trading/order`, `trading/proposal`. `gen-cordis-catalog` fails until `tradingExecutor` has a service page — add `tradingExecutor: 'trading.md',` beside `tradingVenue: 'trading.md',` in `SERVICE_PAGE` of `scripts/gen-cordis-catalog.ts` and rerun.

```bash
git add packages/experimental/tool-trading docs/persistence-catalog.md docs/persistence-catalog.zh.md docs/persistence-catalog.i18n.yaml packages/core/session/src/known-event-types.ts scripts/gen-cordis-catalog.ts docs/subsystems/trading.md docs/subsystems/trading.zh.md
git commit -m "feat(tool-trading): add the order executor with proposals, approval projection, and fail-closed execution"
```

---
### Task 8: The tool pipeline — pre-execute listener, Halt guard, settlement, and the seven tools

**Files:**
- Create: `packages/experimental/tool-trading/src/tools.ts`
- Modify: `packages/experimental/tool-trading/src/executor.ts` (constructor wiring, `gate`, `proposeFromArgs`)
- Modify: `packages/experimental/tool-trading/package.json` (add the `./tools` export), `tsconfig.base.json` (regenerated)
- Modify: `packages/experimental/tool-trading/tests/harness.ts` (mount the tools plugin)
- Test: `packages/experimental/tool-trading/tests/pipeline.spec.ts`

**Interfaces:**
- Consumes: `TradingExecutor` public methods (Task 7); `defineTool`, `ToolRunContext`, `ToolExecution`, `PreToolDecision` from `@deepseek-ai/dsh-tools`; `'tools/pre-execute'` waterfall `(exec, next) => Promise<PreToolDecision>` and `'tools/result'` emit `(exec, result)` (`packages/core/tools/src/index.ts:146,177`); `ctx.tools.guard(guard): () => void` (`packages/core/tools/src/index.ts:1116`). Argument validation runs only inside the tool body (`packages/core/tools/src/schema.ts:584-588`), so the listener reads raw model JSON.
- Produces: `@deepseek-ai/dsh-experimental-tool-trading/tools` exporting `name = 'tool-trading'`, `inject = ['tools', 'tradingExecutor']`, `apply(ctx)`; tools `get_quote`, `get_bars`, `get_account`, `get_positions`, `list_orders`, `place_order`, `cancel_order`; `ORDER_TOOLS` behavior: every call to `place_order`/`cancel_order` passes the executor's listener and guard.

- [ ] **Step 1: Write the failing pipeline tests**

`packages/experimental/tool-trading/tests/pipeline.spec.ts`:

```ts
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId } from '@deepseek-ai/dsh-experimental-trading'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVAL_OFF, HALTED, KEYS_MISSING, NO_AGENT, NO_CHECKED_PROPOSAL } from '../src/format.ts'
import { acceptedOrder } from './fake-venue.ts'
import { bootDesk, type Desk } from './harness.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const buyArgs = { symbol: 'BTC/USD', side: 'buy', qty: 0.0002, type: 'market', time_in_force: 'gtc', rationale: 'Testing the desk.' }
const PLACE_ORDER_DESCRIPTION = 'Propose a stock or crypto order. The user approves or rejects every order before it reaches the '
  + 'broker; an order that breaks a risk limit is refused with the reasons, and the limits cannot be changed from here. Give '
  + 'exactly one of qty or notional; notional orders are market orders. Crypto orders use time_in_force gtc or ioc and type '
  + 'market, limit, or stop_limit. Fractional and notional stock orders are day orders. A plain stop order is accepted only to '
  + 'reduce a position you hold; use stop_limit otherwise. A market order that adds exposure is sent as a limit near the quoted '
  + 'price, so it may not fill in a fast market. take_profit with stop_loss adds a bracket to a whole-share stock order. The '
  + 'result reports the order id and status; later fills arrive as messages.'

let desk: Desk
afterEach(async () => { await desk.close() })

function run(name: string, args: Record<string, unknown>, callId = 'call-1', withAgent = true): Promise<ToolExecutionResult> {
  return desk.ctx.tools.execute({
    callId: ToolCallId(callId), name, arguments: args, ...withAgent ? { agent: desk.agent } : {}, signal: new AbortController().signal,
  })
}

const text = (result: ToolExecutionResult): string => result.content.map(block => block.type === 'text' ? block.text : '').join('')

const restingOrder = (): void => {
  desk.venue.open = [acceptedOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 62_000, timeInForce: 'gtc',
    clientOrderId: brandString('resting') }, { id: brandString<BrokerOrderId>('order-9') })]
}

describe('place_order and cancel_order through the tool pipeline', () => {
  it('asks once with the proposal summary and submits after approval', async () => {
    desk = await bootDesk()
    const result = await run('place_order', buyArgs)
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(
      /^Placed buy 0\.0002 BTC\/USD as a limit at \$63,463\.35 \(ioc\), capped near the approved price; order order-[0-9a-f]{8} is open\.$/)
    const asked = desk.events('approval/asked')
    expect(asked.map(event => event.data)).toMatchObject([{ toolName: 'place_order', callId: 'call-1' }])
    expect(asked[0]?.data.reason?.split('\n')[0]).toBe('PAPER Buy 0.0002 BTC/USD market gtc')
    expect(desk.venue.submitted).toHaveLength(1)
  })

  it.each([
    ['rejected', 'Error: the user rejected tool "place_order"'],
    ['cancelled', 'Error: approval for tool "place_order" was cancelled'],
  ] as const)('submits nothing when the approval is %s', async (outcome, message) => {
    desk = await bootDesk()
    desk.answer = outcome
    const result = await run('place_order', buyArgs)
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(message)
    expect(desk.venue.submitted).toEqual([])
    await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]?.status).toBe('rejected') })
  })

  it('denies orders when approval prompts are off, switched off for the session, or not composed', async () => {
    for (const approval of ['never', 'none'] as const) {
      desk = await bootDesk({ approval })
      expect(text(await run('place_order', buyArgs))).toBe(`Error: ${APPROVAL_OFF}`)
      expect(desk.events('trading/proposal')).toEqual([])
      await desk.close()
    }
    desk = await bootDesk()
    desk.session.append('approval/policy', { policy: 'never' })
    expect(text(await run('cancel_order', { order_id: 'order-9', rationale: 'r' }))).toBe(`Error: ${APPROVAL_OFF}`)
  })

  it('denies without asking when a limit fails or the arguments are malformed', async () => {
    desk = await bootDesk()
    expect(text(await run('place_order', { ...buyArgs, qty: 1 })))
      .toBe('Error: order-notional: order $62,835.00 vs max $1,000.00\nposition-size: position 62.8% of equity vs max 20.0%')
    expect(text(await run('place_order', { ...buyArgs, side: 'hold', notional: 'lots' })))
      .toBe('Error: side must be one of buy, sell\nnotional must be a finite number')
    expect(text(await run('cancel_order', { order_id: 'nope', rationale: 'r' })))
      .toBe('Error: no open order has id nope; call list_orders for the current ids')
    expect(text(await run('cancel_order', { rationale: 'r' }))).toBe('Error: order_id must be an order id from list_orders')
    expect(desk.events('approval/asked')).toEqual([])
  })

  it('fails closed when a listener ahead of the executor allows or asks without delegating', async () => {
    desk = await bootDesk()
    desk.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.callId.startsWith('allow-ahead')) return { kind: 'allow' }
      if (exec.callId === 'ask-ahead') return { kind: 'ask', reason: 'a hook asks' }
      return next()
    }, { prepend: true })
    expect(text(await run('place_order', buyArgs, 'allow-ahead'))).toBe(`Error: ${NO_CHECKED_PROPOSAL}`)
    expect(text(await run('place_order', buyArgs, 'allow-ahead-no-agent', false))).toBe(`Error: ${NO_CHECKED_PROPOSAL}`)
    expect(text(await run('place_order', buyArgs, 'ask-ahead'))).toBe(`Error: ${NO_CHECKED_PROPOSAL}`)
    expect(desk.venue.submitted).toEqual([])
    expect(desk.events('trading/proposal')).toEqual([])
  })

  it("returns a later listener's denial without recording a proposal", async () => {
    desk = await bootDesk()
    desk.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'place_order' ? { kind: 'deny', reason: 'policy says no' } : next())
    expect(text(await run('place_order', buyArgs))).toBe('Error: policy says no')
    expect(desk.events('trading/proposal')).toEqual([])
  })

  it('denies order tools while halted, including a Halt that lands while the approval is open', async () => {
    desk = await bootDesk()
    let haltDuringApproval = true
    desk.ctx.on('approval/request', async (_request, next) => {
      if (haltDuringApproval) desk.venue.current = 'halted'
      return next()
    }, { prepend: true })
    expect(text(await run('place_order', buyArgs))).toBe(`Error: ${HALTED}`)
    expect(desk.venue.submitted).toEqual([])
    await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'rejected', note: 'not sent' }) })
    haltDuringApproval = false
    expect(text(await run('place_order', buyArgs, 'call-2'))).toBe(`Error: ${HALTED}`)
    restingOrder()
    expect(text(await run('cancel_order', { order_id: 'order-9', rationale: 'r' }, 'call-3'))).toBe(`Error: ${HALTED}`)
  })

  it("submits only the call that was approved, with that call's arguments", async () => {
    desk = await bootDesk()
    desk.answer = 'rejected'
    expect((await run('place_order', { ...buyArgs, qty: 0.0003 }, 'call-1')).isError).toBe(true)
    desk.answer = 'allowed-once'
    expect((await run('place_order', buyArgs, 'call-2')).isError).toBe(false)
    expect(desk.venue.submitted.map(request => request.qty)).toEqual([0.0002])
  })

  it('cancels an open order through cancel_order after approval', async () => {
    desk = await bootDesk()
    restingOrder()
    expect(text(await run('cancel_order', { order_id: 'order-9', rationale: 'No longer needed.' })))
      .toBe('Cancellation requested for order order-9 (buy BTC/USD).')
    expect(desk.venue.cancelled).toEqual(['order-9'])
  })

  it('denies a call without an agent session and reports venue failures as denials', async () => {
    desk = await bootDesk()
    expect(text(await run('place_order', buyArgs, 'call-1', false))).toBe(`Error: ${NO_AGENT}`)
    desk.venue.keysMissing = true
    expect(text(await run('place_order', buyArgs, 'call-2'))).toBe(`Error: ${KEYS_MISSING}`)
  })
})

describe('read tools', () => {
  it('runs the read tools and renders their results', async () => {
    desk = await bootDesk()
    desk.venue.history = [{ t: Date.UTC(2026, 9, 5, 10), o: 100, h: 101, l: 99, c: 100.5, v: 10 }]
    expect(text(await run('get_quote', { symbol: 'BTCUSD' })))
      .toBe('BTC/USD bid $62,830.00 ask $62,835.00 (mid $62,832.50); quote 0 s old; market open.')
    expect(text(await run('get_bars', { symbol: 'BTC/USD', timeframe: '1h' }))).toContain('BTC/USD 1h: 1 bars, oldest first.')
    expect(text(await run('get_bars', { symbol: 'BTC/USD', timeframe: '1h', limit: 1, indicators: ['rsi'] })))
      .toContain('Indicators: RSI(14) n/a (needs more bars).')
    expect(text(await run('get_account', {})))
      .toBe('PAPER account, ready: equity $100,000.00, cash $100,000.00, buying power $100,000.00, day P&L $0.00 (0.00%).')
    expect(text(await run('get_positions', {}))).toBe('No open positions.')
    expect(text(await run('list_orders', {}))).toBe('No open orders.\nNo desk orders today.')
    expect(text(await run('get_quote', { symbol: 'NOT A SYMBOL' })))
      .toBe('Error: symbol "NOT A SYMBOL" is not a US stock ticker or a supported crypto pair such as BTC/USD')
  })

  it('registers the seven tools with their model-facing descriptions', async () => {
    desk = await bootDesk({ config: { barsDefault: 50, barsCap: 200 } })
    expect(desk.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'cancel_order', 'get_account', 'get_bars', 'get_positions', 'get_quote', 'list_orders', 'place_order',
    ])
    expect(desk.ctx.tools.get('get_bars')?.description).toBe(
      'Get recent price bars for a US stock or a crypto pair, oldest first, with a summary: last price, high and low of the window, '
      + 'change, recent swing highs and lows, and the latest value of each requested indicator (sma: SMA 20, ema: EMA 20, '
      + 'rsi: RSI 14, macd: MACD 12/26/9, bollinger: Bollinger 20/2). Returns the last `limit` bars (default 50, at most 200) '
      + 'as a CSV table.')
    expect(desk.ctx.tools.get('place_order')?.description).toBe(PLACE_ORDER_DESCRIPTION)
  })
})
```

- [ ] **Step 2: Mount the tools in the harness and run the tests to verify they fail**

In `tests/harness.ts`, add `import * as TradingTools from '../src/tools.ts'`, add `readonly tools?: boolean` to `DeskOptions` (JSDoc: "Mount the tools plugin; default true."), and after the executor wait add `if (options.tools !== false) await ctx.plugin(TradingTools)`.

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/pipeline.spec.ts`
Expected: FAIL — `Cannot find module '../src/tools.ts'`.

- [ ] **Step 3: Write `src/tools.ts`**

```ts
/**
 * The seven model-facing trading tools over `ctx.tradingExecutor`. The `trader` agent preset mounts this plugin, so no
 * other agent sees them. `place_order` and `cancel_order` always ask: the executor's pre-execute listener checks the
 * proposal and asks, and the body sends only a checked, approved proposal.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { TIMEFRAMES } from '@deepseek-ai/dsh-experimental-trading'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { INDICATORS, renderBars } from './bars.ts'
import type { TradingExecutor } from './executor.ts'
import { NO_CHECKED_PROPOSAL, renderAccount, renderOrderReport, renderOrders, renderPositions, renderQuote } from './format.ts'
import type { AccountReport, BarsReport, OrderReport, OrdersReport, PositionReport, QuoteReport } from './types.ts'

/** Plugin name. */
export const name = 'tool-trading'
/** Services the tools call. */
export const inject = ['tools', 'tradingExecutor']

const SYMBOL = 'A US stock ticker such as AAPL, or a crypto pair such as BTC/USD (BTCUSD also works).'
const RATIONALE = 'One to three sentences on why, shown to the user with the approval request.'
const PLACE_ORDER = 'Propose a stock or crypto order. The user approves or rejects every order before it reaches the broker; an '
  + 'order that breaks a risk limit is refused with the reasons, and the limits cannot be changed from here. Give exactly one of '
  + 'qty or notional; notional orders are market orders. Crypto orders use time_in_force gtc or ioc and type market, limit, or '
  + 'stop_limit. Fractional and notional stock orders are day orders. A plain stop order is accepted only to reduce a position '
  + 'you hold; use stop_limit otherwise. A market order that adds exposure is sent as a limit near the quoted price, so it may '
  + 'not fill in a fast market. take_profit with stop_loss adds a bracket to a whole-share stock order. The result reports the '
  + 'order id and status; later fills arrive as messages.'
const OUTPUT = { type: 'json' } as const

/** Reports are plain JSON made of strings, booleans, and finite numbers; the registry snapshots and re-validates them. */
function json(value: object): JsonValue {
  return value as unknown as JsonValue
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

async function executeCall(executor: TradingExecutor, exec: ToolRunContext): Promise<JsonValue> {
  const sessionId = exec.agent?.session.id
  const proposalId = sessionId === undefined ? undefined : executor.proposalForCall(sessionId, exec.callId)
  if (sessionId === undefined || proposalId === undefined) throw new Error(NO_CHECKED_PROPOSAL)
  return json(await executor.execute(proposalId, sessionId))
}

/**
 * Register the trading tools.
 * @param ctx - plugin context with the tool registry and the executor.
 */
export function apply(ctx: Context): void {
  const executor = ctx.tradingExecutor
  const window = executor.barWindow()
  ctx.tools.register(defineTool({
    name: 'get_quote',
    description: 'Get the latest bid and ask for a US stock or a crypto pair, how old the quote is, and whether its market is open.',
    parameters: { symbol: { type: 'string', required: true, description: SYMBOL } },
    output: { schema: OUTPUT, render: (_args, value) => text(renderQuote(value as unknown as QuoteReport)) },
    isConcurrencySafe: () => true,
    execute: async args => json(await executor.quote(args.symbol)),
  }))
  ctx.tools.register(defineTool({
    name: 'get_bars',
    description: 'Get recent price bars for a US stock or a crypto pair, oldest first, with a summary: last price, high and low of '
      + 'the window, change, recent swing highs and lows, and the latest value of each requested indicator (sma: SMA 20, ema: '
      + 'EMA 20, rsi: RSI 14, macd: MACD 12/26/9, bollinger: Bollinger 20/2). Returns the last `limit` bars (default '
      + `${window.defaultCount}, at most ${window.cap}) as a CSV table.`,
    parameters: {
      symbol: { type: 'string', required: true, description: SYMBOL },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Bar length.' },
      limit: { type: 'integer', description: 'How many of the most recent bars to return.' },
      indicators: { type: 'array', items: { type: 'string', enum: [...INDICATORS] }, description: 'Indicators to summarize.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(renderBars(value as unknown as BarsReport)) },
    isConcurrencySafe: () => true,
    execute: async args => json(await executor.bars({
      symbol: args.symbol, timeframe: args.timeframe,
      ...args.limit === undefined ? {} : { limit: args.limit },
      ...args.indicators === undefined ? {} : { indicators: args.indicators },
    })),
  }))
  ctx.tools.register(defineTool({
    name: 'get_account',
    description: 'Get the trading account: paper or live, whether trading is ready or halted, equity, cash, buying power, and '
      + 'profit or loss since the previous close.',
    parameters: {},
    output: { schema: OUTPUT, render: (_args, value) => text(renderAccount(value as unknown as AccountReport)) },
    isConcurrencySafe: () => true,
    execute: async () => json(await executor.account()),
  }))
  ctx.tools.register(defineTool({
    name: 'get_positions',
    description: 'List open positions with quantity, quantity available to sell, average entry price, current price, market value, '
      + 'and unrealized profit or loss.',
    parameters: {},
    output: { schema: OUTPUT, render: (_args, value) => text(renderPositions(value as unknown as PositionReport[])) },
    isConcurrencySafe: () => true,
    execute: async () => json(await executor.positions()),
  }))
  ctx.tools.register(defineTool({
    name: 'list_orders',
    description: "List the broker's open orders with their order ids, and the orders proposed through this desk today with their "
      + 'status and fills.',
    parameters: {},
    output: { schema: OUTPUT, render: (_args, value) => text(renderOrders(value as unknown as OrdersReport)) },
    isConcurrencySafe: () => true,
    execute: async () => json(await executor.orders()),
  }))
  ctx.tools.register(defineTool({
    name: 'place_order',
    description: PLACE_ORDER,
    parameters: {
      symbol: { type: 'string', required: true, description: SYMBOL },
      side: { type: 'string', required: true, enum: ['buy', 'sell'] },
      qty: { type: 'number', description: 'Quantity in shares or coins. Give exactly one of qty or notional.' },
      notional: { type: 'number', description: 'Dollar amount for a market order. Give exactly one of qty or notional.' },
      type: { type: 'string', required: true, enum: ['market', 'limit', 'stop', 'stop_limit'] },
      limit_price: { type: 'number', description: 'Required for limit and stop_limit orders.' },
      stop_price: { type: 'number', description: 'Required for stop and stop_limit orders.' },
      time_in_force: {
        type: 'string', required: true, enum: ['day', 'gtc', 'ioc'],
        description: 'Stocks: day or gtc (fractional and notional orders are day only). Crypto: gtc or ioc.',
      },
      take_profit: { type: 'number', description: 'Bracket take-profit limit price; whole-share stock orders only, with stop_loss.' },
      stop_loss: { type: 'number', description: 'Bracket stop-loss price; whole-share stock orders only, with take_profit.' },
      rationale: { type: 'string', required: true, description: RATIONALE },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(renderOrderReport(value as unknown as OrderReport)) },
    execute: (_args, exec) => executeCall(executor, exec),
  }))
  ctx.tools.register(defineTool({
    name: 'cancel_order',
    description: 'Propose cancelling one open order by its order id from list_orders. The user approves or rejects the cancellation.',
    parameters: {
      order_id: { type: 'string', required: true, description: 'Order id from list_orders.' },
      rationale: { type: 'string', required: true, description: RATIONALE },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(renderOrderReport(value as unknown as OrderReport)) },
    execute: (_args, exec) => executeCall(executor, exec),
  }))
}
```

- [ ] **Step 4: Wire the listener, the guard, and settlement into the executor**

In `src/executor.ts`, add `import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'`, add `APPROVAL_OFF` and `NO_AGENT` to the `./format.ts` import, `parseCancelOrder` and `parsePlaceOrder` to the `./order-args.ts` import, and this constant below `FirstCheck`:

```ts
/** Tools whose calls must pass the executor: they reach the broker. */
const ORDER_TOOLS: ReadonlySet<string> = new Set(['place_order', 'cancel_order'])
```

Append to the constructor:

```ts
    // Steps 1–4 run here, before the body. A downstream deny or cancel stands; anything else is replaced by the
    // executor's own check and an ask. A listener prepended ahead that answers without delegating leaves no checked
    // proposal, so the body fails closed.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!ORDER_TOOLS.has(exec.name)) return next()
      const downstream = await next()
      if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
      return this.gate(exec)
    })
    // Guards run after the ask resolves and have no allow, so a Halt during the approval still stops the call.
    ctx.tools.guard(exec => ORDER_TOOLS.has(exec.name) && ctx.tradingVenue.status() === 'halted' ? HALTED : undefined)
    // Whatever ended the call (a guard, a later denial, an interrupted turn), its reservation must not outlive it.
    ctx.on('tools/result', (exec) => {
      const sessionId = exec.agent?.session.id
      if (!ORDER_TOOLS.has(exec.name) || sessionId === undefined) return
      const settled = this.book.settleCall(sessionId, exec.callId)
      if (settled !== undefined) this.journalLater(settled.proposal.proposalId, { status: 'rejected', note: 'not sent' })
    })
```

Add these private methods after `proposalForCall`:

```ts
  /** The pre-execute decision for an order tool call: deny, or ask with the checked proposal's summary. */
  private async gate(exec: ToolExecution): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent === undefined) return { kind: 'deny', reason: NO_AGENT }
    const approval = this.ctx.get('approval')
    const policy = approval === undefined ? 'never' : approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'
    if (policy === 'never') return { kind: 'deny', reason: APPROVAL_OFF }
    const context: ProposalContext = { session: agent.session, source: 'dsh-agent', callId: exec.callId }
    try {
      const result = await this.proposeFromArgs(exec.name, exec.arguments, context)
      if (result.kind === 'denied') return { kind: 'deny', reason: result.reasons.join('\n') }
      return { kind: 'ask', reason: result.summary }
    } catch (error) {
      return { kind: 'deny', reason: failureOf(error).message }
    }
  }

  private async proposeFromArgs(tool: string, args: unknown, context: ProposalContext): Promise<ProposeResult> {
    if (tool === 'place_order') {
      const parsed = parsePlaceOrder(args)
      return parsed.ok ? this.proposeOrder(parsed.value, context) : denied(parsed.reasons)
    }
    const parsed = parseCancelOrder(args)
    return parsed.ok ? this.proposeCancel(parsed.value, context) : denied(parsed.reasons)
  }
```

In `package.json` `exports`, after `"."`, add:

```json
    "./tools": {
      "types": "./lib/types/tools.d.ts",
      "default": "./lib/types/tools.js"
    },
```

- [ ] **Step 5: Run the pipeline and executor tests with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run gen-tsconfig-paths && pnpm exec vitest run packages/experimental/tool-trading --coverage --coverage.include='packages/experimental/tool-trading/src/{executor,tools}.ts'`
Expected: `tsconfig.base.json` gains `"@deepseek-ai/dsh-experimental-tool-trading/tools": ["./packages/experimental/tool-trading/src/tools.ts"]`; every spec PASS; both files 100%.

- [ ] **Step 6: Tool catalog, typecheck, commit**

Add a `gen-tool-catalog` entry beside `@deepseek-ai/dsh-experimental-tool-agent-team` in `scripts/gen-tool-catalog.ts`:

```ts
  {
    pkg: '@deepseek-ai/dsh-experimental-tool-trading',
    dir: 'tool-trading',
    source: 'packages/experimental/tool-trading/src/tools.ts',
    requires: ['ctx.tools', 'ctx.tradingExecutor'],
    writes: ['tool/call', 'trading/proposal', 'approval/asked', 'approval/decided', 'trading/order', 'trading/fill', 'tool/result'],
    async mount(ctx) {
      ctx.provide('tradingExecutor', { barWindow: () => ({ defaultCount: 100, cap: 500 }) } as unknown as TradingExecutor)
      await ctx.plugin(TradingTools)
    },
    note:
      'The seven trading tools of the experimental trading desk; only the trader agent preset of the trading profile mounts them. '
      + 'place_order and cancel_order always ask the user through the executor service at ctx.tradingExecutor.',
  },
```

with `import type { TradingExecutor } from '@deepseek-ai/dsh-experimental-tool-trading'` and `import * as TradingTools from '@deepseek-ai/dsh-experimental-tool-trading/tools'` at the top.

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run gen-tool-catalog && pnpm exec tsc -b packages/experimental/tool-trading && pnpm run lint`
Expected: `docs/tool-catalog.md` (and its `.zh.md` generated mirror, if the generator writes one) gain the seven tools; exit 0.

```bash
git add packages/experimental/tool-trading tsconfig.base.json scripts/gen-tool-catalog.ts docs/tool-catalog.md docs/tool-catalog.zh.md
git commit -m "feat(tool-trading): gate order tools through the executor and register the seven trading tools"
```

---

### Task 9: Fills, reconciliation, and injection into the proposing agent

**Files:**
- Modify: `packages/experimental/tool-trading/src/executor.ts` (init subscription and timer; `reconcile`, `onOrderEvent`, `applyOrder`, `reportFill`)
- Test: `packages/experimental/tool-trading/tests/fills.spec.ts`

**Interfaces:**
- Consumes: `TradingVenueGateway.subscribeOrderUpdates(listener): () => void` and `order(clientOrderId)` (Task 1); `Journal.inFlight`, `Journal.byClientOrderId` (Task 5); `fillText` (Task 7); `ctx.sessions.get(id)`, `ctx.sessions.flush(session)`; `ctx.agents.get(id)?.inject(message)` (`packages/core/agent/src/index.ts:563`; `inject` queues for the next step without waking an idle agent — `packages/core/agent-loop/src/agent.ts:145`; the inbox splice is itself logged as `agent/inbox/spliced`, which keeps "model-visible ⟺ logged").
- Produces: `TradingExecutor.reconcile(): Promise<void>` (public: Plan 4's gateway and Plan 5 may trigger it); the `trading/fill` event; the journal reaches `partially_filled` / `filled` / `canceled` / `expired` / `rejected` / `failed` and never moves backwards.

- [ ] **Step 1: Write the failing fill tests**

`packages/experimental/tool-trading/tests/fills.spec.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, BrokerOrderRequest, ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { type Session, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from '../src/journal.ts'
import { acceptedOrder } from './fake-venue.ts'
import { bootDesk, type Desk } from './harness.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
let desk: Desk
afterEach(async () => {
  vi.restoreAllMocks()
  await desk.close()
})

interface Placed { readonly proposalId: ProposalId; readonly request: BrokerOrderRequest; readonly orderId: BrokerOrderId }

async function placed(qty = 0.0002, callId = 'call-1', session: Session = desk.session): Promise<Placed> {
  const result = await desk.executor.proposeOrder(
    { order: { symbol: btc, side: 'buy', qty, type: 'market', timeInForce: 'gtc' }, rationale: 'Fill test.' },
    { session, source: 'dsh-agent', callId: ToolCallId(callId) },
  )
  if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`)
  const id = ApprovalRequestId(`approval-${callId}`)
  session.append('approval/asked', { id, toolName: 'place_order', callId: ToolCallId(callId) })
  session.append('approval/decided', { id, outcome: 'allowed-once' })
  const report = await desk.executor.execute(result.proposalId, session.id)
  const request = desk.venue.submitted.at(-1)
  if (request === undefined) throw new Error('nothing was submitted')
  return { proposalId: result.proposalId, request, orderId: brandString<BrokerOrderId>(report.orderId) }
}

const filledOrder = (order: Placed, filledQty = 0.0002, price = 62_831.5) =>
  acceptedOrder(order.request, { id: order.orderId, filledQty, filledAvgPrice: price, status: 'filled' })

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))

describe('fills from the order stream', () => {
  it('records a streamed fill once, in the journal and the session, and tells the proposing agent', async () => {
    desk = await bootDesk()
    const order = await placed()
    const update = { kind: 'update', update: { event: 'fill', order: filledOrder(order), t: Date.UTC(2026, 9, 5, 14),
      fillPrice: 62_831.5, fillQty: 0.0002 } } as const
    desk.venue.emit(update)
    desk.venue.emit(update)
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    await settle()
    expect(desk.events('trading/fill').map(event => event.data)).toEqual([{
      proposalId: order.proposalId, orderId: order.orderId, ticker: 'BTC/USD', side: 'buy', fillQty: 0.0002, fillPrice: 62_831.5,
      filledQty: 0.0002, filledAvgPrice: 62_831.5, status: 'filled', t: Date.UTC(2026, 9, 5, 14),
    }])
    expect(desk.injected.map(message => message.content)).toEqual([[{ type: 'text',
      text: `Order update: your buy of BTC/USD (order ${order.orderId}) filled 0.0002 at $62,831.50; 0.0002 filled in total, order filled.` }]])
    expect(desk.injected[0]?.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-experimental-tool-trading' })
    await desk.executor.reconcile()
    expect(desk.events('trading/fill')).toHaveLength(1)
    expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'filled', filledQty: 0.0002, filledAvgPrice: 62_831.5 })
  })

  it('records partial fills as they arrive and then the final fill', async () => {
    desk = await bootDesk()
    const order = await placed(0.0004)
    desk.venue.emit({ kind: 'update', update: { event: 'partial_fill', t: 1, fillPrice: 62_830, fillQty: 0.0001,
      order: acceptedOrder(order.request, { id: order.orderId, filledQty: 0.0001, filledAvgPrice: 62_830, status: 'partially_filled' }) } })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 2, fillPrice: 62_831, fillQty: 0.0003,
      order: filledOrder(order, 0.0004, 62_830.75) } })
    await vi.waitFor(() => {
      expect(desk.events('trading/fill').map(event => [event.data.fillQty, event.data.status]))
        .toEqual([[0.0001, 'partially_filled'], [0.0003, 'filled']])
    })
  })

  it('recovers a fill missed while the stream was down and never moves an order back to open', async () => {
    desk = await bootDesk()
    const order = await placed()
    desk.venue.known.set(order.request.clientOrderId, filledOrder(order))
    desk.venue.emit({ kind: 'gap', reason: 'the order-update stream reconnected' })
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    expect(desk.events('trading/fill')[0]?.data).toMatchObject({ fillQty: 0.0002, fillPrice: 62_831.5, status: 'filled' })
    desk.venue.emit({ kind: 'update', update: { event: 'new', order: acceptedOrder(order.request, { id: order.orderId }), t: 3 } })
    await settle()
    expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'filled', filledQty: 0.0002 })
  })

  it('reconciles on the timer when no gap is reported', async () => {
    desk = await bootDesk({ config: { reconcileMs: 1_000 } })
    const order = await placed()
    desk.venue.known.set(order.request.clientOrderId, filledOrder(order))
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) }, { timeout: 3_000 })
  })

  it('marks an order the broker never received as not placed instead of resubmitting it', async () => {
    desk = await bootDesk()
    desk.venue.respond = () => { throw new VenueError('Alpaca did not confirm order', 'unknown-outcome') }
    await expect(placed()).rejects.toThrow('the order outcome is unknown')
    await desk.executor.reconcile()
    expect((await desk.executor.orders()).today[0])
      .toMatchObject({ status: 'failed', note: 'the broker has no order with this id, so it was not placed' })
    expect(desk.venue.submitted).toHaveLength(1)
  })
})

describe('fills after a restart and without a live agent', () => {
  it('reconciles in-flight orders at startup and tells the agent of the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-restart-'))
    try {
      desk = await bootDesk({ root })
      const order = await placed()
      await desk.close()
      desk = await bootDesk({ root, prepare: (venue) => { venue.known.set(order.request.clientOrderId, filledOrder(order)) } })
      await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]?.status).toBe('filled') })
      await vi.waitFor(() => { expect(desk.injected).toHaveLength(1) })
      expect(desk.events('trading/fill')).toHaveLength(1)
    } finally {
      await desk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('journals the fill but records no event when the proposing session is not live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-restart-'))
    try {
      desk = await bootDesk({ root })
      const order = await placed()
      await desk.close()
      desk = await bootDesk({ root, sessionId: 'another-session',
        prepare: (venue) => { venue.known.set(order.request.clientOrderId, filledOrder(order)) } })
      await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]?.status).toBe('filled') })
      expect(desk.events('trading/fill')).toEqual([])
      expect(desk.injected).toEqual([])
    } finally {
      await desk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records fills without telling an agent for Claude Code proposals or sessions without a live agent', async () => {
    desk = await bootDesk()
    const order = await placed()
    const original = Journal.prototype.byClientOrderId
    vi.spyOn(Journal.prototype, 'byClientOrderId').mockImplementation(function (this: Journal, id: ClientOrderId) {
      const entry = original.call(this, id)
      return entry === undefined ? undefined : { ...entry, source: 'claude-code-mcp' }
    })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 1 } })
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    vi.restoreAllMocks()
    const loose = desk.ctx.sessions.create(SessionId('no-agent-session'))
    const second = await placed(0.0002, 'call-2', loose)
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(second), t: 2 } })
    await vi.waitFor(() => { expect(loose.snapshotEvents().filter(event => event.type === 'trading/fill')).toHaveLength(1) })
    expect(desk.injected).toEqual([])
  })

  it('ignores updates for orders the desk did not place and keeps going after failures', async () => {
    desk = await bootDesk()
    desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 1, order: acceptedOrder({ symbol: btc, side: 'buy', qty: 1,
      type: 'market', timeInForce: 'gtc', clientOrderId: brandString('elsewhere') }, { filledQty: 1, status: 'filled' }) } })
    const order = await placed()
    vi.spyOn(desk.agent, 'inject').mockImplementation(() => { throw new Error('agent disposed') })
    vi.spyOn(Journal.prototype, 'update').mockRejectedValueOnce(new Error('disk full'))
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 2 } })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 2 } })
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    expect(desk.events('trading/fill')[0]?.data).toMatchObject({ fillQty: 0.0002, fillPrice: 62_831.5 })
    await placed(0.0002, 'call-2')
    desk.venue.keysMissing = true
    desk.venue.emit({ kind: 'gap', reason: 'reconnected' })
    await settle()
    desk.venue.keysMissing = false
    await expect(desk.executor.reconcile()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/fills.spec.ts`
Expected: FAIL — `desk.executor.reconcile is not a function` and no `trading/fill` events.

- [ ] **Step 3: Implement fills and reconciliation**

In `src/executor.ts`, add `brandString` (`@deepseek-ai/dsh-brand`), `createUserMessage` (`@deepseek-ai/dsh-llm`), and the types `ClientOrderId`, `OrderStreamEvent`, `OrderUpdate` to the imports; `fillText` to the `./format.ts` import; `InFlightEntry` to the `./journal.ts` import; `TradingFillEvent` to the `./types.ts` import. Add below `ORDER_TOOLS`:

```ts
/** Plugin name on the fill notices an agent receives. */
const PLUGIN_NAME = '@deepseek-ai/dsh-experimental-tool-trading'

/** Journal status order: a later, lower-ranked observation (a stale snapshot) never moves an order back. */
const RANK: Readonly<Record<JournalStatus, number>> = {
  proposed: 0, submitted: 1, unknown: 1, partially_filled: 2, filled: 3, canceled: 3, expired: 3, rejected: 3, denied: 3, failed: 3,
}
```

Add a field `private readonly updates = new AccountLock()` (it serializes journal updates from the stream and from reconciliation). Replace `[Service.init]` with:

```ts
  /** Open the trading journal, follow the venue's order stream, and reconcile at startup and every `reconcileMs`. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(tradingJournalSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'tool-trading journal close')
    this.journalReady.resolve(new Journal(domain))
    const off = this.ctx.tradingVenue.subscribeOrderUpdates((event) => { this.onOrderEvent(event) })
    const timer = setInterval(() => { this.reconcileLater() }, this.settings.reconcileMs)
    timer.unref()
    this.ctx.effect(() => () => { off(); clearInterval(timer) }, 'tool-trading order updates')
    // A new subscriber gets no gap for what happened before it subscribed; read the broker state now.
    this.reconcileLater()
  }
```

Add after `execute`:

```ts
  /**
   * Re-read the broker's open orders and look up every journaled order still in flight, recording fills the stream did
   * not deliver. Runs at startup, on every order-stream gap, and every `reconcileMs`, because a socket that hangs
   * without closing reports no gap. An order the broker has no record of is marked not placed; nothing is resubmitted.
   * @returns when every in-flight order was checked.
   */
  async reconcile(): Promise<void> {
    const journal = await this.journalReady.promise
    const inFlight = journal.inFlight()
    if (inFlight.length === 0) return
    const venue = this.ctx.tradingVenue
    const open = new Map<string, BrokerOrder>((await venue.openOrders()).map(order => [order.clientOrderId, order]))
    for (const entry of inFlight) {
      const order = open.get(entry.clientOrderId) ?? await venue.order(brandString<ClientOrderId>(entry.clientOrderId))
      await this.updates.run(() => order === undefined ? this.markNotPlaced(journal, entry) : this.applyOrder(order))
    }
  }

  private onOrderEvent(event: OrderStreamEvent): void {
    if (event.kind === 'gap') {
      this.reconcileLater()
      return
    }
    const { update } = event
    this.updates.run(() => this.applyOrder(update.order, update)).catch((error: unknown) => {
      this.warn(`could not record an order update: ${(error as Error).message}`)
    })
  }

  private reconcileLater(): void {
    this.reconcile().catch((error: unknown) => { this.warn(`order reconciliation failed: ${(error as Error).message}`) })
  }

  private async markNotPlaced(journal: Journal, entry: InFlightEntry): Promise<void> {
    const note = 'the broker has no order with this id, so it was not placed'
    await journal.update(entry.proposalId, { status: 'failed', note }, Date.now())
  }

  /** Fold one broker view of a desk order into the journal; report the newly filled quantity, if any. */
  private async applyOrder(order: BrokerOrder, update?: OrderUpdate): Promise<void> {
    const journal = await this.journalReady.promise
    const entry = journal.byClientOrderId(order.clientOrderId)
    if (entry === undefined) return
    const observed = journalStatus(order.status)
    const status = RANK[observed] >= RANK[entry.status] ? observed : entry.status
    const filledQty = Math.max(order.filledQty, entry.filledQty)
    const delta = filledQty - entry.filledQty
    if (delta <= 0 && status === entry.status && order.id === entry.orderId) return
    const next = await journal.update(entry.proposalId, compact<JournalPatch>({
      status, orderId: order.id, filledQty, filledAvgPrice: order.filledAvgPrice ?? entry.filledAvgPrice, note: undefined,
    }), Date.now())
    if (delta > 0) await this.reportFill(next, order, delta, update)
  }

  /**
   * Record a fill as `trading/fill` in the proposing session (when it is live) and queue a notice for that session's
   * agent's next request; an idle agent is not woken. Claude Code proposals get no notice: Claude Code reads fills
   * through tool results and `list_orders`.
   */
  private async reportFill(entry: JournalEntry, order: BrokerOrder, delta: number, update?: OrderUpdate): Promise<void> {
    const fill = compact<TradingFillEvent>({
      proposalId: entry.proposalId, orderId: order.id, ticker: order.symbol.ticker, side: order.side,
      fillQty: update?.fillQty ?? delta, fillPrice: update?.fillPrice ?? order.filledAvgPrice, filledQty: entry.filledQty,
      filledAvgPrice: entry.filledAvgPrice, status: order.status, t: update?.t ?? Date.now(),
    })
    const session = this.ctx.sessions.get(entry.sessionId)
    if (session === undefined) return
    session.append('trading/fill', fill)
    await this.ctx.sessions.flush(session)
    if (entry.source !== 'dsh-agent') return
    try {
      this.ctx.agents.get(entry.sessionId)?.inject(createUserMessage({
        content: [{ type: 'text', text: fillText(fill) }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
      }))
    } catch (error) {
      this.warn(`could not tell the agent about a fill: ${(error as Error).message}`)
    }
  }
```

- [ ] **Step 4: Run every tool-trading spec with coverage**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading --coverage --coverage.include='packages/experimental/tool-trading/src/**'`
Expected: every spec PASS; every `src` file 100%.

- [ ] **Step 5: Typecheck and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec tsc -b packages/experimental/tool-trading && pnpm run lint`
Expected: exit 0.

```bash
git add packages/experimental/tool-trading
git commit -m "feat(tool-trading): record fills, reconcile in-flight orders, and tell the proposing agent"
```

---
### Task 10: Real composition through the Loader, and HMR disposal

**Files:**
- Test: `packages/experimental/tool-trading/tests/composition.spec.ts`

**Interfaces:**
- Consumes: the package root default export and `./tools` (Tasks 7–9); `Loader`, `Include` (precedent: `packages/experimental/trading-alpaca/tests/composition.spec.ts`); `FakeVenue` (Task 6).
- Produces: the repository's required real-composition test for `tool-trading` (`packages/AGENTS.md`) and the HMR-disposal proof for its registry contributions (tools, pre-execute listener, guard, `tools/result` listener, order-stream subscription).

- [ ] **Step 1: Write the composition test**

```ts
/**
 * Real-composition and HMR guard: the storage stack, sessions, agents, the system prompt, tools, approval, an in-memory
 * venue, the executor, and the tools plugin boot from a test-only cordis.yml through the Loader + Include path. A
 * place_order call asks, submits, and the fill reaches the agent; the journal survives a reboot over the same storage;
 * a misconfigured limit fails the executor at load; disposing each plugin removes its tools, listeners, guard, and
 * order-stream subscription.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as AgentModule from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import * as SessionModule from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as SystemPromptModule from '@deepseek-ai/dsh-system-prompt'
import * as ToolsModule from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ApprovalModule from '@deepseek-ai/dsh-user-approval'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ToolTrading from '../src/index.ts'
import * as TradingTools from '../src/tools.ts'
import * as FakeVenueModule from './fake-venue.ts'
import { acceptedOrder, FakeVenue } from './fake-venue.ts'

let root: string
let contexts: Context[]

const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-json', StorageJson],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-session', SessionModule],
  ['@deepseek-ai/dsh-agent', AgentModule],
  ['@deepseek-ai/dsh-system-prompt', SystemPromptModule],
  ['@deepseek-ai/dsh-tools', ToolsModule],
  ['@deepseek-ai/dsh-user-approval', ApprovalModule],
  ['fake-trading-venue', FakeVenueModule],
  ['@deepseek-ai/dsh-experimental-tool-trading', ToolTrading],
  ['@deepseek-ai/dsh-experimental-tool-trading/tools', TradingTools],
])

async function boot(trading: readonly string[] | false): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    '- name: fake-trading-venue',
    ...trading === false ? [] : [
      "- name: '@deepseek-ai/dsh-experimental-tool-trading'",
      '  config:',
      '    reconcileMs: 3600000',
      ...trading,
      "- name: '@deepseek-ai/dsh-experimental-tool-trading/tools'",
    ],
    '',
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function liveAgent(ctx: Context, id: string): Promise<{ agent: Agent; injected: UserMessage[] }> {
  const session = ctx.sessions.create(SessionId(id))
  const injected: UserMessage[] = []
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx,
    followup: () => {}, steer: () => {}, inject: (message) => { injected.push(message) }, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  return { agent, injected }
}

const venueOf = (ctx: Context): FakeVenue => {
  const venue = ctx.get('tradingVenue')
  if (!(venue instanceof FakeVenue)) throw new Error('fake venue missing')
  return venue
}

const placeOrder = (ctx: Context, agent: Agent, callId: string) => ctx.tools.execute({
  callId: ToolCallId(callId), name: 'place_order', agent, signal: new AbortController().signal,
  arguments: { symbol: 'BTC/USD', side: 'buy', qty: 0.0002, type: 'market', time_in_force: 'gtc', rationale: 'Composition test.' },
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-composition-'))
  await mkdir(join(root, 'storages'))
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('tool-trading real composition', () => {
  it('asks, submits, tells the agent about the fill, and keeps the journal across a reboot', async () => {
    const ctx = await boot([])
    await vi.waitFor(() => { expect(ctx.tools.get('place_order')).toBeDefined() })
    const venue = venueOf(ctx)
    const { agent, injected } = await liveAgent(ctx, 'composition-session')
    ctx.on('approval/request', async () => 'allowed-once')
    const result = await placeOrder(ctx, agent, 'call-1')
    expect(result.isError).toBe(false)
    const request = venue.submitted[0]
    if (request === undefined) throw new Error('nothing was submitted')
    expect(request).toMatchObject({ type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc' })
    venue.emit({ kind: 'update', update: { event: 'fill', t: 1, fillPrice: 62_900, fillQty: 0.0002,
      order: acceptedOrder(request, { filledQty: 0.0002, filledAvgPrice: 62_900, status: 'filled' }) } })
    await vi.waitFor(() => { expect(injected).toHaveLength(1) })
    await ctx.fiber.dispose()
    const again = await boot([])
    await vi.waitFor(async () => {
      expect((await again.get('tradingExecutor')?.orders())?.today).toMatchObject([{ status: 'filled', filledQty: 0.0002 }])
    })
  })

  it('fails the executor at load when a limit is misconfigured', async () => {
    const ctx = await boot(['    maxOrderNotional: -5'])
    expect(ctx.get('tradingExecutor')).toBeUndefined()
    expect(ctx.tools.get('place_order')).toBeUndefined()
  })

  it('removes the tools, the listeners, the guard, and the stream subscription when their plugins are disposed', async () => {
    const ctx = await boot(false)
    const venue = venueOf(ctx)
    const executor = ctx.plugin(ToolTrading.default, { reconcileMs: 3_600_000 })
    await vi.waitFor(() => { expect(ctx.get('tradingExecutor')).toBeDefined() })
    const tools = ctx.plugin(TradingTools)
    await vi.waitFor(() => { expect(ctx.tools.get('place_order')).toBeDefined() })
    expect(venue.listenerCount).toBe(1)
    await tools.dispose()
    expect(ctx.tools.get('place_order')).toBeUndefined()
    await executor.dispose()
    expect(ctx.get('tradingExecutor')).toBeUndefined()
    expect(venue.listenerCount).toBe(0)
    // With the executor gone, a stand-in place_order runs unguarded while halted: its listener and guard left with it.
    venue.current = 'halted'
    ctx.tools.register(defineTool({
      name: 'place_order', description: 'stand-in', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'ran',
    }))
    const { agent } = await liveAgent(ctx, 'after-dispose')
    expect(await ctx.tools.execute({ callId: ToolCallId('after'), name: 'place_order', arguments: {}, agent,
      signal: new AbortController().signal })).toMatchObject({ isError: false, value: 'ran' })
  })
})
```

- [ ] **Step 2: Run it**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading/tests/composition.spec.ts`
Expected: 3 passed. The misconfiguration case: the Loader logs the `RangeError` (`tool-trading: maxOrderNotional must be a finite number >= 0`) and leaves the row inactive; if the Loader instead rejects `ctx.loader.await()`, assert that rejection's message rather than the absent service.

- [ ] **Step 3: Full package coverage and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/tool-trading --coverage --coverage.include='packages/experimental/tool-trading/src/**'`
Expected: every spec PASS; every `src` file 100%.

```bash
git add packages/experimental/tool-trading/tests/composition.spec.ts
git commit -m "test(tool-trading): boot the executor and tools through the Loader and prove HMR disposal"
```

---

### Task 11: `bundle-trading` — the trading profile patch and the `trader` preset

**Files:**
- Create: `packages/experimental/bundle-trading/package.json`, `tsconfig.json`, `cordis.patch.yml`, `src/index.ts`
- Create: `packages/experimental/bundle-trading/presets/trader/agent.cordis.yml`, `presets/trader/preset.yml`
- Test: `packages/experimental/bundle-trading/tests/profile.spec.ts`
- Modify: `tsconfig.host.json`, `tsconfig.base.json` (regenerated), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: row ids of `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` (`mcp-resources` — `packages/bundle/base/cordis.patch.yml:471`; `cordis-host-runner`, `cordis-client-runner`, `ui-cordis`, `agent-presets` — `packages/bundle/web-app/cordis.patch.yml:121,198,274,522`); `AgentPresets.Config` (`default`, `roots[].path|trust`, `includeShippedRoot`, `includeUserRoot` — `packages/preset/agent-presets/src/index.ts:108-116`); tool-trading's `./tools` and Config (Tasks 2, 8).
- Produces: npm package `@deepseek-ai/dsh-experimental-bundle-trading` with `dsh.bundle.patch`; preset id `trader`.

- [ ] **Step 1: Write the failing profile test**

`packages/experimental/bundle-trading/tests/profile.spec.ts`:

```ts
/** The trading profile layer and the trader preset: parseable, explicit, and closed to every non-trading tool. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const shippedPresets = fileURLToPath(new URL('../../../preset/agent-presets/presets', import.meta.url))

interface Row {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
  readonly insert?: readonly Row[]
}

function rows(path: string): Row[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list`)
  return parsed as Row[]
}

describe('trading profile bundle', () => {
  it('is a public bundle carrying its patch, its presets, and the trading packages', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      private?: boolean; publishConfig?: { access?: string }; files?: string[]; dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toEqual(expect.arrayContaining(['cordis.patch.yml', 'presets']))
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-experimental-tool-trading': 'workspace:^',
      '@deepseek-ai/dsh-experimental-trading-alpaca': 'workspace:^',
    })
  })

  it('closes every non-trading path, keeps the Terminal tab, and selects only the trader preset', () => {
    const patch = rows(join(root, 'cordis.patch.yml'))
    for (const id of ['mcp-resources', 'cordis-host-runner', 'cordis-client-runner', 'ui-cordis']) {
      expect(patch.find(row => row.id === id), id).toEqual({ id, disabled: true })
    }
    expect(patch.some(row => row.id === 'terminal-controller' || row.id === 'ui-sidebar-terminal')).toBe(false)
    const presets = patch.find(row => row.id === 'agent-presets')
    expect(presets?.config).toMatchObject({ default: 'trader', includeShippedRoot: false, includeUserRoot: false })
    const roots = presets?.config?.roots as { path: { __jsExpr: string }; trust: string }[]
    expect(roots.map(entry => entry.trust)).toEqual(['system'])
    // oxlint-disable-next-line no-new-func -- evaluates the patch's own !!js expression the way the Loader does (`with (ctx)`)
    const resolveRoot = new Function('baseUrl', `return (${roots[0]?.path.__jsExpr ?? ''})`) as (baseUrl: string) => string
    expect(resolveRoot(pathToFileURL(root).href)).toBe(join(root, 'presets'))
    const inserted = patch.flatMap(row => row.insert ?? [])
    expect(inserted.map(row => [row.id, row.name])).toEqual([
      ['trading-alpaca', '@deepseek-ai/dsh-experimental-trading-alpaca'],
      ['trading-executor', '@deepseek-ai/dsh-experimental-tool-trading'],
    ])
    expect(inserted[0]?.config).toEqual({ mode: 'paper' })
    expect(inserted[1]?.config).toEqual({
      maxOrderNotional: 1000, maxPositionPct: 0.2, dailyLossPct: 0.03, maxOrdersPerDay: 20, allowShort: false, allowMargin: false,
      allowlist: [], denylist: [], staleQuoteMs: 30000, driftTolerance: 0.01, barsDefault: 100, barsCap: 500,
    })
  })

  it('composes the trader agent from its persona, the trading tools, and web search and fetch only', () => {
    expect(rows(join(root, 'presets/trader/agent.cordis.yml')).map(row => [row.id, row.name, row.config])).toEqual([
      ['persona', '@deepseek-ai/dsh-persona', expect.objectContaining({ prefix: expect.stringMatching(/^You are a trading assistant/) })],
      ['tool-trading', '@deepseek-ai/dsh-experimental-tool-trading/tools', undefined],
      ['tool-web', '@deepseek-ai/dsh-tool-web', { fetch: true, searchTimeoutMs: 60000 }],
    ])
    expect(yaml.load(readFileSync(join(root, 'presets/trader/preset.yml'), 'utf8'))).toEqual({
      name: 'Trader', description: 'Analyzes US stocks and crypto and proposes orders that you approve one at a time.', order: 1,
    })
  })

  it('keeps the trading tools out of every shipped preset', () => {
    for (const preset of readdirSync(shippedPresets)) {
      expect(readFileSync(join(shippedPresets, preset, 'agent.cordis.yml'), 'utf8'), preset).not.toContain('tool-trading')
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/bundle-trading`
Expected: FAIL — `ENOENT … bundle-trading/package.json`.

- [ ] **Step 3: Write the package**

`packages/experimental/bundle-trading/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-experimental-bundle-trading",
  "description": "Experimental trading profile bundle: the trading profile patch and the trader agent preset",
  "version": "0.1.6-alpha.1",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/experimental/bundle-trading"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "cordis.patch.yml",
    "presets",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-experimental-tool-trading": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-alpaca": "workspace:^",
    "@deepseek-ai/dsh-experimental-trading-venue": "workspace:^"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/cordis-plugin-include": "workspace:^",
    "js-yaml": "^4.2.0"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../tool-trading" },
    { "path": "../trading-alpaca" }
  ]
}
```

`src/index.ts`:

```ts
/**
 * @deepseek-ai/dsh-experimental-bundle-trading — the experimental trading profile bundle. Its runtime content is the
 * `dsh.bundle.patch` document and the `trader` agent preset under `presets/`; this module exports no runtime API.
 * @module @deepseek-ai/dsh-experimental-bundle-trading
 */

export {}
```

`cordis.patch.yml`:

```yaml
# Experimental trading profile layer. Apply after dsh-base and dsh-web-app:
#
#   dsh --profile trading --from-default-profile web
#   dsh plugin --profile trading add @deepseek-ai/dsh-experimental-bundle-trading
#
# The trader agent reaches the broker only through the trading tools, whose orders the
# user approves one by one. This layer removes the other ways a model could reach it:
# every preset except `trader` (and with them shell, file, code, workflow, delegation,
# and extension tools), the MCP resource tools on the host plane, and the cordis
# runners that let a model define Host or Client plugins. The Terminal tab stays.

- id: mcp-resources
  disabled: true

- id: cordis-host-runner
  disabled: true

- id: cordis-client-runner
  disabled: true

# The cordis browser view runs on the client runner disabled above.
- id: ui-cordis
  disabled: true

# Only the trader preset is selectable. Its root is this package's presets directory,
# found through the profile's node_modules, where `dsh plugin add` installed the package.
# A saved default naming another preset makes new sessions fail with an error that names
# it; choose Trader as the default (or turn off mode selection) in Settings to clear it.
- id: agent-presets
  config:
    default: trader
    includeShippedRoot: false
    includeUserRoot: false
    roots:
      - path: !!js >-
          process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(
          process.getBuiltinModule('node:module').createRequire(baseUrl)
          .resolve('@deepseek-ai/dsh-experimental-bundle-trading/package.json')), 'presets')
        trust: system

- insert:
    # Paper trading. Live mode also needs DSH_TRADING_LIVE=1 at launch.
    - id: trading-alpaca
      name: '@deepseek-ai/dsh-experimental-trading-alpaca'
      config:
        mode: paper

    # The order executor stays on the host plane so every order path shares one lock,
    # one set of reservations, and one journal; its tools mount only in the trader preset.
    - id: trading-executor
      name: '@deepseek-ai/dsh-experimental-tool-trading'
      config:
        maxOrderNotional: 1000
        maxPositionPct: 0.2
        dailyLossPct: 0.03
        maxOrdersPerDay: 20
        allowShort: false
        allowMargin: false
        allowlist: []
        denylist: []
        staleQuoteMs: 30000
        driftTolerance: 0.01
        barsDefault: 100
        barsCap: 500
```

`presets/trader/agent.cordis.yml`:

```yaml
# The `trader` agent preset: market analysis and order proposals only.
#
# The model receives exactly nine tools: get_quote, get_bars, get_account,
# get_positions, list_orders, place_order, cancel_order, web_search, and web_fetch.
# There is no shell, terminal, file, code, workflow, delegation, MCP, or extension
# tool, so the trading tools and their approval requests are the agent's only way to
# reach the broker.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: >-
      You are a trading assistant powered by the {{model}} model. You analyze US stocks and crypto pairs with the
      trading tools and web research, and you propose orders that the user approves one at a time. Base every
      proposal on data you fetched in this conversation and give the reason in its rationale. A refused order means
      a risk limit applies: explain the limit instead of retrying a variant. You cannot change the risk limits or
      resume a halted desk. Fills arrive as messages before the user's next message. You give analysis, not
      financial advice.

- id: tool-trading
  name: '@deepseek-ai/dsh-experimental-tool-trading/tools'

# The `web` service and its search provider stay in the host composition; only the
# model-facing tool is per-agent. web_fetch exposes no headers or method.
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
```

`presets/trader/preset.yml`:

```yaml
name: Trader
description: Analyzes US stocks and crypto and proposes orders that you approve one at a time.
order: 1
```

In `tsconfig.host.json` `references`, beside `./packages/experimental/tool-trading`, add `{ "path": "./packages/experimental/bundle-trading" },`.

- [ ] **Step 4: Install, run, typecheck**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm install && pnpm run gen-tsconfig-paths && pnpm exec vitest run packages/experimental/bundle-trading && pnpm exec tsc -b packages/experimental/bundle-trading && pnpm run lint`
Expected: 4 passed; exit 0. `src/index.ts` exports nothing and is 100% by construction.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/bundle-trading tsconfig.host.json tsconfig.base.json pnpm-lock.yaml
git commit -m "feat(bundle-trading): add the trading profile layer and the trader agent preset"
```

---

### Task 12: Keyless recorded-session snapshot through the trading profile

**Files:**
- Create: `apps/web/tests/trading-fake-broker.ts`, `apps/web/tests/trading-desk.snapshot.ts`
- Create: `snapshots/web/trading-desk/snapshot.yml`; recorded: `snapshots/web/trading-desk/session.v3.jsonl`, `system-prompt.expected.md`, `tool-schemas.expected.json`
- Modify: `scripts/session-snapshot-corpus.corpus.ts` (`snapshotAdapters` gains `'apps/web/tests/trading-desk.snapshot.ts'` after `'apps/web/tests/preset-migration.snapshot.ts'`)

**Interfaces:**
- Consumes: `launchWebScaffold({ replayFixture, compareReplaySession, harnessHome, extraOverlayPath, extraInstallAnchors })`, `recordFixture`, `assertFixtureInventory`, `webSnapshotMode` (`apps/web/tests/scaffold.ts`; precedent `apps/web/tests/minimal-preset.snapshot.ts` and `agent-team-panel.e2e.ts`); `scaffold.ctx.agents.create`, `scaffold.ctx.agentPresets.mount`/`resolve`/`roots`; the `approval/request` waterfall; the Alpaca REST and trade-stream wire formats Plan 2 maps (`packages/experimental/trading-alpaca/src/map.ts`).
- Produces: the keyless snapshot the spec requires ("analyze → propose → approve → fill through the trading profile with a fake broker provider"), the pinned `trader` tool allowlist (`tool-schemas.expected.json`) and prompt (`system-prompt.expected.md`), and the unknown-saved-default failure.

The fake broker is an HTTP + WebSocket stand-in for Alpaca, not a fake venue: the real `trading-alpaca` provider, executor, tools, preset, and profile layer all run. Approval is answered by a test listener on the generic `approval/request` waterfall (the Web approval panel needs a browser; Plan 4's composer card brings a browser test).

- [ ] **Step 1: Write the fake broker**

`apps/web/tests/trading-fake-broker.ts`:

```ts
/**
 * Keyless Alpaca stand-in for the trading-desk snapshot: the REST routes the venue and executor call for one BTC/USD
 * order, and a trade-updates WebSocket that sends that order's fill on demand. Every value is fixed except the quote
 * time, which is always the request time so the quote is never stale.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'

/** A running fake broker. */
export interface FakeBroker {
  /** REST base URL for both `tradingUrl` and `dataUrl`. */
  readonly url: string
  /** Trade-updates WebSocket URL. */
  readonly streamUrl: string
  /** Order bodies the desk posted. */
  readonly orders: Record<string, unknown>[]
  /** Sockets that authenticated and listen to trade updates. */
  listening(): number
  /** Fill the last posted order and send the update to every listening socket. */
  fill(): void
  /** Close both servers. */
  stop(): Promise<void>
}

const HOUR = 3_600_000
const LAST_BAR = Date.UTC(2026, 9, 5, 14)
// Newest first: the venue asks for `sort=desc` and reverses.
const BARS = Array.from({ length: 5 }, (_, i) => {
  const close = 62_850 - i * 40
  return { t: new Date(LAST_BAR - i * HOUR).toISOString(), o: close - 20, h: close + 30, l: close - 50, c: close, v: 3 + i }
})

async function body(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
}

/**
 * Start the broker on loopback ports.
 * @returns the running broker.
 */
export async function startFakeBroker(): Promise<FakeBroker> {
  const config: Record<string, unknown> = { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false }
  const orders: Record<string, unknown>[] = []
  let order: Record<string, unknown> | undefined
  let filled = false
  const route = (method: string, path: string, sent: Record<string, unknown> | undefined): { status: number; body: unknown } => {
    if (path === '/v2/account/configurations') {
      if (method === 'PATCH' && sent !== undefined) Object.assign(config, sent)
      return { status: 200, body: { ...config, fractional_trading: true } }
    }
    if (method === 'GET' && path === '/v2/account') {
      return { status: 200, body: { equity: '100000', cash: '100000', last_equity: '100000', buying_power: '100000' } }
    }
    if (method === 'GET' && path === '/v2/assets/BTCUSD') {
      return { status: 200, body: { symbol: 'BTC/USD', class: 'crypto', status: 'active', tradable: true, fractionable: true,
        price_increment: '0.01', min_order_size: '0.0001' } }
    }
    if (method === 'GET' && path === '/v1beta3/crypto/us/latest/quotes') {
      return { status: 200, body: { quotes: { 'BTC/USD': { t: new Date().toISOString(), bp: 62_830, ap: 62_835 } } } }
    }
    if (method === 'GET' && path === '/v1beta3/crypto/us/bars') {
      return { status: 200, body: { bars: { 'BTC/USD': BARS }, next_page_token: null } }
    }
    if (method === 'GET' && path === '/v2/positions') return { status: 200, body: [] }
    if (method === 'GET' && path === '/v2/orders') return { status: 200, body: order === undefined || filled ? [] : [order] }
    if (method === 'POST' && path === '/v2/orders' && sent !== undefined) {
      orders.push(sent)
      order = { id: 'order-1', client_order_id: sent.client_order_id, symbol: 'BTC/USD', asset_class: 'crypto', side: sent.side,
        type: sent.type, time_in_force: sent.time_in_force, qty: sent.qty, limit_price: sent.limit_price, filled_qty: '0', status: 'new' }
      return { status: 200, body: order }
    }
    if (method === 'GET' && path === '/v2/orders:by_client_order_id' && order !== undefined) return { status: 200, body: order }
    return { status: 404, body: { message: `no route ${method} ${path}` } }
  }
  const server: Server = createServer((request, response) => {
    void body(request).then((sent) => {
      const url = new URL(request.url ?? '/', 'http://fake')
      const answer = route(request.method ?? 'GET', url.pathname, sent)
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
  })
  const stream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const listeners = new Set<WebSocket>()
  stream.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse((raw as Buffer).toString()) as { action: string }
      if (message.action === 'auth') socket.send(JSON.stringify({ stream: 'authorization', data: { status: 'authorized' } }))
      if (message.action === 'listen') {
        listeners.add(socket)
        socket.send(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }))
      }
    })
    socket.on('close', () => { listeners.delete(socket) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  await new Promise<void>((resolve) => { stream.on('listening', () => { resolve() }) })
  const port = (target: Server | WebSocketServer): number => (target.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${String(port(server))}`,
    streamUrl: `ws://127.0.0.1:${String(port(stream))}`,
    orders,
    listening: () => listeners.size,
    fill() {
      if (order === undefined) throw new Error('no order to fill')
      filled = true
      order = { ...order, filled_qty: order.qty, filled_avg_price: order.limit_price, status: 'filled' }
      const frame = Buffer.from(JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', timestamp: '2026-10-05T14:30:00Z',
        price: order.limit_price, qty: order.qty, position_qty: order.qty, order } }))
      for (const socket of listeners) socket.send(frame)
    },
    async stop() {
      for (const socket of stream.clients) socket.terminate()
      await new Promise<void>((resolve) => { stream.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
```

- [ ] **Step 2: Write the snapshot adapter**

`apps/web/tests/trading-desk.snapshot.ts`:

```ts
// Keyless recorded-session snapshot of the trading profile: the trader agent analyzes BTC/USD, proposes a limit order
// that the user approves through the generic approval waterfall, the real Alpaca provider submits it to a local fake
// broker, the fill streams back, and the agent reads it on the next request.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertFixtureInventory, launchWebScaffold, recordFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { type FakeBroker, startFakeBroker } from './trading-fake-broker.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/trading-desk', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const BUNDLE_DIR = fileURLToPath(new URL('../../../packages/experimental/bundle-trading', import.meta.url))
const BUNDLE_PATCH = join(BUNDLE_DIR, 'cordis.patch.yml')
const MODE = webSnapshotMode()
const ANALYZE = 'Call get_bars for BTC/USD with timeframe 1h and limit 5. Then call place_order to buy qty 0.0002 of BTC/USD '
  + 'as a limit order with limit_price 62000 and time_in_force gtc, with the rationale "Snapshot test order near recent support." '
  + 'Then reply exactly ORDER_PROPOSED and stop.'
const FOLLOW_UP = 'Reply with exactly the fill price of that order as a plain number and nothing else.'
const ALLOWLIST = ['cancel_order', 'get_account', 'get_bars', 'get_positions', 'get_quote', 'list_orders', 'place_order',
  'web_fetch', 'web_search']

interface Desk { readonly scaffold: WebScaffold; readonly broker: FakeBroker; readonly home: string }

async function launchDesk(options: { readonly settings?: string; readonly replay: boolean }): Promise<Desk> {
  const broker = await startFakeBroker()
  const home = await mkdtemp(join(tmpdir(), 'dsh-trading-home-'))
  await writeFile(join(home, '.credentials.yaml'),
    'version: 1\nrefs:\n  ALPACA_API_KEY: fake-key\n  ALPACA_SECRET_KEY: fake-secret\n', { mode: 0o600 })
  if (options.settings !== undefined) await writeFile(join(home, 'settings.yaml'), options.settings)
  const overlay = join(home, 'trading.overlay.yml')
  await writeFile(overlay, [
    readFileSync(BUNDLE_PATCH, 'utf8'),
    '- id: trading-alpaca',
    '  config:',
    '    mode: paper',
    `    tradingUrl: ${broker.url}`,
    `    dataUrl: ${broker.url}`,
    `    tradeStreamUrl: ${broker.streamUrl}`,
    '    streamBackoffMs: [50]',
    '    lookupConfirmMs: 0',
    '',
  ].join('\n'))
  const scaffold = await launchWebScaffold({
    ...options.replay && MODE !== 'record' ? { replayFixture: FIXTURE, compareReplaySession: true } : {},
    harnessHome: home,
    extraOverlayPath: overlay,
    extraInstallAnchors: [join(BUNDLE_DIR, 'package.json')],
  })
  return { scaffold, broker, home }
}

async function closeDesk(desk: Desk | undefined): Promise<void> {
  await desk?.scaffold.close()
  await desk?.broker.stop()
  if (desk !== undefined) await rm(desk.home, { recursive: true, force: true })
}

describe('trading profile: trader agent trades on a fake broker', () => {
  let desk: Desk
  let handle: AgentHandle

  beforeAll(async () => {
    desk = await launchDesk({ replay: true })
    const { scaffold, broker } = desk
    scaffold.ctx.on('approval/request', async (request, next) => request.toolName === 'place_order' ? 'allowed-once' : next(),
      { prepend: true })
    await vi.waitFor(() => { expect(broker.listening()).toBe(1) }, { timeout: 15_000 })
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('trading-desk-snapshot'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'trader' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'trader').then(() => undefined),
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: ANALYZE }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    broker.fill()
    await vi.waitFor(() => {
      expect(handle.agent.session.snapshotEvents().some(event => event.type === 'trading/fill')).toBe(true)
    }, { timeout: 15_000 })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: FOLLOW_UP }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    if (MODE === 'record') await recordFixture(scaffold, handle.agent.session.id, FIXTURE)
  }, 240_000)

  afterAll(async () => {
    await handle?.dispose()
    await closeDesk(desk)
  })

  it('applies the shipped profile layer and gives the trader agent exactly the allowlisted tools', () => {
    expect(readFileSync(BUNDLE_PATCH, 'utf8').length).toBeGreaterThan(0)
    expect(desk.scaffold.ctx.agentPresets.roots).toEqual([{ path: realpathSync(join(BUNDLE_DIR, 'presets')), trust: 'system' }])
    const header = handle.agent.session.requestHeader()
    expect(header?.tools?.map(tool => tool.name).toSorted()).toEqual(ALLOWLIST)
    expect(desk.scaffold.ctx.tools.schemas(handle.agent).map(tool => tool.name).toSorted()).toEqual(ALLOWLIST)
  })

  it('asks with the proposal, submits the order to the broker, and tells the agent about the fill', () => {
    const events = handle.agent.session.snapshotEvents()
    const asked = events.find(event => event.type === 'approval/asked')
    expect(asked?.type === 'approval/asked' ? asked.data.reason?.split('\n')[0] : undefined)
      .toBe('PAPER Buy 0.0002 BTC/USD limit at $62,000.00 gtc')
    expect(desk.broker.orders).toEqual([expect.objectContaining({
      symbol: 'BTC/USD', side: 'buy', qty: '0.0002', type: 'limit', limit_price: '62000', time_in_force: 'gtc',
      client_order_id: expect.stringMatching(/^[0-9a-f]{64}$/),
    })])
    expect(events.filter(event => event.type === 'trading/fill')).toHaveLength(1)
    expect(JSON.stringify(events.filter(event => event.type === 'agent/inbox/spliced')))
      .toContain('filled 0.0002 at $62,000.00; 0.0002 filled in total, order filled.')
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'])
  })
})

describe('trading profile with a saved default from another profile', () => {
  it('fails new sessions loudly, naming the saved preset', async () => {
    const desk = await launchDesk({
      replay: false, settings: 'agent-presets:\n  default: standard\n  modeSelectionEnabled: true\n',
    })
    try {
      await expect(desk.scaffold.ctx.agentPresets.resolve())
        .rejects.toThrow('agent-presets: preset "standard" not found (available: trader)')
    } finally {
      await closeDesk(desk)
    }
  }, 120_000)
})
```

Create `snapshots/web/trading-desk/snapshot.yml`:

```yaml
version: 1
scenario: trading-desk
profile: web
composition: web-trading
recording: live
header:
  class: web-trading
  pin: true
```

Add `'apps/web/tests/trading-desk.snapshot.ts',` to `snapshotAdapters` in `scripts/session-snapshot-corpus.corpus.ts`, after `'apps/web/tests/preset-migration.snapshot.ts'`.

- [ ] **Step 3: Record, then refresh the sidecars**

Recording spends DeepSeek quota; the snapshot config loads `DEEPSEEK_API_KEY` from the repository-root `.env` itself (`vitest.snapshot.config.ts`) — do not open that file.

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run build && DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/trading-desk.snapshot.ts && DSH_EXAMPLE_MODE=lib DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/trading-desk.snapshot.ts`
Expected: record writes `session.v3.jsonl`; refresh writes `system-prompt.expected.md` and `tool-schemas.expected.json`; both runs pass. If the recorded model did not call `get_bars` then `place_order` with the requested arguments, rerun record once; if it still deviates, tighten `ANALYZE` (never edit the JSONL by hand). If the allowlist assertion lists another tool, disable the host-plane row that registers it in `bundle-trading/cordis.patch.yml` (add a profile.spec expectation for it) — never widen `ALLOWLIST`.

- [ ] **Step 4: Replay keylessly**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && env -u DEEPSEEK_API_KEY DSH_EXAMPLE_MODE=lib pnpm exec vitest run --config vitest.snapshot.config.ts apps/web/tests/trading-desk.snapshot.ts scripts/session-snapshot-corpus.corpus.ts`
Expected: all pass with no key. Review the fixture diff: `trading/proposal`, `approval/asked` (reason starting `PAPER Buy 0.0002 BTC/USD limit at $62,000.00 gtc`), `approval/decided` `allowed-once`, `trading/order` `submitted`, `trading/fill`, then the injected fill notice and the follow-up answer; `tool-schemas.expected.json` lists exactly the nine allowlisted tools.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/trading-fake-broker.ts apps/web/tests/trading-desk.snapshot.ts snapshots/web/trading-desk scripts/session-snapshot-corpus.corpus.ts
git commit -m "test(bundle-trading): record a keyless trading-desk session through the trading profile"
```

---
### Task 13: Documentation, catalogs, the spec note, and repository gates

**Files:**
- Create: `packages/experimental/tool-trading/README.md`, `packages/experimental/bundle-trading/README.md` (English only)
- Modify: `scripts/translation-pairing.manifest.json` (`excluded` += both README paths, kept sorted)
- Modify: `packages/experimental/README.md`, `packages/experimental/README.zh.md`, `packages/experimental/README.i18n.yaml` (two rows each, re-recorded pair)
- Modify: `docs/subsystems/trading.md`, `docs/subsystems/trading.zh.md`, `docs/subsystems/trading.i18n.yaml` (intro sentence; generated regions regenerate)
- Modify: `scripts/gen-doc-graphs.ts` (consumer of `tradingVenue`; `tradingExecutor` entry), regenerated graphs
- Modify: `docs/config-catalog.md`, `docs/config-catalog.zh.md`, `docs/config-catalog.i18n.yaml` (generated `tool-trading` section and its mirror)
- Create: `docs/persistence-changes/2026-10-06-trading-session-events.{md,zh.md,i18n.yaml,schema.json}` (generated by `persistence-changes --record`), `.agents/plans/trading-desk/03-persistence-prose.json` (input to that command; delete after use)
- Modify: `docs/persistence-schema.json` (generated)
- Modify: `.agents/notes/proposed/feature/2026-10-05-trading-desk.md`, `.zh.md`, `.i18n.yaml` (the venue row names order lookup and mode)
- Modify: any allowlist a gate names for these packages (`scripts/verify-package-readme-model-experience.ts`, `scripts/verify-package-readme-limitations.ts`, `scripts/verify-subsystem-pages.ts`)

**Interfaces:** none.

- [ ] **Step 1: Write `packages/experimental/tool-trading/README.md`**

Use `packages/experimental/tool-agent-team/README.md` for the section skeleton and anchors, without the language line. Content:

````markdown
---
description: "Trading order executor at ctx.tradingExecutor and the seven model-facing trading tools of the experimental trading desk."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-trading

## Summary

`dsh-experimental-tool-trading` is the order executor of the experimental trading desk and the seven tools the `trader` agent uses: `get_quote`, `get_bars`, `get_account`, `get_positions`, `list_orders`, `place_order`, and `cancel_order`. The executor service at `ctx.tradingExecutor` owns the only broker path the tools offer: it validates each proposed order, checks it against configured risk limits and reserves its exposure under a per-account lock, records it, asks the user, and after approval re-checks and submits it with an idempotent client order id. Fills from the venue's order stream are journaled, recorded in the proposing session, and given to that session's agent with its next request. The package root default-exports the service; `@deepseek-ai/dsh-experimental-tool-trading/tools` registers the tools. It talks to the broker only through `ctx.tradingVenue`. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to choose it

Use it through [`bundle-trading`](../bundle-trading/README.md), which mounts the executor on the host plane and the tools only inside the `trader` agent preset. Mounting the tools in a preset that also has a shell defeats the approval: an agent with a shell can read the broker keys and trade directly.

### Composition

```yaml
# host plane
- id: trading-executor
  name: '@deepseek-ai/dsh-experimental-tool-trading'
  config:
    maxOrderNotional: 1000
# agent preset
- id: tool-trading
  name: '@deepseek-ai/dsh-experimental-tool-trading/tools'
```

The executor injects `tradingVenue`, `tools`, `storageDomain`, `sessions`, and `agents`, and reads `approval` when it is composed.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxOrderNotional` | `1000` | Largest estimated order value in dollars |
| `maxPositionPct` | `0.2` | Largest position as a fraction of equity, counting open orders and pending proposals |
| `dailyLossPct` | `0.03` | Day loss against the previous close at which exposure-increasing orders stop |
| `maxOrdersPerDay` | `20` | Desk orders per trading day (America/New_York), counting pending proposals |
| `allowShort` | `false` | Whether sells may open or extend a short |
| `allowMargin` | `false` | Whether buys may exceed cash |
| `allowlist` / `denylist` | `[]` | Tickers allowed (empty allows all) / never allowed |
| `staleQuoteMs` | `30000` | Quote age above which market orders are refused while the market is open |
| `driftTolerance` | `0.01` | Allowed price drift between approval and submission, and the market-order price cap |
| `barsDefault` / `barsCap` | `100` / `500` | Bars `get_bars` returns by default and at most |
| `reconcileMs` | `60000` | Interval between re-reads of open and in-flight orders |
| `exitRetryMs` | `[500, 1000, 2000]` | Retries of a crypto exit the broker refused for insufficient balance right after a fill |

A negative, non-finite, or out-of-range value fails the plugin at load with a `RangeError` naming the field. Limits change only in configuration, never from chat.

### What success and failure look like

| Condition | What the model receives |
|---|---|
| A limit fails at the first check | A denial listing each failed check; the user is not asked |
| The user rejects or the approval is cancelled | The generic approval denial; nothing is sent |
| Approval prompts are off (`never`, including `DSH_PERMISSION_MODE=danger-full-access`) or no approval service | `orders need the user's approval, and approval prompts are off in this session` |
| Halted (before or during the approval) | `trading is halted; only the user can resume trading` |
| Price moved past the tolerance, or a limit fails, after approval | `price moved; propose again` plus the failed checks |
| Keys missing | `Alpaca keys not configured — add them in Settings → Trading` |
| Submission outcome unknown, or a reused client order id the broker does not show | `the order outcome is unknown …` / `… check list_orders before proposing again`; never "not placed" |
| A listener ahead of the executor answered without delegating | `no checked proposal for this call` |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Order flow, journal, fills, and the source map — click to expand</summary>

### Order flow

1–4 run in the executor's `tools/pre-execute` listener (and in `proposeOrder` / `proposeCancel` for the MCP endpoint): validate against the broker's rules and the price tick; under the account lock read quote, account, positions, open orders, reservations, and today's count, run `checkRisk`, plan the broker order, and reserve; journal the proposal and append `trading/proposal`; ask with the summary. The listener calls `next()` first and keeps a downstream deny. 5–8 run in the tool body (`execute`): only a proposal whose own `trading/proposal` committed and whose call received `allowed-once` (observed through `approval/asked` / `approval/decided`) is sent; under the lock it is re-snapshotted and re-checked, planned with the re-check's reduce-only answer, and submitted with `client_order_id` = SHA-256 of `sessionId:proposalId`. The `ctx.tools.guard()` denies both order tools while the venue is halted, after the ask resolves. A `tools/result` listener settles whatever the call left reserved.

### Journal and fills

The journal is the storage domain `trading_journal` (table `entries`, one record per proposal). Order-stream updates, every gap, startup, and a `reconcileMs` timer fold the broker's view into it; status never moves backwards, and each newly filled quantity is reported once as `trading/fill` and as a notice injected into the proposing session's agent (`dsh-agent` proposals only). An in-flight order the broker has no record of is marked not placed; nothing is resubmitted.

### Source map

| File | Owns |
|---|---|
| `src/executor.ts` | The service: proposals, pipeline wiring, execution, fills, reconciliation |
| `src/tools.ts` | The seven tool definitions (`./tools` plugin) |
| `src/book.ts` | Reservations, proposal states, call and approval links |
| `src/journal.ts` | The `trading_journal` domain |
| `src/snapshot.ts` | One risk snapshot; order planning and the broker request |
| `src/order-args.ts` | Raw argument parsing and the price-tick check |
| `src/bars.ts` | The `get_bars` report |
| `src/format.ts` | Model-facing texts and renderers |
| `src/config.ts`, `src/ids.ts`, `src/lock.ts`, `src/types.ts` | Config, ids and the trading day, the account lock, types and session events |

No `./invariant` companion is published: every relation the executor owns (approval before submission, reservation release, journal monotonicity) is enforced in the operation that makes it and pinned by tests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Trading subsystem](../../../docs/subsystems/trading.md) — the venue and executor service APIs.
- [trading-venue](../trading-venue/README.md) and [trading-alpaca](../trading-alpaca/README.md) — the broker seam and its provider.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-trading) — the exact schemas.
- [Trading desk Agent Note](../../../.agents/notes/proposed/feature/2026-10-05-trading-desk.md) — the design.

-----

<a id="model-experience"></a>
## Model Experience

### Trading tools

#### What the model sees

Seven tool schemas with the descriptions in `src/tools.ts`: read tools return compact text (quote, account, positions, open and desk orders, and for `get_bars` a summary with swing points and indicator values followed by a CSV table of at most `barsCap` bars); `place_order` and `cancel_order` return the order id and status or a denial reason. Every order call is followed by a user decision the model does not see except as the tool result.

#### Token effect

Fixed schema cost per request for the seven tools. `get_bars` results grow with `limit` (about 40 tokens per bar row); the default is 100 and the cap 500.

#### KV Cache effect

Schemas are stable for a preset generation, so the request prefix is reusable; `barsDefault`/`barsCap` appear in the `get_bars` description, so changing them changes the prefix.

### Fill notices

#### What the model sees

When an order of the agent's own proposals fills, the next request carries a user message from `@deepseek-ai/dsh-experimental-tool-trading`: `Order update: your buy of BTC/USD (order …) filled 0.0002 at $62,000.00; 0.0002 filled in total, order filled.` An idle agent is not woken.

#### Token effect

About 40 tokens per fill.

#### KV Cache effect

Appended after the existing history; no prefix change.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No resume, flatten, or close tool** — Halt, resume, Close, and Cancel all & flatten are user actions in the Trading panel (Plan 4); the agent cannot resume trading.
- **Approval card** — until the Trading panel's composer card exists, approval uses the generic approval panel, which shows the proposal summary as its headline.
- **Daily order count** — counts orders placed through this desk; orders placed elsewhere with the same keys are not counted.
- **MCP approvals** — the trading-owned approval queue for Claude Code over MCP (events `trading/approval-asked` / `trading/approval-decided`) arrives with `trading-mcp`; until then only in-app approvals release a proposal.
- **Unpriced open market buys** — an open market buy without a limit or stop price counts 0 toward committed cash; the broker's own cash check (margin multiplier 1) still applies.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The proposal book is in memory by design: a restart aborts pending tool calls, so a lost entry fails closed. Do not replace it with history scans (`Session.eventAt`/`snapshotEvents` are deprecated outside tests).

</details>
````

- [ ] **Step 2: Write `packages/experimental/bundle-trading/README.md`**

Use `packages/experimental/agent-team-profile/README.md` for the skeleton (`kind: "package-bundle"`), without the language line. Required content:

- **Summary:** the trading profile layer over `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` and the `trader` preset; paper by default; no shipped profile enables it.
- **Install into a profile:** `dsh --profile trading --from-default-profile web`, then `dsh plugin --profile trading add @deepseek-ai/dsh-experimental-bundle-trading`, then put `ALPACA_API_KEY` and `ALPACA_SECRET_KEY` (paper keys) into `$DSH_HOME/.credentials.yaml` (the Trading settings card arrives with the Trading panel), then start `dsh --profile trading`.
- **What the layer changes:** a table of every row the patch touches — `mcp-resources`, `cordis-host-runner`, `cordis-client-runner`, `ui-cordis` disabled; `agent-presets` with `default: trader`, `includeShippedRoot: false`, `includeUserRoot: false`, and the package's `presets` directory as the only (system) root; `trading-alpaca` (`mode: paper`) and `trading-executor` inserted with the spec's limits. `terminal-controller` and `ui-sidebar-terminal` stay.
- **The trader preset:** its three rows and the exact nine tools; no shell, file, code, workflow, delegation, MCP, or extension tool.
- **Model Experience:** the persona prefix verbatim (from `presets/trader/agent.cordis.yml`), its token effect (fixed, about 120 tokens), and KV-cache effect (stable per model; `{{model}}` interpolation changes it only when the model changes).
- **Known Limitations:** a saved `agent-presets.default` from another profile (settings are shared under `$DSH_HOME`) makes new sessions fail with `agent-presets: preset "<id>" not found (available: trader)` until the user picks Trader or turns off mode selection; an external shell-capable agent (Claude Code in the Terminal tab) can still read the keys — see the spec's Execution boundary; the Trading panel, gateway, and market-data stream arrive with Plan 4 and the MCP endpoint with Plan 5.
- **Dev Note:** the preset root is resolved with `createRequire(baseUrl)` from the profile directory, where `dsh plugin add` (and the web test scaffold's install anchors) place the package.

- [ ] **Step 3: Group rows, manifest, subsystem page, doc graphs**

`packages/experimental/README.md`, after the `trading-venue` row:

```markdown
| [`tool-trading`](tool-trading/README.md) | Trading order executor and the seven trading tools: proposals, approval, re-check, idempotent submit, journal, fills | provides `ctx.tradingExecutor` |
| [`bundle-trading`](bundle-trading/README.md) | Experimental trading profile layer and the `trader` agent preset | profile bundle — no ctx key |
```

`packages/experimental/README.zh.md`, after the `trading-venue` row (links point at the English READMEs):

```markdown
| [`tool-trading`](tool-trading/README.md) | 交易下单执行器与七个交易工具：提议、审批、复核、幂等提交、日志、成交 | 提供 `ctx.tradingExecutor` |
| [`bundle-trading`](bundle-trading/README.md) | 实验性交易 profile 层与 `trader` Agent 预设 | profile bundle——无 ctx key |
```

`scripts/translation-pairing.manifest.json` `excluded`: add `"packages/experimental/bundle-trading/README.md"` and `"packages/experimental/tool-trading/README.md"` in sorted position.

`docs/subsystems/trading.md` intro paragraph: append `[`@deepseek-ai/dsh-experimental-tool-trading`](../../packages/experimental/tool-trading/README.md) provides the order executor at `ctx.tradingExecutor`, the only broker path the trading tools offer.` and mirror it in `trading.zh.md`: `[`@deepseek-ai/dsh-experimental-tool-trading`](../../packages/experimental/tool-trading/README.md) 在 `ctx.tradingExecutor` 上提供下单执行器，它是交易工具通往券商的唯一路径。`

`scripts/gen-doc-graphs.ts`: in the `tradingVenue` entry add `consumers: ['experimental-tool-trading'],` and after it add:

```ts
  {
    key: 'tradingExecutor',
    pkg: 'experimental-tool-trading',
    title: 'Trading order executor',
    mode: 'core',
    consumers: ['experimental-tool-trading'],
    note: 'Validates, risk-checks, reserves, and records orders, then re-checks and submits them over ctx.tradingVenue after the '
      + 'user approves; the seven trading tools and the MCP endpoint call it.',
  },
```

- [ ] **Step 4: Spec note, persistence acknowledgement, generators**

In the spec note's Package topology table, append to the `trading-venue` row's Exposes cell `, order lookup by client order id, account mode` (English) and `、按 client order id 查询订单、账户模式` (Chinese), then re-record the pair.

Write `.agents/plans/trading-desk/03-persistence-prose.json`:

```json
{
  "en": {
    "summary": "Add the trading desk's log-only session events: trading/proposal (a checked order or cancellation proposal), trading/order (the outcome of sending an approved proposal), and trading/fill (one fill of a desk order).",
    "compatibility": "New required-on-read event types written only by sessions of the experimental trading profile; logs without them are unchanged, and builds that predate them refuse logs that contain them, as for any new in-repo event type.",
    "verification": "tool-trading executor, pipeline, fill, and composition specs append and read each event; the trading-desk web snapshot replays a session containing all three."
  },
  "zh": {
    "summary": "新增交易台的仅日志会话事件：trading/proposal（已检查的下单或撤单提议）、trading/order（发送已批准提议的结果）与 trading/fill（交易台订单的一次成交）。",
    "compatibility": "仅由实验性交易 profile 的会话写入的新增必读事件类型；不含这些事件的日志不受影响，早于它们的构建会拒绝包含它们的日志，与任何新增仓库内事件类型相同。",
    "verification": "tool-trading 的 executor、pipeline、fill 与 composition 测试会追加并读取每种事件；trading-desk Web 快照回放包含全部三种事件的会话。"
  }
}
```

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run persistence-changes --record 2026-10-06-trading-session-events --prose .agents/plans/trading-desk/03-persistence-prose.json && rm .agents/plans/trading-desk/03-persistence-prose.json && pnpm run gen-persistence-catalog && pnpm run gen-config-catalog && pnpm run gen-cordis-catalog && pnpm run gen-cordis-inspect-catalog && pnpm run gen-doc-graphs && pnpm run gen-tool-catalog && pnpm run gen-dependency-catalog`
Expected: the record and its schema are written under `docs/persistence-changes/`, `docs/persistence-schema.json` updates, and every generator exits 0. Mirror each new `docs/config-catalog.md` line in `docs/config-catalog.zh.md` beside its English neighbor (copy that neighbor's format).

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && for f in packages/experimental/README.md docs/subsystems/trading.md docs/config-catalog.md .agents/notes/proposed/feature/2026-10-05-trading-desk.md; do pnpm run verify-translation-pairing --write $f; done`
Expected: four records written.

- [ ] **Step 5: Run the gates**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run constraints && pnpm run typecheck && pnpm run lint && pnpm run doc-sync && pnpm run build && pnpm run hygiene`
Expected: all exit 0. Fix what a gate names and re-run only that gate. Expected gate asks and their fixes: `verify-package-readme-model-experience` accepts both READMEs because each has a canonical Model Experience section; `verify-subsystem-pages` may require the group link already added; `verify-default-product-isolation` must stay green (only `apps/web` tests and `apps/cli` devDependencies may name experimental packages). No shipped composition emits `trading/*` events, so the SDK snapshot projections (`snapshots/sdk/`, `scripts/snapshots/python-sdk-single-exe/`) do not change.

- [ ] **Step 6: Commit**

```bash
git add packages/experimental/tool-trading/README.md packages/experimental/bundle-trading/README.md packages/experimental/README.md packages/experimental/README.zh.md packages/experimental/README.i18n.yaml scripts docs .agents/notes/proposed/feature/2026-10-05-trading-desk.md .agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md .agents/notes/proposed/feature/2026-10-05-trading-desk.i18n.yaml
git commit -m "docs(tool-trading): document the executor, the trading tools, and the trading profile"
```

---

### Task 14: Opt-in executor paper e2e, the manual desk run, and the roadmap

**Files:**
- Create: `packages/experimental/tool-trading/tests/executor-paper.e2e.ts`
- Modify: `apps/cli/package.json` (`devDependencies` += `"@deepseek-ai/dsh-experimental-bundle-trading": "workspace:^"`, beside `@deepseek-ai/dsh-experimental-agent-team-profile`, so the source launch can resolve the profile's packages for the manual run), `pnpm-lock.yaml`
- Modify: `.agents/plans/trading-desk/00-roadmap.md` (Plan 3 status once the manual run passes)

**Interfaces:**
- Consumes: `AlpacaVenue` (`@deepseek-ai/dsh-experimental-trading-alpaca`), `createLaunchEnvironmentSnapshot` / `DSH_LAUNCH_ENVIRONMENT_KEY` (`@deepseek-ai/dsh-launch-environment`), the executor and tools.

- [ ] **Step 1: Write the e2e test**

```ts
/**
 * Opt-in Alpaca paper e2e for the executor. Needs DSH_ALPACA_PAPER_E2E=1 plus ALPACA_API_KEY / ALPACA_SECRET_KEY of a
 * paper account. Effects on that account: buys about $12 of BTC/USD through place_order (sent as a capped IOC limit),
 * waits for the fill notice, sells the position through place_order (a reduce-only market exit, retried while Alpaca
 * releases the coins), and in `finally` closes any BTC/USD left and cancels this test's open BTC/USD orders. It refuses to
 * run when the account already holds BTC/USD or has open BTC/USD orders.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AlpacaVenue from '@deepseek-ai/dsh-experimental-trading-alpaca'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import TradingExecutor from '../src/index.ts'
import * as TradingTools from '../src/tools.ts'

const keyId = process.env.ALPACA_API_KEY
const secret = process.env.ALPACA_SECRET_KEY
const enabled = process.env.DSH_ALPACA_PAPER_E2E === '1' && keyId !== undefined && secret !== undefined
const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const

describe.skipIf(!enabled)('executor on Alpaca paper', () => {
  it('buys and sells BTC/USD through place_order with approval, and reports both fills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-paper-'))
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { ALPACA_API_KEY: keyId ?? '', ALPACA_SECRET_KEY: secret ?? '' } },
    ]))
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      await ctx.plugin(AlpacaVenue, {})
      await vi.waitFor(() => { expect(ctx.get('tradingVenue')?.status()).toBe('ready') }, { timeout: 30_000 })
      const venue = ctx.get('tradingVenue')
      if (venue === undefined) throw new Error('venue missing')
      if ((await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD') || (await venue.openOrders()).some(o => o.symbol.ticker === 'BTC/USD')) {
        throw new Error('this paper account already holds BTC/USD or has open BTC/USD orders; use a clean paper account')
      }
      await ctx.plugin(TradingExecutor, { maxOrderNotional: 50, exitRetryMs: [1_000, 2_000, 4_000] })
      await vi.waitFor(() => { expect(ctx.get('tradingExecutor')).toBeDefined() })
      await ctx.plugin(TradingTools)
      ctx.on('approval/request', async () => 'allowed-once')
      const session = ctx.sessions.create(SessionId('paper-e2e'))
      const injected: UserMessage[] = []
      const agent: Agent = {
        id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx,
        followup: () => {}, steer: () => {}, inject: (message) => { injected.push(message) }, send: () => {}, cancel() {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(agent)
      session.append('turn/start', { turn: 1 })
      const quote = await venue.latestQuote(btc)
      const qty = Math.ceil(12 / quote.ask * 1e6) / 1e6
      const order = (callId: string, side: 'buy' | 'sell', amount: number) => ctx.tools.execute({
        callId: ToolCallId(callId), name: 'place_order', agent, signal: new AbortController().signal,
        arguments: { symbol: 'BTC/USD', side, qty: amount, type: 'market', time_in_force: 'gtc', rationale: 'Paper e2e.' },
      })
      const bought = await order('buy-1', 'buy', qty)
      expect(bought.isError, JSON.stringify(bought.content)).toBe(false)
      await vi.waitFor(() => { expect(injected).toHaveLength(1) }, { timeout: 60_000, interval: 500 })
      const held = (await venue.positions()).find(p => p.symbol.ticker === 'BTC/USD')?.qty ?? 0
      expect(held).toBeGreaterThan(0)
      const sold = await order('sell-1', 'sell', held)
      expect(sold.isError, JSON.stringify(sold.content)).toBe(false)
      await vi.waitFor(() => { expect(injected).toHaveLength(2) }, { timeout: 60_000, interval: 500 })
      const kinds = session.snapshotEvents().filter(e => e.type === 'trading/order').map(e => e.data.outcome)
      expect(kinds).toEqual(['submitted', 'submitted'])
    } finally {
      const venue = ctx.get('tradingVenue')
      if (venue !== undefined) {
        if ((await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD')) await venue.closePosition(btc)
        for (const open of await venue.openOrders()) if (open.symbol.ticker === 'BTC/USD') await venue.cancelOrder(open.id)
      }
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
```

The `finally` cleanup may cancel a BTC/USD order this test did not place only when the precondition above was violated, which throws before any order; with a clean account every BTC/USD order is this test's.

- [ ] **Step 2: Verify it skips without the opt-in and commit**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && env -u DSH_ALPACA_PAPER_E2E pnpm exec vitest run --config vitest.e2e.config.ts packages/experimental/tool-trading`
Expected: 1 skipped, 0 failed.

```bash
git add packages/experimental/tool-trading/tests/executor-paper.e2e.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "test(tool-trading): add an opt-in Alpaca paper e2e for the executor"
```

Before committing, run `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm install && pnpm run verify-default-product-isolation` (devDependencies may name experimental packages; `dependencies` may not) and `pnpm dsh --profile trading-check --from-default-profile web --patch packages/experimental/bundle-trading/cordis.patch.yml --dump-config | grep -E "trading-executor|agent-presets" ` — expected: both rows printed with the patch as their source. Delete the `trading-check` profile directory under `$DSH_HOME/profiles/` afterwards.

- [ ] **Step 3: The user runs the paper e2e and the desk by hand**

The controller asks the user to run these on their machine (they use the user's paper keys; the agent never reads `.env` or the credentials file):

1. `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && DSH_ALPACA_PAPER_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts packages/experimental/tool-trading` with `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` exported → 1 passed.
2. `pnpm run build`, then `pnpm dsh --profile trading --from-default-profile web --patch packages/experimental/bundle-trading/cordis.patch.yml` (the published path is `dsh plugin --profile trading add @deepseek-ai/dsh-experimental-bundle-trading`; the `--patch` form runs the same layer from source) with paper keys in `$DSH_HOME/.credentials.yaml`. In the Web app, open a session (the only preset is Trader), ask "Analyze BTC/USD on the 1h chart and propose a $12 market buy", approve the request in the approval panel, and confirm: the order appears in Alpaca's paper dashboard; the next reply mentions the fill; asking it to sell the position produces a second approval and a market exit. If the session fails with `agent-presets: preset "<id>" not found (available: trader)`, set the default to Trader in Settings (the saved default is shared by every profile). If the preset root does not resolve under the source launch, add the root row with the absolute path `<repo>/packages/experimental/bundle-trading/presets` to `$DSH_HOME/profiles/trading/cordis.patch.yml` for the manual run and report it as a deviation.

- [ ] **Step 4: Mark Plan 3 done in the roadmap**

After both runs pass, set the Plan 3 row's Status cell in `.agents/plans/trading-desk/00-roadmap.md` to `Done (branch `feat/trading-desk`)` and commit:

```bash
git add .agents/plans/trading-desk/00-roadmap.md
git commit -m "docs(plans): mark the trading executor, tools, and profile plan done"
```

---

## Deferred to later plans

- **Plan 4:** Trading panel, composer approval card (reads `trading/proposal` by `callId`), tool views (`tool.call.toolview`), Trading settings card (limits, keys, Halt/resume, Close, Cancel all & flatten), `trading-gateway`, market-data WebSocket, LIVE badge, Today's trades tab (journal entries carry `sessionId` and `callId` for the message link), re-running venue setup when keys are added later (Plan 2 ledger Task 9).
- **Plan 5:** `trading-mcp` and its trading-owned approval queue: new `trading/approval-asked` / `trading/approval-decided` events that the executor's `observe` folds the same way it folds `approval/asked` / `approval/decided` today; per-session tokens; SSE progress; the Pending approvals strip. The executor API it calls already exists: `proposeOrder`/`proposeCancel` with `source: 'claude-code-mcp'` and no `callId` (identical pending MCP proposals return `kind: 'duplicate'`), `execute(proposalId, sessionId)`, the read methods, and `reconcile()`.

## Spec coverage (self-review)

| Spec requirement (Plan 3 scope) | Task |
|---|---|
| Seven tools; `get_bars` summary + last N bars (default 100, cap 500) with `trading` indicators | 6, 8 |
| Proposal id at step 1; callId → proposal id; `client_order_id` = SHA-256(`sessionId:proposalId`) | 2, 4, 7 |
| Lock held for two short sections; reservations seen by concurrent proposals; released on reject/expire/fail/fill | 4, 7, 8 |
| Steps 1–4 in `tools/pre-execute`, 5–8 in the body; body fails closed without its own `trading/proposal` and `allowed-once` | 7, 8 |
| Always ask; `never` or no approval service denies; interrupted approval submits nothing | 8 |
| Re-check drift (1%) → "price moved; propose again"; price cap; unusable approved price / zero cap refused; tick check; Config limits validated; reduce-only from the re-check | 3, 6, 7 |
| Crypto exit retried on "insufficient balance"; $10 minimum via `Asset.minNotional` | 7 |
| Gate on derived `status()`; Halt guard; flatten window owned by the venue | 7, 8 |
| Unknown outcome reported via lookup, never resubmitted | 7, 9 |
| Journal in the storage service; restart reconciles | 5, 9 |
| Fills as `trading/fill` and injected into the proposing session's agent; re-read on gaps and a timer | 9 |
| Keys missing message | 7 |
| Executor service usable by `trading-mcp` (source attribution, de-duplication hook) | 7 |
| Profile: `mcp-resources` and cordis runners disabled, terminal kept, preset roots closed, `default: trader`, unknown saved default fails loudly | 11, 12 |
| `trader` tool allowlist pinned by `tool-schemas.expected.json` | 12 |
| Keyless recorded-session snapshot with a fake broker | 12 |
| Real composition, HMR disposal, per-file 100% coverage | 10, every task |
| End to end on paper | 14 |
