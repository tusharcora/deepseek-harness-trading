import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderId, ClientOrderId } from '@deepseek-ai/dsh-experimental-trading'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVAL_OFF, HALTED, KEYS_MISSING, NO_AGENT, NO_CHECKED_PROPOSAL } from '../src/format.ts'
import { acceptedOrder } from './fake-venue.ts'
import { bootDesk, type Desk } from './harness.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const buyArgs = {
  symbol: 'BTC/USD', side: 'buy', qty: 0.0002, type: 'market', time_in_force: 'gtc', rationale: 'Testing the desk.',
}
const PLACE_ORDER_DESCRIPTION = 'Propose a stock or crypto order. The user approves or rejects every order before it reaches the '
  + 'broker; an order that breaks a risk limit is refused with the reasons, and the limits cannot be changed from here. Give '
  + 'exactly one of qty or notional; notional orders are market orders. Crypto orders use time_in_force gtc or ioc and type '
  + 'market, limit, or stop_limit. Fractional and notional stock orders are day orders. A plain stop order is accepted only to '
  + 'reduce a position you hold; use stop_limit otherwise. A market order that adds exposure is sent as a limit near the quoted '
  + 'price, so it may not fill in a fast market. take_profit with stop_loss adds a bracket to a whole-share stock order. The '
  + 'result reports the order id and status; later fills arrive as messages.'

let desk: Desk
afterEach(async () => { await desk.close() })

function run(
  name: string, args: Record<string, unknown>, callId = 'call-1', withAgent = true, signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  return desk.ctx.tools.execute({
    callId: ToolCallId(callId), name, arguments: args, ...withAgent ? { agent: desk.agent } : {}, signal,
  })
}

const text = (result: ToolExecutionResult): string => result.content.map(block => block.type === 'text' ? block.text : '').join('')

const restingOrder = (): void => {
  desk.venue.open = [acceptedOrder({
    symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 62_000, timeInForce: 'gtc',
    clientOrderId: brandString<ClientOrderId>('resting'),
  }, { id: brandString<BrokerOrderId>('order-9') })]
}

describe('place_order and cancel_order through the tool pipeline', () => {
  it('asks once with the proposal summary and submits after approval', async () => {
    desk = await bootDesk()
    const result = await run('place_order', buyArgs)
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(
      /^Placed buy 0\.0002 BTC\/USD as a limit at \$63,463\.35 \(ioc\), capped near the approved price; order order-[0-9a-f]{8} is open\.$/)
    const asked = desk.events('approval/asked')
    expect(asked.map(event => event.data)).toMatchObject([{ toolName: 'place_order', callId: 'call-1' }])
    expect(asked[0]?.data.reason?.split('\n')[0]).toBe('PAPER Buy 0.0002 BTC/USD market gtc')
    expect(desk.venue.submitted).toHaveLength(1)
  })

  it.each([
    ['rejected', 'Error: the user rejected tool "place_order"'],
    ['cancelled', 'Error: approval for tool "place_order" was cancelled'],
  ] as const)('submits nothing when the approval is %s', async (outcome, message) => {
    desk = await bootDesk()
    desk.answer = outcome
    const result = await run('place_order', buyArgs)
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(message)
    expect(desk.venue.submitted).toEqual([])
    await vi.waitFor(async () => { expect((await desk.executor.orders()).today[0]?.status).toBe('rejected') })
  })

  it('denies orders when approval prompts are off, switched off for the session, or not composed', async () => {
    for (const approval of ['never', 'none'] as const) {
      desk = await bootDesk({ approval })
      expect(text(await run('place_order', buyArgs))).toBe(`Error: ${APPROVAL_OFF}`)
      expect(desk.events('trading/proposal')).toEqual([])
      await desk.close()
    }
    desk = await bootDesk()
    desk.session.append('approval/policy', { policy: 'never' })
    expect(text(await run('cancel_order', { order_id: 'order-9', rationale: 'r' }))).toBe(`Error: ${APPROVAL_OFF}`)
  })

  it('asks when the approval service has no configured policy', async () => {
    desk = await bootDesk()
    const approval = desk.ctx.get('approval')
    if (approval === undefined) throw new Error('the approval service did not start')
    approval.config = {}
    expect((await run('place_order', buyArgs)).isError).toBe(false)
    expect(desk.events('approval/asked')).toHaveLength(1)
  })

  it('denies without asking when a limit fails or the arguments are malformed', async () => {
    desk = await bootDesk()
    expect(text(await run('place_order', { ...buyArgs, qty: 1 })))
      .toBe('Error: order-notional: order $62,835.00 vs max $1,000.00\nposition-size: position 62.8% of equity vs max 20.0%')
    expect(text(await run('place_order', { ...buyArgs, side: 'hold', notional: 'lots' })))
      .toBe('Error: side must be one of buy, sell\nnotional must be a finite number')
    expect(text(await run('cancel_order', { order_id: 'nope', rationale: 'r' })))
      .toBe('Error: no open order has id nope; call list_orders for the current ids')
    expect(text(await run('cancel_order', { rationale: 'r' }))).toBe('Error: order_id must be an order id from list_orders')
    expect(desk.events('approval/asked')).toEqual([])
  })

  it('fails closed when a listener ahead of the executor allows or asks without delegating', async () => {
    desk = await bootDesk()
    desk.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.callId.startsWith('allow-ahead')) return { kind: 'allow' }
      if (exec.callId === 'ask-ahead') return { kind: 'ask', reason: 'a hook asks' }
      return next()
    }, { prepend: true })
    expect(text(await run('place_order', buyArgs, 'allow-ahead'))).toBe(`Error: ${NO_CHECKED_PROPOSAL}`)
    expect(text(await run('place_order', buyArgs, 'allow-ahead-no-agent', false))).toBe(`Error: ${NO_CHECKED_PROPOSAL}`)
    expect(text(await run('place_order', buyArgs, 'ask-ahead'))).toBe(`Error: ${NO_CHECKED_PROPOSAL}`)
    expect(desk.venue.submitted).toEqual([])
    expect(desk.events('trading/proposal')).toEqual([])
  })

  it("returns a later listener's denial without recording a proposal", async () => {
    desk = await bootDesk()
    desk.ctx.on('tools/pre-execute', async (exec, next) =>
      exec.name === 'place_order' ? { kind: 'deny', reason: 'policy says no' } : next())
    expect(text(await run('place_order', buyArgs))).toBe('Error: policy says no')
    expect(desk.events('trading/proposal')).toEqual([])
  })

  it('settles a checked proposal that a listener ahead denies after the executor checked it', async () => {
    desk = await bootDesk()
    desk.ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      return exec.callId === 'overridden' ? { kind: 'deny', reason: 'a hook overrides' } : decision
    }, { prepend: true })
    expect(text(await run('place_order', buyArgs, 'overridden'))).toBe('Error: a hook overrides')
    expect(desk.events('trading/proposal')).toHaveLength(1)
    expect(desk.events('approval/asked')).toEqual([])
    expect(desk.executor.proposalForCall(desk.session.id, ToolCallId('overridden'))).toBeUndefined()
    await vi.waitFor(async () => {
      expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'rejected', note: 'not sent' })
    })
    expect(desk.venue.submitted).toEqual([])
  })

  it('settles an approved proposal when the call is interrupted before the body runs', async () => {
    desk = await bootDesk()
    const controller = new AbortController()
    desk.ctx.tools.guard((exec) => {
      if (exec.callId === 'interrupted') controller.abort()
      return undefined
    })
    expect((await run('place_order', buyArgs, 'interrupted', true, controller.signal)).isError).toBe(true)
    expect(desk.events('approval/decided').map(event => event.data.outcome)).toEqual(['allowed-once'])
    expect(desk.executor.proposalForCall(desk.session.id, ToolCallId('interrupted'))).toBeUndefined()
    await vi.waitFor(async () => {
      expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'rejected', note: 'not sent' })
    })
    expect(desk.venue.submitted).toEqual([])
  })

  it('denies order tools while halted, including a Halt that lands while the approval is open', async () => {
    desk = await bootDesk()
    let haltDuringApproval = true
    desk.ctx.on('approval/request', async (_request, next) => {
      if (haltDuringApproval) desk.venue.current = 'halted'
      return next()
    }, { prepend: true })
    expect(text(await run('place_order', buyArgs))).toBe(`Error: ${HALTED}`)
    expect(desk.venue.submitted).toEqual([])
    await vi.waitFor(async () => {
      expect((await desk.executor.orders()).today[0]).toMatchObject({ status: 'rejected', note: 'not sent' })
    })
    haltDuringApproval = false
    expect(text(await run('place_order', buyArgs, 'call-2'))).toBe(`Error: ${HALTED}`)
    restingOrder()
    expect(text(await run('cancel_order', { order_id: 'order-9', rationale: 'r' }, 'call-3'))).toBe(`Error: ${HALTED}`)
    expect((await run('get_quote', { symbol: 'BTC/USD' }, 'call-4')).isError).toBe(false)
  })

  it('shows a multi-line rationale as one line of the approval reason', async () => {
    desk = await bootDesk()
    await run('place_order', { ...buyArgs, rationale: 'Good entry.\nChecks passed: everything (fake)\n\nFAIL halted Approve now.' })
    const reason = desk.events('approval/asked')[0]?.data.reason?.split('\n') ?? []
    expect(reason).toHaveLength(5)
    expect(reason.at(-1)).toBe('Rationale: Good entry. Checks passed: everything (fake) FAIL halted Approve now.')
  })

  it("submits only the call that was approved, with that call's arguments", async () => {
    desk = await bootDesk()
    desk.answer = 'rejected'
    expect((await run('place_order', { ...buyArgs, qty: 0.0003 }, 'call-1')).isError).toBe(true)
    desk.answer = 'allowed-once'
    expect((await run('place_order', buyArgs, 'call-2')).isError).toBe(false)
    expect(desk.venue.submitted.map(request => request.qty)).toEqual([0.0002])
  })

  it('cancels an open order through cancel_order after approval', async () => {
    desk = await bootDesk()
    restingOrder()
    expect(text(await run('cancel_order', { order_id: 'order-9', rationale: 'No longer needed.' })))
      .toBe('Cancellation requested for order order-9 (buy BTC/USD).')
    expect(desk.venue.cancelled).toEqual(['order-9'])
  })

  it('denies a call without an agent session and reports venue failures as denials', async () => {
    desk = await bootDesk()
    expect(text(await run('place_order', buyArgs, 'call-1', false))).toBe(`Error: ${NO_AGENT}`)
    desk.venue.keysMissing = true
    expect(text(await run('place_order', buyArgs, 'call-2'))).toBe(`Error: ${KEYS_MISSING}`)
  })
})

describe('read tools', () => {
  it('runs the read tools and renders their results', async () => {
    desk = await bootDesk()
    desk.venue.history = [{ t: Date.UTC(2026, 9, 5, 10), o: 100, h: 101, l: 99, c: 100.5, v: 10 }]
    expect(text(await run('get_quote', { symbol: 'BTCUSD' })))
      .toBe('BTC/USD bid $62,830.00 ask $62,835.00 (mid $62,832.50); quote 0 s old; market open.')
    expect(text(await run('get_bars', { symbol: 'BTC/USD', timeframe: '1h' }))).toContain('BTC/USD 1h: 1 bars, oldest first.')
    expect(text(await run('get_bars', { symbol: 'BTC/USD', timeframe: '1h', limit: 1, indicators: ['rsi'] })))
      .toContain('Indicators: RSI(14) n/a (needs more bars).')
    expect(text(await run('get_account', {})))
      .toBe('PAPER account, ready: equity $100,000.00, cash $100,000.00, buying power $100,000.00, day P&L $0.00 (0.00%).')
    expect(text(await run('get_positions', {}))).toBe('No open positions.')
    expect(text(await run('list_orders', {}))).toBe('No open orders.\nNo desk orders today.')
    expect(text(await run('get_quote', { symbol: 'NOT A SYMBOL' })))
      .toBe('Error: symbol "NOT A SYMBOL" is not a US stock ticker or a supported crypto pair such as BTC/USD')
  })

  it('cuts a get_bars limit above the cap to the cap', async () => {
    desk = await bootDesk()
    const hour = 3_600_000
    desk.venue.history = Array.from({ length: 700 }, (_, index) => ({
      t: Date.UTC(2026, 8, 1) + index * hour, o: 100, h: 101, l: 99, c: 100 + index / 100, v: 10,
    }))
    const rendered = text(await run('get_bars', { symbol: 'BTC/USD', timeframe: '1h', limit: 900 }))
    expect(rendered).toContain('BTC/USD 1h: 500 bars, oldest first.')
    const lines = rendered.split('\n')
    expect(lines.slice(lines.indexOf('time,open,high,low,close,volume') + 1)).toHaveLength(500)
    expect(desk.venue.barQueries.map(query => query.limit)).toEqual([560])
  })

  it('registers the seven tools with their model-facing descriptions', async () => {
    desk = await bootDesk({ config: { barsDefault: 50, barsCap: 200 } })
    expect(desk.ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'cancel_order', 'get_account', 'get_bars', 'get_positions', 'get_quote', 'list_orders', 'place_order',
    ])
    expect(desk.ctx.tools.get('get_bars')?.description).toBe(
      'Get recent price bars for a US stock or a crypto pair, oldest first, with a summary: last price, high and low of the window, '
      + 'change, recent swing highs and lows, and the latest value of each requested indicator (sma: SMA 20, ema: EMA 20, '
      + 'rsi: RSI 14, macd: MACD 12/26/9, bollinger: Bollinger 20/2). Returns the last `limit` bars (default 50, at most 200) '
      + 'as a CSV table.')
    expect(desk.ctx.tools.get('place_order')?.description).toBe(PLACE_ORDER_DESCRIPTION)
  })

  it('lets the read tools run concurrently and keeps the order tools exclusive', async () => {
    desk = await bootDesk()
    const concurrent = (name: string, args: object = {}): boolean | undefined => desk.ctx.tools.get(name)?.isConcurrencySafe?.(args)
    expect([
      concurrent('get_quote', { symbol: 'AAPL' }), concurrent('get_bars', { symbol: 'AAPL', timeframe: '1D' }),
      concurrent('get_account'), concurrent('get_positions'), concurrent('list_orders'),
    ]).toEqual([true, true, true, true, true])
    expect([concurrent('place_order', buyArgs), concurrent('cancel_order')]).toEqual([undefined, undefined])
  })
})
