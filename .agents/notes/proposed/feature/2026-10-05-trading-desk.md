# Agent Note: Trading desk — agent-proposed stock and crypto orders with live charts

Status: proposed

English | [中文](2026-10-05-trading-desk.zh.md)

## Problem

DeepSeek Harness agents can read, write, and run code, but they cannot observe a market or act in one. A user who wants a conversational trading assistant — ask the agent to analyze a symbol, see the same chart the agent sees, and let it place stock or crypto orders — has no market-data source, no broker connection, no chart, and no order-safety mechanism in the harness. Placing orders is the first harness capability whose mistakes cost money directly, so order limits must be enforced by executor code rather than by model instructions, and the human must see the order, its rationale, and its risk before it reaches a broker.

## Proposal

Slice 1 adds a chat-driven trading desk as an opt-in `trading` profile built from five `packages/experimental/` packages. One agent analyzes markets through tools and proposes orders; the user approves each order on an approval card; the Trading sidebar panel shows live charts, the agent's fills and proposals, positions, and orders. Slice 2 (a separate Agent Note) adds a multi-agent desk — analyst, strategist, risk reviewer — that reuses the slice 1 tools unchanged.

Fixed decisions:

- Paper trading first. The live-money code path exists but stays locked; the e2e and manual verification use Alpaca paper accounts only.
- Every order and cancellation requires per-call human approval. Autonomous trading is out of scope.
- Alpaca is the only provider in slice 1, for both US equities and crypto, for both market data and order execution.
- Charts use TradingView `lightweight-charts` v5 (Apache-2.0) with harness-drawn overlays. The licensed Advanced Charts library and the iframe widget are not used.

### Package topology

All packages are `@deepseek-ai/dsh-experimental-*`, published by default under `packages/experimental/` policy, and reach product compositions only through the opt-in profile.

| Package | Responsibility | Exposes |
|---|---|---|
| `trading-core` | Shared types and pure logic; no I/O | `Symbol`, `Bar`, `Timeframe`, `Quote`, `Order`, `Position`, `Account` types; `MarketData` and `Broker` service interfaces; indicators (SMA, EMA, RSI, MACD, Bollinger); trade-to-candle aggregation; `RiskEngine` |
| `trading-alpaca` | Alpaca provider for both interfaces | Registers `ctx.marketData` and `ctx.broker`; REST history and order APIs; one shared WebSocket per asset class; keys via `ctx.credentials`; `mode: paper \| live`, default `paper` |
| `tool-trading` | Model-facing tools and the order executor | `get_quote`, `get_bars`, `get_account`, `get_positions`, `list_orders`, `place_order`, `cancel_order`; risk check, approval, re-check, idempotent submit, journal |
| `trading-gateway` | Typed remote service for the client | `bars(symbol, tf, before?)`, `streamBars(symbol, tf)`, `streamAccount()`, watchlist get/set, halt/flatten |
| `ui-trading` | Browser half | Right-sidebar Trading tab; tool views for trading tools in the `tool.call.toolview` slot; Trading settings card |

An opt-in profile patch (`trading`) composes the five packages into the web application and adds a trading section to the system prompt. `dsh web --profile trading` launches the desk; default profiles are unchanged. Tools and the gateway depend only on the `MarketData` and `Broker` interfaces, so a later provider (Binance, IBKR) is a new provider package with no consumer changes. Whether `trading-core` splits into a types package and a risk package follows the role-word naming rules in [adding-a-package](../../../../docs/cookbook/adding-a-package.md); the implementation plan settles it.

Live mode requires both `mode: live` in the provider config and the launch environment variable `DSH_TRADING_LIVE=1`; either alone refuses to start the provider in live mode. Live mode renders a persistent red LIVE badge in the panel and on every order card.

### Market data

A symbol is `{ assetClass: 'equity' | 'crypto', ticker }` (`AAPL`, `BTC/USD`); tools and UI accept either spelling and infer the asset class. A bar is `{ t, o, h, l, c, v }` with `t` in UTC epoch milliseconds. Timeframes are `1m 5m 15m 1h 4h 1D 1W`.

- History comes from Alpaca REST bar endpoints (separate equity and crypto endpoints), paged.
- Live data comes from one WebSocket per asset class. Subscriptions are reference-counted across the chart, the watchlist, and agent tools; an upstream subscription closes when its last consumer releases it.
- The equity feed is configurable (`feed: iex | sip`, default `iex` on the free plan). The UI labels the feed so IEX prices are not mistaken for the consolidated tape.
- On disconnect, the provider reconnects with backoff, backfills the gap from REST, and marks the symbol stale until a fresh tick arrives.
- Indicators and candle aggregation are pure `trading-core` functions used by both `get_bars` and the chart, so the agent and the user see identical values.

`get_bars` returns a summary (last price, range, latest requested indicator values, recent swing highs and lows) plus the last N bars as a compact table, default 100 and capped at 500, to bound model context.

### Order flow

`place_order` arguments: `symbol`, `side` (`buy | sell`), exactly one of `qty` or `notional`, `type` (`market | limit | stop | stop_limit`) with `limit_price` and `stop_price` as required, `time_in_force`, an optional equity-only bracket (`take_profit`, `stop_loss`), and a required `rationale` of one to three sentences shown on the approval card.

1. **Validate.** Asset tradability, time-in-force allowed for the asset class (crypto: `gtc`, `ioc`), fractional permission. Invalid input returns a tool error.
2. **Snapshot.** Quote, account equity and buying power, current position, today's order count, and today's P&L against Alpaca's `last_equity`.
3. **Risk check.** `RiskEngine.check(order, snapshot, limits)` returns pass or a list of violations. Any violation denies the call without asking the user and returns the reasons to the model. Limits change only in settings, never from chat.
4. **Approval.** The `tools/pre-execute` listener returns `{ kind: 'ask', reason }`, and the existing approval service shows the card: side, quantity, symbol, type, estimated cost, percent of equity, bid/ask, rationale, each risk check, and the PAPER/LIVE badge. The proposed price renders as a line on the chart while the card is pending.
5. **Re-check.** After approval the executor re-snapshots. If the estimated cost drifted beyond the tolerance (default 1%) or any limit now fails, the call is denied with "price moved; propose again".
6. **Submit** with a `client_order_id` derived from the tool call id. Order ids and client order ids are branded types (`Branded<B>`), never bare strings.
7. **Report.** The tool returns the order id and status. Fills arrive on the account stream, update the chart markers and positions panel, and reach the agent's next request through `exec.agent.inject`; each injected fill is first recorded as a trading session event so the model-visible input is reconstructable from the session log.

The trading tools always ask, regardless of the session's permission mode. When the approval policy is `never` (including `DSH_PERMISSION_MODE=danger-full-access`) or no approval service is available (headless), `place_order` and `cancel_order` are denied, never auto-approved. `cancel_order` requires approval because cancelling a protective stop increases risk.

### Risk limits

Each limit, the re-check drift tolerance, the stale-quote window, and the `get_bars` default and cap are validated `Config` fields of `tool-trading`; the trading profile sets these defaults and the Trading settings card edits them:

| Limit | Default |
|---|---|
| Max order notional | $1,000 |
| Max position size | 20% of equity |
| Daily loss limit | 3% of start-of-day equity; blocks exposure-increasing orders once hit |
| Max orders per day | 20 |
| Shorting | disabled |
| Margin | disabled; buys capped at cash |
| Symbol allowlist / denylist | empty |
| Stale quote | market orders denied when no quote within 30 s during market hours |

Orders that only reduce or close an existing position bypass the limits (they still require approval), so an exit is always available.

**Kill switch.** The panel's Halt control sets a halted flag that denies every `place_order` until the user resumes. Cancel all & flatten cancels open orders and closes all positions after its own confirmation. No tool lets the agent resume trading.

**Audit.** Every proposal, risk result, approval decision, submission, and fill is recorded in the session log (approval decisions already are) and appended to a trading journal in the storage service. The panel's Today's trades tab reads the journal and links each trade to the chat message that proposed it.

### Trading panel and tool views

The Trading tab registers in the right sidebar beside the chat. From top to bottom:

1. Account bar: PAPER/LIVE badge, equity, day P&L, buying power, Halt; Cancel all & flatten in its menu.
2. Watchlist: live last price, percent change, market status; add and remove; collapsible; persisted through settings.
3. Chart toolbar: symbol search, timeframe buttons, indicator menu.
4. Chart: candlesticks with a volume histogram; SMA, EMA, and Bollinger on the price pane; RSI and MACD in separate panes; crosshair OHLC legend; history loads on scroll-left; market-status pill and feed label; agent overlays for fills (markers), open positions (dashed average-entry line with unrealized P&L), pending limit and stop orders, and the pending proposal.
5. Bottom tabs: Positions (with a user-initiated Close that asks for confirmation), Orders (with cancel), Today's trades.

Follow agent, on by default, switches the chart to the symbol and timeframe of the agent's latest `get_bars` or `place_order` call. Slice 1 has no manual order ticket; entries go through the agent, exits through the agent or the Close button.

Tool views: `get_bars` renders a mini candle chart and indicator summary and opens the symbol in the panel on click; `place_order` renders the approval detail and, after submission, an order status chip that tracks submitted → partially filled → filled or cancelled; `get_positions` and `get_account` render compact tables; denials render with their reasons. All copy goes through English and Chinese locale dictionaries. The panel hides on narrow viewports; tool views remain. If the right sidebar cannot widen enough for a usable chart, the panel adds a widen toggle; a full-screen desk view is deferred.

### Error handling

| Condition | Behavior |
|---|---|
| Alpaca keys missing | Tools return "Alpaca keys not configured — add them in Settings → Trading"; the panel shows a setup card linking to the settings card |
| 401 / 403 | Explicit authentication error to the model and the panel; no retry |
| Order rejected (422 and similar) | Alpaca's reason returned to the model |
| 429 | Reads retry with backoff; submits never retry blindly |
| Network error or 5xx during submit | Outcome treated as unknown; the executor looks the order up by `client_order_id` before reporting and never resubmits without that lookup |
| Stream disconnect | Reconnect with backoff, REST backfill, stale badge until fresh data |
| Equity market closed | Card states "queued until market open"; extended hours deferred |
| Agent interrupted while approval pending | Request cancelled; nothing submitted |
| Restart | Broker state is authoritative; positions and orders reload from Alpaca; the journal reconciles against them |

## Alternatives considered

### Why not make trading part of the default product?

A first-class `packages/trading/*` group in the default composition would make every `dsh` launch a trading bot. It changes default compositions that upstream also edits, which turns every upstream merge into a conflict, and it takes on full release obligations for a contract that is still changing. The opt-in experimental profile keeps the coding-agent product unchanged and isolates the trading surface.

### Why not an out-of-tree plugin repository?

An external plugin keeps the cleanest separation from upstream, but slot registration, typed remote namespaces in `packages/api/remotes`, the forwarded-event allowlist, and the client build pipeline are wired into this repository's build and generators. The chart panel would fight that wiring.

### Why not the TradingView Advanced Charts library or widget?

Advanced Charts provides drawing tools and many more indicators, but it requires a license application and cannot be redistributed in an open-source repository. The iframe widget uses TradingView's own data, so agents cannot read what the chart shows and the harness cannot draw the agent's orders on it. `lightweight-charts` is Apache-2.0, accepts harness data, and supports markers, price lines, and panes for the overlays.

### Why not a multi-agent desk first?

Specialist agents add a second opinion and clear role boundaries, but they multiply token cost and latency per proposal and make a bad trade harder to trace. With per-order human approval the user already acts as the risk reviewer, and hard limits must live in code either way. Slice 2 adds the multi-agent desk on top of the same tools.

### Why not autonomous trading within limits?

Autonomous execution removes the human check on the first harness capability that spends money. It becomes a separate, deliberate setting after the approval flow, limits, kill switch, and journal have run on paper accounts.

### Why not a second crypto exchange or Interactive Brokers in slice 1?

Alpaca covers both asset classes with one paper account and free market data. A dedicated exchange or IBKR (which needs a local TWS or Gateway process) doubles adapter work before the interfaces have been exercised by a first provider.

## Acceptance criteria

- `dsh web --profile trading` with Alpaca paper keys shows the Trading tab: account bar, watchlist, a live-updating chart for an equity and a crypto symbol, and empty positions and orders.
- Asking the agent to analyze `BTC/USD` produces a `get_bars` call whose tool view shows a mini chart; with Follow agent on, the panel chart switches to that symbol and timeframe, and the indicator values in the tool result match the chart's.
- A proposed order within limits shows an approval card with rationale, estimated cost, percent of equity, and per-limit checks, and draws the proposal on the chart. Approving submits a paper order; the fill appears as a chart marker, a position row, and a Today's trades entry linked to the proposing message.
- Rejecting, cancelling, or interrupting at the approval card submits nothing.
- An order exceeding any limit is denied without an approval card, and the model receives the violated limits.
- With `DSH_PERMISSION_MODE=danger-full-access`, or with no approval service, `place_order` and `cancel_order` are denied.
- While halted, every `place_order` is denied; the agent has no tool that resumes trading.
- A simulated network failure during submit never produces a duplicate order.
- Live mode refuses to start unless both `mode: live` and `DSH_TRADING_LIVE=1` are set.
- All five packages pass the per-file 100% coverage gate; the profile has a real-composition test; registry contributions have HMR disposal tests; client copy passes `verify-client-ui-i18n`.
- A keyless snapshot test replays an analyze → propose → approve → fill session through the trading profile with a fake broker provider.
- An opt-in e2e test against Alpaca paper places and then cancels or closes a minimal crypto order, and skips without `ALPACA_*` keys.

## Risks

- **Financial loss.** A defect in the risk engine, idempotency, or approval wiring could place unintended orders. Mitigations: paper-only slice, locked live path, fail-closed approval, executor-level limits, unknown-outcome lookup before reporting, kill switch. Live trading needs its own review before it is unlocked.
- **Data fidelity.** The free IEX feed differs from the consolidated tape, and free-plan symbol and rate limits cap the watchlist size. The feed is labeled in the UI and configurable.
- **Credential exposure.** Alpaca keys live in the file-backed credentials store, readable by processes running as the same OS user, including agent shell tools. Paper keys bound the blast radius in slice 1; live keys need a stronger story before live mode ships.
- **Model overconfidence.** The agent's rationale may sound authoritative while being wrong. The card shows the rationale and the risk checks side by side, and slice 1 makes no claim of investment advice.
- **Upstream churn.** Experimental packages depend on pre-stable harness APIs (`tools/pre-execute`, slots, typert remotes) and will need updates as upstream changes them.
- **Given up in slice 1:** drawing tools, multi-chart layouts, options, extended-hours trading, a manual order ticket, autonomous or scheduled trading, providers other than Alpaca, and live money.
