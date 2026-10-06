/**
 * Proposal ids, client order ids, and the trading day.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/ids
 */
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import type { SessionId } from '@deepseek-ai/dsh-session'

const NEW_YORK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * Mint a fresh proposal id at the first step of a proposal.
 * @returns `p-<uuid>`.
 */
export function mintProposalId(): ProposalId {
  return brandString<ProposalId>(`p-${randomUUID()}`)
}

/**
 * The broker idempotency key for one proposal. Provider call ids repeat across sessions and MCP calls have none, so the
 * key hashes the session id and the proposal id.
 * @param sessionId - session that recorded the proposal.
 * @param proposalId - proposal id.
 * @returns 64 lowercase hex characters (Alpaca accepts up to 128).
 */
export function clientOrderIdFor(sessionId: SessionId, proposalId: ProposalId): ClientOrderId {
  return brandString<ClientOrderId>(createHash('sha256').update(`${sessionId}:${proposalId}`).digest('hex'))
}

/**
 * The broker's trading day for a time.
 * @param t - UTC epoch milliseconds.
 * @returns `YYYY-MM-DD` in America/New_York.
 */
export function tradingDay(t: number): string {
  return NEW_YORK_DAY.format(t)
}
