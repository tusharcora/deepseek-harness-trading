---
description: "Trading order executor at ctx.tradingExecutor and the seven model-facing trading tools of the experimental trading desk."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-trading

## Summary

`dsh-experimental-tool-trading` is the order executor of the experimental trading desk and the seven tools the `trader` agent uses. The service at `ctx.tradingExecutor` is the only broker path the tools offer: it validates each order, checks risk limits and reserves exposure under an account lock, records the proposal, asks the user, and after approval re-checks and submits it with an idempotent client order id. Fills are journaled and reported to the proposing agent. The root default-exports the service; `./tools` registers the tools and `./command` the user's `/trading` command. It is experimental and carries no stability promise.

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
- id: command-trading
  name: '@deepseek-ai/dsh-experimental-tool-trading/command'
```

### The `/trading` command

`/trading` (or `/trading status`) shows the venue's derived status, the account mode, and the reason behind the status; `/trading halt [reason]` halts through `ctx.tradingVenue.halt()` (default reason `halted by the user`); `/trading resume` goes through `ctx.tradingVenue.resume()`, which re-applies the account safety settings and lifts the broker suspension, and reports when a Halt that arrived meanwhile wins. The command is the user's: it runs in the command registry, is logged as `command/run` / `command/done`, and never reaches the model.

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

A negative, non-finite, or out-of-range value fails the plugin at load with a `RangeError` naming the field. Limits change only in configuration, never from chat. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-trading) is the exhaustive source for every field and its JSDoc.

### What success and failure look like

| Condition | What the model receives |
|---|---|
| A limit fails at the first check | A denial listing each failed check; the user is not asked |
| The user rejects or the approval is cancelled | The generic approval denial; nothing is sent |
| Approval prompts are off (`never`, including `DSH_PERMISSION_MODE=danger-full-access`) or no approval service | `orders need the user's approval, and approval prompts are off in this session` |
| Halted (before or during the approval) | `trading is halted; only the user can resume trading` |
| Blocked: the account cannot be made safe, or the broker blocks trading on it | `new orders are blocked because the account cannot be made safe; …` / `the broker blocks trading on this account` |
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

The journal is the storage domain `trading_journal` (table `entries`, one record per proposal). The submit result, order-stream updates, every gap, startup, and a `reconcileMs` timer all go through one fold, serialized on one lock; status never moves backwards (a fill that streams in before the submission returns is not overwritten by the stale submit result), a broker final status (`filled`, `canceled`, `expired`, `rejected`) is never replaced once journaled (only the filled quantity may still grow), and each growth of the cumulative filled quantity is reported once as `trading/fill` and as a notice injected into the proposing session's agent (`dsh-agent` proposals only). Reconciliation runs whatever the venue status, so a halted, blocked, or unconfigured desk still records fills. An in-flight order the broker has no record of, that the broker never reported, and whose entry has not changed for two `reconcileMs` intervals is marked not placed (until then a submission whose outcome was unknown may still be processing at the broker); nothing is resubmitted.

### Source map

| File | Owns |
|---|---|
| `src/executor.ts` | The service: proposals, pipeline wiring, execution, fills, reconciliation |
| `src/tools.ts` | The seven tool definitions (`./tools` plugin) |
| `src/command.ts` | The user's `/trading` command (`./command` plugin) |
| `src/book.ts` | Reservations, proposal states, call and approval links |
| `src/journal.ts` | The `trading_journal` domain |
| `src/snapshot.ts` | One risk snapshot; order planning and the broker request |
| `src/order-args.ts` | Raw argument parsing and the price-tick check |
| `src/bars.ts` | The `get_bars` report |
| `src/format.ts` | Model-facing texts and renderers |
| `src/config.ts`, `src/ids.ts`, `src/lock.ts`, `src/types.ts` | Config, ids and the trading day, the account lock, types and session events |

No runtime invariant companion is published: every relation the executor owns (approval before submission, reservation release, journal monotonicity) is enforced in the operation that makes it and pinned by tests.

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

Seven tool schemas, listed in the [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-trading): read tools return compact text (quote, account, positions, open and desk orders, and for `get_bars` a summary with swing points and indicator values followed by a CSV table of at most `barsCap` bars); `place_order` and `cancel_order` return the order id and status or a denial reason. Every order call is followed by a user decision the model does not see except as the tool result.

#### Token effect

Fixed schema cost per request for the seven tools. `get_bars` results grow with `limit` (about 40 tokens per bar row); the default is 100 and the cap 500, and a larger `limit` is cut to the cap rather than refused.

#### KV Cache effect

Schemas are stable for a preset generation, so the request prefix is reusable; `barsDefault`/`barsCap` appear in the `get_bars` description, so changing them changes the prefix.

### Fill notices

#### What the model sees

When an order of the agent's own proposals fills, the next request carries a user message from `@deepseek-ai/dsh-experimental-tool-trading`: `Order update: your <side> of <ticker> (order <orderId>) filled <fillQty> at <price>; <filledQty> filled in total, order <status>.` A fill without a reported price reads `at an unreported price`. An idle agent is not woken. Proposals from Claude Code over MCP get no notice; Claude Code reads fills through `list_orders`.

#### Token effect

About 40 tokens per fill.

#### KV Cache effect

Appended after the existing history; no prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Close and Cancel all & flatten** — user actions in the Trading panel (Plan 4). Halt, resume, and status are the user's `/trading` command today; no tool lets the agent halt or resume.
- **Approval card** — until the Trading panel's composer card exists, approval uses the generic approval panel, which shows the proposal summary as its headline.
- **Daily order count** — counts orders placed through this desk; orders placed elsewhere with the same keys are not counted.
- **MCP approvals** — the trading-owned approval queue for Claude Code over MCP (events `trading/approval-asked` / `trading/approval-decided`) arrives with `trading-mcp`; until then only in-app approvals release a proposal.
- **Unpriced open market buys** — an open market buy without a limit or stop price counts 0 toward committed cash; the broker's own cash check (margin multiplier 1) still applies.
- **Keys and limits in files** — until the Trading settings card arrives with the Trading panel (Plan 4), the Alpaca keys go in `$DSH_HOME/.credentials.yaml` and the limits in the profile configuration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The proposal book is in memory by design: a restart aborts pending tool calls, so a lost entry fails closed. Do not replace it with history scans (`Session.eventAt`/`snapshotEvents` are deprecated outside tests).

</details>
