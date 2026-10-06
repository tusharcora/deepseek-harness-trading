// Keyless recorded-session snapshot of the trading profile: the trader agent analyzes BTC/USD, proposes a limit order
// that the user approves through the generic approval waterfall, the real Alpaca provider submits it to a local fake
// broker, the fill streams back, and the agent reads it on the next request.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-experimental-tool-trading'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertFixtureInventory, launchWebScaffold, recordFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { type FakeBroker, startFakeBroker } from './trading-fake-broker.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/trading-desk', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const BUNDLE_DIR = fileURLToPath(new URL('../../../packages/experimental/bundle-trading', import.meta.url))
const BUNDLE_PATCH = join(BUNDLE_DIR, 'cordis.patch.yml')
const MODE = webSnapshotMode()
const ANALYZE = 'This task needs exactly two tool calls, in order. First call get_bars with {"symbol": "BTC/USD", '
  + '"timeframe": "1h", "limit": 5}. When it returns, do not summarize the bars: immediately call place_order with '
  + '{"symbol": "BTC/USD", "side": "buy", "qty": 0.0002, "type": "limit", "limit_price": 62000, "time_in_force": "gtc", '
  + '"rationale": "Snapshot test order near recent support."}. After place_order returns, reply exactly ORDER_PROPOSED and stop.'
const FOLLOW_UP = 'Reply with exactly the fill price of that order as a plain number and nothing else.'
const ALLOWLIST = ['cancel_order', 'get_account', 'get_bars', 'get_positions', 'get_quote', 'list_orders', 'place_order',
  'web_fetch', 'web_search']

interface Desk { readonly scaffold: WebScaffold; readonly broker: FakeBroker; readonly home: string }

async function launchDesk(options: { readonly settings?: string; readonly replay: boolean }): Promise<Desk> {
  const broker = await startFakeBroker()
  let home: string | undefined
  try {
    home = await mkdtemp(join(tmpdir(), 'dsh-trading-home-'))
    await writeFile(join(home, '.credentials.yaml'),
      'version: 1\nrefs:\n  ALPACA_API_KEY: fake-key\n  ALPACA_SECRET_KEY: fake-secret\n', { mode: 0o600 })
    if (options.settings !== undefined) await writeFile(join(home, 'settings.yaml'), options.settings)
    const overlay = join(home, 'trading.overlay.yml')
    await writeFile(overlay, [
      readFileSync(BUNDLE_PATCH, 'utf8'),
      '- id: trading-alpaca',
      '  config:',
      '    mode: paper',
      `    tradingUrl: ${broker.url}`,
      `    dataUrl: ${broker.url}`,
      `    tradeStreamUrl: ${broker.streamUrl}`,
      '    streamBackoffMs: [50]',
      '    lookupConfirmMs: 0',
      '',
    ].join('\n'))
    const scaffold = await launchWebScaffold({
      ...options.replay && MODE !== 'record' ? { replayFixture: FIXTURE, compareReplaySession: true } : {},
      harnessHome: home,
      extraOverlayPath: overlay,
      extraInstallAnchors: [join(BUNDLE_DIR, 'package.json')],
    })
    return { scaffold, broker, home }
  } catch (error) {
    // The scaffold removes its own temp roots when it fails to boot; the broker and harness home are this file's.
    await broker.stop()
    if (home !== undefined) await rm(home, { recursive: true, force: true })
    throw error
  }
}

async function closeDesk(desk: Desk | undefined): Promise<void> {
  if (desk === undefined) return
  try {
    await desk.scaffold.close()
  } finally {
    await desk.broker.stop()
    await rm(desk.home, { recursive: true, force: true })
  }
}

describe('trading profile: trader agent trades on a fake broker', () => {
  let desk: Desk
  let handle: AgentHandle
  let statusResult: unknown

  beforeAll(async () => {
    desk = await launchDesk({ replay: true })
    const { scaffold, broker } = desk
    scaffold.ctx.on('approval/request', async (request, next) => request.toolName === 'place_order' ? 'allowed-once' : next(),
      { prepend: true })
    await vi.waitFor(() => { expect(broker.listening()).toBe(1) }, { timeout: 15_000 })
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('trading-desk-snapshot'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'trader' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'trader').then(() => undefined),
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: ANALYZE }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    broker.fill()
    await vi.waitFor(() => {
      expect(handle.agent.session.snapshotEvents().some(event => event.type === 'trading/fill')).toBe(true)
    }, { timeout: 15_000 })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: FOLLOW_UP }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    // Inside the recorded session, so its log-only command/run and command/done events are part of the fixture.
    statusResult = (await scaffold.ctx.commands.execute(handle.agent, '/trading status', [], new AbortController().signal))?.result
    if (MODE === 'record') await recordFixture(scaffold, handle.agent.session.id, FIXTURE)
  }, MODE === 'record' ? 900_000 : 240_000)

  afterAll(async () => {
    await handle?.dispose()
    await closeDesk(desk)
  })

  it('applies the shipped profile layer and gives the trader agent exactly the allowlisted tools', () => {
    expect(desk.scaffold.ctx.agentPresets.roots).toEqual([{ path: realpathSync(join(BUNDLE_DIR, 'presets')), trust: 'system' }])
    const header = handle.agent.session.requestHeader()
    expect(header?.tools?.map(tool => tool.name).toSorted()).toEqual(ALLOWLIST)
    expect(desk.scaffold.ctx.tools.schemas(handle.agent).map(tool => tool.name).toSorted()).toEqual(ALLOWLIST)
    // User-mandated: compaction and the two user commands are composed, and none of them adds a model-facing tool, so
    // ALLOWLIST and tool-schemas.expected.json list the same nine tools as before they were added.
    expect(desk.scaffold.ctx.agentPresets.serviceFor(handle.agent, 'compaction')).toBeDefined()
    expect(desk.scaffold.ctx.commands.find(handle.agent, 'trading')).toBeDefined()
    expect(desk.scaffold.ctx.commands.find(handle.agent, 'compact')).toBeDefined()
  })

  it('answers /trading status for the user without telling the model', () => {
    expect(statusResult).toEqual({ kind: 'success', text: 'Trading status: ready (paper).' })
    expect(JSON.stringify(handle.agent.session.deriveMessages())).not.toContain('Trading status')
  })

  it('asks with the proposal, submits the order to the broker, and tells the agent about the fill', () => {
    const events = handle.agent.session.snapshotEvents()
    const asked = events.find(event => event.type === 'approval/asked')
    expect(asked?.type === 'approval/asked' ? asked.data.reason?.split('\n')[0] : undefined)
      .toBe('PAPER Buy 0.0002 BTC/USD limit at $62,000.00 gtc')
    expect(desk.broker.orders).toHaveLength(1)
    const [order] = desk.broker.orders
    expect(order).toMatchObject({
      symbol: 'BTC/USD', side: 'buy', qty: '0.0002', type: 'limit', limit_price: '62000', time_in_force: 'gtc',
    })
    // The client order id is a SHA-256 the snapshot redaction does not stabilize, so it must stay off the session log.
    const clientOrderId = order?.client_order_id
    expect(clientOrderId).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(events)).not.toContain(String(clientOrderId))
    expect(events.filter(event => event.type === 'trading/fill')).toHaveLength(1)
    expect(JSON.stringify(events.filter(event => event.type === 'agent/inbox/spliced')))
      .toContain('filled 0.0002 at $62,000.00; 0.0002 filled in total, order filled.')
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'])
  })
})

describe('trading profile with a saved default from another profile', () => {
  it('fails new sessions loudly, naming the saved preset', async () => {
    const desk = await launchDesk({
      replay: false, settings: 'agent-presets:\n  default: standard\n  modeSelectionEnabled: true\n',
    })
    try {
      const { scaffold } = desk
      // A new session names no preset, so it is composed from the saved default.
      await expect(scaffold.ctx.agents.create({
        sessionId: SessionId('trading-desk-unknown-default'),
        meta: { cwd: scaffold.workspaceCwd },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
      })).rejects.toThrow('agent-presets: preset "standard" not found (available: trader)')
    } finally {
      await closeDesk(desk)
    }
  }, 120_000)
})
