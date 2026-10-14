# DeepSeek Harness — AI Trading Desk

This repository is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), DeepSeek AI's open-source agent harness. The fork adds an experimental **trading desk**: an AI agent analyzes US stocks and crypto pairs, proposes orders with a written rationale, and a person approves each order before it reaches the broker. Order limits are enforced by executor code, not by instructions to the model.

> **Paper trading only.** The desk trades Alpaca paper accounts by default. A live-money path exists but stays locked behind two separate switches. Nothing here is investment advice.

## Contents

- [What the desk does](#what-the-desk-does)
- [How an order flows](#how-an-order-flows)
- [Safety design](#safety-design)
- [Packages](#packages)
- [Run it](#run-it)
- [Tests](#tests)
- [Status and roadmap](#status-and-roadmap)
- [About DeepSeek Harness](#about-deepseek-harness)

## What the desk does

The desk is an opt-in `trading` profile. Its `trader` agent has exactly nine tools:

| Tool | Purpose | Needs approval |
|---|---|---|
| `get_quote` | Latest bid/ask and whether the market is open | No |
| `get_bars` | Price history with SMA, EMA, RSI, MACD, and Bollinger values and recent swing points | No |
| `get_account` | Equity, cash, buying power, and day profit or loss | No |
| `get_positions` | Open positions | No |
| `list_orders` | Open broker orders and today's desk orders | No |
| `place_order` | Propose a market, limit, stop, or stop-limit order, with optional bracket exits | **Yes, every call** |
| `cancel_order` | Propose cancelling an open order | **Yes, every call** |
| `web_search`, `web_fetch` | Research | No |

The agent has no shell, terminal, file, code-execution, delegation, or extension tools, so the trading tools and their approval requests are its only way to reach the broker. The user checks status, halts, and resumes the desk with `/trading status`, `/trading halt [reason]`, and `/trading resume`; these commands never reach the model.

Fills arrive on the broker's order stream, are recorded in the session log and the trading journal, and are reported to the agent that proposed the order.

## How an order flows

Every `place_order` and `cancel_order` call goes through one order executor (`ctx.tradingExecutor`):

1. **Validate** the order against the broker's rules: tradability, order type and time-in-force per asset class, price tick, fractional and bracket rules.
2. **Snapshot** the quote, account, positions, open orders, exposure reserved by pending proposals, and today's order count, under a per-account lock.
3. **Check risk** with `checkRisk`. Any violation denies the call without asking the user and returns the reasons to the model. A passing proposal reserves its exposure, so several orders proposed at once are checked against each other.
4. **Ask the user.** The proposal (order, estimated cost, percent of equity, each risk result, and the agent's rationale) is written to the session log, and the user approves or rejects it.
5. **Re-check** after approval. If the price moved past the tolerance (default 1%) or a limit now fails, the order is refused with "price moved; propose again".
6. **Cap the price.** A market order that adds exposure is sent as a marketable limit at the approved price plus the tolerance, so the broker enforces the approved cost.
7. **Submit** with an idempotent client order id (SHA-256 of session id and proposal id). If the outcome is unknown after a network error, the executor looks the order up instead of resubmitting.
8. **Record** the order, then each fill, in the journal and the session log.

The tool body fails closed: it submits only a proposal whose own proposal event was recorded and whose call received an explicit one-time approval.

## Safety design

| Control | Default |
|---|---|
| Max order value | $1,000 |
| Max position size | 20% of equity, counting open orders and pending proposals |
| Daily loss limit | 3% of start-of-day equity; blocks orders that add exposure |
| Max orders per day | 20 |
| Shorting and margin | Disabled; buys capped at cash |
| Stale quote | Market orders refused when the quote is older than 30 s during market hours |
| Symbol allowlist / denylist | Empty |

Limits are validated configuration fields and change only in configuration, never from chat. Orders that only reduce or close a position bypass the limits but still need approval, so an exit is always available.

Further controls:

- **Approval cannot be skipped.** With approvals turned off (including `DSH_PERMISSION_MODE=danger-full-access`) or no approval service available, order tools are denied, never auto-approved.
- **Kill switch.** Halt registers a tool guard that denies both order tools, sets Alpaca's `suspend_trade`, and persists until the user resumes. No tool lets the agent resume trading.
- **Broker-side settings.** At startup the Alpaca provider sets and verifies `no_shorting` and a margin multiplier of 1, and refuses to start if it cannot. It re-reads them every 60 seconds; any drift halts the desk.
- **Reconciliation.** Open and in-flight orders are re-read at startup, after every stream gap, and on a timer, so fills missed while a socket was down are still recorded. Nothing is ever resubmitted automatically.
- **Audit trail.** Every proposal, risk result, approval decision, submission, and fill is recorded in the session log and the `trading_journal` storage domain.
- **Live mode is locked.** It requires both `mode: live` in configuration and `DSH_TRADING_LIVE=1` at launch.

The full design, including what the approval can and cannot guard against, is in the [trading desk Agent Note](.agents/notes/proposed/feature/2026-10-05-trading-desk.md).

## Packages

All trading code lives under [`packages/experimental/`](packages/experimental/README.md):

| Package | Role |
|---|---|
| [`trading`](packages/experimental/trading/README.md) | Pure domain library with no I/O: symbols, bars, indicators, candle building, order validation, `checkRisk`, submission planning |
| [`trading-venue`](packages/experimental/trading-venue/README.md) | Broker interface (`ctx.tradingVenue`): account, market data, submit, cancel, close, flatten, Halt, order-update stream |
| [`trading-alpaca`](packages/experimental/trading-alpaca/README.md) | Alpaca provider: REST and WebSocket clients, idempotent submit, account safety settings, drift check, persisted Halt |
| [`tool-trading`](packages/experimental/tool-trading/README.md) | Order executor, the seven trading tools, the journal, fill reporting, reconciliation, and the `/trading` command |
| [`bundle-trading`](packages/experimental/bundle-trading/README.md) | The `trading` profile and the `trader` agent preset with its tool allowlist |

A new broker (for example Binance or Interactive Brokers) is a new provider of `trading-venue`; the tools and executor do not change.

## Run it

Requires Node.js `^22.19 || >=24`, pnpm, and an [Alpaca](https://alpaca.markets) paper account.

```sh
git clone https://github.com/tusharcora/deepseek-harness-trading.git
cd deepseek-harness-trading
pnpm install
pnpm run build
```

Add your Alpaca paper keys to `$DSH_HOME/.credentials.yaml`:

```yaml
ALPACA_API_KEY: <paper key id>
ALPACA_SECRET_KEY: <paper secret>
```

Create the trading profile, add the layer, and start it:

```sh
pnpm dsh --profile trading --from-default-profile web
pnpm dsh plugin --profile trading add @deepseek-ai/dsh-experimental-bundle-trading
pnpm dsh --profile trading
```

Then ask the agent something like "Analyze BTC/USD on the 1h chart and propose a small paper buy if the trend supports it." Each order shows an approval request before anything is sent. Model access uses `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_BASE_URL`), as in upstream.

## Tests

About 320 test cases cover the trading packages, including:

- unit tests for indicators, validation, risk checks, and submission planning;
- the Alpaca provider against a fake Alpaca HTTP and WebSocket server;
- the executor and tools booted through the real plugin loader, with disposal checks;
- a keyless recorded-session snapshot of an analyze → propose → approve → fill session through the trading profile;
- opt-in end-to-end tests against Alpaca paper accounts, which skip without `ALPACA_*` keys.

```sh
pnpm run test       # unit and composition tests
pnpm run test:e2e   # real-API tests; need DEEPSEEK_API_KEY and ALPACA_* keys
```

## Status and roadmap

| # | Plan | Status |
|---|---|---|
| 1 | Trading domain library (`trading`) | Done |
| 2 | Broker interface and Alpaca provider (`trading-venue`, `trading-alpaca`) | Done |
| 3 | Order executor, trading tools, and the `trading` profile (`tool-trading`, `bundle-trading`) | Done |
| 4 | Trading panel: live charts (TradingView `lightweight-charts`), watchlist, positions and orders tabs, a dedicated approval card, settings card | Planned |
| 5 | MCP server (`trading-mcp`): a streamable-HTTP endpoint so external agents such as Claude Code call the same seven tools through the same executor and approval gate, with per-session bearer tokens | Planned |

Today the agent trades end to end on paper through the harness's generic approval panel. Plans live in [`.agents/plans/trading-desk/`](.agents/plans/trading-desk/00-roadmap.md).

## About DeepSeek Harness

DeepSeek Harness is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com), built on an everything-is-a-plugin architecture powered by [Cordis](https://github.com/cordiverse/cordis). It is in developer preview, and compatibility-breaking changes are expected. Review the [safety notice](SAFETY.md) before running it.

- Upstream repository: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Documentation: [deepseek-harness.github.io/deepseek-harness](https://deepseek-harness.github.io/deepseek-harness/)
- Development guide: [docs/development.md](docs/development.md); architecture: [docs/architecture.md](docs/architecture.md); agent instructions: [AGENTS.md](AGENTS.md)

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The trading desk is experimental and comes with no warranty; you are responsible for any orders it places.
