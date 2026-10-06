/**
 * Boots the executor over a real storage stack, session store, agent registry, tool registry, and approval service,
 * with the in-memory venue as the only fake. One registered agent owns one session with an open turn.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent, type SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { vi } from 'vitest'
import TradingExecutor, { type Config } from '../src/index.ts'
import FakeVenue from './fake-venue.ts'

/** Timers long enough that tests drive reconciliation themselves; one-millisecond exit retries. */
export const TEST_CONFIG: Partial<Config> = { reconcileMs: 3_600_000, exitRetryMs: [1, 1] }

/** How to boot a desk. */
export interface DeskOptions {
  /** Executor configuration over {@link TEST_CONFIG}. */
  readonly config?: Partial<Config>
  /** Approval service policy, or `none` to compose no approval service. */
  readonly approval?: 'ask' | 'never' | 'none'
  /** Storage folder to reuse (restart tests); the caller removes it. */
  readonly root?: string
  /** Session id of the desk's agent. */
  readonly sessionId?: string
  /** Set venue state before the executor starts. */
  readonly prepare?: (venue: FakeVenue) => void
}

/** A booted desk. */
export interface Desk {
  readonly ctx: Context
  readonly venue: FakeVenue
  readonly executor: TradingExecutor
  readonly session: Session
  readonly agent: Agent
  /** Messages injected into the agent. */
  readonly injected: UserMessage[]
  /** What the approval answerer returns next. */
  answer: ApprovalOutcome
  /** Events of one type appended to the desk session. */
  events<T extends SessionEventType>(type: T): SessionEvent<T>[]
  /** Dispose everything; safe to call twice. */
  close(): Promise<void>
}

/**
 * Boot a desk.
 * @param options - configuration, approval policy, storage folder, session id, venue preparation.
 * @returns the desk.
 */
export async function bootDesk(options: DeskOptions = {}): Promise<Desk> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-tool-trading-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.approval !== 'none') await ctx.plugin(ApprovalService, { policy: options.approval ?? 'ask' })
  await ctx.plugin(FakeVenue)
  const venue = ctx.get('tradingVenue')
  if (!(venue instanceof FakeVenue)) throw new Error('the fake venue did not start')
  options.prepare?.(venue)
  // The session and its agent exist before the executor starts, so startup reconciliation can reach them.
  const session = ctx.sessions.create(SessionId(options.sessionId ?? 'trading-session'))
  const injected: UserMessage[] = []
  const scope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: (message) => { injected.push(message) }, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  session.append('turn/start', { turn: 1 })
  await ctx.plugin(TradingExecutor, { ...TEST_CONFIG, ...options.config })
  await vi.waitFor(() => { if (ctx.get('tradingExecutor') === undefined) throw new Error('the executor did not start') })
  const executor = ctx.get('tradingExecutor')
  if (executor === undefined) throw new Error('the executor did not start')
  let closed = false
  const desk: Desk = {
    ctx, venue, executor, session, agent, injected, answer: 'allowed-once',
    events<T extends SessionEventType>(type: T): SessionEvent<T>[] {
      return session.snapshotEvents().filter((event): event is SessionEvent<T> => event.type === type)
    },
    async close() {
      if (closed) return
      closed = true
      await ctx.fiber.dispose()
      if (options.root === undefined) await rm(root, { recursive: true, force: true })
    },
  }
  ctx.on('approval/request', async () => desk.answer)
  return desk
}
