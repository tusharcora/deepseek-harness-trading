import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { clientOrderIdFor, mintProposalId, tradingDay } from '../src/ids.ts'

describe('ids', () => {
  it('mints distinct proposal ids', () => {
    const first = mintProposalId()
    expect(first).toMatch(/^p-[0-9a-f-]{36}$/)
    expect(mintProposalId()).not.toBe(first)
  })

  it('derives the client order id as SHA-256 hex of the session and proposal ids', () => {
    expect(clientOrderIdFor(SessionId('session-1'), brandString<ProposalId>('p-1')))
      .toBe('9d2adc3b6e9a8cc41407ecfd874ea5bc82954bee8dc099a80d3ac8f7c727cee8')
  })

  it('names the trading day in New York time', () => {
    expect(tradingDay(Date.UTC(2026, 9, 5, 2))).toBe('2026-10-04')
    expect(tradingDay(Date.UTC(2026, 9, 5, 14))).toBe('2026-10-05')
  })
})
