# Agent Note: Trading desk — agent-proposed stock and crypto orders with live charts

Status: proposed

English | [中文](2026-10-05-trading-desk.zh.md)

## Problem

DeepSeek Harness agents can read, write, and run code, but they cannot observe a market or act in one. A user who wants a conversational trading assistant — ask the agent to analyze a symbol, see the same chart the agent sees, and let it place stock or crypto orders — has no market-data source, no broker connection, no chart, and no order-safety mechanism in the harness. Placing orders is the first harness capability whose mistakes cost money directly, so order limits must be enforced by executor code rather than by model instructions, and the human must see the order, its rationale, and its risk before it reaches a broker.

## Proposal

Slice 1 adds a chat-driven trading desk as an opt-in `trading` profile built from seven `packages/experimental/` packages. One agent analyzes markets through tools and proposes orders — either the in-app dsh agent or the user's own Claude Code CLI running in the desk's terminal and connected over MCP; the user approves each order on an approval card; the Trading sidebar panel shows live charts, the agent's fills and proposals, positions, and orders. Slice 2 (a separate Agent Note) adds a multi-agent desk — analyst, strategist, risk reviewer — that reuses the slice 1 tools unchanged. Delegated subagents run with approval policy pinned to `never` (`subagent/src/child-agent.ts`), so in slice 2 only the lead session places orders; subagents analyze and recommend.

Fixed decisions:

- Paper trading first. The live-money code path exists but stays locked; the e2e and manual verification use Alpaca paper accounts only.
- Every order and cancellation requires per-call human approval. Autonomous trading is out of scope.
- Alpaca is the only provider in slice 1, for both US equities and crypto, for both market data and order execution.
- Charts use TradingView `lightweight-charts` v5 (Apache-2.0) with harness-drawn overlays. The licensed Advanced Charts library and the iframe widget are not used.

### Package topology

All packages are `@deepseek-ai/dsh-experimental-*`, published by default under `packages/experimental/` policy, and reach product compositions only through the opt-in profile.

| Package | Responsibility | Exposes |
|---|---|---|
| `trading` | Shared types and pure logic; no I/O | `Symbol`, `Bar`, `Timeframe`, `Quote`, `Order`, `Position`, `Account` types; `MarketData` and `Broker` service interfaces; indicators (SMA, EMA, RSI, MACD, Bollinger); trade-to-candle aggregation; `checkRisk` |
| `trading-alpaca` | Alpaca provider for both interfaces | Registers `ctx.marketData` and `ctx.broker`; REST history and order APIs; one shared WebSocket per asset class; keys via `ctx.credentials`; `mode: paper \| live`, default `paper` |
| `tool-trading` | Model-facing tools and the order executor | `get_quote`, `get_bars`, `get_account`, `get_positions`, `list_orders`, `place_order`, `cancel_order`; risk check, approval, re-check, idempotent submit, journal |
| `trading-gateway` | Typed remote service for the client | `bars(symbol, tf, before?)`, `streamBars(symbol, tf)`, `streamAccount()`, watchlist get/set, halt/flatten |
| `trading-mcp` | MCP endpoint for external agents | Streamable-HTTP MCP server on the dsh host exposing the same seven tools through the same order executor; per-session bearer tokens |
| `bundle-trading` | Profile bundle | The `trading` profile patch and the `trader` agent preset (its `agent.cordis.yml`) |
| `ui-trading` | Browser half | Right-sidebar Trading tab; tool views for trading tools in the `tool.call.toolview` slot; Trading settings card |

`tool-trading` owns the order executor (validate, snapshot, risk check, approval, re-check, submit, journal) and exposes it as a service that both its own tools and `trading-mcp` call. The executor is the only broker path the trading tools offer; the Execution boundary section below states which other paths exist and how they are closed or contained. The domain library is named `trading` rather than `trading-core` because the package naming rules name the capability, and its risk decision is the function `checkRisk`.

The `trading` profile patch in `bundle-trading` composes the other six packages, keeps the web app's user terminal (`terminal-controller`, `ui-sidebar-terminal`), selects the `trader` agent preset, and adds a trading section to the system prompt. `web` is a fixed alias that rejects `--profile`, so the desk is created the way Agent Teams is: `dsh --profile trading --from-default-profile web` initializes the profile and `dsh plugin --profile trading add` installs the trading packages; default profiles are unchanged. `packages/api/remotes` is a release package and cannot import experimental types, so `ui-trading` owns the Remote assembly for the `trading-gateway` namespace and its forwarded events, following `client-ui-agent-team`. Tools and the gateway depend only on the `MarketData` and `Broker` interfaces, so a later provider (Binance, IBKR) is a new provider package with no consumer changes. Whether `trading` splits into a types package and a risk package follows the role-word naming rules in [adding-a-package](../../../../docs/cookbook/adding-a-package.md); the implementation plan settles it.

Live mode requires both `mode: live` in the provider config and the launch environment variable `DSH_TRADING_LIVE=1`; either alone refuses to start the provider in live mode. Live mode renders a persistent red LIVE badge in the panel and on every order card.

### Execution boundary

The approval card is only a real gate if the trading agent has no other way to reach the broker. The default tool surface provides two:

- **Shell.** The sandbox restricts file writes only; reads and network are outside the sandbox policy's vocabulary (`sandbox-policy` README). An agent with shell can read `$DSH_HOME/.credentials.yaml` and send an order to Alpaca with `curl`, with no approval step in `workspace-write`.
- **Runtime plugins.** The shipped `tool-cordis` and the cordis runners let the model define Host plugins, which could call `ctx.broker` directly or register an approval answerer.

Slice 1 closes both for the in-app agent and bounds what remains at the broker:

1. **`trader` agent preset, tool allowlist.** The trading tools are registered only inside the `trader` preset's `agent.cordis.yml`, never as profile rows, so no other preset's agent can combine them with a shell. The `trading` profile also sets `includeShippedRoot: false` and `includeUserRoot: false` on `agent-presets`, so the shipped `standard`, `ptc`, `cordis`, and `minimal` presets and anything under `$DSH_HOME/.agent-presets` are not selectable. The `trader` agent's tools are an allowlist: the seven trading tools, `web_search`, and `web_fetch` (which exposes no headers or method). Everything else is absent, including shell, terminal, file read and write tools (`fs-sandbox` reads stay unconfined), `run_code`, workflows, subagent delegation, MCP client tools, `tool-cordis`, and extension tools. The profile disables the cordis Host and Client runners.
2. **Broker-side account configuration.** At startup `trading-alpaca` sets and verifies `no_shorting: true` and `max_margin_multiplier: "1"` through Alpaca's account configuration API, and refuses to start if the account cannot be configured. Halt sets `suspend_trade: true`. These settings bound an agent that can only place orders; an agent holding the Alpaca keys can change them back. `trading-alpaca` therefore re-reads all three on a timer (default every 60 seconds, a `Config` field); any drift from the expected values halts the desk and shows a panel warning naming the changed setting. On startup the desk starts halted if either the persisted Halt flag or Alpaca's `suspend_trade` is set.
3. **External agents with their own shell.** Claude Code has its own Bash tool, runs as the same OS user, and can read the credentials file and call Alpaca directly; the dsh approval cannot gate that path. The broker-side configuration above still applies. Claude Code's sandbox covers its shell commands only, so the Connect Claude Code instructions recommend three Claude Code settings together: a `Read` permission deny rule on the dsh credentials file, `network.deniedDomains` listing the Alpaca API and data hosts, and `allowUnsandboxedCommands: false` so a blocked command cannot be retried outside the sandbox; the dsh approval is the gate for orders that go through `trading-mcp`, not a guarantee against a shell-capable agent.

### Market data

A symbol is `{ assetClass: 'equity' | 'crypto', ticker }` (`AAPL`, `BTC/USD`); tools and UI accept either spelling and infer the asset class. A bar is `{ t, o, h, l, c, v }` with `t` in UTC epoch milliseconds. Timeframes are `1m 5m 15m 1h 4h 1D 1W`.

- History comes from Alpaca REST bar endpoints (separate equity and crypto endpoints), paged.
- Live data comes from one WebSocket per asset class. Subscriptions are reference-counted across the chart, the watchlist, and agent tools; an upstream subscription closes when its last consumer releases it.
- The equity feed is configurable (`feed: iex | sip`, default `iex` on the free plan). The UI labels the feed so IEX prices are not mistaken for the consolidated tape.
- On disconnect, the provider reconnects with backoff, backfills the gap from REST, and marks the symbol stale until a fresh tick arrives.
- Indicators and candle aggregation are pure `trading` functions used by both `get_bars` and the chart, so the agent and the user see identical values.

`get_bars` returns a summary (last price, range, latest requested indicator values, recent swing highs and lows) plus the last N bars as a compact table, default 100 and capped at 500, to bound model context.

### Order flow

`place_order` arguments: `symbol`, `side` (`buy | sell`), exactly one of `qty` or `notional`, `type` (`market | limit | stop | stop_limit`) with `limit_price` and `stop_price` as required, `time_in_force`, an optional equity-only bracket (`take_profit`, `stop_loss`), and a required `rationale` of one to three sentences shown on the approval card.

Every proposal gets an executor-minted proposal id (a branded type) at step 1; MCP calls have no tool call id, so both paths key proposals, approvals, and the `client_order_id` on it, and the in-app path maps its `callId` to the proposal id. The executor holds a per-account lock for two short sections, never across the approval wait: steps 2–3 (snapshot, check, reserve) and steps 5–7 (re-snapshot, re-check, submit). The reservation made in the first section is what makes concurrent proposals see each other, so several `place_order` calls in one model message are checked against each other while the user decides on the first card. Steps 1–4 run in `tool-trading`'s `tools/pre-execute` listener, because that waterfall runs before the tool body; steps 5–8 run in the tool body after approval. `trading-mcp` calls the same executor functions in the same order.

The tool body fails closed. A listener ahead of `tool-trading`'s can return `allow` or `ask` and skip validate, snapshot, and risk check (`hooks-claude-code` returns `ask` when a Claude Code hook asks), and the body still runs. The body therefore submits only when it finds its own `trading/proposal` event for the call's proposal id and an `allowed-once` approval decision for that call; otherwise it denies with "no checked proposal for this call".

1. **Validate.** Asset tradability; time-in-force allowed for the asset class (crypto: `gtc`, `ioc`); order type allowed for the asset class (crypto has no plain `stop`; only `market`, `limit`, `stop_limit`); fractional and `notional` equity orders are `day` only; brackets require whole-share equity quantities. Invalid input returns a tool error.
2. **Snapshot.** Quote, account equity and buying power, current position, open orders, exposure reserved by pending proposals, today's order count, and today's P&L against Alpaca's `last_equity`.
3. **Risk check.** `checkRisk(order, snapshot, limits)` returns pass or a list of violations, counting open orders and reserved exposure as if filled. Any violation denies the call without asking the user and returns the reasons to the model. A passing proposal reserves its exposure until it is rejected, expires, fails, or fills. Limits change only in settings, never from chat.
4. **Approval.** The listener appends a `trading/proposal` session event keyed by the proposal id and `callId` (order, quote, estimated cost, percent of equity, each risk result, source, mode) and returns `{ kind: 'ask', reason }`. `ctx.approval.request` carries only the tool name, call id, and reason, so the card reads the proposal event by `callId`. `ui-chat` already owns the single `conversation.approval.detail` slot, so `ui-trading` registers its own `conversation.composer` entry at a higher priority for trading approvals: side, quantity, symbol, type, estimated cost, percent of equity, bid/ask, rationale, each risk check, and the PAPER/LIVE badge. The proposed price renders as a line on the chart while the card is pending.
5. **Re-check.** After approval the executor re-snapshots. If the estimated cost drifted beyond the tolerance (default 1%) or any limit now fails, the call is denied with "price moved; propose again".
6. **Price cap.** A quantity-based `market` order that adds exposure is sent as a marketable `limit` (crypto `ioc`, equity `day`) at the approved price plus the drift tolerance for a buy, or minus it for a sell, so the broker enforces the approved notional even when queued overnight. Reduce-only exits are sent as real `market` orders so an exit fills in a fast move. `notional` orders stay `market`, because the notional already caps the cost. A plain `stop` triggers a market order the cap cannot cover, so orders that add exposure must use `stop_limit`; plain `stop` is accepted only for reduce-only exits. The card states the cap or why none applies.
7. **Submit** with `client_order_id` = a hash of the dsh session id and the proposal id; provider call ids are not unique across sessions and MCP calls have none. Order ids and client order ids are branded types (`Branded<B>`), never bare strings.
8. **Report.** The tool returns the order id and status. Fills arrive on the account stream, update the chart markers and positions panel, and are recorded as `trading/fill` session events. A fill arrives outside any tool call, so the account-stream handler looks up the session's root agent and injects the fill into that agent's next request; injection does not wake an idle agent, so the agent sees the fill with the user's next message. Claude Code sees fills only in a tool result or by calling `list_orders`.

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

Orders that only reduce or close an existing position bypass the limits (they still require approval), so an exit is always available. Reduce-only is computed net of open sell orders and pending sell proposals, so an exit can never oversell into a short; with `no_shorting` set at Alpaca, the broker rejects an oversell as well.

**Kill switch.** Halt registers a `ctx.tools.guard()` that denies `place_order` and `cancel_order`; a guard is deny-only and cannot be overridden by a prepended `tools/pre-execute` listener. The executor checks the same halted state for `trading-mcp` calls, and Halt sets Alpaca `suspend_trade: true`. Halt persists until the user resumes. Cancel all & flatten cancels open orders and closes all positions after its own confirmation. The per-position Close and Cancel all & flatten are the only orders allowed while halted; both are user-initiated and reduce-only. To send them, the desk first journals an open flatten window, then lifts `suspend_trade`, submits, and restores `suspend_trade` before closing the window. On startup an open flatten window means a crash inside it: the desk restores `suspend_trade`, starts halted, and shows a warning. No tool lets the agent resume trading.

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

### Claude Code as a trading agent

The user can drive trading from their own Claude Code subscription by running the unmodified `claude` CLI — in a Terminal tab of the desk or any external terminal — with the `trading-mcp` endpoint configured as an MCP server. Claude Code signs in through Anthropic's own flow; the harness never reads, stores, or forwards Claude Code credentials and never sends model requests on the subscription.

- **Endpoint.** `trading-mcp` serves streamable HTTP at `/mcp/trading` on the dsh host. Each token is issued per dsh session from the Trading settings card and binds every call to that session's log and journal. Settings shows a copyable `claude mcp add --transport http dsh-trading <url> --header "Authorization: Bearer <token>"` line. `terminal-controller` sets a fixed `env: { DSH_SESSION_ID }` for new terminals, so injecting the URL and token automatically needs an upstream change to the controller; slice 1 uses the copied line.
- **Tools.** The same seven tools with the same descriptions and limits. Read-only tools need no approval and can be added to Claude Code's allowed tools.
- **Approval.** The dsh approval in the Trading panel is the deciding check for MCP orders and cancellations. Approving inside Claude Code alone never places an order, and Claude Code permission bypass modes do not skip the dsh approval. Pending MCP approvals render in a Pending approvals strip at the top of the Trading panel, and the Trading tab shows a badge while the user is in another tab. A pending MCP approval expires after a configurable window (default 10 minutes) and resolves as rejected. `ctx.approval.request` throws without an agent and an open turn, so MCP approvals use a trading-owned queue. The queue re-implements the approval-policy check (`never` or no approval capability denies) and records `trading/approval-asked` and `trading/approval-decided` session events alongside `trading/proposal`.
- **Long waits.** The MCP call blocks until the decision. The server opens the SSE response stream immediately, so Claude Code's first-byte timer for HTTP servers (60 seconds by default) is satisfied, and emits progress notifications every 30 seconds, which keep the idle timer (5 minutes by default) alive. No per-server timeout setting is needed.
- **Backgrounded calls.** Since Claude Code v2.1.212, an MCP call still running after two minutes moves to the background and Claude keeps working, so it may propose the same order again. The executor de-duplicates: a `place_order` whose symbol, side, quantity or notional, type, and prices match a pending proposal from the same session returns that proposal's pending status instead of creating a second card.
- **Attribution.** Every card and journal entry names its source: the dsh agent or Claude Code (MCP).

Usage stays interactive: a person drives Claude Code and approves each order. Unattended or scheduled trading on a Claude subscription is out of scope; a later autonomous slice uses API-key authentication.

## Alternatives considered

### Why not make trading part of the default product?

A first-class trading package group in the default composition would make every `dsh` launch a trading bot. It changes default compositions that upstream also edits, which turns every upstream merge into a conflict, and it takes on full release obligations for a contract that is still changing. The opt-in experimental profile keeps the coding-agent product unchanged and isolates the trading surface.

### Why not an out-of-tree plugin repository?

An external plugin keeps the cleanest separation from upstream, but slot registration, typed remote namespaces in `packages/api/remotes`, the forwarded-event allowlist, and the client build pipeline are wired into this repository's build and generators. The chart panel would fight that wiring.

### Why not the TradingView Advanced Charts library or widget?

Advanced Charts provides drawing tools and many more indicators, but it requires a license application and cannot be redistributed in an open-source repository. The iframe widget uses TradingView's own data, so agents cannot read what the chart shows and the harness cannot draw the agent's orders on it. `lightweight-charts` is Apache-2.0, accepts harness data, and supports markers, price lines, and panes for the overlays.

### Why not route model requests through the user's Claude Pro/Max login?

`llm-pi-ai` can sign in to Anthropic with a Claude Pro/Max OAuth flow supplied by its library. Anthropic's Claude Code legal and compliance documentation does not permit third-party applications to route requests through Free, Pro, or Max plan credentials or to collect or intermediate Claude.ai credentials; products built on Claude use API-key authentication. Running the unmodified Claude Code binary with the user's own subscription is permitted, so the desk exposes tools to that binary instead of consuming its credentials.

### Why not the `subagent-claude-code` backend on the subscription?

That backend runs Claude Code through the Claude Agent SDK, whose guidance is API-key authentication for SDK-built agents, and it runs one-shot without user prompts. It remains available for slice 2 with an API key, not as the subscription path.

### Why not a stdio MCP server?

A stdio server would be launched by Claude Code as a separate process, which needs a package bin or ad-hoc launcher that the application-launch rule forbids, and it would still have to reach the running host's broker connection, risk state, approvals, and journal. Serving MCP from the host over HTTP keeps one executor and one source of state.

### Why not a multi-agent desk first?

Specialist agents add a second opinion and clear role boundaries, but they multiply token cost and latency per proposal and make a bad trade harder to trace. With per-order human approval the user already acts as the risk reviewer, and hard limits must live in code either way. Slice 2 adds the multi-agent desk on top of the same tools.

### Why not autonomous trading within limits?

Autonomous execution removes the human check on the first harness capability that spends money. It becomes a separate, deliberate setting after the approval flow, limits, kill switch, and journal have run on paper accounts.

### Why not a second crypto exchange or Interactive Brokers in slice 1?

Alpaca covers both asset classes with one paper account and free market data. A dedicated exchange or IBKR (which needs a local TWS or Gateway process) doubles adapter work before the interfaces have been exercised by a first provider.

## Acceptance criteria

- A profile created with `dsh --profile trading --from-default-profile web` and the trading packages installed, with Alpaca paper keys, shows the Trading tab: account bar, watchlist, a live-updating chart for an equity and a crypto symbol, and empty positions and orders.
- Asking the agent to analyze `BTC/USD` produces a `get_bars` call whose tool view shows a mini chart; with Follow agent on, the panel chart switches to that symbol and timeframe, and the indicator values in the tool result match the chart's.
- A proposed order within limits shows an approval card with rationale, estimated cost, percent of equity, and per-limit checks, and draws the proposal on the chart. Approving submits a paper order; the fill appears as a chart marker, a position row, and a Today's trades entry linked to the proposing message.
- Rejecting, cancelling, or interrupting at the approval card submits nothing.
- An order exceeding any limit is denied without an approval card, and the model receives the violated limits.
- With `DSH_PERMISSION_MODE=danger-full-access`, or with no approval service, `place_order` and `cancel_order` are denied.
- While halted, every `place_order` and `cancel_order` is denied by a tool guard and by the MCP executor, and the Alpaca account reports `suspend_trade: true`; the agent has no tool that resumes trading.
- The `trader` agent exposes exactly the allowlisted tools; no other preset is selectable in the `trading` profile, no other preset's agent has trading tools, and the cordis runners are disabled.
- A `place_order` call whose pre-execute decision came from another listener (no `trading/proposal` for the call) is denied by the tool body.
- Changing `no_shorting`, `max_margin_multiplier`, or `suspend_trade` at Alpaca while the desk runs halts the desk with a warning; restarting with `suspend_trade` set starts halted.
- A sell market order that adds exposure reaches Alpaca as a limit below the approved price; a reduce-only exit reaches Alpaca as a market order; a plain `stop` buy is rejected at validation.
- `trading-alpaca` refuses to start unless the account reports `no_shorting: true` and `max_margin_multiplier: "1"`.
- Two `place_order` calls in one model message whose combined exposure exceeds a limit produce one approval card and one denial.
- A reduce-only sell larger than the position net of open sell orders is denied.
- An approved market order reaches Alpaca as a marketable limit capped at the approved price plus tolerance.
- A Claude Code `place_order` repeated while the first is pending produces one card.
- A simulated network failure during submit never produces a duplicate order.
- Live mode refuses to start unless both `mode: live` and `DSH_TRADING_LIVE=1` are set.
- An unmodified `claude` CLI configured with the `trading-mcp` line from Trading settings can call every trading tool; its `place_order` shows in the Pending approvals strip with source Claude Code (MCP), blocks until decided without hitting Claude Code's idle timeout, and on approval produces the same fill, marker, and journal entry as an in-app order. A request without a valid session token is refused.
- A Terminal tab is available in the `trading` profile alongside the Trading tab.
- All seven packages pass the per-file 100% coverage gate; the profile has a real-composition test; registry contributions have HMR disposal tests; client copy passes `verify-client-ui-i18n`.
- A keyless snapshot test replays an analyze → propose → approve → fill session through the trading profile with a fake broker provider.
- An opt-in e2e test against Alpaca paper places and then cancels or closes a minimal crypto order, and skips without `ALPACA_*` keys.

## Risks

- **Financial loss.** A defect in the risk engine, idempotency, or approval wiring could place unintended orders. Mitigations: paper-only slice, locked live path, fail-closed approval, executor-level limits, unknown-outcome lookup before reporting, kill switch. Live trading needs its own review before it is unlocked.
- **Data fidelity.** The free IEX feed differs from the consolidated tape, and free-plan symbol and rate limits cap the watchlist size. The feed is labeled in the UI and configurable.
- **Credential exposure.** Alpaca keys live in the file-backed credentials store, readable by any process running as the same OS user. The `trader` preset removes the in-app agent's shell, but Claude Code and any other shell-capable external agent can still read the keys and bypass the dsh approval. Broker-side `no_shorting`, margin multiplier 1, and `suspend_trade` bound only an agent that places orders without changing account configuration; the drift check detects a change within one polling interval and halts the desk, but cannot prevent orders placed directly with the keys. Paper keys bound the blast radius in slice 1; live mode needs credentials the trading agent's OS user cannot read before it ships.
- **Model overconfidence.** The agent's rationale may sound authoritative while being wrong. The card shows the rationale and the risk checks side by side, and slice 1 makes no claim of investment advice.
- **Claude subscription terms.** Subscription use is limited to the user driving the unmodified Claude Code CLI; plan limits assume ordinary individual use. The harness must never read Claude Code credentials, and autonomous trading must use an API key. Anthropic may change these terms; the MCP endpoint itself is agent-agnostic and works with any MCP client.
- **Local endpoint exposure.** The MCP endpoint can place orders, so it accepts only per-session bearer tokens, binds to the host's configured address, and is subject to the same approval and limits as in-app tools.
- **Upstream churn.** Experimental packages depend on pre-stable harness APIs (`tools/pre-execute`, slots, typert remotes) and will need updates as upstream changes them.
- **Given up in slice 1:** drawing tools, multi-chart layouts, options, extended-hours trading, a manual order ticket, autonomous or scheduled trading, providers other than Alpaca, and live money.
