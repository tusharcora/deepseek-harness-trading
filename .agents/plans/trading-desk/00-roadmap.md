# Trading Desk Implementation Roadmap

**Spec:** `.agents/notes/proposed/feature/2026-10-05-trading-desk.md` (read it before any plan).

The spec covers eight packages across five subsystems. Each plan below ends in working, tested software and is written in full only when the previous plan has merged, so it can cite real signatures instead of guessed ones.

| # | Plan | Packages | Ends with | Status |
|---|---|---|---|---|
| 1 | Trading domain library | `trading` (spec name `trading-core`), Chinese note pair | Pure, 100%-covered library: types, symbol parsing, indicators, candle building, order validation, risk policy, submission planning | Done (branch `feat/trading-desk`, through `bef3cb17a7`) |
| 2 | Alpaca provider | `trading-venue`, `trading-alpaca` | `ctx.tradingVenue` against a fake Alpaca HTTP/WebSocket server: reads, idempotent submit, cancel, close, flatten, account configuration set/verified/drift-checked, persisted Halt and flatten window, order-update stream | Written: [02-alpaca-venue.md](02-alpaca-venue.md) |
| 3 | Order executor, tools, profile | `tool-trading`, `bundle-trading` | In-app `trader` agent trades end to end on paper through the generic approval UI: proposal ids, two locked sections with reservations, fail-closed tool body, Halt guard, flatten window, journal, fills injected into the root agent, tool allowlist with a `tool-schemas.expected.json` snapshot, `mcp-resources` row disabled, configured preset root with `default: trader` failing loudly on an unknown saved default, keyless recorded-session snapshot | — |
| 4 | Gateway and Trading panel | `trading-gateway`, `ui-trading` | Trading sidebar tab with lightweight-charts, overlays, watchlist, positions/orders/journal tabs, trading approval composer entry, tool views, settings card, client-owned Remote assembly, en/zh locale dictionaries; live market-data WebSocket (one per asset class, reference-counted subscriptions, reconnect with REST backfill, stale marking) added to `trading-alpaca` and consumed by `trading-gateway` | — |
| 5 | Claude Code over MCP | `trading-mcp` | Streamable-HTTP MCP endpoint with per-session tokens, trading-owned approval queue, immediate SSE stream plus 30-second progress, de-duplicated pending proposals, Pending approvals strip, Connect Claude Code settings row | — |

## Notes carried from spec review into later plans

- **Plan 2:** the drift check treats `suspend_trade: false` as expected while a journaled flatten window is open; any other drift halts.
- **Plan 3:** `mcp-resources` is a base-bundle profile row; disable it in the `trading` profile and pin the `trader` agent's exact tool list with a `tool-schemas.expected.json` snapshot, as the minimal preset does.
- **Plan 3:** with `includeShippedRoot` and `includeUserRoot` false, the profile patch adds a configured preset root pointing at `bundle-trading`'s presets and sets `default: trader`; a saved default naming any other preset fails at load with an error naming it.
- **Plan 3:** fills arrive outside any tool call, so the account-stream handler resolves the session's root agent by session id; injection does not wake an idle agent.
- **Plan 3:** `client_order_id` = SHA-256 of `sessionId + ':' + proposalId`, as 64 hex characters (Alpaca allows up to 128); it uses `node:crypto` and therefore lives in `tool-trading`, not in the browser-safe `trading` library.
- **Plan 5:** Claude Code sees fills only in a tool result or through `list_orders`.
- **Plan 3 (from Plan 2 review):** re-read open orders and positions on a timer as well as on order-stream gaps; a socket that hangs without closing sends no gap. Gate every order path on the venue's derived `status()`, never a cached copy.
- **Plan 2 (from Plan 1 review):** `applyTrade` updates any `1D`/`1W` bar whose start precedes the trade, so the provider must open the next daily/weekly bar before folding trades into it; never pass a trade with a non-finite `t`.
- **Plan 3 (from Plan 1 review):** before `planSubmission`, the executor rejects a non-finite or non-positive approved price and a cap that rounds to 0; validation should check limit/stop prices against `priceIncrement` so sub-penny prices become tool errors; `RiskLimits` `Config` fields reject negative and non-finite values; pass `reduceOnly` from the post-approval re-check, not the first check.
