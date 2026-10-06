/**
 * The trading journal: one durable entry per proposal in the storage service (domain `trading_journal`), from proposal
 * to final order state. It maps broker client order ids back to the proposing session, survives restarts, and backs
 * `list_orders` and the daily order count.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/journal
 */
import type { BrokerOrderId, ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { type Domain, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { type ZodType, z as zod } from 'zod'
import type { JournalEntry, JournalStatus } from './types.ts'

const STATUSES = [
  'proposed', 'denied', 'rejected', 'submitted', 'partially_filled', 'filled', 'canceled', 'expired', 'failed', 'unknown',
] as const satisfies readonly JournalStatus[]

// Branded ids are plain strings on disk; the cast restores the brands the executor wrote.
const entrySchema = zod.object({
  proposalId: zod.string(),
  sessionId: zod.string(),
  callId: zod.string().optional(),
  source: zod.enum(['dsh-agent', 'claude-code-mcp']),
  kind: zod.enum(['order', 'cancel']),
  ticker: zod.string(),
  side: zod.enum(['buy', 'sell']),
  qty: zod.number().optional(),
  notional: zod.number().optional(),
  rationale: zod.string(),
  clientOrderId: zod.string().optional(),
  orderId: zod.string().optional(),
  status: zod.enum(STATUSES),
  filledQty: zod.number(),
  filledAvgPrice: zod.number().optional(),
  day: zod.string(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  note: zod.string().optional(),
}).strict() as unknown as ZodType<JournalEntry>

/** Storage domain holding the trading journal. */
export const tradingJournalSpec = defineDomain({
  name: 'trading_journal',
  version: 1,
  tables: { entries: domainTable<ProposalId, JournalEntry>(entrySchema) },
})

/** Fields a lifecycle update may change. */
export interface JournalPatch {
  readonly status?: JournalStatus
  readonly orderId?: BrokerOrderId
  readonly filledQty?: number
  readonly filledAvgPrice?: number
  readonly note?: string
}

/** A journaled order whose broker state is not final yet. */
export type InFlightEntry = JournalEntry & { readonly clientOrderId: ClientOrderId }

const IN_FLIGHT: ReadonlySet<JournalStatus> = new Set(['submitted', 'partially_filled', 'unknown'])
const COUNTED: ReadonlySet<JournalStatus> = new Set(['submitted', 'partially_filled', 'filled', 'canceled', 'expired', 'unknown'])

/** Reads and writes over the open journal domain. Reads are synchronous; writes resolve once durable. */
export class Journal {
  private readonly byClientOrder = new Map<ClientOrderId, ProposalId>()

  /** @param domain - the open `trading_journal` domain; the caller closes it. */
  constructor(private readonly domain: Domain<typeof tradingJournalSpec>) {
    for (const [, entry] of domain.table('entries').entries()) this.index(entry)
  }

  /**
   * Read one journal entry.
   * @param id - proposal id.
   * @returns the entry.
   */
  get(id: ProposalId): JournalEntry | undefined {
    return this.domain.table('entries').get(id)
  }

  /**
   * Find the entry of the order sent with a client order id.
   * @param id - client order id sent to the broker.
   * @returns the entry of the proposal that sent it.
   */
  byClientOrderId(id: ClientOrderId): JournalEntry | undefined {
    const proposalId = this.byClientOrder.get(id)
    return proposalId === undefined ? undefined : this.get(proposalId)
  }

  /**
   * Write a new entry.
   * @param entry - the entry.
   * @returns when the write is durable.
   */
  async put(entry: JournalEntry): Promise<void> {
    await this.domain.table('entries').put(entry.proposalId, entry)
    this.index(entry)
  }

  /**
   * Change an entry's lifecycle fields.
   * @param id - proposal id.
   * @param patch - fields to change.
   * @param now - update time, UTC epoch milliseconds.
   * @returns the updated entry once durable.
   */
  async update(id: ProposalId, patch: JournalPatch, now: number): Promise<JournalEntry> {
    return this.domain.table('entries').update(id, current => ({ ...current, ...patch, updatedAt: now }))
  }

  /**
   * List the orders reconciliation re-reads.
   * @returns order entries the broker may still be working: submitted, partially filled, or of unknown outcome.
   */
  inFlight(): InFlightEntry[] {
    return [...this.domain.table('entries').entries()].flatMap(([, entry]) =>
      entry.kind === 'order' && entry.clientOrderId !== undefined && IN_FLIGHT.has(entry.status)
        ? [{ ...entry, clientOrderId: entry.clientOrderId }]
        : [])
  }

  /**
   * List one trading day's entries.
   * @param day - trading day, `YYYY-MM-DD`.
   * @returns that day's entries, oldest first.
   */
  on(day: string): JournalEntry[] {
    return [...this.domain.table('entries').entries()].map(([, entry]) => entry)
      .filter(entry => entry.day === day)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * Count the desk orders that reached the broker on one trading day.
   * @param day - trading day, `YYYY-MM-DD`.
   * @returns how many desk orders reached the broker that day.
   */
  submittedOn(day: string): number {
    return this.on(day).filter(entry => entry.kind === 'order' && COUNTED.has(entry.status)).length
  }

  private index(entry: JournalEntry): void {
    if (entry.clientOrderId !== undefined) this.byClientOrder.set(entry.clientOrderId, entry.proposalId)
  }
}
