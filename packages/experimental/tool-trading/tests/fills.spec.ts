import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, BrokerOrderRequest, ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { type Session, SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Journal } from '../src/journal.ts'
import { acceptedOrder } from './fake-venue.ts'
import { bootDesk, type Desk } from './harness.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
let desk: Desk
afterEach(async () => {
  vi.restoreAllMocks()
  await desk.close()
})

interface Placed { readonly proposalId: ProposalId; readonly request: BrokerOrderRequest; readonly orderId: BrokerOrderId }

async function placed(qty = 0.0002, callId = 'call-1', session: Session = desk.session): Promise<Placed> {
  const result = await desk.executor.proposeOrder(
    { order: { symbol: btc, side: 'buy', qty, type: 'market', timeInForce: 'gtc' }, rationale: 'Fill test.' },
    { session, source: 'dsh-agent', callId: ToolCallId(callId) },
  )
  if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`)
  const id = ApprovalRequestId(`approval-${callId}`)
  session.append('approval/asked', { id, toolName: 'place_order', callId: ToolCallId(callId) })
  session.append('approval/decided', { id, outcome: 'allowed-once' })
  const report = await desk.executor.execute(result.proposalId, session.id)
  const request = desk.venue.submitted.at(-1)
  if (request === undefined) throw new Error('nothing was submitted')
  return { proposalId: result.proposalId, request, orderId: brandString<BrokerOrderId>(report.orderId) }
}

const filledOrder = (order: Placed, filledQty = 0.0002, price = 62_831.5) =>
  acceptedOrder(order.request, { id: order.orderId, filledQty, filledAvgPrice: price, status: 'filled' })

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))

describe('fills from the order stream', () => {
  it('records a streamed fill once, in the journal and the session, and tells the proposing agent', async () => {
    desk = await bootDesk()
    const order = await placed()
    const update = { kind: 'update', update: { event: 'fill', order: filledOrder(order), t: Date.UTC(2026, 9, 5, 14),
      fillPrice: 62_831.5, fillQty: 0.0002 } } as const
    desk.venue.emit(update)
    desk.venue.emit(update)
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    await settle()
    expect(desk.events('trading/fill').map(event => event.data)).toEqual([{
      proposalId: order.proposalId, orderId: order.orderId, ticker: 'BTC/USD', side: 'buy', fillQty: 0.0002, fillPrice: 62_831.5,
      filledQty: 0.0002, filledAvgPrice: 62_831.5, status: 'filled', t: Date.UTC(2026, 9, 5, 14),
    }])
    expect(desk.injected.map(message => message.content)).toEqual([[{ type: 'text',
      text: `Order update: your buy of BTC/USD (order ${order.orderId}) filled 0.0002 at $62,831.50; `
        + '0.0002 filled in total, order filled.' }]])
    expect(desk.injected[0]?.source).toEqual({ kind: 'plugin', plugin: '@deepseek-ai/dsh-experimental-tool-trading' })
    await desk.executor.reconcile()
    expect(desk.events('trading/fill')).toHaveLength(1)
    expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'filled', filledQty: 0.0002, filledAvgPrice: 62_831.5 })
  })

  it('records a fill that streams in before the submission resolves exactly once', async () => {
    desk = await bootDesk()
    desk.venue.respond = (request) => {
      // Alpaca's trade stream can deliver the fill before the POST that placed the order returns.
      desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 1, fillPrice: 62_831.5, fillQty: 0.0002,
        order: acceptedOrder(request, { filledQty: 0.0002, filledAvgPrice: 62_831.5, status: 'filled' }) } })
      return acceptedOrder(request)
    }
    const order = await placed()
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    await desk.executor.reconcile()
    desk.venue.emit({ kind: 'gap', reason: 'the order-update stream reconnected' })
    await settle()
    expect(desk.events('trading/fill')).toHaveLength(1)
    expect(desk.injected).toHaveLength(1)
    expect((await desk.executor.orders()).today[0])
      .toMatchObject({ status: 'filled', filledQty: 0.0002, filledAvgPrice: 62_831.5, orderId: order.orderId })
  })

  it('keeps a streamed fill when the submission then fails with an unknown outcome', async () => {
    desk = await bootDesk()
    desk.venue.respond = (request) => {
      desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 1, fillPrice: 62_831.5, fillQty: 0.0002,
        order: acceptedOrder(request, { filledQty: 0.0002, filledAvgPrice: 62_831.5, status: 'filled' }) } })
      throw new VenueError('Alpaca did not confirm order', 'unknown-outcome')
    }
    await expect(placed()).rejects.toThrow('the order outcome is unknown')
    await desk.executor.reconcile()
    expect(desk.events('trading/fill')).toHaveLength(1)
    expect(desk.injected).toHaveLength(1)
    const [row] = (await desk.executor.orders()).today
    expect(row).toMatchObject({ status: 'filled', filledQty: 0.0002 })
    expect(row?.note).toMatch(/^the order outcome is unknown/)
  })

  it('keeps a streamed open order when the submission then fails with an unknown outcome', async () => {
    desk = await bootDesk()
    desk.venue.respond = (request) => {
      desk.venue.emit({ kind: 'update', update: { event: 'new', t: 1, order: acceptedOrder(request) } })
      throw new VenueError('Alpaca did not confirm order', 'unknown-outcome')
    }
    await expect(placed()).rejects.toThrow('the order outcome is unknown')
    const [row] = (await desk.executor.orders()).today
    expect(row?.status).toBe('submitted')
    expect(row?.note).toMatch(/^the order outcome is unknown/)
  })

  it('records partial fills as they arrive and then the final fill', async () => {
    desk = await bootDesk()
    const order = await placed(0.0004)
    desk.venue.emit({ kind: 'update', update: { event: 'partial_fill', t: 1, fillPrice: 62_830, fillQty: 0.0001,
      order: acceptedOrder(order.request, { id: order.orderId, filledQty: 0.0001, filledAvgPrice: 62_830, status: 'partially_filled' }) } })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 2, fillPrice: 62_831, fillQty: 0.0003,
      order: filledOrder(order, 0.0004, 62_830.75) } })
    await vi.waitFor(() => {
      expect(desk.events('trading/fill').map(event => [event.data.fillQty, event.data.status]))
        .toEqual([[0.0001, 'partially_filled'], [0.0003, 'filled']])
    })
  })

  it('reports the whole new quantity at the average price when the update describes a different or unpriced fill', async () => {
    desk = await bootDesk()
    const order = await placed(0.0004)
    // A missed partial fill: the update's own fill is smaller than what the journal has not recorded yet.
    desk.venue.emit({ kind: 'update', update: { event: 'partial_fill', t: 1, fillPrice: 62_831, fillQty: 0.0001,
      order: acceptedOrder(order.request, { id: order.orderId, filledQty: 0.0002, filledAvgPrice: 62_830, status: 'partially_filled' }) } })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 2, fillPrice: Number.NaN, fillQty: 0.0002,
      order: filledOrder(order, 0.0004, 62_831) } })
    await vi.waitFor(() => {
      expect(desk.events('trading/fill').map(event => [event.data.fillQty, event.data.fillPrice, event.data.t]))
        .toEqual([[0.0002, 62_830, 1], [0.0002, 62_831, 2]])
    })
  })

  it('never writes a non-finite filled quantity or average price into the journal', async () => {
    desk = await bootDesk()
    const order = await placed()
    desk.venue.emit({ kind: 'update', update: { event: 'partial_fill', t: 1, fillQty: Number.NaN, order: acceptedOrder(order.request,
      { id: order.orderId, filledQty: Number.NaN, filledAvgPrice: Number.POSITIVE_INFINITY, status: 'partially_filled' }) } })
    await vi.waitFor(async () => {
      expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'partially_filled', filledQty: 0 })
    })
    expect((await desk.executor.orders()).today[0]).not.toHaveProperty('filledAvgPrice')
    expect(desk.events('trading/fill')).toEqual([])
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 2 } })
    await vi.waitFor(() => { expect(desk.events('trading/fill').map(event => event.data.fillQty)).toEqual([0.0002]) })
  })

  it('recovers a fill missed while the stream was down and never moves an order back to open', async () => {
    desk = await bootDesk()
    const order = await placed()
    desk.venue.known.set(order.request.clientOrderId, filledOrder(order))
    desk.venue.emit({ kind: 'gap', reason: 'the order-update stream reconnected' })
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    expect(desk.events('trading/fill')[0]?.data).toMatchObject({ fillQty: 0.0002, fillPrice: 62_831.5, status: 'filled' })
    desk.venue.emit({ kind: 'update', update: { event: 'new', order: acceptedOrder(order.request, { id: order.orderId }), t: 3 } })
    await settle()
    expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'filled', filledQty: 0.0002 })
  })

  it('reads an order that is still open from the open orders without looking it up', async () => {
    desk = await bootDesk()
    const order = await placed(0.0004)
    desk.venue.known.clear()
    desk.venue.open = [acceptedOrder(order.request, { id: order.orderId, filledQty: 0.0001, filledAvgPrice: 62_830,
      status: 'partially_filled' })]
    await desk.executor.reconcile()
    expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'partially_filled', filledQty: 0.0001 })
    expect(desk.events('trading/fill').map(event => event.data.fillQty)).toEqual([0.0001])
  })

  it('reconciles on the timer when no gap is reported', async () => {
    desk = await bootDesk({ config: { reconcileMs: 1_000 } })
    const order = await placed()
    desk.venue.known.set(order.request.clientOrderId, filledOrder(order))
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) }, { timeout: 3_000 })
  })

  it('marks an order the broker never received as not placed instead of resubmitting it', async () => {
    desk = await bootDesk()
    desk.venue.respond = () => { throw new VenueError('Alpaca did not confirm order', 'unknown-outcome') }
    await expect(placed()).rejects.toThrow('the order outcome is unknown')
    await desk.executor.reconcile()
    expect((await desk.executor.orders()).today[0])
      .toMatchObject({ status: 'failed', note: 'the broker has no order with this id, so it was not placed' })
    expect(desk.venue.submitted).toHaveLength(1)
  })

  it('never marks an order the broker already reported as not placed', async () => {
    desk = await bootDesk()
    await placed()
    desk.venue.known.clear()
    await desk.executor.reconcile()
    expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'submitted' })
    expect((await desk.executor.orders()).today[0]).not.toHaveProperty('note')
  })
})

describe('fills after a restart and without a live agent', () => {
  it('reconciles in-flight orders at startup and tells the agent of the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-restart-'))
    try {
      desk = await bootDesk({ root })
      const order = await placed()
      await desk.close()
      desk = await bootDesk({ root, prepare: (venue) => { venue.known.set(order.request.clientOrderId, filledOrder(order)) } })
      await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]?.status).toBe('filled') })
      await vi.waitFor(() => { expect(desk.injected).toHaveLength(1) })
      expect(desk.events('trading/fill')).toHaveLength(1)
    } finally {
      await desk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('journals the fill but records no event when the proposing session is not live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-trading-restart-'))
    try {
      desk = await bootDesk({ root })
      const order = await placed()
      await desk.close()
      desk = await bootDesk({ root, sessionId: 'another-session',
        prepare: (venue) => { venue.known.set(order.request.clientOrderId, filledOrder(order)) } })
      await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]?.status).toBe('filled') })
      expect(desk.events('trading/fill')).toEqual([])
      expect(desk.injected).toEqual([])
    } finally {
      await desk.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records fills without telling an agent for Claude Code proposals or sessions without a live agent', async () => {
    desk = await bootDesk()
    const order = await placed()
    // The notice decision reads the source of the entry the fold just wrote.
    // oxlint-disable-next-line typescript/unbound-method -- the spy calls the saved method with its original receiver.
    const original = Journal.prototype.update
    vi.spyOn(Journal.prototype, 'update').mockImplementation(async function (this: Journal, ...args: Parameters<Journal['update']>) {
      return { ...await original.apply(this, args), source: 'claude-code-mcp' }
    })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 1 } })
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    expect(desk.events('trading/fill')[0]?.data).toMatchObject({ fillQty: 0.0002, fillPrice: 62_831.5, t: 1 })
    vi.restoreAllMocks()
    const loose = desk.ctx.sessions.create(SessionId('no-agent-session'))
    const second = await placed(0.0002, 'call-2', loose)
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(second), t: 2 } })
    await vi.waitFor(() => { expect(loose.snapshotEvents().filter(event => event.type === 'trading/fill')).toHaveLength(1) })
    expect(desk.injected).toEqual([])
  })

  it('ignores updates for orders the desk did not place and keeps going after failures', async () => {
    desk = await bootDesk()
    desk.venue.emit({ kind: 'update', update: { event: 'fill', t: 1, order: acceptedOrder({ symbol: btc, side: 'buy', qty: 1,
      type: 'market', timeInForce: 'gtc', clientOrderId: brandString<ClientOrderId>('elsewhere') }, { filledQty: 1, status: 'filled' }) } })
    const order = await placed()
    vi.spyOn(desk.agent, 'inject').mockImplementation(() => { throw new Error('agent disposed') })
    vi.spyOn(Journal.prototype, 'update').mockRejectedValueOnce(new Error('disk full'))
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 2 } })
    desk.venue.emit({ kind: 'update', update: { event: 'fill', order: filledOrder(order), t: 2 } })
    await vi.waitFor(() => { expect(desk.events('trading/fill')).toHaveLength(1) })
    expect(desk.events('trading/fill')[0]?.data).toMatchObject({ fillQty: 0.0002, fillPrice: 62_831.5 })
    await placed(0.0002, 'call-2')
    desk.venue.keysMissing = true
    desk.venue.emit({ kind: 'gap', reason: 'reconnected' })
    await settle()
    desk.venue.keysMissing = false
    await expect(desk.executor.reconcile()).resolves.toBeUndefined()
  })

  it('stops following the order stream when the executor is disposed', async () => {
    desk = await bootDesk()
    expect(desk.venue.listenerCount).toBe(1)
    await desk.close()
    expect(desk.venue.listenerCount).toBe(0)
  })
})
