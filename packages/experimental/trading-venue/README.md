---
description: "Service Definition for a trading venue: account reads, market data, order submission, Halt, and order updates at ctx.tradingVenue."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trading-venue

## Summary

`dsh-experimental-trading-venue` is the Service Definition of the trading desk's venue seam. It declares the abstract Cordis service `TradingVenueGateway` at `ctx.tradingVenue`, the `VenueError` class with its desk-level failure codes, and the `trading/venue-status` event. The order executor, the Trading panel gateway, and the MCP endpoint depend only on this class, so a new broker is a new Service Provider package with no consumer changes; `dsh-experimental-trading-alpaca` is the current provider. Domain values (symbols, orders, positions, `VenueStatus`, `OrderStreamEvent`) come from `dsh-experimental-trading`. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A consumer injects `tradingVenue` and calls it; a provider extends `TradingVenueGateway` and implements every abstract method:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'

export const inject = ['tradingVenue']
export function apply(ctx: Context): void {
  ctx.on('trading/venue-status', (status, reason) => { ctx.logger.info(`venue ${status}: ${reason}`) })
}

async function positionsOrEmpty(ctx: Context) {
  try {
    return await ctx.tradingVenue.positions()
  } catch (error) {
    if (error instanceof VenueError && error.code === 'unconfigured') return []
    throw error
  }
}
```

### Methods

Every method that reaches the broker resolves the API keys at call time and throws `VenueError` on failure.

| Method | Behavior |
|---|---|
| `status()` | Current readiness: `unconfigured` (keys missing or setup not yet completed), `ready`, `halted`, or `blocked` (the account cannot be made safe, or the broker refused the safety settings). |
| `account()` | Equity, cash, last equity, buying power, and whether trading is blocked at the broker. |
| `positions()` | Every open position. |
| `openOrders()` | Every order the broker still works. |
| `asset(symbol)` | Tradability, fractional support, minimum size, and price tick for one instrument. |
| `marketOpen(symbol)` | Whether the instrument's market is open now; always true for crypto. |
| `latestQuote(symbol)` | Best bid, best ask, and quote time. |
| `bars(symbol, timeframe, query)` | At most `query.limit` bars, oldest first. |
| `submitOrder(request)` | Submits an order; a retry with the same `clientOrderId` returns the existing order instead of creating a second one. Refused while `halted` or `blocked`, including a Halt that arrives while the order is still being prepared. |
| `cancelOrder(id)` | Cancels one open order. |
| `closePosition(symbol)` | Cancels the instrument's open orders, then closes the position at market; runs while halted or blocked. `not-found` when there is no position; the open orders are cancelled even then. |
| `flatten()` | Cancels every open order, then attempts to close every position; runs while halted or blocked. Throws `rejected` naming every instrument that failed to close; the closes that succeeded stand. |
| `halt(reason)` | Halts the desk now and persists the Halt, then suspends trading at the broker with retries. Works without keys and while blocked; resolves once the desk is halted even when the broker suspension is still pending. |
| `resume()` | Re-applies the account safety settings and lifts the Halt. Refuses while `unconfigured` or `blocked`. It may resolve with the desk still halted, because a Halt requested after the resume began wins; check `status()` once it resolves. |
| `subscribeOrderUpdates(listener)` | Delivers order updates and gaps; returns a disposer. The venue streams only while at least one listener is registered. A listener that throws does not keep an event from the other listeners. |

After a `gap` event the listener re-reads open orders and positions, because missed updates are not replayed. A gap is delivered only after the stream is listening again, so a re-read made after it cannot miss updates, or once when the stream stops for good.

### Error codes

`VenueError` carries `code` (below) and, when the broker sent one, its numeric `brokerCode`.

| Code | When it occurs |
|---|---|
| `unconfigured` | The API keys are not configured, or setup has not completed yet. |
| `auth` | The broker rejected the API keys. |
| `blocked` | The account could not be made safe: the broker refused the provider's safety settings or did not keep them. Orders and resume are refused; exits still run. |
| `halted` | `submitOrder` was called while the desk is halted. |
| `rejected` | The broker refused the request, or `flatten` could not close one or more positions. |
| `not-found` | The order, position, asset, or quote does not exist. |
| `rate-limited` | The broker's rate limit was reached. Reads are retried first; writes (`submitOrder`, `cancelOrder`, `closePosition`, `flatten`) report it on the first rate-limit response. |
| `unavailable` | The broker is unreachable, answered with a server error, or sent a response that could not be read. From `submitOrder` it means the order was not placed. |
| `unknown-outcome` | `submitOrder` may have placed the order but the broker did not confirm it; check open orders before proposing again. |

### Event

`trading/venue-status(status, reason)` is emitted when the venue's readiness changes or is re-confirmed, with a readable cause such as the account setting that drifted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `TradingVenueGateway`, `VenueError`, `VenueErrorCode`, the `ctx.tradingVenue` declaration, and the `trading/venue-status` event |
| — | No runtime invariant companion is published; the Service Definition owns no event stream or mutable state, so there is no relation for one to check. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-experimental-trading-alpaca`](../trading-alpaca/README.md) — the Alpaca Service Provider.
- [`dsh-experimental-trading`](../trading/README.md) — the domain types this definition uses.
- [Trading desk Agent Note](../../../.agents/notes/proposed/feature/2026-10-05-trading-desk.md) — the design of the venue seam.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No market-data subscription** — the definition offers REST reads only; the live market-data subscription arrives with the Trading panel.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
