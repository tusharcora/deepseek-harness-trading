import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, ClientOrderId, OrderRequest, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { ProposalBook } from '../src/book.ts'
import type { TradingCancelProposal, TradingOrderProposal } from '../src/types.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const session = SessionId('s-1')
const pid = (id: string): ProposalId => brandString<ProposalId>(id)
const order = (overrides: Partial<OrderRequest> = {}): OrderRequest =>
  ({ symbol: btc, side: 'buy', qty: 0.1, type: 'market', timeInForce: 'gtc', ...overrides })

function proposal(id: string, callId?: string, o: OrderRequest = order()): TradingOrderProposal {
  return {
    kind: 'order', proposalId: pid(id), ...callId === undefined ? {} : { callId: ToolCallId(callId) }, source: 'dsh-agent',
    mode: 'paper', order: o, rationale: 'r', quote: { bid: 1, ask: 1 }, marketOpen: true, referencePrice: 100,
    estimatedNotional: 10, equityPct: 0, reduceOnly: false, plan: { type: 'market', timeInForce: 'gtc', capped: false },
    priceIncrement: 0.01, checks: [],
  }
}

const cancel = (id: string): TradingCancelProposal => ({
  kind: 'cancel', proposalId: pid(id), source: 'dsh-agent', mode: 'paper', rationale: 'r',
  order: {
    id: brandString<BrokerOrderId>('o-1'), clientOrderId: brandString<ClientOrderId>('c-1'),
    symbol: btc, side: 'buy', type: 'limit', timeInForce: 'gtc',
    qty: 0.1, limitPrice: 60_000, filledQty: 0, status: 'open',
  },
})

describe('ProposalBook exposure', () => {
  it('sums reservations per ticker and side, excluding one proposal', () => {
    const book = new ProposalBook()
    book.add(proposal('p1'), session, { ticker: 'BTC/USD', side: 'buy', qty: 0.1, notional: 10 })
    book.add(proposal('p2'), session, { ticker: 'BTC/USD', side: 'sell', qty: 0.05, notional: 5 })
    book.add(proposal('p3'), session, { ticker: 'AAPL', side: 'buy', qty: 2, notional: 460 })
    book.add(cancel('p4'), session)
    expect(book.exposure('BTC/USD')).toEqual({ pendingBuyQty: 0.1, pendingSellQty: 0.05 })
    expect(book.exposure('BTC/USD', pid('p1'))).toEqual({ pendingBuyQty: 0, pendingSellQty: 0.05 })
    expect(book.pendingBuyNotional()).toBe(470)
    expect(book.pendingBuyNotional(pid('p3'))).toBe(10)
    expect(book.pendingOrders()).toBe(3)
    expect(book.pendingOrders(pid('p2'))).toBe(2)
  })
})

describe('ProposalBook approval', () => {
  it('approves only a logged proposal that was asked about through its own call', () => {
    const book = new ProposalBook()
    book.add(proposal('p1', 'call-1'), session, { ticker: 'BTC/USD', side: 'buy', qty: 0.1, notional: 10 })
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('early'))
    expect(book.decide(ApprovalRequestId('early'), 'allowed-once')).toBeUndefined()
    expect(book.get(pid('p1'))?.state).toBe('checked')
    book.markLogged(SessionId('other'), pid('p1'))
    expect(book.get(pid('p1'))?.state).toBe('checked')
    book.markLogged(session, pid('p1'))
    expect(book.get(pid('p1'))?.state).toBe('asked')
    book.linkApproval(session, undefined, ApprovalRequestId('no-call'))
    book.linkApproval(session, ToolCallId('call-x'), ApprovalRequestId('other-call'))
    expect(book.decide(ApprovalRequestId('other-call'), 'allowed-once')).toBeUndefined()
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('a-1'))
    expect(book.decide(ApprovalRequestId('a-1'), 'allowed-once')).toBeUndefined()
    expect(book.get(pid('p1'))?.state).toBe('approved')
    expect(book.decide(ApprovalRequestId('a-1'), 'allowed-once')).toBeUndefined()
    expect(book.forCall(session, ToolCallId('call-1'))).toBe('p1')
  })

  it('settles a refused proposal, drops its links, and frees its reservation', () => {
    const book = new ProposalBook()
    book.add(proposal('p1', 'call-1'), session, { ticker: 'BTC/USD', side: 'buy', qty: 0.1, notional: 10 })
    book.markLogged(session, pid('p1'))
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('a-1'))
    expect(book.decide(ApprovalRequestId('a-1'), 'rejected')?.proposal.proposalId).toBe('p1')
    expect(book.get(pid('p1'))).toBeUndefined()
    expect(book.forCall(session, ToolCallId('call-1'))).toBeUndefined()
    expect(book.exposure('BTC/USD')).toEqual({ pendingBuyQty: 0, pendingSellQty: 0 })
  })

  it('settles by call id once', () => {
    const book = new ProposalBook()
    book.add(proposal('p1', 'call-1'), session)
    book.markLogged(session, pid('p1'))
    book.linkApproval(session, ToolCallId('call-1'), ApprovalRequestId('a-1'))
    expect(book.settleCall(session, ToolCallId('call-1'))?.proposal.proposalId).toBe('p1')
    expect(book.settleCall(session, ToolCallId('call-1'))).toBeUndefined()
    expect(book.decide(ApprovalRequestId('a-1'), 'allowed-once')).toBeUndefined()
    expect(book.settle(pid('missing'))).toBeUndefined()
    book.add(proposal('p2'), session)
    expect(book.settle(pid('p2'))?.proposal.proposalId).toBe('p2')
  })
})

describe('ProposalBook duplicates', () => {
  it('finds an identical unsent order proposal from the same session only', () => {
    const book = new ProposalBook()
    book.add(cancel('p0'), session)
    book.add(proposal('p1', undefined, order({ type: 'limit', limitPrice: 60_000 })), session)
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_000 }))?.proposalId).toBe('p1')
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_001 }))).toBeUndefined()
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_000, qty: 0.2 }))).toBeUndefined()
    expect(book.findDuplicate(SessionId('other'), order({ type: 'limit', limitPrice: 60_000 }))).toBeUndefined()
    const entry = book.get(pid('p1'))
    if (entry === undefined) throw new Error('p1 missing')
    entry.state = 'submitting'
    expect(book.findDuplicate(session, order({ type: 'limit', limitPrice: 60_000 }))).toBeUndefined()
  })
})
