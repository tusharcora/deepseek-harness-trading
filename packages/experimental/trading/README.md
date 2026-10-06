---
description: "Browser-safe trading domain library: symbols, indicators, live candles, order validation, risk checks, and price caps for the experimental trading desk."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trading

English | [中文](README.zh.md)

## Summary

`dsh-experimental-trading` holds the trading desk's pure domain logic: canonical symbols, timeframes, indicators (SMA, EMA, RSI, MACD, Bollinger), live-candle building, Alpaca order validation, the risk policy, and submission planning with side-aware price caps. It performs no I/O and registers no services, so the trading provider, the order executor, and the browser chart import the same functions and show the same values. It is published under its experimental name and carries no stability promise.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import it from any trading package or browser component that needs a trading decision or a chart value:

```ts
import { checkRisk, parseSymbol, planSubmission, rsi, validateOrder } from '@deepseek-ai/dsh-experimental-trading'
```

An order goes through three calls in order. `validateOrder(order, asset)` returns the broker rules the order breaks, including the asset's `minNotional` minimum order value for a notional order or a priced (`limit`, `stop_limit`) quantity order; a quantity-based market order has no known value before the quote, so the broker enforces its minimum. `checkRisk(order, snapshot, limits)` returns every limit check, whether the order only reduces a position, and the reference price and estimated value shown on the approval card. `planSubmission(order, approvedPrice, tolerance, reduceOnly, priceIncrement)` returns the broker-facing type, prices, and time in force: a quantity-based market order that adds exposure becomes a limit capped at the approved price plus the tolerance for a buy or minus it for a sell, while exits and notional orders stay market orders.

Indicator functions return series aligned to their input, with `null` during warm-up. `applyTrade(lastBar, trade, timeframe)` folds a live trade into the forming candle and returns `undefined` for a trade that belongs to an earlier bucket.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/types.ts`](src/types.ts) | Domain types and branded proposal, broker-order, and client-order ids |
| [`src/symbol.ts`](src/symbol.ts) | Canonical symbol parsing |
| [`src/timeframe.ts`](src/timeframe.ts) | Timeframe membership and intraday bucket lengths |
| [`src/indicators.ts`](src/indicators.ts) | SMA, EMA, Wilder RSI, MACD, Bollinger |
| [`src/candles.ts`](src/candles.ts) | Folding trades into the forming candle |
| [`src/validation.ts`](src/validation.ts) | Alpaca static order rules |
| [`src/risk.ts`](src/risk.ts) | Limits, reservations, and reduce-only netting |
| [`src/submission.ts`](src/submission.ts) | Broker-facing order planning and price caps |
| — | No runtime invariant companion is published; this pure library owns no event stream or mutable runtime data; unit tests pin its behavior. |

### Why reduce-only is netted

An exit is computed against the position minus open sell orders and pending sell proposals, so two exits proposed together cannot sell more than the position and open a short.

### Why caps follow the side

A buy limit above the approved price and a sell limit below it both cross the spread and fill like a market order in a normal market, while bounding the fill price. Exits stay market orders because a capped exit can fail to fill in a fast move.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Trading desk Agent Note](../../../.agents/notes/proposed/feature/2026-10-05-trading-desk.md) — the design these functions implement.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **US-dollar accounts only** — estimates and limits assume a USD account; crypto pairs quoted in BTC or USDT are sized in the quote currency without conversion.
- **Intraday buckets are UTC-aligned** — `1D` and `1W` candles must come from the provider; `applyTrade` only updates them.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
