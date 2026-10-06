import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrder, BrokerOrderId, ClientOrderId, OrderRequest, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BLOCKED, HALTED, KEYS_MISSING, NO_CHECKED_PROPOSAL, renderOrders, TRADING_BLOCKED } from '../src/format.ts'
import { Journal } from '../src/journal.ts'
import type { ProposedOrder } from '../src/order-args.ts'
import type { ProposalContext, ProposeResult } from '../src/types.ts'
import { acceptedOrder } from './fake-venue.ts'
import { bootDesk, type Desk } from './harness.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const brokerId = (id: string): BrokerOrderId => brandString<BrokerOrderId>(id)
const clientId = (id: string): ClientOrderId => brandString<ClientOrderId>(id)
const buy = (qty = 0.0002, overrides: Partial<OrderRequest> = {}): ProposedOrder =>
  ({ order: { symbol: btc, side: 'buy', qty, type: 'market', timeInForce: 'gtc', ...overrides }, rationale: 'Testing the desk.' })
const sell: ProposedOrder = {
  order: { symbol: btc, side: 'sell', qty: 0.001, type: 'market', timeInForce: 'gtc' }, rationale: 'Take profit.',
}
const position = { symbol: btc, qty: 0.001, qtyAvailable: 0.001, avgEntryPrice: 60_000, currentPrice: 62_830, marketValue: 62.83,
  unrealizedPl: 2.83 }

let desk: Desk
afterEach(async () => {
  vi.restoreAllMocks()
  await desk.close()
})

const context = (callId = 'call-1'): ProposalContext => ({ session: desk.session, source: 'dsh-agent', callId: ToolCallId(callId) })

function approve(callId: string, outcome: ApprovalOutcome = 'allowed-once', toolName = 'place_order'): void {
  const id = ApprovalRequestId(`approval-${callId}`)
  desk.session.append('approval/asked', { id, toolName, callId: ToolCallId(callId) })
  desk.session.append('approval/decided', { id, outcome })
}

function idOf(result: ProposeResult): ProposalId {
  if (result.kind === 'denied') throw new Error(`denied: ${result.reasons.join('; ')}`)
  return result.proposalId
}

const today = async (): Promise<readonly unknown[]> => (await desk.executor.orders()).today

describe('proposing an order', () => {
  it('checks, reserves, records, and summarizes a passing proposal', async () => {
    desk = await bootDesk()
    const result = await desk.executor.proposeOrder(buy(), context())
    if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`)
    expect(result.summary.split('\n')).toEqual([
      'PAPER Buy 0.0002 BTC/USD market gtc',
      'Estimated $12.57 (0.0% of equity); bid $62,830.00 / ask $62,835.00',
      'Price cap: sent as a limit order (ioc) at $63,463.35 so the fill stays within 1% of the approved price.',
      'Checks passed: halted (trading is not halted); symbol-list (BTC/USD is allowed); stale-quote (quote is at most 30 s old); '
        + 'stop-type (market order); shorting (not a short sale); order-notional (order $12.57 vs max $1,000.00); '
        + 'position-size (position 0.0% of equity vs max 20.0%); cash (needs $12.57 of $100,000.00 cash); '
        + 'daily-loss (day P&L 0.0% vs limit -3.0%); orders-per-day (0 of 20 orders today)',
      'Rationale: Testing the desk.',
    ])
    expect(desk.events('trading/proposal').map(event => event.data)).toMatchObject([{
      kind: 'order', proposalId: result.proposalId, callId: 'call-1', source: 'dsh-agent', mode: 'paper', reduceOnly: false,
      quote: { bid: 62_830, ask: 62_835 }, plan: { type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', capped: true },
    }])
    expect(desk.executor.proposalForCall(desk.session.id, ToolCallId('call-1'))).toBe(result.proposalId)
    expect(await today()).toEqual([
      { proposalId: result.proposalId, symbol: 'BTC/USD', side: 'buy', qty: 0.0002, status: 'proposed', filledQty: 0 },
    ])
  })

  it('denies a proposal that breaks a limit without recording it, and journals the risk result', async () => {
    desk = await bootDesk()
    const reasons = ['order-notional: order $62,835.00 vs max $1,000.00', 'position-size: position 62.8% of equity vs max 20.0%']
    expect(await desk.executor.proposeOrder(buy(1), context())).toEqual({ kind: 'denied', reasons })
    expect(desk.events('trading/proposal')).toEqual([])
    expect(await today()).toMatchObject([{ status: 'denied', note: reasons.join('; ') }])
  })

  it("checks concurrent proposals against each other's reservations", async () => {
    desk = await bootDesk({ config: { maxOrderNotional: 20_000 } })
    const results = await Promise.all([
      desk.executor.proposeOrder(buy(0.2), context('call-1')),
      desk.executor.proposeOrder(buy(0.2), context('call-2')),
    ])
    expect(results.map(result => result.kind).sort()).toEqual(['denied', 'pending'])
    expect(results.find(result => result.kind === 'denied'))
      .toEqual({ kind: 'denied', reasons: ['position-size: position 25.1% of equity vs max 20.0%'] })
  })

  it('validates broker rules and the price tick before checking risk', async () => {
    desk = await bootDesk()
    expect(await desk.executor.proposeOrder(buy(0.0002, { type: 'limit', limitPrice: 62_000.123 }), context()))
      .toEqual({ kind: 'denied', reasons: ['limit_price 62000.123 is not a multiple of the 0.01 price tick'] })
    expect(await desk.executor.proposeOrder(buy(0.0002, { type: 'stop', stopPrice: 63_000, timeInForce: 'day' }), context()))
      .toEqual({ kind: 'denied', reasons: [
        'crypto orders support market, limit, and stop_limit; use stop_limit instead of stop', 'crypto orders use gtc or ioc',
      ] })
    const stopBuy: ProposedOrder = {
      order: { symbol: { assetClass: 'equity', ticker: 'AAPL' }, side: 'buy', qty: 1, type: 'stop', stopPrice: 231, timeInForce: 'day' },
      rationale: 'Breakout entry.',
    }
    expect(await desk.executor.proposeOrder(stopBuy, context()))
      .toEqual({ kind: 'denied', reasons: ['stop-type: orders that add exposure must use stop_limit'] })
    expect(desk.events('trading/proposal')).toEqual([])
  })

  it('refuses while halted or blocked, before setup completed, and when the broker blocks the account', async () => {
    desk = await bootDesk()
    desk.venue.current = 'halted'
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [HALTED] })
    desk.venue.current = 'blocked'
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [BLOCKED] })
    desk.venue.current = 'unconfigured'
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [KEYS_MISSING] })
    desk.venue.current = 'ready'
    desk.venue.accountState = { ...desk.venue.accountState, tradingBlocked: true }
    expect(await desk.executor.proposeOrder(buy(), context())).toEqual({ kind: 'denied', reasons: [TRADING_BLOCKED] })
    desk.venue.keysMissing = true
    await expect(desk.executor.proposeOrder(buy(), context())).rejects.toThrow(KEYS_MISSING)
    expect(desk.executor.status()).toBe('ready')
  })

  it('frees the reservation when the proposal cannot be recorded', async () => {
    desk = await bootDesk({ config: { maxOrderNotional: 20_000 } })
    vi.spyOn(Journal.prototype, 'put').mockRejectedValueOnce(new Error('disk full'))
    await expect(desk.executor.proposeOrder(buy(0.2), context('call-1'))).rejects.toThrow('disk full')
    expect((await desk.executor.proposeOrder(buy(0.2), context('call-2'))).kind).toBe('pending')
  })

  it('returns the pending proposal for an identical MCP proposal, but not for the in-app agent', async () => {
    desk = await bootDesk()
    const mcp: ProposalContext = { session: desk.session, source: 'claude-code-mcp' }
    const first = idOf(await desk.executor.proposeOrder(buy(), mcp))
    expect(await desk.executor.proposeOrder(buy(), mcp)).toMatchObject({ kind: 'duplicate', proposalId: first })
    expect((await desk.executor.proposeOrder(buy(0.0003), mcp)).kind).toBe('pending')
    expect((await desk.executor.proposeOrder(buy(), context('call-1'))).kind).toBe('pending')
    expect((await desk.executor.proposeOrder(buy(), context('call-2'))).kind).toBe('pending')
  })
})

describe('executing a proposal', () => {
  it('submits only an approved, logged proposal, as a capped limit keyed by session and proposal', async () => {
    desk = await bootDesk()
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
    approve('call-1')
    await expect(desk.executor.execute(id, SessionId('another-session'))).rejects.toThrow(NO_CHECKED_PROPOSAL)
    const report = await desk.executor.execute(id, desk.session.id)
    const clientOrderId = createHash('sha256').update(`${desk.session.id}:${id}`).digest('hex')
    expect(desk.venue.submitted).toEqual([
      { symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', clientOrderId },
    ])
    expect(report).toEqual({
      proposalId: id, orderId: `order-${clientOrderId.slice(0, 8)}`, symbol: 'BTC/USD', side: 'buy', type: 'limit', qty: 0.0002,
      limitPrice: 63_463.35, timeInForce: 'ioc', status: 'open', filledQty: 0, capped: true,
    })
    expect(desk.events('trading/order').map(event => event.data))
      .toEqual([{ proposalId: id, outcome: 'submitted', orderId: report.orderId, status: 'open' }])
    expect(await today()).toMatchObject([{ status: 'submitted', orderId: report.orderId }])
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
  })

  it('releases the reservation and journals the refusal when the user says no', async () => {
    desk = await bootDesk({ config: { maxOrderNotional: 20_000 } })
    const first = idOf(await desk.executor.proposeOrder(buy(0.2), context('call-1')))
    approve('call-1', 'rejected')
    await vi.waitFor(async () => { expect(await today()).toMatchObject([{ status: 'rejected', note: 'approval rejected' }]) })
    expect((await desk.executor.proposeOrder(buy(0.2), context('call-2'))).kind).toBe('pending')
    await expect(desk.executor.execute(first, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
  })

  it('denies submission when the price moved past the tolerance or a limit fails after approval', async () => {
    desk = await bootDesk()
    const moved = idOf(await desk.executor.proposeOrder(buy(), context('call-1')))
    approve('call-1')
    desk.venue.quotes.set('BTC/USD', { bid: 63_700, ask: 63_705 })
    await expect(desk.executor.execute(moved, desk.session.id)).rejects.toThrow(/^price moved; propose again$/)
    desk.venue.quotes.set('BTC/USD', { bid: 62_830, ask: 62_835 })
    const losing = idOf(await desk.executor.proposeOrder(buy(), context('call-2')))
    approve('call-2')
    desk.venue.accountState = { ...desk.venue.accountState, equity: 96_000 }
    await expect(desk.executor.execute(losing, desk.session.id))
      .rejects.toThrow('price moved; propose again; daily-loss: day P&L -4.0% vs limit -3.0%')
    desk.venue.accountState = { ...desk.venue.accountState, equity: 100_000 }
    const halted = idOf(await desk.executor.proposeOrder(buy(), context('call-3')))
    approve('call-3')
    desk.venue.current = 'halted'
    await expect(desk.executor.execute(halted, desk.session.id)).rejects.toThrow(HALTED)
    expect(desk.venue.submitted).toEqual([])
    expect(desk.events('trading/order').map(event => event.data.outcome)).toEqual(['failed', 'failed', 'failed'])
  })

  it('sends a reduce-only exit as a market order and reads reduce-only from the re-check', async () => {
    desk = await bootDesk()
    desk.venue.held = [position]
    const exit = idOf(await desk.executor.proposeOrder(sell, context('call-1')))
    expect(desk.events('trading/proposal')[0]?.data).toMatchObject({ reduceOnly: true, plan: { type: 'market', capped: false } })
    approve('call-1')
    expect(await desk.executor.execute(exit, desk.session.id)).toMatchObject({ type: 'market', capped: false })
    const again = idOf(await desk.executor.proposeOrder(sell, context('call-2')))
    approve('call-2')
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'sell', qty: 0.001, type: 'limit', limitPrice: 70_000, timeInForce: 'gtc',
      clientOrderId: clientId('resting') })]
    await expect(desk.executor.execute(again, desk.session.id))
      .rejects.toThrow('price moved; propose again; 0.001 BTC/USD is held by open sell orders; cancel them first; '
        + 'shorting: this sell would open or extend a short position')
    // A reduce-only exit skips the position-size check, so equity can be 0; the share of equity must stay finite.
    desk.venue.open = []
    desk.venue.accountState = { ...desk.venue.accountState, equity: 0 }
    idOf(await desk.executor.proposeOrder(sell, context('call-3')))
    expect(desk.events('trading/proposal').at(-1)?.data).toMatchObject({ reduceOnly: true, equityPct: 0 })
  })

  it('says when resting sell orders or pending sell proposals hold the position a sell would exit', async () => {
    desk = await bootDesk()
    desk.venue.held = [position]
    expect((await desk.executor.proposeOrder(sell, context('call-1'))).kind).toBe('pending')
    expect(await desk.executor.proposeOrder(sell, context('call-2'))).toEqual({ kind: 'denied', reasons: [
      '0.001 BTC/USD is reserved by sell proposals awaiting approval; wait for their decision first',
      'shorting: this sell would open or extend a short position',
    ] })
    approve('call-1', 'rejected')
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'sell', qty: 0.001, type: 'limit', limitPrice: 70_000, timeInForce: 'gtc',
      clientOrderId: clientId('resting') })]
    expect(await desk.executor.proposeOrder(sell, context('call-3'))).toEqual({ kind: 'denied', reasons: [
      '0.001 BTC/USD is held by open sell orders; cancel them first',
      'shorting: this sell would open or extend a short position',
    ] })
  })

  it('reports a fill the submission result already carries exactly once', async () => {
    desk = await bootDesk()
    desk.venue.respond = request => acceptedOrder(request, { filledQty: 0.0002, filledAvgPrice: 62_833, status: 'filled' })
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    expect(await desk.executor.execute(id, desk.session.id)).toMatchObject({ status: 'filled', filledQty: 0.0002 })
    expect(desk.events('trading/fill').map(event => event.data))
      .toMatchObject([{ proposalId: id, fillQty: 0.0002, fillPrice: 62_833, filledQty: 0.0002, status: 'filled' }])
    expect(desk.injected).toHaveLength(1)
    expect(await today()).toMatchObject([{ status: 'filled', filledQty: 0.0002, filledAvgPrice: 62_833 }])
  })

  const streamed = (order: BrokerOrder): void => {
    desk.venue.emit({ kind: 'update', update: { event: 'other', order, t: 1 } })
  }

  it('keeps a broker final status when a later view of the same order disagrees', async () => {
    desk = await bootDesk()
    let placed: BrokerOrder | undefined
    desk.venue.respond = (request) => {
      placed = acceptedOrder(request, { filledQty: 0.0002, filledAvgPrice: 62_833, status: 'filled' })
      return placed
    }
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    await desk.executor.execute(id, desk.session.id)
    if (placed === undefined) throw new Error('the order was not placed')
    streamed({ ...placed, status: 'canceled' })
    streamed({ ...placed, status: 'open', filledQty: 0 })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(await today()).toMatchObject([{ status: 'filled', filledQty: 0.0002 }])
    expect(desk.events('trading/fill')).toHaveLength(1)
    expect(desk.injected).toHaveLength(1)
  })

  it('lets a broker view of the order correct a submission recorded as failed', async () => {
    desk = await bootDesk()
    desk.venue.respond = () => { throw new VenueError('insufficient buying power', 'rejected', 40310000) }
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow('insufficient buying power')
    expect(await today()).toMatchObject([{ status: 'failed' }])
    const clientOrderId = clientId(createHash('sha256').update(`${desk.session.id}:${id}`).digest('hex'))
    streamed(acceptedOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc',
      clientOrderId }))
    await vi.waitFor(async () => {
      expect(await today()).toMatchObject([{ status: 'submitted', orderId: `order-${clientOrderId.slice(0, 8)}` }])
    })
    expect((await today())[0]).not.toHaveProperty('note')
  })

  it('approves a proposal only through the approval of its own order tool call', async () => {
    desk = await bootDesk()
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1', 'allowed-once', 'get_quote')
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(NO_CHECKED_PROPOSAL)
    expect(desk.venue.submitted).toEqual([])
  })

  it('retries a crypto exit rejected for insufficient balance with the same client order id, and only an exit', async () => {
    desk = await bootDesk()
    desk.venue.held = [position]
    let failures = 1
    desk.venue.respond = (request) => {
      if (failures > 0) {
        failures -= 1
        throw new VenueError('insufficient balance for BTC (requested: 0.001, available: 0)', 'rejected')
      }
      return acceptedOrder(request)
    }
    const exit = idOf(await desk.executor.proposeOrder(sell, context('call-1')))
    approve('call-1')
    await desk.executor.execute(exit, desk.session.id)
    expect(desk.venue.submitted).toHaveLength(2)
    expect(desk.venue.submitted[0]?.clientOrderId).toBe(desk.venue.submitted[1]?.clientOrderId)
    failures = 5
    const stuck = idOf(await desk.executor.proposeOrder(sell, context('call-2')))
    approve('call-2')
    await expect(desk.executor.execute(stuck, desk.session.id)).rejects.toThrow('insufficient balance for BTC')
    expect(desk.venue.submitted).toHaveLength(5)
    failures = 1
    const entry = idOf(await desk.executor.proposeOrder(buy(), context('call-3')))
    approve('call-3')
    await expect(desk.executor.execute(entry, desk.session.id)).rejects.toThrow('insufficient balance for BTC')
    expect(desk.venue.submitted).toHaveLength(6)
  })

  it.each([
    [new VenueError('Alpaca did not confirm order x', 'unknown-outcome'), 'unknown',
      'the order outcome is unknown; check list_orders before proposing again'],
    [new VenueError('client_order_id must be unique', 'rejected', 40010001), 'unknown',
      'the broker reports this order id as already used but does not show the order; check list_orders before proposing again'],
    [new VenueError('insufficient buying power', 'rejected', 40310000), 'failed', 'insufficient buying power'],
  ] as const)('reports %s without claiming the order was not placed', async (error, outcome, message) => {
    desk = await bootDesk()
    desk.venue.respond = () => { throw error }
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(message)
    expect(desk.events('trading/order').map(event => event.data)).toEqual([{ proposalId: id, outcome, message }])
    expect(await today()).toMatchObject([{ status: outcome, note: message }])
  })

  // The unknown-outcome messages trading-alpaca's orders.ts throws; each names the 64-hex client order id.
  const ALPACA_UNKNOWN: readonly (readonly [string, (id: string) => string])[] = [
    ['an unconfirmed lookup', id => `Alpaca did not confirm order ${id}; check open orders before proposing again `
      + `(Alpaca returned order o-1 for client order id ${id})`],
    ['a reused id it cannot read', id => `Alpaca reports client order id ${id} as already used but no order with it could be read; `
      + 'check open orders before proposing again'],
    ['an accepted order it cannot read back', id => `Alpaca accepted order ${id} but it could not be read back`],
  ]
  it.each(ALPACA_UNKNOWN)('keeps the client order id out of the model text, events, and journal for %s', async (_case, text) => {
    desk = await bootDesk()
    desk.venue.respond = (request) => { throw new VenueError(text(request.clientOrderId), 'unknown-outcome') }
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    const message = 'the order outcome is unknown; check list_orders before proposing again'
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow(new Error(message))
    expect(desk.events('trading/order').map(event => event.data)).toEqual([{ proposalId: id, outcome: 'unknown', message }])
    expect(await today()).toMatchObject([{ status: 'unknown', note: message }])
    expect(renderOrders(await desk.executor.orders())).not.toMatch(/[0-9a-f]{64}/)
  })

  it('keeps a placed order reported as placed when the journal or session write afterwards fails', async () => {
    desk = await bootDesk()
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    // oxlint-disable-next-line typescript/unbound-method -- the spy's first call runs the saved method on the same journal
    const original = Journal.prototype.update
    // The first write marks the order in flight before it is sent; the second records the broker's answer.
    vi.spyOn(Journal.prototype, 'update').mockImplementationOnce(original).mockRejectedValueOnce(new Error('disk full'))
    vi.spyOn(desk.session, 'append').mockImplementationOnce(() => { throw new Error('log closed') })
    await expect(desk.executor.execute(id, desk.session.id)).resolves.toMatchObject({ status: 'open' })
    expect(desk.venue.submitted).toHaveLength(1)
  })

  it('sends nothing when the order cannot be journaled as in flight first', async () => {
    desk = await bootDesk()
    const id = idOf(await desk.executor.proposeOrder(buy(), context()))
    approve('call-1')
    vi.spyOn(Journal.prototype, 'update').mockRejectedValueOnce(new Error('disk full'))
    await expect(desk.executor.execute(id, desk.session.id)).rejects.toThrow('disk full')
    expect(desk.venue.submitted).toEqual([])
    expect(await today()).toMatchObject([{ status: 'failed', note: 'disk full' }])
  })

  it('cancels an open order only after approval', async () => {
    desk = await bootDesk()
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 62_000, timeInForce: 'gtc',
      clientOrderId: clientId('resting') }, { id: brokerId('order-9') })]
    expect(await desk.executor.proposeCancel({ orderId: brokerId('missing'), rationale: 'Stale.' }, context()))
      .toEqual({ kind: 'denied', reasons: ['no open order has id missing; call list_orders for the current ids'] })
    const result = await desk.executor.proposeCancel({ orderId: brokerId('order-9'), rationale: 'Stale.' }, context('call-1'))
    if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`)
    expect(result.summary).toBe('PAPER Cancel order order-9: buy 0.0002 BTC/USD limit at $62,000.00 gtc, filled 0\nRationale: Stale.')
    approve('call-1', 'allowed-once', 'cancel_order')
    // An accepted cancellation stays reported as accepted when the journal write afterwards fails.
    vi.spyOn(Journal.prototype, 'update').mockRejectedValueOnce(new Error('disk full'))
    expect(await desk.executor.execute(result.proposalId, desk.session.id))
      .toMatchObject({ orderId: 'order-9', status: 'cancel_requested', capped: false })
    expect(desk.venue.cancelled).toEqual(['order-9'])
    expect(desk.events('trading/order').map(event => event.data))
      .toEqual([{ proposalId: result.proposalId, outcome: 'cancelled', orderId: 'order-9' }])
    const failing = idOf(await desk.executor.proposeCancel({ orderId: brokerId('order-9'), rationale: 'Again.' }, context('call-2')))
    approve('call-2', 'allowed-once', 'cancel_order')
    desk.venue.cancelFailure = new VenueError('order is not cancelable', 'rejected')
    await expect(desk.executor.execute(failing, desk.session.id)).rejects.toThrow('order is not cancelable')
    desk.venue.cancelFailure = undefined
    const late = idOf(await desk.executor.proposeCancel({ orderId: brokerId('order-9'), rationale: 'Late.' }, context('call-3')))
    approve('call-3', 'allowed-once', 'cancel_order')
    desk.venue.current = 'halted'
    await expect(desk.executor.execute(late, desk.session.id)).rejects.toThrow(HALTED)
    expect(await desk.executor.proposeCancel({ orderId: brokerId('order-9'), rationale: 'Halted.' }, context('call-4')))
      .toEqual({ kind: 'denied', reasons: [HALTED] })
    desk.venue.current = 'blocked'
    expect(await desk.executor.proposeCancel({ orderId: brokerId('order-9'), rationale: 'Blocked.' }, context('call-5')))
      .toEqual({ kind: 'denied', reasons: [BLOCKED] })
  })
})

describe('reads', () => {
  it('serves quotes, the account, positions, and orders', async () => {
    desk = await bootDesk()
    expect(await desk.executor.quote('btcusd'))
      .toEqual({ symbol: 'BTC/USD', assetClass: 'crypto', bid: 62_830, ask: 62_835, mid: 62_832.5, ageSeconds: 0, marketOpen: true })
    desk.venue.quoteAgeMs = 5_000
    expect((await desk.executor.quote('AAPL')).ageSeconds).toBe(5)
    await expect(desk.executor.quote('??')).rejects.toThrow('symbol "??" is not a US stock ticker')
    expect(await desk.executor.account()).toEqual({
      mode: 'paper', status: 'ready', equity: 100_000, cash: 100_000, buyingPower: 100_000, dayPl: 0, dayPlPct: 0, tradingBlocked: false,
    })
    desk.venue.accountState = { equity: 101_000, cash: 50_000, lastEquity: 100_000, buyingPower: 50_000, tradingBlocked: false }
    expect(await desk.executor.account()).toMatchObject({ dayPl: 1_000, dayPlPct: 1 })
    desk.venue.accountState = { ...desk.venue.accountState, lastEquity: 0 }
    expect((await desk.executor.account()).dayPlPct).toBe(0)
    desk.venue.held = [{ ...position, qtyAvailable: 0.0005 }]
    expect(await desk.executor.positions()).toEqual([{ symbol: 'BTC/USD', qty: 0.001, qtyAvailable: 0.0005, avgEntryPrice: 60_000,
      currentPrice: 62_830, marketValue: 62.83, unrealizedPl: 2.83 }])
    desk.venue.open = [acceptedOrder({ symbol: btc, side: 'sell', qty: 0.001, type: 'stop_limit', limitPrice: 59_000, stopPrice: 59_500,
      timeInForce: 'gtc', clientOrderId: clientId('c-9') }, { id: brokerId('order-9') })]
    await desk.executor.proposeOrder(buy(1), context())
    expect(await desk.executor.orders()).toEqual({
      open: [{ orderId: 'order-9', symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', qty: 0.001, limitPrice: 59_000,
        stopPrice: 59_500, timeInForce: 'gtc', filledQty: 0, status: 'open' }],
      today: [expect.objectContaining({ symbol: 'BTC/USD', side: 'buy', qty: 1, status: 'denied', filledQty: 0 })],
    })
  })

  it('returns bars with warm-up, caps the window, and refuses a bad timeframe or limit', async () => {
    desk = await bootDesk()
    desk.venue.history = Array.from({ length: 3 }, (_, i) => ({ t: Date.UTC(2026, 9, 5, 10 + i), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }))
    expect(desk.executor.barWindow()).toEqual({ defaultCount: 100, cap: 500 })
    expect(await desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h', limit: 2 })).toMatchObject({ symbol: 'BTC/USD', count: 2 })
    await desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h' })
    await desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h', limit: 5_000, indicators: ['rsi'] })
    expect(desk.venue.barQueries.map(query => query.limit)).toEqual([62, 160, 560])
    await expect(desk.executor.bars({ symbol: 'BTC/USD', timeframe: '2h' }))
      .rejects.toThrow('timeframe must be one of 1m, 5m, 15m, 1h, 4h, 1D, 1W')
    await expect(desk.executor.bars({ symbol: 'BTC/USD', timeframe: '1h', limit: 0 }))
      .rejects.toThrow('limit must be a whole number of at least 1')
  })
})
