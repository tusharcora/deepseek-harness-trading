/**
 * Opt-in Alpaca paper e2e for the executor. Needs DSH_ALPACA_PAPER_E2E=1 plus ALPACA_API_KEY / ALPACA_SECRET_KEY of a
 * paper account; the e2e config also loads the repository root `.env`, so keys placed there count. Effects on that
 * account: the venue sets no_shorting=true and max_margin_multiplier=1 (they stay set); the test buys about $12 of
 * BTC/USD through place_order (sent as a capped IOC limit, above Alpaca's $10 crypto minimum), waits for the fill
 * notice, and sells the position through place_order (a reduce-only market exit, retried while Alpaca releases the
 * coins). It refuses to run when the venue is not on the paper account, or when the account already holds BTC/USD or
 * has open BTC/USD orders. The session id is unique to the run, so the client order ids the executor derives from it
 * are too; cleanup cancels only open orders carrying one of this run's client order ids and, once the clean-account
 * check passed, closes any BTC/USD left. Cleanup is best-effort: a failed run can leave a tiny BTC/USD position or
 * order. The test is not retried.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ClientOrderId } from '@deepseek-ai/dsh-experimental-trading'
import AlpacaVenue from '@deepseek-ai/dsh-experimental-trading-alpaca'
import type { TradingVenueGateway } from '@deepseek-ai/dsh-experimental-trading-venue'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { clientOrderIdFor } from '../src/ids.ts'
import TradingExecutor from '../src/index.ts'
import * as TradingTools from '../src/tools.ts'

const keyId = process.env.ALPACA_API_KEY
const secret = process.env.ALPACA_SECRET_KEY
const enabled = process.env.DSH_ALPACA_PAPER_E2E === '1' && keyId !== undefined && secret !== undefined
const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const

/** Order value the test aims for, in dollars; above Alpaca's $10 crypto minimum with margin. */
const ORDER_DOLLARS = 12

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param session - this run's session.
 * @returns the client order ids the executor derives for every proposal recorded in `session`.
 */
function ownClientOrderIds(session: Session): Set<ClientOrderId> {
  return new Set(session.snapshotEvents().filter(e => e.type === 'trading/proposal')
    .map(e => clientOrderIdFor(session.id, e.data.proposalId)))
}

/**
 * Run every cleanup step even when one throws.
 * @param steps - cleanup steps, in order.
 * @returns the failures' messages.
 */
async function runCleanup(steps: readonly (() => Promise<void>)[]): Promise<string[]> {
  const failures: string[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  return failures
}

describe.skipIf(!enabled)('executor on Alpaca paper', { retry: 0 }, () => {
  it('buys and sells BTC/USD through place_order with approval, and reports both fills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-paper-'))
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { ALPACA_API_KEY: keyId ?? '', ALPACA_SECRET_KEY: secret ?? '' } },
    ]))
    let venue: TradingVenueGateway | undefined
    let session: Session | undefined
    let clean = false
    let failure: unknown
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      await ctx.plugin(AlpacaVenue, {})
      await vi.waitFor(() => { expect(ctx.get('tradingVenue')?.status()).toBe('ready') }, { timeout: 30_000 })
      venue = ctx.get('tradingVenue')
      if (venue === undefined) throw new Error('venue missing')
      if (venue.mode() !== 'paper') throw new Error('the venue is not on the Alpaca paper account')
      const holding = (await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD')
      const resting = (await venue.openOrders()).some(o => o.symbol.ticker === 'BTC/USD')
      if (holding || resting) {
        throw new Error('this paper account already holds BTC/USD or has open BTC/USD orders; use a clean paper account')
      }
      clean = true
      // A five-second reconcile backs up the order stream, so a missed fill update still reaches the agent in time.
      await ctx.plugin(TradingExecutor, { maxOrderNotional: 50, reconcileMs: 5_000, exitRetryMs: [1_000, 2_000, 4_000] })
      await vi.waitFor(() => { expect(ctx.get('tradingExecutor')).toBeDefined() })
      await ctx.plugin(TradingTools)
      ctx.on('approval/request', async () => 'allowed-once')
      const own = ctx.sessions.create(SessionId(`paper-e2e-${String(Date.now())}`))
      session = own
      const injected: UserMessage[] = []
      const agent: Agent = {
        id: own.id, options: {}, session: own, inbox: unsupportedInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx,
        followup: () => {}, steer: () => {}, inject: (message) => { injected.push(message) }, send: () => {}, cancel() {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(agent)
      own.append('turn/start', { turn: 1 })
      const quote = await venue.latestQuote(btc)
      const minSize = (await venue.asset(btc)).minOrderSize ?? 0
      const qty = Math.max(minSize, Math.ceil((ORDER_DOLLARS / quote.ask) * 1e6) / 1e6)
      const order = (callId: string, side: 'buy' | 'sell', amount: number) => ctx.tools.execute({
        callId: ToolCallId(callId), name: 'place_order', agent, signal: new AbortController().signal,
        arguments: { symbol: 'BTC/USD', side, qty: amount, type: 'market', time_in_force: 'gtc', rationale: 'Paper e2e.' },
      })
      const bought = await order('buy-1', 'buy', qty)
      expect(bought.isError, JSON.stringify(bought.content)).toBe(false)
      await vi.waitFor(() => { expect(injected).toHaveLength(1) }, { timeout: 60_000, interval: 500 })
      // Alpaca shows the filled position before its coins are sellable: qty_available stays 0 for a moment.
      let held = 0
      for (let i = 0; i < 30 && held <= 0; i++) {
        held = (await venue.positions()).find(p => p.symbol.ticker === 'BTC/USD')?.qtyAvailable ?? 0
        if (held <= 0) await sleep(500)
      }
      expect(held).toBeGreaterThan(0)
      const sold = await order('sell-1', 'sell', held)
      expect(sold.isError, JSON.stringify(sold.content)).toBe(false)
      await vi.waitFor(() => { expect(injected).toHaveLength(2) }, { timeout: 60_000, interval: 500 })
      const outcomes = own.snapshotEvents().filter(e => e.type === 'trading/order').map(e => e.data.outcome)
      expect(outcomes).toEqual(['submitted', 'submitted'])
    } catch (error) {
      failure = error
    }
    const failures = await runCleanup([
      async () => {
        if (venue === undefined || session === undefined) return
        const own = ownClientOrderIds(session)
        for (const open of await venue.openOrders()) if (own.has(open.clientOrderId)) await venue.cancelOrder(open.id)
      },
      async () => {
        if (venue === undefined || !clean) return
        if ((await venue.positions()).some(p => p.symbol.ticker === 'BTC/USD')) await venue.closePosition(btc)
      },
      async () => { await ctx.fiber.dispose() },
      async () => { await rm(root, { recursive: true, force: true }) },
    ])
    if (failure !== undefined) {
      if (failures.length > 0 && failure instanceof Error) failure.message += `\ncleanup also failed: ${failures.join('; ')}`
      throw failure
    }
    if (failures.length > 0) throw new Error(`paper e2e cleanup failed: ${failures.join('; ')}`)
  }, 180_000)
})
