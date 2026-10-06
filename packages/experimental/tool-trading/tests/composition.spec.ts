/**
 * Real-composition and HMR guard: the storage stack, sessions, agents, the system prompt, tools, approval, an in-memory
 * venue, the executor, and the tools plugin boot from a test-only cordis.yml through the Loader + Include path. A
 * place_order call asks, submits, and the fill reaches the agent; the journal survives a reboot over the same storage;
 * a misconfigured limit fails the executor at load; disposing each plugin removes its tools, listeners, guard, and
 * order-stream subscription; the user's `/trading` command loads from a Loader entry and leaves when that entry is
 * disabled.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import * as AgentModule from '@deepseek-ai/dsh-agent'
import * as CommandsModule from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import * as SessionModule from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as SystemPromptModule from '@deepseek-ai/dsh-system-prompt'
import * as ToolsModule from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as ApprovalModule from '@deepseek-ai/dsh-user-approval'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as TradingCommand from '../src/command.ts'
import * as ToolTrading from '../src/index.ts'
import * as TradingTools from '../src/tools.ts'
import * as FakeVenueModule from './fake-venue.ts'
import { acceptedOrder, FakeVenue } from './fake-venue.ts'

let root: string
let contexts: Context[]

const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-json', StorageJson],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@deepseek-ai/dsh-session', SessionModule],
  ['@deepseek-ai/dsh-agent', AgentModule],
  ['@deepseek-ai/dsh-system-prompt', SystemPromptModule],
  ['@deepseek-ai/dsh-tools', ToolsModule],
  ['@deepseek-ai/dsh-user-approval', ApprovalModule],
  ['@deepseek-ai/dsh-commands', CommandsModule],
  ['fake-trading-venue', FakeVenueModule],
  ['@deepseek-ai/dsh-experimental-tool-trading', ToolTrading],
  ['@deepseek-ai/dsh-experimental-tool-trading/tools', TradingTools],
  ['@deepseek-ai/dsh-experimental-tool-trading/command', TradingCommand],
])

async function boot(trading: readonly string[] | false): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    '- name: fake-trading-venue',
    ...trading === false ? [] : [
      "- name: '@deepseek-ai/dsh-experimental-tool-trading'",
      '  config:',
      '    reconcileMs: 3600000',
      ...trading,
      "- name: '@deepseek-ai/dsh-experimental-tool-trading/tools'",
    ],
    '',
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = {
    version: 'v2',
    loadCache: new Map(),
    import: (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function liveAgent(ctx: Context, id: string): Promise<{ agent: Agent; injected: UserMessage[] }> {
  const session = ctx.sessions.create(SessionId(id))
  const injected: UserMessage[] = []
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx,
    followup: () => {}, steer: () => {}, inject: (message) => { injected.push(message) }, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  return { agent, injected }
}

const venueOf = (ctx: Context): FakeVenue => {
  const venue = ctx.get('tradingVenue')
  if (!(venue instanceof FakeVenue)) throw new Error('fake venue missing')
  return venue
}

const placeOrder = (ctx: Context, agent: Agent, callId: string) => ctx.tools.execute({
  callId: ToolCallId(callId), name: 'place_order', agent, signal: new AbortController().signal,
  arguments: { symbol: 'BTC/USD', side: 'buy', qty: 0.0002, type: 'market', time_in_force: 'gtc', rationale: 'Composition test.' },
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-composition-'))
  await mkdir(join(root, 'storages'))
  contexts = []
})

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('tool-trading real composition', () => {
  it('asks, submits, tells the agent about the fill, and keeps the journal across a reboot', async () => {
    const ctx = await boot([])
    await vi.waitFor(() => { expect(ctx.tools.get('place_order')).toBeDefined() })
    const venue = venueOf(ctx)
    const { agent, injected } = await liveAgent(ctx, 'composition-session')
    ctx.on('approval/request', async () => 'allowed-once')
    const result = await placeOrder(ctx, agent, 'call-1')
    expect(result.isError).toBe(false)
    const request = venue.submitted[0]
    if (request === undefined) throw new Error('nothing was submitted')
    expect(request).toMatchObject({ type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc' })
    venue.emit({ kind: 'update', update: { event: 'fill', t: 1, fillPrice: 62_900, fillQty: 0.0002,
      order: acceptedOrder(request, { filledQty: 0.0002, filledAvgPrice: 62_900, status: 'filled' }) } })
    await vi.waitFor(() => { expect(injected).toHaveLength(1) })
    await ctx.fiber.dispose()
    const again = await boot([])
    await vi.waitFor(async () => {
      expect((await again.get('tradingExecutor')?.orders())?.today).toMatchObject([{ status: 'filled', filledQty: 0.0002 }])
    })
  })

  it('fails the executor at load when a limit is misconfigured', async () => {
    const ctx = await boot(['    maxOrderNotional: -5'])
    expect(ctx.get('tradingExecutor')).toBeUndefined()
    expect(ctx.tools.get('place_order')).toBeUndefined()
  })

  it('removes the tools, the listeners, the guard, and the stream subscription when their plugins are disposed', async () => {
    const ctx = await boot(false)
    const venue = venueOf(ctx)
    const executor = ctx.plugin(ToolTrading.default, { reconcileMs: 3_600_000 })
    await vi.waitFor(() => { expect(ctx.get('tradingExecutor')).toBeDefined() })
    const tools = ctx.plugin(TradingTools)
    await vi.waitFor(() => { expect(ctx.tools.get('place_order')).toBeDefined() })
    expect(venue.listenerCount).toBe(1)
    await tools.dispose()
    expect(ctx.tools.get('place_order')).toBeUndefined()
    await executor.dispose()
    expect(ctx.get('tradingExecutor')).toBeUndefined()
    expect(venue.listenerCount).toBe(0)
    // With the executor gone, a stand-in place_order runs unguarded while halted: its listener and guard left with it.
    venue.current = 'halted'
    ctx.tools.register(defineTool({
      name: 'place_order', description: 'stand-in', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'ran',
    }))
    const { agent } = await liveAgent(ctx, 'after-dispose')
    expect(await ctx.tools.execute({ callId: ToolCallId('after'), name: 'place_order', arguments: {}, agent,
      signal: new AbortController().signal })).toMatchObject({ isError: false, value: 'ran' })
  })

  it('loads /trading from a Loader entry, halts and resumes through it, and removes it when the entry is disabled', async () => {
    const ctx = await boot([])
    const venue = venueOf(ctx)
    await ctx.loader.create({ name: '@deepseek-ai/dsh-commands' })
    const entryId = await ctx.loader.create({ name: '@deepseek-ai/dsh-experimental-tool-trading/command' })
    await ctx.loader.await()
    const { agent } = await liveAgent(ctx, 'command-session')
    const run = async (line: string) => (await ctx.commands.execute(agent, line, [], new AbortController().signal))?.result
    expect(await run('/trading halt composition')).toEqual({ kind: 'success',
      text: 'Trading halted. Trading status: halted (paper). Reason: composition.' })
    expect(venue.status()).toBe('halted')
    expect(await run('/trading resume')).toEqual({ kind: 'success', text: 'Trading resumed. Trading status: ready (paper).' })
    expect(venue.resumeCalls).toBe(1)
    expect(ctx.tools.schemas().some(schema => /halt|resume/i.test(schema.name))).toBe(false)
    await ctx.loader.update(entryId, { disabled: true })
    expect(ctx.commands.find(agent, 'trading')).toBeUndefined()
    expect(await run('/trading halt')).toBeUndefined()
    expect(venue.status()).toBe('ready')
  })
})
