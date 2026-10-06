---
description: "Alpaca Service Provider for ctx.tradingVenue: paper and live trading, account safety with a persisted Halt, idempotent order submission, and order updates."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trading-alpaca

## Summary

`dsh-experimental-trading-alpaca` provides `ctx.tradingVenue` (the [`TradingVenueGateway`](../trading-venue/README.md) Service Definition) on Alpaca. It reads accounts, positions, orders, assets, quotes, bars, and the market clock over Alpaca's REST APIs; submits orders without duplicates; holds the account to no shorting and no margin; persists the desk's Halt in the `trading_alpaca_safety` storage domain; and streams order updates from the account's trade-updates WebSocket. It trades paper by default; any other trading host needs `DSH_TRADING_LIVE=1` at launch. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the plugin after the storage stack that provides `storageDomain` and, optionally, a credentials provider:

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
- name: '@deepseek-ai/dsh-experimental-trading-alpaca'
  config:
    mode: paper
```

The plugin injects `storageDomain`. Consumers read `ctx.tradingVenue` and depend only on the Service Definition.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `mode` | `paper` | `paper` or `live` account; live also needs `DSH_TRADING_LIVE=1` at launch. |
| `apiKeyEnv` | `ALPACA_API_KEY` | Credential name holding the API key id. |
| `secretKeyEnv` | `ALPACA_SECRET_KEY` | Credential name holding the secret key. |
| `feed` | `iex` | Equity data feed, `iex` or `sip`; the free plan serves only `iex`. |
| `driftCheckMs` | `60000` | Interval between account-settings drift checks; minimum 5000. |
| `requestTimeoutMs` | `15000` | Per-request timeout for REST calls; minimum 1000. |
| `rateLimitRetryMs` | `[1000, 2000, 4000]` | Waits before retrying a rate-limited `GET`; one retry per entry. Writes are never retried. |
| `streamBackoffMs` | `[1000, 2000, 5000, 10000, 30000]` | Waits before trade-stream reconnect attempts; the last entry repeats. At least one entry. |
| `suspendRetryMs` | `[500, 1000, 2000]` | Waits before retrying an unconfirmed broker suspension during Halt; one retry per entry. |
| `lookupConfirmMs` | `2000` | Wait before the second confirming lookup after a submission failed in transit or hit a used client order id. |
| `closeSettleMs` | `500` | Wait between checks that a symbol's cancelled orders are gone before closing its position. |
| `closeSettleChecks` | `10` | Maximum such checks before closing anyway. |
| `cryptoMinNotional` | `10` | Alpaca's minimum crypto order value in dollars, reported as every crypto asset's `minNotional`; Alpaca rejects smaller crypto orders but does not publish the minimum on the asset. Minimum 0. Equities carry no minimum value. |
| `tradingUrl` | `''` | Trading API base URL; empty selects `https://paper-api.alpaca.markets` or `https://api.alpaca.markets` for `mode`. |
| `dataUrl` | `https://data.alpaca.markets` | Market data API base URL. |
| `tradeStreamUrl` | `''` | Trade-updates stream URL; empty selects `wss://<trading host>/stream` for `mode`. |

### API keys

Keys resolve on every request and every stream connection, never cached: through the credentials service when one is loaded, otherwise from the launch environment (`ALPACA_API_KEY` and `ALPACA_SECRET_KEY` under the default names). Without both keys the venue reports `unconfigured`, or `halted` when a saved Halt is set (the status table below decides), and every broker call throws `unconfigured`, except `halt`. Setup runs at start, again when a credentials provider becomes available after this service, and on the next venue call while it has not completed.

### Paper and live

The trading host decides. Any trading host other than `paper-api.alpaca.markets` or loopback (`127.0.0.1`, `localhost`, `[::1]`), and any `mode: live`, needs `DSH_TRADING_LIVE=1` in the launch environment; otherwise the plugin fails at load. `mode()` reports `paper` only for `mode: paper` against the paper host or loopback, and `live` for every other trading host, whatever `mode` says. The lock checks the trading host only: `dataUrl` and `tradeStreamUrl` overrides receive the API keys without `DSH_TRADING_LIVE`, so point them only at hosts you trust. Every request uses `redirect: 'error'`, so key headers never follow a redirect to another host.

### Status

`status()` is derived on each call:

| Status | When |
|---|---|
| `halted` | The saved Halt flag is set, whatever else holds. |
| `blocked` | The account cannot be made safe: Alpaca refused the safety settings (`rejected` or `auth` on the write) or did not keep them. It stays blocked until the service restarts. |
| `ready` | Setup verified the safety settings. |
| `unconfigured` | Keys are missing or setup has not completed yet, for example because Alpaca was unavailable or rate-limited; the next venue call retries setup. |

`statusReason()` returns the saved Halt reason while `halted`, the block reason while `blocked`, the missing-keys message while `unconfigured`, and an empty string while `ready`. Every change and setup result is published as `trading/venue-status`. `submitOrder` refuses while `halted` (`halted`) or `blocked` (`blocked`); `resume` refuses while `unconfigured` or `blocked`. Reads, `cancelOrder`, `closePosition`, and `flatten` run while halted or blocked.

### Account safety

At setup the provider reads `/v2/account/configurations`, applies `no_shorting=true` and `max_margin_multiplier="1"` when they differ, and reads them back. When Alpaca refuses the write (`rejected` or `auth`) or does not keep the settings, the venue is `blocked`; exits still run. When the write fails transiently (`unavailable` or `rate-limited`), setup stays incomplete and runs again on the next venue call. Setup also restores a Halt from saved state, or adopts one when Alpaca reports `suspend_trade=true`.

`halt(reason)` saves the Halt locally before contacting Alpaca, so an outage or missing keys never leave the desk running, then sets `suspend_trade=true`, retrying per `suspendRetryMs`. An unconfirmed suspension stays pending and the drift watch retries it. When saving fails, `halt` throws the storage error and the desk is still halted in memory. `resume()` re-applies the safety settings, lifts the suspension, and clears the Halt; it refuses while `unconfigured` or `blocked`. A Halt requested after the user asked to resume wins: `resume()` then resolves with the desk still halted and the suspension restored, so callers check `status()` once it resolves.

Every `driftCheckMs` the provider first retries a pending suspension, then compares `no_shorting`, `max_margin_multiplier`, and `suspend_trade` with the expected values and halts on any difference. A pending suspension is never reported as drift. Checks never overlap and run only once setup has succeeded or the desk is halted.

While halted, `closePosition` and `flatten` run inside a flatten window: the provider saves that the window is open, lifts the suspension, runs the closes, then restores the suspension (or leaves it pending). Safety operations run one at a time, so windows never overlap. When the process stops inside a window, the next setup halts with "the desk stopped while closing positions" and suspends trading at Alpaca before doing anything else.

### Order submission

Numbers are sent as plain decimal strings, never in exponent notation, and every order carries its `client_order_id`, so a retry never duplicates:

- A duplicate-id rejection (Alpaca code `40010001`, or a `rejected` error whose message contains `client_order_id must be unique`, which Alpaca sends under its generic validation code `42210000`) triggers two lookups by client order id, `lookupConfirmMs` apart, and returns the existing order; when neither finds it, `submitOrder` throws `unknown-outcome` naming the client order id.
- The Halt is checked again immediately before the order is sent, after the keys resolve, so a Halt that arrives while the request is being prepared sends nothing and `submitOrder` throws `halted`.
- A failure in transit (`unavailable`) triggers two lookups by client order id, `lookupConfirmMs` apart; when neither finds the order, `submitOrder` throws `unavailable` "the order was not placed".
- A 2xx response that cannot be read, or that names a different client order id, triggers the same two lookups; when neither finds the order, `submitOrder` throws `unknown-outcome`.
- A lookup that fails, or returns an order with a different client order id, throws `unknown-outcome`.

`order(clientOrderId)` reads `GET /v2/orders:by_client_order_id`; a 404 is `undefined`.

### Closing positions

`positions()` reports Alpaca's `qty_available` as `qtyAvailable`, signed like `qty`. Right after a crypto buy fills, Alpaca reports the position with `qty_available` of 0 for a moment and rejects a sell for more than it, so a partial sell or cover is sized from `qtyAvailable`.

`closePosition(symbol)` cancels the symbol's resting orders, which hold the shares (a per-order cancel failure is tolerated), checks up to `closeSettleChecks` times, `closeSettleMs` apart, that they are gone, then closes the position at market. While Alpaca rejects the close with insufficient balance or qty because it has not yet released the coins held by the cancelled orders, the close is retried up to `closeSettleChecks` times, `closeSettleMs` apart, before that rejection is thrown. The resting orders are cancelled even when Alpaca then reports no position and `closePosition` throws `not-found`. `flatten()` cancels every order and closes every position in one request; when any position fails, it throws `rejected` naming every failed instrument with its HTTP status.

### Order updates

The trade-updates stream connects while at least one listener is subscribed, authenticates, and listens to `trade_updates`. It decodes Alpaca's binary frames and reconnects with `streamBackoffMs`. A `gap` event is delivered after the stream listens again following a reconnect, after an order update that cannot be read, after an Alpaca stream error, and once when Alpaca rejects the keys, which stops the stream. A frame that is not valid JSON is reported as an error without a gap event, so consumers should also re-read open orders and positions on a timer. An outage is logged once until the stream listens again. After Alpaca rejects the keys, the stream starts again on the next `subscribeOrderUpdates` call, or when the credentials service reports a changed reference (`credentials/reference-updated`) while listeners remain. Each listener is called separately: one that throws is logged and does not keep the event from the others.

### Errors

HTTP 401, and 403 without a broker code, map to `auth`; 404 to `not-found`; 429 to `rate-limited` (reads retry per `rateLimitRetryMs` first; writes report it on the first 429); 5xx, network failures, and malformed responses to `unavailable`; other 4xx to `rejected`. Assets outside US equities and crypto are `rejected`.

### Egress

REST requests and the WebSocket both go through the configured HTTP proxy (`tests/egress.spec.ts` observes a REST request and a `CONNECT` for the stream at a fake proxy).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `AlpacaVenue` service, the `trading_alpaca_safety` storage domain, key resolution, and setup on start and on credentials availability |
| [`src/config.ts`](src/config.ts) | `Config` schema and endpoint resolution with the live lock |
| [`src/http.ts`](src/http.ts) | REST client: per-request keys, timeouts, rate-limit retries for reads, refused redirects, and error mapping; `AcceptedUnreadableError` |
| [`src/map.ts`](src/map.ts) | Alpaca JSON to domain values with checked numbers, symbols, and timestamps; `decimalString` |
| [`src/market.ts`](src/market.ts) | Latest quotes, paged bar history, the market clock, and assets |
| [`src/orders.ts`](src/orders.ts) | Account reads, idempotent submission with confirming lookups, cancel, close, and flatten |
| [`src/safety.ts`](src/safety.ts) | Safety settings, local-first Halt, resume, flatten window, crash recovery, and drift checks |
| [`src/stream.ts`](src/stream.ts) | Trade-updates WebSocket with reconnect and gap events |
| [`src/venue.ts`](src/venue.ts) | `VenueCore`: derived status, order gating, drift watch, listener-counted streaming; `orderedStore` |
| [`src/types.ts`](src/types.ts) | Key pair and raw record types |
| — | No runtime invariant companion is published; every observable relation (Halt before submission, safety settings, suspension) is checked by the operation that makes it. |

### Persisted state

The `trading_alpaca_safety` domain holds one global record: `halted`, `haltReason`, `flattenWindowOpen`, and `suspendPending`. The provider writes it through an ordered store: reads reflect a write immediately, writes persist one at a time in call order, the last write wins, and a failed write neither stops later ones nor rolls back the in-memory value. When the plugin is disposed, the provider waits for every pending write before it closes the domain, so a Halt clicked just before a reload survives it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-experimental-trading-venue`](../trading-venue/README.md) — the Service Definition this package provides.
- [Trading desk Agent Note](../../../.agents/notes/proposed/feature/2026-10-05-trading-desk.md) — the design, including the execution boundary these settings bound.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **One-cent tick for equities** — `asset()` reports a 0.01 price increment for every equity, including sub-dollar equities that Alpaca allows to trade in finer increments.
- **The crypto minimum value is configured, not read** — Alpaca enforces a minimum crypto order value (currently $10) that `GET /v2/assets` does not publish, so `cryptoMinNotional` carries it; a change at Alpaca needs a config change. Validation checks it only for notional and priced orders; Alpaca rejects a quantity-based crypto market order below it.
- **No market-data WebSocket** — live quotes and trades arrive with the Trading panel; this package serves REST market data only.
- **Account settings are bounded, not locked** — an agent holding the keys can change `no_shorting`, `max_margin_multiplier`, or `suspend_trade`; the drift check detects the change within one `driftCheckMs` and halts, but cannot prevent it.
- **Keys added after startup apply on the next venue call** — the panel shows `unconfigured` until something calls the venue or a credentials provider starts.
- **No dead-connection detection on the stream** — the stream sends no ping and has no idle timeout; a silently dropped connection is noticed only when the socket closes.
- **Missed order updates are not replayed** — after a `gap`, consumers re-read open orders and positions.
- **Disposing the storage stack with the venue can drop a queued Halt write** — the venue flushes its pending writes before closing its domain, but when the storage plugins are disposed in the same teardown they close the storage under it; a write still queued behind another can then be lost. Reloading the venue alone keeps every write.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
