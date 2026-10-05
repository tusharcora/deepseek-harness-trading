# Trading Domain Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@deepseek-ai/dsh-experimental-trading`, a pure, browser-safe library that every later trading package builds on: domain types, symbol parsing, indicators, live-candle building, Alpaca order validation, the risk policy, and submission planning (price caps).

**Architecture:** One experimental package at `packages/experimental/trading/` with no I/O, no Cordis services, and no Node-only imports, so both Host packages (`tool-trading`, `trading-alpaca`) and the browser (`ui-trading`) import the same functions. Each concern is one module with one test file. The spec's `trading-core` is named `trading` here because the role-word rules in `docs/cookbook/adding-a-package.md` name the capability, and "core" names nothing; the spec's `RiskEngine.check` becomes the function `checkRisk` (a decision function, "Policy" in the role table). Task 1 records both renames in the spec.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vitest, pnpm workspaces, `@deepseek-ai/dsh-brand`.

**Spec:** `.agents/notes/proposed/feature/2026-10-05-trading-desk.md`. Roadmap: [00-roadmap.md](00-roadmap.md).

## Global Constraints

- Node `^22.19 || >=24`. On this machine prefix every command with `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH &&` (the default `node` is v20 and the repo scripts fail on it).
- npm name `@deepseek-ai/dsh-experimental-trading`; omit `private`; `publishConfig.access: "public"`; `version` equals the root `package.json` version (`0.1.6-alpha.1` today; copy whatever root says).
- `@deepseek-ai/cordis` in both `peerDependencies` and `devDependencies` (`workspace:^`), even though the library does not import it.
- ESM only; in-package relative imports use explicit `.ts` specifiers.
- No `!` non-null assertions in `src` (`typescript/no-non-null-assertion` is an error there; tests may use them).
- Every export has JSDoc; function exports carry `@param` and `@returns` (`verify-export-jsdoc`).
- Per-file 100% coverage on `src` (lines, branches, functions, statements). Avoid `??` / `?.` fallbacks whose second branch no test reaches.
- No Node-only imports (`node:*`) in `src`: the browser imports this package.
- Commit messages carry no Claude or AI attribution lines.
- Money and quantities are JavaScript numbers; percentages in limits are fractions (`0.2` = 20%).

## Review Focus

1. **Non-finite sizes and prices from model JSON** (`NaN`, `Infinity`, `0`, negatives) must be validation errors, never pass as "greater than zero". Pinned in Task 5.
2. **A brand-new or empty paper account** (`equity` 0, `lastEquity` 0) must not divide by zero into `NaN` checks that silently pass or fail; position-size fails with a readable reason and daily loss reads as 0%. Pinned in Task 6.
3. **Messy symbol input** (`" btc/usd "`, `"brk.b"`, `"SOLUSDT"`) parses to canonical symbols; junk throws a `RangeError` naming the input. Pinned in Task 2.
4. **Out-of-order and late trades** in the live stream never move a closed candle or open a bucket in the past. Pinned in Task 4.
5. **A zero or missing quote side** (illiquid crypto with `bid` 0) never yields an `Infinity` quantity; the risk result fails a `quote` check instead. Pinned in Task 6.

---

### Task 1: Record the renames in the spec and add its Chinese counterpart

The translation-pairing gate fails today because the note links to a `.zh.md` that does not exist.

**Files:**
- Modify: `.agents/notes/proposed/feature/2026-10-05-trading-desk.md`
- Create: `.agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md`
- Create: `.agents/notes/proposed/feature/2026-10-05-trading-desk.i18n.yaml` (written by the gate)

**Interfaces:** none.

- [ ] **Step 1: Apply the two renames in the English note**

In the Package topology table and everywhere else in the note, replace the package name `trading-core` with `trading`, and replace `RiskEngine.check(order, snapshot, limits)` with `checkRisk(order, snapshot, limits)` and any other `RiskEngine` with `checkRisk`. Add this sentence at the end of the paragraph that begins "`tool-trading` owns the order executor":

```markdown
The domain library is named `trading` rather than `trading-core` because the package naming rules name the capability, and its risk decision is the function `checkRisk`.
```

Run: `grep -n "trading-core\|RiskEngine" .agents/notes/proposed/feature/2026-10-05-trading-desk.md`
Expected: no output.

- [ ] **Step 2: Write the Chinese counterpart**

Read `docs/i18n/README.md`, `docs/i18n/terminology.md`, and `docs/i18n/translation-prompt.md`, then the English note, then any existing `.zh.md` note in `.agents/notes/proposed/feature/` as a style sample. Write `2026-10-05-trading-desk.zh.md` mirroring the English section for section and paragraph for paragraph. Keep these lines byte-identical to English: `# Agent Note: <title>` (the title itself is translated after the prefix, as the sample notes do) and `Status: proposed`. The language line is `[English](2026-10-05-trading-desk.md) | 中文`. Headings use the sample notes' Chinese section names (`## 问题`, `## 提案`, `## 曾考虑的替代方案`, `## 验收标准`, `## 风险`). Code spans, package names, tool names, config keys, URLs, and command lines stay unchanged. One physical line per paragraph.

- [ ] **Step 3: Record the pair**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-10-05-trading-desk.md`
Expected: writes `2026-10-05-trading-desk.i18n.yaml` with the blob hashes of both files.

- [ ] **Step 4: Run the note gates**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run verify-translation-pairing && pnpm run verify-agent-note-format`
Expected: both pass. If pairing reports the plans folder `.agents/plans/` as unpaired, add `".agents/plans/"` to `excluded` in `scripts/translation-pairing.manifest.json` (keep the trailing slash) and re-run.

- [ ] **Step 5: Commit**

```bash
git add .agents/notes/proposed/feature/2026-10-05-trading-desk.md .agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md .agents/notes/proposed/feature/2026-10-05-trading-desk.i18n.yaml scripts/translation-pairing.manifest.json
git commit -m "docs(notes): add Chinese trading desk note and name the trading library"
```

---

### Task 2: Package scaffold, domain types, symbols, timeframes

**Files:**
- Create: `packages/experimental/trading/package.json`
- Create: `packages/experimental/trading/tsconfig.json`
- Create: `packages/experimental/trading/src/index.ts`
- Create: `packages/experimental/trading/src/types.ts`
- Create: `packages/experimental/trading/src/symbol.ts`
- Create: `packages/experimental/trading/src/timeframe.ts`
- Modify: `tsconfig.base.json` (add a `paths` entry next to the other `@deepseek-ai/dsh-experimental-*` entries)
- Modify: `tsconfig.host.json` (add a `references` entry)
- Test: `packages/experimental/trading/tests/symbol.spec.ts`, `packages/experimental/trading/tests/timeframe.spec.ts`

**Interfaces:**
- Produces (`types.ts`): `AssetClass`, `TradingSymbol`, `TIMEFRAMES`, `Timeframe`, `Bar`, `Quote`, `Trade`, `Side`, `OrderType`, `TimeInForce`, `Bracket`, `OrderRequest`, `Asset`, `ProposalId`, `BrokerOrderId`, `ClientOrderId`.
- Produces (`symbol.ts`): `parseSymbol(input: string): TradingSymbol`.
- Produces (`timeframe.ts`): `isTimeframe(value: string): value is Timeframe`, `intradayMs(timeframe: Timeframe): number | undefined`.

- [ ] **Step 1: Create the manifest and compiler config**

`packages/experimental/trading/package.json` (set `version` to the root `package.json` version):

```json
{
  "name": "@deepseek-ai/dsh-experimental-trading",
  "description": "Browser-safe trading domain library: types, indicators, candles, order validation, risk policy, and submission planning",
  "version": "0.1.6-alpha.1",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/experimental/trading"
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
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/dsh-brand": "workspace:^"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```

`packages/experimental/trading/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src"],
  "references": [
    { "path": "../../util/brand" }
  ]
}
```

In `tsconfig.base.json`, beside the existing `"@deepseek-ai/dsh-experimental-browser-use-runtime"` entry, add:

```json
      "@deepseek-ai/dsh-experimental-trading": ["./packages/experimental/trading/src/index.ts"],
```

In `tsconfig.host.json` `references`, beside the other `./packages/experimental/*` entries, add:

```json
    { "path": "./packages/experimental/trading" },
```

- [ ] **Step 2: Write the domain types**

`packages/experimental/trading/src/types.ts`:

```ts
/**
 * Trading domain values shared by the trading provider, executor, gateway, and browser UI.
 *
 * @module @deepseek-ai/dsh-experimental-trading/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Market an instrument trades in. */
export type AssetClass = 'equity' | 'crypto'

/** A canonical instrument: `AAPL`, `BRK.B`, or a crypto pair such as `BTC/USD`. */
export interface TradingSymbol {
  /** Market the instrument trades in. */
  readonly assetClass: AssetClass
  /** Upper-case ticker; crypto pairs use `BASE/QUOTE`. */
  readonly ticker: string
}

/** Every chart and bar timeframe the desk supports, shortest first. */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'] as const

/** One supported timeframe. */
export type Timeframe = typeof TIMEFRAMES[number]

/** One OHLCV candle; `t` is the bucket start in UTC epoch milliseconds. */
export interface Bar {
  /** Bucket start, UTC epoch milliseconds. */
  readonly t: number
  /** Open price. */
  readonly o: number
  /** High price. */
  readonly h: number
  /** Low price. */
  readonly l: number
  /** Close (latest) price. */
  readonly c: number
  /** Traded volume. */
  readonly v: number
}

/** Best bid and ask at time `t` (UTC epoch milliseconds). */
export interface Quote {
  /** Best bid price. */
  readonly bid: number
  /** Best ask price. */
  readonly ask: number
  /** Quote time, UTC epoch milliseconds. */
  readonly t: number
}

/** One executed trade print from the market-data stream. */
export interface Trade {
  /** Trade time, UTC epoch milliseconds. */
  readonly t: number
  /** Execution price. */
  readonly price: number
  /** Executed size. */
  readonly size: number
}

/** Order direction. */
export type Side = 'buy' | 'sell'

/** Order types the desk accepts. */
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'

/** Time-in-force values the desk accepts. */
export type TimeInForce = 'day' | 'gtc' | 'ioc'

/** Equity bracket legs attached to an entry order. */
export interface Bracket {
  /** Take-profit limit price. */
  readonly takeProfit: number
  /** Stop-loss stop price. */
  readonly stopLoss: number
}

/** An order as proposed by an agent, before validation and risk checks. Exactly one of `qty` and `notional` is set. */
export interface OrderRequest {
  /** Instrument. */
  readonly symbol: TradingSymbol
  /** Direction. */
  readonly side: Side
  /** Quantity in shares or coins. */
  readonly qty?: number
  /** Dollar amount for a notional market order. */
  readonly notional?: number
  /** Order type. */
  readonly type: OrderType
  /** Limit price for `limit` and `stop_limit`. */
  readonly limitPrice?: number
  /** Stop price for `stop` and `stop_limit`. */
  readonly stopPrice?: number
  /** Time in force. */
  readonly timeInForce: TimeInForce
  /** Optional equity bracket. */
  readonly bracket?: Bracket
}

/** Broker facts about one instrument that order validation needs. */
export interface Asset {
  /** Instrument these facts describe. */
  readonly symbol: TradingSymbol
  /** Whether the broker accepts orders for it now. */
  readonly tradable: boolean
  /** Whether fractional and notional orders are allowed. */
  readonly fractionable: boolean
  /** Smallest accepted quantity, when the broker publishes one. */
  readonly minOrderSize?: number
  /** Smallest price step for limit and stop prices. */
  readonly priceIncrement: number
}

/** Executor-minted id of one order proposal; keys proposals, approvals, and client order ids on both the in-app and MCP paths. */
export type ProposalId = Branded<'TradingProposalId'>

/** Broker-assigned order id. */
export type BrokerOrderId = Branded<'TradingBrokerOrderId'>

/** Idempotency key sent to the broker with an order. */
export type ClientOrderId = Branded<'TradingClientOrderId'>
```

- [ ] **Step 3: Write the failing symbol and timeframe tests**

`packages/experimental/trading/tests/symbol.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseSymbol } from '../src/symbol.ts'

describe('parseSymbol', () => {
  it('reads equities, including class shares, case- and space-insensitively', () => {
    expect(parseSymbol('aapl')).toEqual({ assetClass: 'equity', ticker: 'AAPL' })
    expect(parseSymbol(' brk.b ')).toEqual({ assetClass: 'equity', ticker: 'BRK.B' })
  })

  it('reads slash crypto pairs', () => {
    expect(parseSymbol(' btc/usd ')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(parseSymbol('eth/btc')).toEqual({ assetClass: 'crypto', ticker: 'ETH/BTC' })
  })

  it('reads joined crypto pairs by their quote currency', () => {
    expect(parseSymbol('BTCUSD')).toEqual({ assetClass: 'crypto', ticker: 'BTC/USD' })
    expect(parseSymbol('solusdt')).toEqual({ assetClass: 'crypto', ticker: 'SOL/USDT' })
    expect(parseSymbol('1INCHUSD')).toEqual({ assetClass: 'crypto', ticker: '1INCH/USD' })
  })

  it('rejects a slash pair with an unknown quote currency or a bad base', () => {
    expect(() => parseSymbol('BTC/EUR')).toThrow(new RangeError('not a supported crypto pair: BTC/EUR'))
    expect(() => parseSymbol('B/USD')).toThrow(new RangeError('not a supported crypto pair: B/USD'))
  })

  it('rejects input that is neither an equity nor a crypto pair', () => {
    expect(() => parseSymbol('')).toThrow(new RangeError('not a symbol: '))
    expect(() => parseSymbol('NOTAPAIR')).toThrow(new RangeError('not a symbol: NOTAPAIR'))
    expect(() => parseSymbol('$$USD')).toThrow(new RangeError('not a symbol: $$USD'))
  })
})
```

`packages/experimental/trading/tests/timeframe.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { intradayMs, isTimeframe } from '../src/timeframe.ts'

describe('timeframes', () => {
  it('recognizes only supported timeframes', () => {
    expect(isTimeframe('4h')).toBe(true)
    expect(isTimeframe('1W')).toBe(true)
    expect(isTimeframe('2h')).toBe(false)
  })

  it('gives bucket lengths for intraday timeframes only', () => {
    expect(intradayMs('1m')).toBe(60_000)
    expect(intradayMs('15m')).toBe(900_000)
    expect(intradayMs('4h')).toBe(14_400_000)
    expect(intradayMs('1D')).toBeUndefined()
    expect(intradayMs('1W')).toBeUndefined()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm install && pnpm exec vitest run packages/experimental/trading`
Expected: FAIL, cannot resolve `../src/symbol.ts` and `../src/timeframe.ts`.

- [ ] **Step 5: Implement symbols, timeframes, and the index**

`packages/experimental/trading/src/symbol.ts`:

```ts
/**
 * Parsing of user- and model-typed instrument names into canonical symbols.
 *
 * @module @deepseek-ai/dsh-experimental-trading/symbol
 */
import type { TradingSymbol } from './types.ts'

const CRYPTO_QUOTES: readonly string[] = ['USDT', 'USDC', 'USD', 'BTC']
const EQUITY = /^[A-Z]{1,5}(\.[A-Z])?$/
const CRYPTO_BASE = /^[A-Z0-9]{2,10}$/

/**
 * Parse `AAPL`, `brk.b`, `BTC/USD`, or `BTCUSD` into a canonical symbol.
 * @param input - instrument name typed by a user or a model.
 * @returns the canonical symbol.
 * @throws RangeError when the input is neither an equity ticker nor a supported crypto pair.
 */
export function parseSymbol(input: string): TradingSymbol {
  const text = input.trim().toUpperCase()
  const slash = text.indexOf('/')
  if (slash !== -1) {
    const base = text.slice(0, slash)
    const quote = text.slice(slash + 1)
    if (CRYPTO_BASE.test(base) && CRYPTO_QUOTES.includes(quote)) return { assetClass: 'crypto', ticker: `${base}/${quote}` }
    throw new RangeError(`not a supported crypto pair: ${text}`)
  }
  if (EQUITY.test(text)) return { assetClass: 'equity', ticker: text }
  for (const quote of CRYPTO_QUOTES) {
    const base = text.slice(0, text.length - quote.length)
    if (text.endsWith(quote) && CRYPTO_BASE.test(base)) return { assetClass: 'crypto', ticker: `${base}/${quote}` }
  }
  throw new RangeError(`not a symbol: ${text}`)
}
```

`CRYPTO_QUOTES` lists `USDT` and `USDC` before `USD` so `SOLUSDT` is not read as `SOLUSD` + `T`.

`packages/experimental/trading/src/timeframe.ts`:

```ts
/**
 * Timeframe membership and intraday bucket lengths.
 *
 * @module @deepseek-ai/dsh-experimental-trading/timeframe
 */
import { TIMEFRAMES, type Timeframe } from './types.ts'

const INTRADAY_MS: ReadonlyMap<Timeframe, number> = new Map([
  ['1m', 60_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['1h', 3_600_000],
  ['4h', 14_400_000],
])

/**
 * Whether a string names a supported timeframe.
 * @param value - candidate timeframe text.
 * @returns true when `value` is one of {@link TIMEFRAMES}.
 */
export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value)
}

/**
 * Bucket length of an intraday timeframe. Daily and weekly buckets follow the market calendar, so the provider opens them.
 * @param timeframe - supported timeframe.
 * @returns bucket length in milliseconds, or undefined for `1D` and `1W`.
 */
export function intradayMs(timeframe: Timeframe): number | undefined {
  return INTRADAY_MS.get(timeframe)
}
```

`packages/experimental/trading/src/index.ts`:

```ts
/**
 * Browser-safe trading domain library: types, symbol parsing, indicators,
 * live-candle building, order validation, risk policy, and submission planning.
 * It performs no I/O and registers no services.
 *
 * @module @deepseek-ai/dsh-experimental-trading
 */
export * from './types.ts'
export * from './symbol.ts'
export * from './timeframe.ts'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading`
Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck and constraints**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run constraints && pnpm exec tsc -b packages/experimental/trading`
Expected: both pass. If `constraints` names a manifest field, fix the manifest to what it asks for and re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/experimental/trading tsconfig.base.json tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(trading): add trading domain types, symbol parsing, and timeframes"
```

---

### Task 3: Indicators

**Files:**
- Create: `packages/experimental/trading/src/indicators.ts`
- Modify: `packages/experimental/trading/src/index.ts` (add `export * from './indicators.ts'`)
- Test: `packages/experimental/trading/tests/indicators.spec.ts`

**Interfaces:**
- Produces: `IndicatorSeries` (= `(number | null)[]`, aligned to the input; `null` during warm-up), `sma(values, period)`, `ema(values, period)`, `rsi(closes, period = 14)`, `macd(closes, fast = 12, slow = 26, signal = 9): MacdSeries`, `bollinger(closes, period = 20, k = 2): BollingerSeries`. `MacdSeries = { macd, signal, histogram }`, `BollingerSeries = { middle, upper, lower }`, each an `IndicatorSeries`.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading/tests/indicators.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bollinger, ema, macd, rsi, sma, type IndicatorSeries } from '../src/indicators.ts'

/** Compare series to 9 decimal places; EMA arithmetic carries float noise. */
function expectSeries(actual: IndicatorSeries, expected: (number | null)[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((value, index) => {
    if (value === null) expect(actual[index]).toBeNull()
    else expect(actual[index]).toBeCloseTo(value, 9)
  })
}

describe('sma', () => {
  it('averages a trailing window and is null during warm-up', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it('rejects a non-positive or fractional period', () => {
    expect(() => sma([1], 0)).toThrow(new RangeError('period must be a positive integer, got 0'))
    expect(() => sma([1], 1.5)).toThrow(RangeError)
  })
})

describe('ema', () => {
  it('seeds with the simple average, then smooths with alpha 2/(n+1)', () => {
    expect(ema([2, 4, 6, 8, 12], 3)).toEqual([null, null, 4, 6, 9])
  })
})

describe('rsi', () => {
  it("uses Wilder's smoothing", () => {
    expect(rsi([1, 2, 1, 2, 3], 2)).toEqual([null, null, 50, 75, 87.5])
  })

  it('reads 100 with only gains, 50 with no movement, and handles empty input', () => {
    expect(rsi([1, 2, 3], 2)).toEqual([null, null, 100])
    expect(rsi([5, 5, 5], 2)).toEqual([null, null, 50])
    expect(rsi([], 14)).toEqual([])
  })
})

describe('macd', () => {
  it('is the fast EMA minus the slow EMA with an EMA signal line', () => {
    const result = macd([1, 2, 3, 4, 5, 6], 2, 3, 2)
    expectSeries(result.macd, [null, null, 0.5, 0.5, 0.5, 0.5])
    expectSeries(result.signal, [null, null, null, 0.5, 0.5, 0.5])
    expectSeries(result.histogram, [null, null, null, 0, 0, 0])
  })

  it('stays null when the series is shorter than the slow period', () => {
    expect(macd([1, 2], 2, 3, 2)).toEqual({ macd: [null, null], signal: [null, null], histogram: [null, null] })
  })

  it('requires the fast period to be shorter than the slow period', () => {
    expect(() => macd([1, 2, 3], 3, 3, 2)).toThrow(new RangeError('fast period 3 must be shorter than slow period 3'))
  })
})

describe('bollinger', () => {
  it('brackets the simple average by k population standard deviations', () => {
    const result = bollinger([1, 2, 3], 3, 2)
    expect(result.middle).toEqual([null, null, 2])
    expect(result.upper[0]).toBeNull()
    expect(result.lower[1]).toBeNull()
    expect(result.upper[2]).toBeCloseTo(3.632993, 6)
    expect(result.lower[2]).toBeCloseTo(0.367007, 6)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/indicators.spec.ts`
Expected: FAIL, cannot resolve `../src/indicators.ts`.

- [ ] **Step 3: Implement the indicators**

`packages/experimental/trading/src/indicators.ts`:

```ts
/**
 * Technical indicators shared by the `get_bars` tool and the chart, so both show identical values.
 * Every series is aligned to its input and holds `null` until enough values exist.
 *
 * @module @deepseek-ai/dsh-experimental-trading/indicators
 */

/** Indicator values aligned to the input series; `null` during warm-up. */
export type IndicatorSeries = (number | null)[]

/** MACD line, signal line, and histogram. */
export interface MacdSeries {
  /** Fast EMA minus slow EMA. */
  readonly macd: IndicatorSeries
  /** EMA of the MACD line. */
  readonly signal: IndicatorSeries
  /** MACD minus signal. */
  readonly histogram: IndicatorSeries
}

/** Bollinger middle band and the bands k standard deviations around it. */
export interface BollingerSeries {
  /** Simple moving average. */
  readonly middle: IndicatorSeries
  /** Middle plus k population standard deviations. */
  readonly upper: IndicatorSeries
  /** Middle minus k population standard deviations. */
  readonly lower: IndicatorSeries
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`period must be a positive integer, got ${period}`)
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function emaStepper(period: number): (value: number) => number | null {
  const alpha = 2 / (period + 1)
  const seed: number[] = []
  let previous: number | null = null
  return value => {
    if (previous === null) {
      seed.push(value)
      if (seed.length === period) previous = mean(seed)
      return previous
    }
    previous = value * alpha + previous * (1 - alpha)
    return previous
  }
}

/**
 * Simple moving average.
 * @param values - input series, oldest first.
 * @param period - window length.
 * @returns the aligned average series.
 */
export function sma(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period)
  return values.map((_, index) => index < period - 1 ? null : mean(values.slice(index - period + 1, index + 1)))
}

/**
 * Exponential moving average seeded with the simple average of the first `period` values.
 * @param values - input series, oldest first.
 * @param period - smoothing length; alpha is 2 / (period + 1).
 * @returns the aligned EMA series.
 */
export function ema(values: readonly number[], period: number): IndicatorSeries {
  assertPeriod(period)
  return values.map(emaStepper(period))
}

/**
 * Relative strength index with Wilder's smoothing. A window with no movement reads 50; one with only gains reads 100.
 * @param closes - closing prices, oldest first.
 * @param period - smoothing length, default 14.
 * @returns the aligned RSI series in [0, 100].
 */
export function rsi(closes: readonly number[], period = 14): IndicatorSeries {
  assertPeriod(period)
  const out: IndicatorSeries = []
  let previousClose: number | null = null
  let avgGain = 0
  let avgLoss = 0
  closes.forEach((close, index) => {
    if (previousClose === null) {
      previousClose = close
      out.push(null)
      return
    }
    const delta = close - previousClose
    previousClose = close
    const gain = Math.max(delta, 0)
    const loss = Math.max(-delta, 0)
    if (index <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (index < period) {
        out.push(null)
        return
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
    }
    if (avgLoss === 0) out.push(avgGain === 0 ? 50 : 100)
    else out.push(100 - 100 / (1 + avgGain / avgLoss))
  })
  return out
}

/**
 * Moving average convergence divergence.
 * @param closes - closing prices, oldest first.
 * @param fast - fast EMA length, default 12.
 * @param slow - slow EMA length, default 26; must exceed `fast`.
 * @param signal - signal EMA length, default 9.
 * @returns the aligned MACD, signal, and histogram series.
 */
export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9): MacdSeries {
  assertPeriod(fast)
  assertPeriod(slow)
  assertPeriod(signal)
  if (fast >= slow) throw new RangeError(`fast period ${fast} must be shorter than slow period ${slow}`)
  const fastStep = emaStepper(fast)
  const slowStep = emaStepper(slow)
  const signalStep = emaStepper(signal)
  const line: IndicatorSeries = []
  const signalLine: IndicatorSeries = []
  const histogram: IndicatorSeries = []
  for (const close of closes) {
    const fastValue = fastStep(close)
    const slowValue = slowStep(close)
    const macdValue = fastValue === null || slowValue === null ? null : fastValue - slowValue
    const signalValue = macdValue === null ? null : signalStep(macdValue)
    line.push(macdValue)
    signalLine.push(signalValue)
    histogram.push(macdValue === null || signalValue === null ? null : macdValue - signalValue)
  }
  return { macd: line, signal: signalLine, histogram }
}

/**
 * Bollinger bands over a simple moving average with population standard deviation.
 * @param closes - closing prices, oldest first.
 * @param period - window length, default 20.
 * @param k - band width in standard deviations, default 2.
 * @returns the aligned middle, upper, and lower series.
 */
export function bollinger(closes: readonly number[], period = 20, k = 2): BollingerSeries {
  assertPeriod(period)
  const middle: IndicatorSeries = []
  const upper: IndicatorSeries = []
  const lower: IndicatorSeries = []
  closes.forEach((_, index) => {
    if (index < period - 1) {
      middle.push(null)
      upper.push(null)
      lower.push(null)
      return
    }
    const window = closes.slice(index - period + 1, index + 1)
    const average = mean(window)
    const deviation = Math.sqrt(mean(window.map(value => (value - average) ** 2)))
    middle.push(average)
    upper.push(average + k * deviation)
    lower.push(average - k * deviation)
  })
  return { middle, upper, lower }
}
```

Add `export * from './indicators.ts'` to `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/indicators.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/trading
git commit -m "feat(trading): add SMA, EMA, RSI, MACD, and Bollinger indicators"
```

---

### Task 4: Live candle building

**Files:**
- Create: `packages/experimental/trading/src/candles.ts`
- Modify: `packages/experimental/trading/src/index.ts` (add `export * from './candles.ts'`)
- Test: `packages/experimental/trading/tests/candles.spec.ts`

**Interfaces:**
- Consumes: `Bar`, `Trade`, `Timeframe` (Task 2), `intradayMs` (Task 2).
- Produces: `CandleUpdate = { kind: 'update' | 'new'; bar: Bar }`, `bucketStart(t: number, timeframe: Timeframe): number`, `applyTrade(last: Bar | undefined, trade: Trade, timeframe: Timeframe): CandleUpdate | undefined`. Plan 4's `streamBars` folds each trade with `applyTrade` and emits the update; `undefined` means "drop this trade".

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading/tests/candles.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyTrade, bucketStart } from '../src/candles.ts'
import type { Bar } from '../src/types.ts'

const FIVE_MIN = 300_000
const bar: Bar = { t: 10 * FIVE_MIN, o: 100, h: 101, l: 99, c: 100.5, v: 3 }

describe('bucketStart', () => {
  it('floors to the UTC-aligned intraday bucket', () => {
    expect(bucketStart(10 * FIVE_MIN + 123_456, '5m')).toBe(10 * FIVE_MIN)
  })

  it('refuses daily and weekly buckets, which the provider opens', () => {
    expect(() => bucketStart(0, '1D')).toThrow(new RangeError('1D candles are opened by the provider, not by trade aggregation'))
  })
})

describe('applyTrade, intraday', () => {
  it('opens the first candle from a trade', () => {
    expect(applyTrade(undefined, { t: 10 * FIVE_MIN + 5, price: 100, size: 2 }, '5m')).toEqual({
      kind: 'new', bar: { t: 10 * FIVE_MIN, o: 100, h: 100, l: 100, c: 100, v: 2 },
    })
  })

  it('folds a trade inside the current bucket', () => {
    expect(applyTrade(bar, { t: 10 * FIVE_MIN + 60_000, price: 102, size: 1 }, '5m')).toEqual({
      kind: 'update', bar: { t: 10 * FIVE_MIN, o: 100, h: 102, l: 99, c: 102, v: 4 },
    })
    expect(applyTrade(bar, { t: 10 * FIVE_MIN + 60_000, price: 98, size: 1 }, '5m')?.bar.l).toBe(98)
  })

  it('opens a new candle when a trade crosses the bucket boundary', () => {
    expect(applyTrade(bar, { t: 11 * FIVE_MIN, price: 103, size: 1 }, '5m')).toEqual({
      kind: 'new', bar: { t: 11 * FIVE_MIN, o: 103, h: 103, l: 103, c: 103, v: 1 },
    })
  })

  it('drops a late trade from an earlier bucket', () => {
    expect(applyTrade(bar, { t: 9 * FIVE_MIN + 1, price: 50, size: 9 }, '5m')).toBeUndefined()
  })
})

describe('applyTrade, daily and weekly', () => {
  const day: Bar = { t: 1_000_000, o: 10, h: 11, l: 9, c: 10, v: 5 }

  it('updates the provider-opened candle', () => {
    expect(applyTrade(day, { t: 1_000_500, price: 12, size: 1 }, '1D')).toEqual({
      kind: 'update', bar: { t: 1_000_000, o: 10, h: 12, l: 9, c: 12, v: 6 },
    })
  })

  it('needs a provider candle and ignores trades before it', () => {
    expect(applyTrade(undefined, { t: 1, price: 12, size: 1 }, '1W')).toBeUndefined()
    expect(applyTrade(day, { t: 999_999, price: 12, size: 1 }, '1D')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/candles.spec.ts`
Expected: FAIL, cannot resolve `../src/candles.ts`.

- [ ] **Step 3: Implement**

`packages/experimental/trading/src/candles.ts`:

```ts
/**
 * Folding live trades into the forming candle of a chart timeframe.
 * Intraday buckets are UTC-aligned; daily and weekly candles follow the market
 * calendar, so the provider opens them and trades only update the latest one.
 *
 * @module @deepseek-ai/dsh-experimental-trading/candles
 */
import { intradayMs } from './timeframe.ts'
import type { Bar, Timeframe, Trade } from './types.ts'

/** Result of folding one trade: the forming candle changed (`update`) or a new one opened (`new`). */
export interface CandleUpdate {
  /** Whether the latest candle changed or a new candle opened. */
  readonly kind: 'update' | 'new'
  /** The candle after the trade. */
  readonly bar: Bar
}

/**
 * Start of the intraday bucket containing `t`.
 * @param t - time in UTC epoch milliseconds.
 * @param timeframe - intraday timeframe.
 * @returns the bucket start in UTC epoch milliseconds.
 * @throws RangeError for `1D` and `1W`.
 */
export function bucketStart(t: number, timeframe: Timeframe): number {
  const length = intradayMs(timeframe)
  if (length === undefined) throw new RangeError(`${timeframe} candles are opened by the provider, not by trade aggregation`)
  return Math.floor(t / length) * length
}

function fold(bar: Bar, trade: Trade): Bar {
  return { t: bar.t, o: bar.o, h: Math.max(bar.h, trade.price), l: Math.min(bar.l, trade.price), c: trade.price, v: bar.v + trade.size }
}

/**
 * Fold one trade into the latest candle.
 * @param last - latest candle, or undefined before any history loaded.
 * @param trade - trade print from the stream.
 * @param timeframe - chart timeframe.
 * @returns the changed or new candle, or undefined when the trade belongs to an earlier bucket (or, for `1D`/`1W`, when no provider candle covers it).
 */
export function applyTrade(last: Bar | undefined, trade: Trade, timeframe: Timeframe): CandleUpdate | undefined {
  if (intradayMs(timeframe) === undefined) {
    if (last === undefined || trade.t < last.t) return undefined
    return { kind: 'update', bar: fold(last, trade) }
  }
  const start = bucketStart(trade.t, timeframe)
  if (last === undefined || start > last.t) {
    return { kind: 'new', bar: { t: start, o: trade.price, h: trade.price, l: trade.price, c: trade.price, v: trade.size } }
  }
  if (start === last.t) return { kind: 'update', bar: fold(last, trade) }
  return undefined
}
```

Add `export * from './candles.ts'` to `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/candles.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/trading
git commit -m "feat(trading): fold live trades into forming candles"
```

---

### Task 5: Order validation (Alpaca rules)

**Files:**
- Create: `packages/experimental/trading/src/validation.ts`
- Modify: `packages/experimental/trading/src/index.ts` (add `export * from './validation.ts'`)
- Test: `packages/experimental/trading/tests/validation.spec.ts`

**Interfaces:**
- Consumes: `OrderRequest`, `Asset` (Task 2).
- Produces: `OrderViolationCode`, `OrderViolation = { code, message }`, `validateOrder(order: OrderRequest, asset: Asset): OrderViolation[]` (empty array = valid). Plan 3's executor runs it as step 1 and returns the messages to the model.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading/tests/validation.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Asset, OrderRequest } from '../src/types.ts'
import { validateOrder } from '../src/validation.ts'

const btc: Asset = { symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, tradable: true, fractionable: true, minOrderSize: 0.0001, priceIncrement: 0.01 }
const aapl: Asset = { symbol: { assetClass: 'equity', ticker: 'AAPL' }, tradable: true, fractionable: true, priceIncrement: 0.01 }
const cryptoBuy: OrderRequest = { symbol: btc.symbol, side: 'buy', qty: 0.015, type: 'market', timeInForce: 'gtc' }
const equityBuy: OrderRequest = { symbol: aapl.symbol, side: 'buy', qty: 2, type: 'market', timeInForce: 'day' }
const codes = (order: OrderRequest, asset: Asset): string[] => validateOrder(order, asset).map(v => v.code)

describe('validateOrder', () => {
  it('accepts well-formed crypto and equity orders', () => {
    expect(validateOrder(cryptoBuy, btc)).toEqual([])
    expect(validateOrder(equityBuy, aapl)).toEqual([])
    expect(validateOrder({ ...equityBuy, type: 'stop_limit', limitPrice: 230, stopPrice: 229, timeInForce: 'gtc' }, aapl)).toEqual([])
  })

  it('rejects a mismatched or untradable asset', () => {
    expect(codes(cryptoBuy, aapl)).toContain('symbol-mismatch')
    expect(codes(cryptoBuy, { ...btc, tradable: false })).toEqual(['not-tradable'])
  })

  it('needs exactly one positive, finite size', () => {
    expect(codes({ symbol: btc.symbol, side: 'buy', type: 'market', timeInForce: 'gtc' }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, notional: 100 }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, qty: 0 }, btc)).toEqual(['size', 'below-minimum'])
    expect(codes({ ...cryptoBuy, qty: Number.NaN }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, qty: Number.POSITIVE_INFINITY }, btc)).toEqual(['size'])
    expect(codes({ ...cryptoBuy, qty: -1 }, btc)).toEqual(['size', 'below-minimum'])
  })

  it('enforces the broker minimum size', () => {
    expect(validateOrder({ ...cryptoBuy, qty: 0.00001 }, btc)).toEqual([
      { code: 'below-minimum', message: 'minimum order size for BTC/USD is 0.0001' },
    ])
  })

  it('matches price fields to the order type', () => {
    expect(codes({ ...cryptoBuy, type: 'limit' }, btc)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, limitPrice: 1 }, btc)).toEqual(['price-fields'])
    expect(codes({ ...equityBuy, type: 'stop', timeInForce: 'gtc' }, aapl)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, stopPrice: 1 }, btc)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, type: 'limit', limitPrice: Number.NaN }, btc)).toEqual(['price-fields'])
    expect(codes({ ...cryptoBuy, type: 'stop_limit', limitPrice: 1, stopPrice: -1 }, btc)).toEqual(['price-fields'])
  })

  it('allows notional only on market orders', () => {
    expect(codes({ symbol: btc.symbol, side: 'buy', notional: 500, type: 'limit', limitPrice: 60_000, timeInForce: 'gtc' }, btc)).toEqual(['notional-type'])
  })

  it('applies crypto order-type, time-in-force, and bracket rules', () => {
    expect(codes({ ...cryptoBuy, type: 'stop', stopPrice: 60_000 }, btc)).toEqual(['order-type'])
    expect(codes({ ...cryptoBuy, timeInForce: 'day' }, btc)).toEqual(['time-in-force'])
    expect(codes({ ...cryptoBuy, timeInForce: 'ioc' }, btc)).toEqual([])
    expect(codes({ ...cryptoBuy, bracket: { takeProfit: 70_000, stopLoss: 60_000 } }, btc)).toEqual(['bracket'])
  })

  it('limits fractional and notional equity orders to fractionable assets and day orders', () => {
    expect(codes({ ...equityBuy, qty: 0.5 }, { ...aapl, fractionable: false })).toEqual(['fractional'])
    expect(codes({ ...equityBuy, qty: 0.5, timeInForce: 'gtc' }, aapl)).toEqual(['fractional'])
    expect(codes({ symbol: aapl.symbol, side: 'buy', notional: 100, type: 'market', timeInForce: 'gtc' }, aapl)).toEqual(['fractional'])
    expect(codes({ ...equityBuy, timeInForce: 'gtc' }, aapl)).toEqual([])
  })

  it('needs whole shares and ordered legs for equity brackets', () => {
    expect(codes({ ...equityBuy, bracket: { takeProfit: 250, stopLoss: 220 } }, aapl)).toEqual([])
    expect(codes({ ...equityBuy, side: 'sell', bracket: { takeProfit: 220, stopLoss: 250 } }, aapl)).toEqual([])
    expect(validateOrder({ ...equityBuy, bracket: { takeProfit: 220, stopLoss: 250 } }, aapl)).toEqual([
      { code: 'bracket', message: 'take_profit must be above stop_loss for a buy' },
    ])
    expect(validateOrder({ ...equityBuy, side: 'sell', bracket: { takeProfit: 250, stopLoss: 220 } }, aapl)).toEqual([
      { code: 'bracket', message: 'take_profit must be below stop_loss for a sell' },
    ])
    expect(codes({ ...equityBuy, qty: 1.5, bracket: { takeProfit: 250, stopLoss: 220 } }, aapl)).toEqual(['bracket'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/validation.spec.ts`
Expected: FAIL, cannot resolve `../src/validation.ts`.

- [ ] **Step 3: Implement**

`packages/experimental/trading/src/validation.ts`:

```ts
/**
 * Static order validation against Alpaca's order rules. Position- and
 * account-dependent rules live in the risk policy.
 *
 * @module @deepseek-ai/dsh-experimental-trading/validation
 */
import type { Asset, OrderRequest } from './types.ts'

/** Which rule an order broke. */
export type OrderViolationCode =
  | 'symbol-mismatch'
  | 'not-tradable'
  | 'size'
  | 'below-minimum'
  | 'price-fields'
  | 'notional-type'
  | 'order-type'
  | 'time-in-force'
  | 'fractional'
  | 'bracket'

/** One broken rule with a message the model and the user can read. */
export interface OrderViolation {
  /** Broken rule. */
  readonly code: OrderViolationCode
  /** Readable reason. */
  readonly message: string
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * Check an order against the broker's static rules.
 * @param order - order as proposed.
 * @param asset - broker facts for the order's instrument.
 * @returns every broken rule; an empty array means the order is valid.
 */
export function validateOrder(order: OrderRequest, asset: Asset): OrderViolation[] {
  const violations: OrderViolation[] = []
  const add = (code: OrderViolationCode, message: string): void => {
    violations.push({ code, message })
  }
  const ticker = order.symbol.ticker
  if (asset.symbol.ticker !== ticker) add('symbol-mismatch', `asset ${asset.symbol.ticker} does not describe ${ticker}`)
  if (!asset.tradable) add('not-tradable', `${ticker} is not tradable now`)

  const sizes = [order.qty, order.notional].filter(value => value !== undefined)
  if (sizes.length !== 1) add('size', 'give exactly one of qty or notional')
  else if (!sizes.every(positiveFinite)) add('size', 'size must be a finite number greater than zero')
  if (order.qty !== undefined && asset.minOrderSize !== undefined && order.qty < asset.minOrderSize) {
    add('below-minimum', `minimum order size for ${ticker} is ${asset.minOrderSize}`)
  }

  const needsLimit = order.type === 'limit' || order.type === 'stop_limit'
  const needsStop = order.type === 'stop' || order.type === 'stop_limit'
  if (needsLimit !== (order.limitPrice !== undefined)) add('price-fields', needsLimit ? `${order.type} orders need limit_price` : `${order.type} orders take no limit_price`)
  if (needsStop !== (order.stopPrice !== undefined)) add('price-fields', needsStop ? `${order.type} orders need stop_price` : `${order.type} orders take no stop_price`)
  const prices = [order.limitPrice, order.stopPrice].filter(value => value !== undefined)
  if (!prices.every(positiveFinite)) add('price-fields', 'prices must be finite numbers greater than zero')
  if (order.notional !== undefined && order.type !== 'market') add('notional-type', 'notional orders must be market orders')

  if (order.symbol.assetClass === 'crypto') {
    if (order.type === 'stop') add('order-type', 'crypto orders support market, limit, and stop_limit; use stop_limit instead of stop')
    if (order.timeInForce === 'day') add('time-in-force', 'crypto orders use gtc or ioc')
    if (order.bracket !== undefined) add('bracket', 'brackets are available for equities only')
    return violations
  }

  const fractional = order.notional !== undefined || (order.qty !== undefined && !Number.isInteger(order.qty))
  if (fractional) {
    if (!asset.fractionable) add('fractional', `${ticker} does not support fractional or notional orders`)
    else if (order.timeInForce !== 'day') add('fractional', 'fractional and notional equity orders are day orders')
  }
  if (order.bracket !== undefined) {
    if (fractional) add('bracket', 'brackets need a whole-share quantity')
    const { takeProfit, stopLoss } = order.bracket
    if (order.side === 'buy' && takeProfit <= stopLoss) add('bracket', 'take_profit must be above stop_loss for a buy')
    if (order.side === 'sell' && takeProfit >= stopLoss) add('bracket', 'take_profit must be below stop_loss for a sell')
  }
  return violations
}
```

Note on the test `{ ...equityBuy, qty: 0.5 }` with `fractionable: false`: only `fractional` is reported because the `else if` reports the day-only rule only for fractionable assets.

Add `export * from './validation.ts'` to `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/validation.spec.ts`
Expected: PASS, 9 tests. If an expectation's code list differs only in order, fix the test to the order the implementation reports (size and price rules are checked before asset-class rules) and confirm the reason is still correct.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/trading
git commit -m "feat(trading): validate orders against Alpaca order rules"
```

---

### Task 6: Risk policy

**Files:**
- Create: `packages/experimental/trading/src/risk.ts`
- Modify: `packages/experimental/trading/src/index.ts` (add `export * from './risk.ts'`)
- Test: `packages/experimental/trading/tests/risk.spec.ts`

**Interfaces:**
- Consumes: `OrderRequest`, `Quote` (Task 2).
- Produces:
  - `RiskLimits = { maxOrderNotional, maxPositionPct, dailyLossPct, maxOrdersPerDay, allowShort, allowMargin, allowlist, denylist, staleQuoteMs }` (Plan 3 builds it from `tool-trading` `Config`).
  - `SymbolExposure = { positionQty, openBuyQty, openSellQty, pendingBuyQty, pendingSellQty }` (signed `positionQty`; pending = reserved by proposals awaiting approval).
  - `RiskSnapshot = { now, quote, marketOpen, equity, cash, lastEquity, committedBuyNotional, exposure, ordersToday, halted }` (`committedBuyNotional` = open buy orders plus pending buy proposals across all symbols; `ordersToday` includes pending proposals).
  - `RiskCheckId`, `RiskCheck = { id, ok, detail }`, `RiskResult = { ok, reduceOnly, quantity, referencePrice, estimatedNotional, checks }`.
  - `checkRisk(order: OrderRequest, snapshot: RiskSnapshot, limits: RiskLimits): RiskResult`.
  - `isReduceOnly(side: Side, quantity: number, exposure: SymbolExposure): boolean`.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading/tests/risk.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { checkRisk, isReduceOnly, type RiskLimits, type RiskSnapshot, type SymbolExposure } from '../src/risk.ts'
import type { OrderRequest } from '../src/types.ts'

const limits: RiskLimits = {
  maxOrderNotional: 1_000, maxPositionPct: 0.2, dailyLossPct: 0.03, maxOrdersPerDay: 20,
  allowShort: false, allowMargin: false, allowlist: [], denylist: [], staleQuoteMs: 30_000,
}
const flat: SymbolExposure = { positionQty: 0, openBuyQty: 0, openSellQty: 0, pendingBuyQty: 0, pendingSellQty: 0 }
const snapshot: RiskSnapshot = {
  now: 1_000_000, quote: { bid: 62_818, ask: 62_832, t: 998_000 }, marketOpen: true,
  equity: 100_000, cash: 60_000, lastEquity: 100_000, committedBuyNotional: 0,
  exposure: flat, ordersToday: 3, halted: false,
}
const buy: OrderRequest = { symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market', timeInForce: 'gtc' }
const failed = (order: OrderRequest, snap: RiskSnapshot = snapshot, lim: RiskLimits = limits): string[] =>
  checkRisk(order, snap, lim).checks.filter(c => !c.ok).map(c => c.id)

describe('checkRisk, exposure-increasing orders', () => {
  it('passes a small market buy and reports every check', () => {
    const result = checkRisk(buy, snapshot, limits)
    expect(result.ok).toBe(true)
    expect(result.reduceOnly).toBe(false)
    expect(result.referencePrice).toBe(62_832)
    expect(result.estimatedNotional).toBeCloseTo(942.48, 2)
    expect(result.checks.map(c => c.id)).toEqual([
      'halted', 'symbol-list', 'stale-quote', 'stop-type', 'shorting', 'order-notional', 'position-size', 'cash', 'daily-loss', 'orders-per-day',
    ])
    expect(result.checks.find(c => c.id === 'order-notional')?.detail).toBe('order $942.48 vs max $1,000.00')
  })

  it('caps order notional, position size, and cash', () => {
    expect(failed({ ...buy, qty: 0.05 })).toEqual(['order-notional'])
    expect(failed(buy, { ...snapshot, exposure: { ...flat, positionQty: 0.31 } })).toEqual(['position-size'])
    expect(failed(buy, { ...snapshot, committedBuyNotional: 59_500 })).toEqual(['cash'])
    expect(failed(buy, { ...snapshot, committedBuyNotional: 59_500 }, { ...limits, allowMargin: true })).toEqual([])
  })

  it('counts open orders and pending proposals toward the position cap', () => {
    expect(failed(buy, { ...snapshot, exposure: { ...flat, positionQty: 0.2, openBuyQty: 0.05, pendingBuyQty: 0.06 } })).toEqual(['position-size'])
  })

  it('uses the limit price for limit orders and the notional for notional orders', () => {
    expect(checkRisk({ ...buy, type: 'limit', limitPrice: 60_000 }, snapshot, limits).estimatedNotional).toBe(900)
    const notional = checkRisk({ symbol: buy.symbol, side: 'buy', notional: 500, type: 'market', timeInForce: 'gtc' }, snapshot, limits)
    expect(notional.estimatedNotional).toBe(500)
    expect(notional.quantity).toBeCloseTo(500 / 62_832, 10)
  })

  it('blocks exposure once the daily loss limit is hit', () => {
    expect(failed(buy, { ...snapshot, equity: 97_000, lastEquity: 100_000 })).toEqual(['daily-loss'])
    expect(failed(buy, { ...snapshot, equity: 97_001, lastEquity: 100_000 })).toEqual([])
  })

  it('caps orders per day, counting pending proposals', () => {
    expect(failed(buy, { ...snapshot, ordersToday: 20 })).toEqual(['orders-per-day'])
  })

  it('applies the allowlist and denylist', () => {
    expect(failed(buy, snapshot, { ...limits, allowlist: ['ETH/USD'] })).toEqual(['symbol-list'])
    expect(failed(buy, snapshot, { ...limits, allowlist: ['BTC/USD'], denylist: ['BTC/USD'] })).toEqual(['symbol-list'])
    expect(checkRisk(buy, snapshot, { ...limits, denylist: ['BTC/USD'] }).checks[1]?.detail).toBe('BTC/USD is on the denylist')
    expect(checkRisk(buy, snapshot, { ...limits, allowlist: ['ETH/USD'] }).checks[1]?.detail).toBe('BTC/USD is not on the allowlist')
  })

  it('refuses market orders on a stale quote only while the market is open', () => {
    const stale = { ...snapshot, quote: { ...snapshot.quote, t: 900_000 } }
    expect(failed(buy, stale)).toEqual(['stale-quote'])
    expect(failed(buy, { ...stale, marketOpen: false })).toEqual([])
    expect(failed({ ...buy, type: 'limit', limitPrice: 62_000 }, stale)).toEqual([])
  })

  it('requires stop_limit for stops that add exposure', () => {
    expect(failed({ ...buy, type: 'stop', stopPrice: 63_000 })).toEqual(['stop-type'])
  })

  it('treats a sell beyond the long position as a short sale', () => {
    expect(failed({ ...buy, side: 'sell' })).toEqual(['shorting'])
    expect(failed({ ...buy, side: 'sell' }, snapshot, { ...limits, allowShort: true })).toEqual([])
  })

  it('denies everything while halted', () => {
    expect(failed(buy, { ...snapshot, halted: true })).toEqual(['halted'])
  })
})

describe('checkRisk, reduce-only exits', () => {
  const long = { ...snapshot, exposure: { ...flat, positionQty: 0.015 } }
  const exit: OrderRequest = { ...buy, side: 'sell', qty: 0.015 }

  it('bypasses the limits but still honors halt', () => {
    const result = checkRisk(exit, { ...long, ordersToday: 99, equity: 50_000 }, limits)
    expect(result.ok).toBe(true)
    expect(result.reduceOnly).toBe(true)
    expect(result.checks.map(c => c.id)).toEqual(['halted'])
    expect(checkRisk(exit, { ...long, halted: true }, limits).ok).toBe(false)
  })

  it('allows a plain stop only as an exit', () => {
    expect(checkRisk({ ...exit, type: 'stop', stopPrice: 60_000 }, long, limits).ok).toBe(true)
  })

  it('nets the position against open and pending sells, so an exit cannot oversell', () => {
    const covered = { ...long, exposure: { ...long.exposure, openSellQty: 0.01 } }
    expect(checkRisk(exit, covered, limits).reduceOnly).toBe(false)
    expect(failed(exit, covered)).toEqual(['shorting'])
  })
})

describe('checkRisk, bad inputs', () => {
  it('fails a quote check instead of computing with a zero price', () => {
    const result = checkRisk({ ...buy, side: 'sell' }, { ...snapshot, quote: { bid: 0, ask: 62_832, t: 998_000 } }, limits)
    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([{ id: 'quote', ok: false, detail: 'no usable sell price for BTC/USD' }])
    expect(result.estimatedNotional).toBe(0)
  })

  it('reads an empty account without dividing by zero', () => {
    const empty = { ...snapshot, equity: 0, cash: 0, lastEquity: 0 }
    const result = checkRisk(buy, empty, limits)
    expect(result.checks.find(c => c.id === 'position-size')).toEqual({ id: 'position-size', ok: false, detail: 'account equity is $0.00' })
    expect(result.checks.find(c => c.id === 'daily-loss')).toEqual({ id: 'daily-loss', ok: true, detail: 'day P&L 0.0% vs limit -3.0%' })
  })
})

describe('isReduceOnly', () => {
  it('recognizes covering a short position', () => {
    expect(isReduceOnly('buy', 1, { ...flat, positionQty: -2, openBuyQty: 0.5 })).toBe(true)
    expect(isReduceOnly('buy', 2, { ...flat, positionQty: -2, pendingBuyQty: 0.5 })).toBe(false)
    expect(isReduceOnly('buy', 1, flat)).toBe(false)
    expect(isReduceOnly('sell', 1, flat)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/risk.spec.ts`
Expected: FAIL, cannot resolve `../src/risk.ts`.

- [ ] **Step 3: Implement**

`packages/experimental/trading/src/risk.ts`:

```ts
/**
 * Account- and position-dependent order limits. The executor runs this before
 * asking the user and again after approval; a failed check denies the order
 * without asking. Orders that only reduce an existing position bypass every
 * limit except halt.
 *
 * @module @deepseek-ai/dsh-experimental-trading/risk
 */
import type { OrderRequest, Quote, Side } from './types.ts'

/** User-configured limits; percentages are fractions (`0.2` = 20%). */
export interface RiskLimits {
  /** Largest estimated order value in dollars. */
  readonly maxOrderNotional: number
  /** Largest position value as a fraction of equity, counting open orders and pending proposals. */
  readonly maxPositionPct: number
  /** Day loss, as a fraction of `lastEquity`, at which exposure-increasing orders stop. */
  readonly dailyLossPct: number
  /** Orders per day, counting pending proposals. */
  readonly maxOrdersPerDay: number
  /** Whether sells may open or extend a short position. */
  readonly allowShort: boolean
  /** Whether buys may exceed cash. */
  readonly allowMargin: boolean
  /** Tickers allowed; empty allows every ticker. */
  readonly allowlist: readonly string[]
  /** Tickers never allowed. */
  readonly denylist: readonly string[]
  /** Quote age above which market orders are refused while the market is open. */
  readonly staleQuoteMs: number
}

/** Holdings and in-flight quantities for the order's instrument. */
export interface SymbolExposure {
  /** Signed position quantity; negative is short. */
  readonly positionQty: number
  /** Quantity on open buy orders at the broker. */
  readonly openBuyQty: number
  /** Quantity on open sell orders at the broker. */
  readonly openSellQty: number
  /** Quantity reserved by buy proposals awaiting approval. */
  readonly pendingBuyQty: number
  /** Quantity reserved by sell proposals awaiting approval. */
  readonly pendingSellQty: number
}

/** Account state at check time. */
export interface RiskSnapshot {
  /** Check time, UTC epoch milliseconds. */
  readonly now: number
  /** Latest quote for the order's instrument. */
  readonly quote: Quote
  /** Whether the instrument's market is open (always true for crypto). */
  readonly marketOpen: boolean
  /** Current account equity. */
  readonly equity: number
  /** Cash available for buys. */
  readonly cash: number
  /** Equity at the previous close. */
  readonly lastEquity: number
  /** Value of open buy orders plus pending buy proposals, all instruments. */
  readonly committedBuyNotional: number
  /** Holdings and in-flight quantities for this instrument. */
  readonly exposure: SymbolExposure
  /** Orders submitted today plus pending proposals. */
  readonly ordersToday: number
  /** Whether trading is halted. */
  readonly halted: boolean
}

/** Identifier of one check; `quote` appears alone when no usable price exists. */
export type RiskCheckId =
  | 'quote'
  | 'halted'
  | 'symbol-list'
  | 'stale-quote'
  | 'stop-type'
  | 'shorting'
  | 'order-notional'
  | 'position-size'
  | 'cash'
  | 'daily-loss'
  | 'orders-per-day'

/** One check result as shown on the approval card. */
export interface RiskCheck {
  /** Which check. */
  readonly id: RiskCheckId
  /** Whether it passed. */
  readonly ok: boolean
  /** Readable values behind the result. */
  readonly detail: string
}

/** Outcome of {@link checkRisk}. */
export interface RiskResult {
  /** Whether every check passed. */
  readonly ok: boolean
  /** Whether the order only reduces an existing position. */
  readonly reduceOnly: boolean
  /** Order quantity; derived from the notional for notional orders. */
  readonly quantity: number
  /** Price used for estimates: limit, then stop, then ask (buy) or bid (sell). */
  readonly referencePrice: number
  /** Estimated order value in dollars. */
  readonly estimatedNotional: number
  /** Checks in display order. */
  readonly checks: readonly RiskCheck[]
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

/**
 * Whether an order only reduces an existing position, net of open orders and pending proposals on the same side.
 * @param side - order direction.
 * @param quantity - order quantity.
 * @param exposure - holdings and in-flight quantities.
 * @returns true when the order cannot open or extend a position.
 */
export function isReduceOnly(side: Side, quantity: number, exposure: SymbolExposure): boolean {
  if (side === 'sell') return exposure.positionQty > 0 && quantity <= exposure.positionQty - exposure.openSellQty - exposure.pendingSellQty
  return exposure.positionQty < 0 && quantity <= -exposure.positionQty - exposure.openBuyQty - exposure.pendingBuyQty
}

function referencePrice(order: OrderRequest, quote: Quote): number {
  if (order.limitPrice !== undefined) return order.limitPrice
  if (order.stopPrice !== undefined) return order.stopPrice
  return order.side === 'buy' ? quote.ask : quote.bid
}

/**
 * Check an order against the limits.
 * @param order - validated order.
 * @param snapshot - account state at check time.
 * @param limits - configured limits.
 * @returns the decision, the estimates behind it, and every check in display order.
 */
export function checkRisk(order: OrderRequest, snapshot: RiskSnapshot, limits: RiskLimits): RiskResult {
  const ticker = order.symbol.ticker
  const price = referencePrice(order, snapshot.quote)
  if (!(Number.isFinite(price) && price > 0)) {
    return { ok: false, reduceOnly: false, quantity: 0, referencePrice: 0, estimatedNotional: 0, checks: [{ id: 'quote', ok: false, detail: `no usable ${order.side} price for ${ticker}` }] }
  }
  const quantity = order.notional === undefined ? order.qty ?? 0 : order.notional / price
  const estimatedNotional = order.notional === undefined ? quantity * price : order.notional
  const reduceOnly = isReduceOnly(order.side, quantity, snapshot.exposure)
  const checks: RiskCheck[] = []
  const add = (id: RiskCheckId, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail })
  }

  add('halted', !snapshot.halted, snapshot.halted ? 'trading is halted' : 'trading is not halted')
  if (!reduceOnly) {
    const denied = limits.denylist.includes(ticker)
    const listed = limits.allowlist.length === 0 || limits.allowlist.includes(ticker)
    add('symbol-list', listed && !denied, denied ? `${ticker} is on the denylist` : listed ? `${ticker} is allowed` : `${ticker} is not on the allowlist`)

    const age = snapshot.now - snapshot.quote.t
    const stale = order.type === 'market' && snapshot.marketOpen && age > limits.staleQuoteMs
    add('stale-quote', !stale, `quote is ${Math.round(age / 1000)} s old`)

    add('stop-type', order.type !== 'stop', order.type === 'stop' ? 'orders that add exposure must use stop_limit' : `${order.type} order`)

    const shortSale = order.side === 'sell'
    add('shorting', !shortSale || limits.allowShort, shortSale ? 'this sell would open or extend a short position' : 'not a short sale')

    add('order-notional', estimatedNotional <= limits.maxOrderNotional, `order ${USD.format(estimatedNotional)} vs max ${USD.format(limits.maxOrderNotional)}`)

    const exposure = snapshot.exposure
    const projected = order.side === 'buy'
      ? exposure.positionQty + exposure.openBuyQty + exposure.pendingBuyQty + quantity
      : exposure.positionQty - exposure.openSellQty - exposure.pendingSellQty - quantity
    if (snapshot.equity > 0) {
      const share = Math.abs(projected) * price / snapshot.equity
      add('position-size', share <= limits.maxPositionPct, `position ${percent(share)} of equity vs max ${percent(limits.maxPositionPct)}`)
    } else {
      add('position-size', false, `account equity is ${USD.format(snapshot.equity)}`)
    }

    const cashNeeded = order.side === 'buy' ? snapshot.committedBuyNotional + estimatedNotional : 0
    add('cash', limits.allowMargin || cashNeeded <= snapshot.cash, `needs ${USD.format(cashNeeded)} of ${USD.format(snapshot.cash)} cash`)

    const dayChange = snapshot.lastEquity > 0 ? (snapshot.equity - snapshot.lastEquity) / snapshot.lastEquity : 0
    add('daily-loss', dayChange > -limits.dailyLossPct, `day P&L ${percent(dayChange)} vs limit -${percent(limits.dailyLossPct)}`)

    add('orders-per-day', snapshot.ordersToday < limits.maxOrdersPerDay, `${snapshot.ordersToday} of ${limits.maxOrdersPerDay} orders today`)
  }
  return { ok: checks.every(check => check.ok), reduceOnly, quantity, referencePrice: price, estimatedNotional, checks }
}
```

`order.qty ?? 0` reaches its fallback only for an order with neither size, which validation rejects first; if per-file branch coverage flags it, add this test to `risk.spec.ts`:

```ts
it('treats a sizeless order as zero quantity', () => {
  expect(checkRisk({ symbol: buy.symbol, side: 'buy', type: 'market', timeInForce: 'gtc' }, snapshot, limits).quantity).toBe(0)
})
```

Add `export * from './risk.ts'` to `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/risk.spec.ts`
Expected: PASS, 17 tests (18 with the sizeless test).

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/trading
git commit -m "feat(trading): add the risk policy with reservations and reduce-only netting"
```

---

### Task 7: Submission planning (price caps)

**Files:**
- Create: `packages/experimental/trading/src/submission.ts`
- Modify: `packages/experimental/trading/src/index.ts` (add `export * from './submission.ts'`)
- Test: `packages/experimental/trading/tests/submission.spec.ts`

**Interfaces:**
- Consumes: `OrderRequest`, `OrderType`, `TimeInForce` (Task 2); `RiskResult.reduceOnly` and `RiskResult.referencePrice` (Task 6) as inputs.
- Produces: `SubmissionPlan = { type, limitPrice?, stopPrice?, timeInForce, capped }`, `planSubmission(order: OrderRequest, approvedPrice: number, tolerance: number, reduceOnly: boolean, priceIncrement: number): SubmissionPlan`. Plan 3's executor sends the plan's type, prices, and time in force to the broker and shows `capped`/`limitPrice` on the card.

- [ ] **Step 1: Write the failing tests**

`packages/experimental/trading/tests/submission.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planSubmission } from '../src/submission.ts'
import type { OrderRequest } from '../src/types.ts'

const btcBuy: OrderRequest = { symbol: { assetClass: 'crypto', ticker: 'BTC/USD' }, side: 'buy', qty: 0.015, type: 'market', timeInForce: 'gtc' }
const ethSell: OrderRequest = { symbol: { assetClass: 'crypto', ticker: 'ETH/USD' }, side: 'sell', qty: 0.25, type: 'market', timeInForce: 'gtc' }
const aaplBuy: OrderRequest = { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', qty: 3, type: 'market', timeInForce: 'gtc' }

describe('planSubmission', () => {
  it('caps an exposure-adding market buy above the approved price, rounded down to the tick', () => {
    expect(planSubmission(btcBuy, 62_832, 0.01, false, 0.01)).toEqual({ type: 'limit', limitPrice: 63_460.32, timeInForce: 'ioc', capped: true })
  })

  it('caps an exposure-adding market sell below the approved price, rounded up to the tick', () => {
    expect(planSubmission(ethSell, 3_401.6, 0.01, false, 0.01)).toEqual({ type: 'limit', limitPrice: 3_367.59, timeInForce: 'ioc', capped: true })
  })

  it('sends capped equity orders as day orders so they queue for the open', () => {
    expect(planSubmission(aaplBuy, 231.42, 0.01, false, 0.01)).toEqual({ type: 'limit', limitPrice: 233.73, timeInForce: 'day', capped: true })
  })

  it('sends reduce-only exits as real market orders', () => {
    expect(planSubmission(ethSell, 3_401.6, 0.01, true, 0.01)).toEqual({ type: 'market', timeInForce: 'gtc', capped: false })
  })

  it('leaves notional market orders uncapped', () => {
    const notional: OrderRequest = { symbol: btcBuy.symbol, side: 'buy', notional: 500, type: 'market', timeInForce: 'gtc' }
    expect(planSubmission(notional, 62_832, 0.01, false, 0.01)).toEqual({ type: 'market', timeInForce: 'gtc', capped: false })
  })

  it('passes limit, stop, and stop_limit orders through with their prices', () => {
    expect(planSubmission({ ...btcBuy, type: 'stop_limit', limitPrice: 64_000, stopPrice: 63_500 }, 63_500, 0.01, false, 0.01))
      .toEqual({ type: 'stop_limit', limitPrice: 64_000, stopPrice: 63_500, timeInForce: 'gtc', capped: false })
    expect(planSubmission({ ...ethSell, type: 'stop', stopPrice: 3_300 }, 3_300, 0.01, true, 0.01))
      .toEqual({ type: 'stop', stopPrice: 3_300, timeInForce: 'gtc', capped: false })
  })

  it('rounds to fine crypto ticks without float noise', () => {
    const doge: OrderRequest = { symbol: { assetClass: 'crypto', ticker: 'DOGE/USD' }, side: 'buy', qty: 1_000, type: 'market', timeInForce: 'gtc' }
    expect(planSubmission(doge, 0.123456789, 0.01, false, 0.000001).limitPrice).toBe(0.124691)
  })

  it('rejects a tolerance outside [0, 1) and a non-positive tick', () => {
    expect(() => planSubmission(btcBuy, 62_832, 1, false, 0.01)).toThrow(new RangeError('tolerance must be in [0, 1), got 1'))
    expect(() => planSubmission(btcBuy, 62_832, -0.1, false, 0.01)).toThrow(RangeError)
    expect(() => planSubmission(btcBuy, 62_832, 0.01, false, 0)).toThrow(new RangeError('price increment must be greater than zero, got 0'))
  })
})
```

Check the expected numbers: `62_832 × 1.01 = 63_460.32`; `3_401.6 × 0.99 = 3_367.584 → 3_367.59`; `231.42 × 1.01 = 233.7342 → 233.73`; `0.123456789 × 1.01 = 0.12469135689 → 0.124691`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/submission.spec.ts`
Expected: FAIL, cannot resolve `../src/submission.ts`.

- [ ] **Step 3: Implement**

`packages/experimental/trading/src/submission.ts`:

```ts
/**
 * Converting an approved order into what is sent to the broker. A
 * quantity-based market order that adds exposure becomes a marketable limit at
 * the approved price plus (buy) or minus (sell) the drift tolerance, so the
 * broker enforces the approved notional. Reduce-only exits and notional orders
 * stay market orders.
 *
 * @module @deepseek-ai/dsh-experimental-trading/submission
 */
import type { OrderRequest, OrderType, TimeInForce } from './types.ts'

/** Broker-facing order type, prices, and time in force. */
export interface SubmissionPlan {
  /** Order type sent to the broker. */
  readonly type: OrderType
  /** Limit price sent to the broker, when the type has one. */
  readonly limitPrice?: number
  /** Stop price sent to the broker, when the type has one. */
  readonly stopPrice?: number
  /** Time in force sent to the broker. */
  readonly timeInForce: TimeInForce
  /** Whether a market order was converted to a capped limit. */
  readonly capped: boolean
}

function toTick(value: number, increment: number, direction: 'down' | 'up'): number {
  const steps = direction === 'down' ? Math.floor(value / increment + 1e-9) : Math.ceil(value / increment - 1e-9)
  return Number((steps * increment).toFixed(10))
}

/**
 * Plan the broker order for an approved proposal.
 * @param order - approved order.
 * @param approvedPrice - reference price shown on the approved card.
 * @param tolerance - allowed drift as a fraction in [0, 1).
 * @param reduceOnly - whether the order only reduces a position.
 * @param priceIncrement - the instrument's price tick.
 * @returns the broker-facing order fields.
 * @throws RangeError for a tolerance outside [0, 1) or a non-positive tick.
 */
export function planSubmission(order: OrderRequest, approvedPrice: number, tolerance: number, reduceOnly: boolean, priceIncrement: number): SubmissionPlan {
  if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError(`tolerance must be in [0, 1), got ${tolerance}`)
  if (!(priceIncrement > 0)) throw new RangeError(`price increment must be greater than zero, got ${priceIncrement}`)
  if (order.type !== 'market' || order.notional !== undefined || reduceOnly) {
    return {
      type: order.type,
      ...order.limitPrice === undefined ? {} : { limitPrice: order.limitPrice },
      ...order.stopPrice === undefined ? {} : { stopPrice: order.stopPrice },
      timeInForce: order.timeInForce,
      capped: false,
    }
  }
  const limitPrice = order.side === 'buy'
    ? toTick(approvedPrice * (1 + tolerance), priceIncrement, 'down')
    : toTick(approvedPrice * (1 - tolerance), priceIncrement, 'up')
  return { type: 'limit', limitPrice, timeInForce: order.symbol.assetClass === 'crypto' ? 'ioc' : 'day', capped: true }
}
```

Add `export * from './submission.ts'` to `src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading/tests/submission.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/experimental/trading
git commit -m "feat(trading): plan broker submissions with side-aware price caps"
```

---

### Task 8: README, Chinese README, gate allowlists, full verification

**Files:**
- Create: `packages/experimental/trading/README.md`
- Create: `packages/experimental/trading/README.zh.md`
- Create: `packages/experimental/trading/README.i18n.yaml` (written by the gate)
- Modify: `scripts/verify-package-readme-model-experience.ts` (`NO_MODEL_EXPERIENCE_SECTION`)
- Modify: `packages/experimental/README.md` and `packages/experimental/README.zh.md` (list the new package wherever the group README lists its packages; re-record that pair)
- Test: none new; this task runs the repository gates.

**Interfaces:** none.

- [ ] **Step 1: Write the README**

`packages/experimental/trading/README.md` (model on `packages/util/brand/README.md`; same frontmatter, headings, and anchors):

````markdown
---
description: "Browser-safe trading domain library: symbols, indicators, live candles, order validation, risk checks, and price caps for the experimental trading desk."
kind: "package-library"
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

An order goes through three calls in order. `validateOrder(order, asset)` returns the broker rules the order breaks. `checkRisk(order, snapshot, limits)` returns every limit check, whether the order only reduces a position, and the reference price and estimated value shown on the approval card. `planSubmission(order, approvedPrice, tolerance, reduceOnly, priceIncrement)` returns the broker-facing type, prices, and time in force: a quantity-based market order that adds exposure becomes a limit capped at the approved price plus the tolerance for a buy or minus it for a sell, while exits and notional orders stay market orders.

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
````

- [ ] **Step 2: Register the no-Model-Experience entry**

In `scripts/verify-package-readme-model-experience.ts`, add to `NO_MODEL_EXPERIENCE_SECTION` (keep the object's existing order style):

```ts
  'packages/experimental/trading': 'The package only computes market values and order decisions; tool-trading owns every model-facing rendering.',
```

- [ ] **Step 3: Write the Chinese README and record both pairs**

Write `packages/experimental/trading/README.zh.md` mirroring the English README section for section (same anchors, code blocks, and table rows; language line `[English](README.md) | 中文`), following `docs/i18n/terminology.md`. Add the package to `packages/experimental/README.md` and `README.zh.md` wherever those files list member packages, in the same format as the neighboring entries.

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run verify-translation-pairing --write packages/experimental/trading/README.md && pnpm run verify-translation-pairing --write packages/experimental/README.md`
Expected: writes `packages/experimental/trading/README.i18n.yaml` and updates `packages/experimental/README.i18n.yaml`.

- [ ] **Step 4: Run per-file coverage for the package**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm exec vitest run packages/experimental/trading --coverage --coverage.include='packages/experimental/trading/src/**'`
Expected: PASS with 100% lines, branches, functions, and statements for every file. For any uncovered branch, add a test to the owning spec file that reaches it with a real input; do not add `/* v8 ignore */` comments.

- [ ] **Step 5: Run the repository gates for this change**

Run: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH && pnpm run constraints && pnpm run typecheck && pnpm run lint && pnpm run doc-sync && pnpm run build && pnpm run hygiene`
Expected: all pass. Fix what a gate names (README section order, manifest fields, JSDoc) and re-run only the failing gate until it passes.

- [ ] **Step 6: Commit**

```bash
git add packages/experimental/trading packages/experimental/README.md packages/experimental/README.zh.md packages/experimental/README.i18n.yaml scripts/verify-package-readme-model-experience.ts
git commit -m "docs(trading): document the trading domain library"
```
