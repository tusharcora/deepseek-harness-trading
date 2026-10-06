---
description: "Experimental trading profile layer over dsh-base and dsh-web-app with the trader agent preset and paper Alpaca trading."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-bundle-trading

## Summary

`dsh-experimental-bundle-trading` is a published experimental profile layer that turns a Web profile built on `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` into a trading desk. Its patch adds the Alpaca venue in paper mode and the [order executor](../tool-trading/README.md), removes every other way the in-app agent could reach the broker, and makes the `trader` agent preset the only selectable preset. The trader analyzes US stocks and crypto pairs and proposes orders the user approves one at a time. Trading is paper by default; add the package explicitly to a profile, because no shipped profile enables it. It is experimental and carries no stability promise.

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

### Install into a profile

Create a Web-based profile, add the layer, add paper keys, and start it:

```sh
dsh --profile trading --from-default-profile web
dsh plugin --profile trading add @deepseek-ai/dsh-experimental-bundle-trading
dsh --profile trading
```

Before starting, put your Alpaca paper keys into `$DSH_HOME/.credentials.yaml` as `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`; the Trading settings card arrives with the Trading panel. Without keys the desk reports `Alpaca keys not configured` and refuses orders. Removing the package with `dsh plugin --profile trading remove @deepseek-ai/dsh-experimental-bundle-trading` removes the layer.

### What the layer changes

| Row | Change |
|---|---|
| `mcp-resources` | Disabled: no MCP resource tools on the host plane |
| `cordis-host-runner`, `cordis-client-runner` | Disabled: no model-defined Host or Client plugins |
| `ui-cordis` | Disabled: the Cordis browser view runs on the disabled client runner |
| `agent-presets` | `default: trader`, `includeShippedRoot: false`, `includeUserRoot: false`; the only root is this package's `presets` directory, with `trust: system` |
| `trading-alpaca` | Inserted: `@deepseek-ai/dsh-experimental-trading-alpaca` with `mode: paper` |
| `trading-executor` | Inserted: `@deepseek-ai/dsh-experimental-tool-trading` with `maxOrderNotional: 1000`, `maxPositionPct: 0.2`, `dailyLossPct: 0.03`, `maxOrdersPerDay: 20`, `allowShort: false`, `allowMargin: false`, empty `allowlist` and `denylist`, `staleQuoteMs: 30000`, `driftTolerance: 0.01`, `barsDefault: 100`, `barsCap: 500` |

`terminal-controller` and `ui-sidebar-terminal` stay, so the user keeps the Terminal tab. Live trading needs `mode: live` and `DSH_TRADING_LIVE=1` at launch; see [trading-alpaca](../trading-alpaca/README.md).

### The trader preset

| Row | Package |
|---|---|
| `persona` | `@deepseek-ai/dsh-persona` with the trader prefix |
| `tool-trading` | `@deepseek-ai/dsh-experimental-tool-trading/tools` |
| `command-trading` | `@deepseek-ai/dsh-experimental-tool-trading/command` |
| `compaction` | The `standard` preset's compaction group: `compaction-basic`, `command-compact`, `tool-result-pruner` |
| `tool-web` | `@deepseek-ai/dsh-tool-web` with `fetch: true` |

The model receives exactly nine tools: `get_quote`, `get_bars`, `get_account`, `get_positions`, `list_orders`, `place_order`, `cancel_order`, `web_search`, and `web_fetch`. Compaction and the commands add none. There is no shell, terminal, file, code, workflow, delegation, MCP, or extension tool, so the trading tools and their approval requests are the agent's only way to reach the broker. The user checks status, halts, and resumes with `/trading status`, `/trading halt [reason]`, and `/trading resume`; commands never reach the model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml), declared as `dsh.bundle.patch`, and the preset under [`presets/trader`](presets/trader). The executor stays on the host plane so every order path shares one account lock, one set of reservations, and one journal; its tools mount only inside the preset.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` and `dsh-web-app` |
| [`presets/trader/agent.cordis.yml`](presets/trader/agent.cordis.yml) | The trader preset's rows |
| [`presets/trader/preset.yml`](presets/trader/preset.yml) | Preset name, description, and order |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch and the preset are the runtime content |
| — | No runtime invariant companion is published; the package carries only a static profile patch and a preset. The executor and venue packages own the relations they enforce. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [tool-trading](../tool-trading/README.md) — the executor, the seven trading tools, and the `/trading` command.
- [trading-alpaca](../trading-alpaca/README.md) — keys, paper and live, and the account safety settings.
- [Trading subsystem](../../../docs/subsystems/trading.md) — the venue and executor service APIs.
- [Trading desk Agent Note](../../../.agents/notes/proposed/feature/2026-10-05-trading-desk.md) — the design and the execution boundary.

-----

<a id="model-experience"></a>
## Model Experience

### Trader persona

#### What the model sees

The system prompt starts with the persona prefix below, with `{{model}}` replaced by the model name. The tool schemas, results, and fill notices are described in [tool-trading](../tool-trading/README.md#model-experience).

##### Persona prefix

```markdown
You are a trading assistant powered by the {{model}} model. You analyze US stocks and crypto pairs with the trading tools and web research, and you propose orders that the user approves one at a time. Base every proposal on data you fetched in this conversation and give the reason in its rationale. A refused order means a risk limit applies: explain the limit instead of retrying a variant. You cannot change the risk limits or resume a halted desk. Fills arrive as messages before the user's next message. You give analysis, not financial advice.
```

#### Token effect

Fixed, about 120 tokens per request.

#### KV Cache effect

Stable for a given model; the `{{model}}` interpolation changes the prefix only when the model changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Saved default preset** — settings are shared under `$DSH_HOME`, so a saved `agent-presets.default` from another profile makes new sessions fail with `agent-presets: preset "<id>" not found (available: trader)` until the user picks Trader as the default or turns off mode selection in Settings.
- **External shell-capable agents** — an agent outside this preset that has a shell, such as Claude Code in the Terminal tab, can still read the keys and trade directly; see the Agent Note's Execution boundary.
- **Keys in a file** — the keys go in `$DSH_HOME/.credentials.yaml` until the Trading settings card arrives.
- **File guidance without file tools** — the trader's system prompt still carries the Web app's file-output guidance and the `workspace-write` file policy line, although the trader has no file tools; Plan 4 drops them.
- **Deferred surfaces** — the Trading panel, its gateway, and the market-data stream arrive with Plan 4; the MCP endpoint for Claude Code arrives with Plan 5.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The preset root is resolved with `createRequire(baseUrl)` from the profile directory, where `dsh plugin add` (and the Web test scaffold's install anchors) place the package. The `trading-desk` Web snapshot (`snapshots/web/trading-desk`) was recorded against a local Qwen model served under the DeepSeek model name; its `snapshot.yml` records this, and re-recording with the DeepSeek API replaces only the session log.

</details>
