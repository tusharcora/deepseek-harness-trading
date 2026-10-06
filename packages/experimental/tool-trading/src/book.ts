/**
 * Proposals between their first check and settlement: reserved exposure, approval state, and the links from tool call
 * ids and approval request ids to proposal ids. The executor maintains it from its own commits and the session events
 * it observes; nothing survives a restart, and a lost entry fails closed.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/book
 */
import type { OrderRequest, ProposalId, Side } from '@deepseek-ai/dsh-experimental-trading'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { TradingOrderProposal, TradingProposal } from './types.ts'

/** Exposure a pending order proposal holds until it settles. */
export interface Reservation {
  /** Instrument ticker. */
  readonly ticker: string
  /** Direction. */
  readonly side: Side
  /** Quantity, derived from the notional for notional orders. */
  readonly qty: number
  /** Estimated value in dollars. */
  readonly notional: number
}

/**
 * `checked`: reserved; its `trading/proposal` event not yet observed. `asked`: the event committed. `approved`: its call
 * received `allowed-once`. `submitting`: the tool body is sending it.
 */
export type ProposalState = 'checked' | 'asked' | 'approved' | 'submitting'

/** One unsettled proposal. */
export interface BookEntry {
  /** The proposal as recorded. */
  readonly proposal: TradingProposal
  /** Session that records it. */
  readonly sessionId: SessionId
  /** Held exposure; absent for cancellations. */
  readonly reservation?: Reservation
  /** Current state. */
  state: ProposalState
  /** Approval request linked to its call. */
  approvalId?: ApprovalRequestId
}

function callKey(sessionId: SessionId, callId: ToolCallId): string {
  return `${sessionId}\u0000${callId}`
}

/** The executor's in-memory proposal book. */
export class ProposalBook {
  private readonly entries = new Map<ProposalId, BookEntry>()
  private readonly calls = new Map<string, ProposalId>()
  private readonly approvals = new Map<ApprovalRequestId, BookEntry>()

  /**
   * Add a checked proposal.
   * @param proposal - the checked proposal.
   * @param sessionId - session that records it.
   * @param reservation - exposure to hold until it settles; cancellations hold none.
   */
  add(proposal: TradingProposal, sessionId: SessionId, reservation?: Reservation): void {
    this.entries.set(proposal.proposalId, { proposal, sessionId, ...reservation === undefined ? {} : { reservation }, state: 'checked' })
    if (proposal.callId !== undefined) this.calls.set(callKey(sessionId, proposal.callId), proposal.proposalId)
  }

  /**
   * Look up an unsettled proposal.
   * @param id - proposal id.
   * @returns the unsettled entry.
   */
  get(id: ProposalId): BookEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Look up the proposal an in-app tool call created.
   * @param sessionId - session of the call.
   * @param callId - in-app tool call id.
   * @returns the unsettled proposal created for that call.
   */
  forCall(sessionId: SessionId, callId: ToolCallId): ProposalId | undefined {
    return this.calls.get(callKey(sessionId, callId))
  }

  /**
   * Record that a proposal's own `trading/proposal` event committed in its session.
   * @param sessionId - session whose log committed the event.
   * @param id - proposal id in the event.
   */
  markLogged(sessionId: SessionId, id: ProposalId): void {
    const entry = this.entries.get(id)
    if (entry?.sessionId === sessionId && entry.state === 'checked') entry.state = 'asked'
  }

  /**
   * Link an `approval/asked` event to the logged proposal of the same call.
   * @param sessionId - session whose log committed the event.
   * @param callId - the event's call id, when it has one.
   * @param approvalId - the event's request id.
   */
  linkApproval(sessionId: SessionId, callId: ToolCallId | undefined, approvalId: ApprovalRequestId): void {
    if (callId === undefined) return
    const id = this.forCall(sessionId, callId)
    const entry = id === undefined ? undefined : this.entries.get(id)
    if (entry?.state !== 'asked') return
    entry.approvalId = approvalId
    this.approvals.set(approvalId, entry)
  }

  /**
   * Apply an `approval/decided` outcome: `allowed-once` approves the linked proposal; any other outcome settles it.
   * @param approvalId - the decided request.
   * @param outcome - the decision.
   * @returns the settled entry for a refusal, cancellation, or unavailable answer; otherwise undefined.
   */
  decide(approvalId: ApprovalRequestId, outcome: ApprovalOutcome): BookEntry | undefined {
    const entry = this.approvals.get(approvalId)
    if (entry === undefined) return undefined
    this.approvals.delete(approvalId)
    if (outcome === 'allowed-once') {
      entry.state = 'approved'
      return undefined
    }
    return this.settle(entry.proposal.proposalId)
  }

  /**
   * Remove a proposal, its reservation, and its links.
   * @param id - proposal id.
   * @returns the removed entry.
   */
  settle(id: ProposalId): BookEntry | undefined {
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    this.entries.delete(id)
    if (entry.proposal.callId !== undefined) this.calls.delete(callKey(entry.sessionId, entry.proposal.callId))
    if (entry.approvalId !== undefined) this.approvals.delete(entry.approvalId)
    return entry
  }

  /**
   * Settle whatever proposal a finished tool call left behind.
   * @param sessionId - session of the call.
   * @param callId - tool call id.
   * @returns the removed entry, when one was still unsettled.
   */
  settleCall(sessionId: SessionId, callId: ToolCallId): BookEntry | undefined {
    const id = this.forCall(sessionId, callId)
    return id === undefined ? undefined : this.settle(id)
  }

  private reservations(excluding?: ProposalId): Reservation[] {
    return [...this.entries.values()].flatMap(entry =>
      entry.reservation === undefined || entry.proposal.proposalId === excluding ? [] : [entry.reservation])
  }

  /**
   * Quantities reserved by pending proposals for one instrument.
   * @param ticker - instrument ticker.
   * @param excluding - proposal to leave out (the one being re-checked).
   * @returns pending buy and sell quantities.
   */
  exposure(ticker: string, excluding?: ProposalId): { pendingBuyQty: number; pendingSellQty: number } {
    let pendingBuyQty = 0
    let pendingSellQty = 0
    for (const reservation of this.reservations(excluding)) {
      if (reservation.ticker !== ticker) continue
      if (reservation.side === 'buy') pendingBuyQty += reservation.qty
      else pendingSellQty += reservation.qty
    }
    return { pendingBuyQty, pendingSellQty }
  }

  /**
   * Sum the cash that pending buy proposals would commit.
   * @param excluding - proposal to leave out.
   * @returns the estimated value of pending buy proposals, all instruments.
   */
  pendingBuyNotional(excluding?: ProposalId): number {
    return this.reservations(excluding).filter(r => r.side === 'buy').reduce((sum, r) => sum + r.notional, 0)
  }

  /**
   * Count pending order proposals toward the daily order limit.
   * @param excluding - proposal to leave out.
   * @returns the number of pending order proposals.
   */
  pendingOrders(excluding?: ProposalId): number {
    return this.reservations(excluding).length
  }

  /**
   * An unsent order proposal from the same session with the same instrument, side, size, type, and prices.
   * @param sessionId - proposing session.
   * @param order - the new order.
   * @returns the matching proposal.
   */
  findDuplicate(sessionId: SessionId, order: OrderRequest): TradingOrderProposal | undefined {
    for (const entry of this.entries.values()) {
      const { proposal } = entry
      if (proposal.kind !== 'order' || entry.sessionId !== sessionId || entry.state === 'submitting') continue
      const pending = proposal.order
      if (pending.symbol.ticker === order.symbol.ticker && pending.side === order.side && pending.qty === order.qty
        && pending.notional === order.notional && pending.type === order.type && pending.limitPrice === order.limitPrice
        && pending.stopPrice === order.stopPrice) return proposal
    }
    return undefined
  }
}
