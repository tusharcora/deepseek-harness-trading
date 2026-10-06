import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Journal, tradingJournalSpec } from '../src/journal.ts'
import type { JournalEntry, JournalStatus } from '../src/types.ts'

let root: string
let contexts: Context[]

async function openContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

async function openJournal(): Promise<{ journal: Journal; close: () => Promise<void> }> {
  const ctx = await openContext()
  const domain = await ctx.storageDomain.open(tradingJournalSpec)
  return { journal: new Journal(domain), close: () => domain.close() }
}

const pid = (id: string): ProposalId => brandString<ProposalId>(id)
const cid = (id: string): ClientOrderId => brandString<ClientOrderId>(id)

const entry = (id: string, overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  proposalId: pid(id), sessionId: SessionId('s-1'), source: 'dsh-agent', kind: 'order', ticker: 'BTC/USD',
  side: 'buy', qty: 0.0002, rationale: 'r', clientOrderId: cid(`client-${id}`), status: 'proposed', filledQty: 0,
  day: '2026-10-05', createdAt: 1, updatedAt: 1, ...overrides,
})

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-journal-')); contexts = [] })
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('Journal', () => {
  it('persists entries across a reopen and finds them by client order id', async () => {
    const first = await openJournal()
    await first.journal.put(entry('p1'))
    const updated = await first.journal.update(pid('p1'), { status: 'submitted', orderId: brandString<BrokerOrderId>('o-1') }, 5)
    expect(updated).toMatchObject({ status: 'submitted', orderId: 'o-1', updatedAt: 5 })
    await first.close()
    const second = await openJournal()
    expect(second.journal.get(pid('p1'))).toMatchObject({ status: 'submitted' })
    expect(second.journal.byClientOrderId(cid('client-p1'))?.proposalId).toBe('p1')
    expect(second.journal.byClientOrderId(cid('nope'))).toBeUndefined()
    expect(second.journal.inFlight().map(e => e.proposalId)).toEqual(['p1'])
  })

  it('counts and lists a trading day', async () => {
    const { journal } = await openJournal()
    await journal.put(entry('p3', { status: 'canceled', kind: 'cancel', createdAt: 3 }))
    await journal.put(entry('p1', { status: 'filled', createdAt: 1 }))
    await journal.put(entry('p2', { status: 'denied', createdAt: 2 }))
    await journal.put(entry('p4', { status: 'unknown', day: '2026-10-04', createdAt: 4 }))
    await journal.put({
      proposalId: pid('p5'), sessionId: SessionId('s-1'), source: 'dsh-agent', kind: 'order', ticker: 'BTC/USD',
      side: 'buy', rationale: 'r', status: 'submitted', filledQty: 0, day: '2026-10-05', createdAt: 5, updatedAt: 5,
    })
    expect(journal.submittedOn('2026-10-05')).toBe(2)
    expect(journal.on('2026-10-05').map(e => e.proposalId)).toEqual(['p1', 'p2', 'p3', 'p5'])
    expect(journal.inFlight().map(e => e.proposalId)).toEqual(['p4'])
  })

  it('refuses to reopen a journal holding an entry outside the schema', async () => {
    const first = await openJournal()
    await first.journal.put(entry('p1', { status: 'bogus' as JournalStatus }))
    await first.close()
    const ctx = await openContext()
    await expect(ctx.storageDomain.open(tradingJournalSpec)).rejects.toMatchObject({ code: 'invalid-record' })
  })
})
