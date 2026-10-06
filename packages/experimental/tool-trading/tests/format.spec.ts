import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrder, BrokerOrderId, ClientOrderId, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { describe, expect, it } from 'vitest'
import {
  bounded, cancelSummary, compact, describeOrder, failureOf, fillText, isInsufficientBalance, proposalSummary, renderAccount,
  renderOrderReport, renderOrders, renderPositions, renderQuote,
} from '../src/format.ts'
import type { TradingOrderProposal } from '../src/types.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const pid = brandString<ProposalId>('p-1')
const proposalId = (id: string): ProposalId => brandString<ProposalId>(id)
const orderId = (id: string): BrokerOrderId => brandString<BrokerOrderId>(id)

const proposal = (overrides: Partial<TradingOrderProposal>): TradingOrderProposal => ({
  kind: 'order', proposalId: pid, source: 'dsh-agent', mode: 'paper',
  order: { symbol: btc, side: 'buy', qty: 0.0002, type: 'market', timeInForce: 'gtc' }, rationale: 'Because.',
  quote: { bid: 62_830, ask: 62_835 }, marketOpen: true, referencePrice: 62_835, estimatedNotional: 12.567, equityPct: 0.000126,
  reduceOnly: false, plan: { type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', capped: true }, priceIncrement: 0.01,
  checks: [{ id: 'halted', ok: true, detail: 'trading is not halted' }], ...overrides,
})

describe('order descriptions and summaries', () => {
  it('describes sizes, prices, and brackets', () => {
    expect(describeOrder({ symbol: btc, side: 'buy', qty: 0.0002, type: 'market', timeInForce: 'gtc' }))
      .toBe('Buy 0.0002 BTC/USD market gtc')
    expect(describeOrder({ symbol: btc, side: 'sell', notional: 25, type: 'market', timeInForce: 'ioc' }))
      .toBe('Sell $25.00 of BTC/USD market ioc')
    expect(describeOrder({
      symbol: aapl, side: 'buy', qty: 2, type: 'stop_limit', limitPrice: 231, stopPrice: 230, timeInForce: 'day',
      bracket: { takeProfit: 250, stopLoss: 220 },
    })).toBe('Buy 2 AAPL stop_limit at $231.00 stop $230.00 day, take profit $250.00, stop loss $220.00')
  })

  it('states the price cap or why there is none, and a closed market', () => {
    const line = (p: TradingOrderProposal): string | undefined => proposalSummary(p, 0.01).split('\n')[2]
    expect(line(proposal({})))
      .toBe('Price cap: sent as a limit order (ioc) at $63,463.35 so the fill stays within 1% of the approved price.')
    expect(line(proposal({ order: { symbol: btc, side: 'buy', qty: 0.0002, type: 'limit', limitPrice: 62_000, timeInForce: 'gtc' },
      plan: { type: 'limit', limitPrice: 62_000, timeInForce: 'gtc', capped: false } })))
      .toBe('No price cap needed: a limit order carries its own price.')
    expect(line(proposal({ order: { symbol: btc, side: 'buy', notional: 25, type: 'market', timeInForce: 'gtc' },
      plan: { type: 'market', timeInForce: 'gtc', capped: false } }))).toBe('No price cap: the notional amount caps the cost.')
    expect(line(proposal({ order: { symbol: btc, side: 'sell', qty: 0.001, type: 'market', timeInForce: 'gtc' }, reduceOnly: true,
      plan: { type: 'market', timeInForce: 'gtc', capped: false } })))
      .toBe('No price cap: a reduce-only exit is sent as a market order so it fills in a fast move.')
    expect(line(proposal({ plan: { type: 'limit', timeInForce: 'ioc', capped: true } })))
      .toBe('Price cap: sent as a limit order (ioc) at $0.00 so the fill stays within 1% of the approved price.')
    expect(proposalSummary(proposal({ order: { symbol: aapl, side: 'buy', qty: 1, type: 'limit', limitPrice: 230, timeInForce: 'day' },
      plan: { type: 'limit', limitPrice: 230, timeInForce: 'day', capped: false }, marketOpen: false }), 0.01).split('\n'))
      .toEqual([
        'PAPER Buy 1 AAPL limit at $230.00 day',
        'Estimated $12.57 (0.0% of equity); bid $62,830.00 / ask $62,835.00',
        'No price cap needed: a limit order carries its own price.',
        'The market is closed: the order is queued until market open.',
        'Checks passed: halted (trading is not halted)',
        'Rationale: Because.',
      ])
  })

  it('summarizes a cancellation and a fill', () => {
    const order: BrokerOrder = {
      id: orderId('order-9'), clientOrderId: brandString<ClientOrderId>('c'), symbol: btc, side: 'buy', type: 'limit', timeInForce: 'gtc',
      qty: 0.0002, limitPrice: 62_000, filledQty: 0, status: 'open',
    }
    expect(cancelSummary({ kind: 'cancel', proposalId: pid, source: 'dsh-agent', mode: 'live', order, rationale: 'Stale.' }))
      .toBe('LIVE Cancel order order-9: buy 0.0002 BTC/USD limit at $62,000.00 gtc, filled 0\nRationale: Stale.')
    const fill = { proposalId: pid, orderId: order.id, ticker: 'BTC/USD', side: 'buy', fillQty: 0.0001, filledQty: 0.0001,
      status: 'partially_filled', t: 1 } as const
    expect(fillText({ ...fill, fillPrice: 62_000 }))
      .toBe('Order update: your buy of BTC/USD (order order-9) filled 0.0001 at $62,000.00; 0.0001 filled in total, '
        + 'order partially filled.')
    expect(fillText(fill)).toContain('filled 0.0001 at an unreported price;')
  })
})

describe('failures', () => {
  it('maps venue failures to what the model is told', () => {
    expect(failureOf(new VenueError('lost', 'unknown-outcome')))
      .toEqual({ outcome: 'unknown', message: 'the order outcome is unknown; check list_orders before proposing again' })
    expect(failureOf(new VenueError('client_order_id must be unique', 'rejected', 40010001))).toEqual({
      outcome: 'unknown',
      message: 'the broker reports this order id as already used but does not show the order; check list_orders before proposing again',
    })
    expect(failureOf(new VenueError('insufficient buying power', 'rejected', 40310000)))
      .toEqual({ outcome: 'failed', message: 'insufficient buying power' })
    expect(failureOf('plain text')).toEqual({ outcome: 'failed', message: 'plain text' })
    expect(bounded('short')).toBe('short')
    expect(bounded('y'.repeat(301))).toBe(`${'y'.repeat(300)}…`)
    expect(isInsufficientBalance(new VenueError('insufficient balance for BTC', 'rejected'))).toBe(true)
    expect(isInsufficientBalance(new VenueError('insufficient balance for BTC', 'unavailable'))).toBe(false)
    expect(isInsufficientBalance(new Error('insufficient balance'))).toBe(false)
  })

  it('drops undefined fields', () => {
    expect(compact<{ a: number; b?: number }>({ a: 1, b: undefined })).toEqual({ a: 1 })
  })
})

describe('renderers', () => {
  it('renders quotes, the account, positions, orders, and order reports', () => {
    const quote = {
      symbol: 'BTC/USD', assetClass: 'crypto', bid: 62_830, ask: 62_835, mid: 62_832.5, ageSeconds: 0, marketOpen: true,
    } as const
    expect(renderQuote(quote)).toBe('BTC/USD bid $62,830.00 ask $62,835.00 (mid $62,832.50); quote 0 s old; market open.')
    expect(renderQuote({ ...quote, marketOpen: false })).toContain('market closed — new orders queue until it opens.')
    const account = { mode: 'paper', status: 'ready', equity: 100_000, cash: 100_000, buyingPower: 100_000, dayPl: 0, dayPlPct: 0,
      tradingBlocked: false } as const
    expect(renderAccount(account))
      .toBe('PAPER account, ready: equity $100,000.00, cash $100,000.00, buying power $100,000.00, day P&L $0.00 (0.00%).')
    expect(renderAccount({ ...account, tradingBlocked: true })).toMatch(/ The broker blocks trading on this account\.$/)
    expect(renderPositions([])).toBe('No open positions.')
    expect(renderPositions([{ symbol: 'BTC/USD', qty: 0.001, qtyAvailable: 0.0005, avgEntryPrice: 60_000, currentPrice: 62_830,
      marketValue: 62.83, unrealizedPl: 2.83 }])).toBe(
      'BTC/USD: qty 0.001 (0.0005 available), average entry $60,000.00, now $62,830.00, value $62.83, unrealized $2.83')
    expect(renderOrders({ open: [], today: [] })).toBe('No open orders.\nNo desk orders today.')
    expect(renderOrders({ open: [], today: [{ proposalId: proposalId('p-3'), symbol: 'AAPL', side: 'sell', status: 'proposed',
      filledQty: 0 }] })).toBe('No open orders.\nDesk orders today:\n- p-3: sell $0.00 of AAPL: proposed, 0 filled')
    expect(renderOrders({
      open: [{ orderId: orderId('order-9'), symbol: 'BTC/USD', side: 'sell', type: 'stop_limit', qty: 0.001, limitPrice: 59_000,
        stopPrice: 59_500, timeInForce: 'gtc', filledQty: 0, status: 'open' }],
      today: [
        { proposalId: pid, symbol: 'BTC/USD', side: 'buy', qty: 0.0002, status: 'filled', filledQty: 0.0002, filledAvgPrice: 62_831.5,
          orderId: orderId('order-1') },
        { proposalId: proposalId('p-2'), symbol: 'AAPL', side: 'buy', notional: 50, status: 'denied', filledQty: 0,
          note: 'cash: needs more' },
      ],
    })).toBe([
      'Open orders:',
      '- order-9: sell 0.001 BTC/USD stop_limit at $59,000.00 stop $59,500.00 gtc, filled 0, open',
      'Desk orders today:',
      '- p-1: buy 0.0002 BTC/USD: filled, 0.0002 filled at $62,831.50 (order order-1)',
      '- p-2: buy $50.00 of AAPL: denied, 0 filled — cash: needs more',
    ].join('\n'))
    const report = { proposalId: pid, orderId: orderId('order-1'), symbol: 'BTC/USD', side: 'buy', type: 'limit', qty: 0.0002,
      limitPrice: 63_463.35, timeInForce: 'ioc', status: 'open', filledQty: 0, capped: true } as const
    expect(renderOrderReport(report))
      .toBe('Placed buy 0.0002 BTC/USD as a limit at $63,463.35 (ioc), capped near the approved price; order order-1 is open.')
    expect(renderOrderReport({ proposalId: pid, orderId: orderId('order-1'), symbol: 'BTC/USD', side: 'buy', type: 'market', notional: 50,
      timeInForce: 'ioc', status: 'filled', filledQty: 0.0008, filledAvgPrice: 62_500, capped: false }))
      .toBe('Placed buy $50.00 of BTC/USD market (ioc); order order-1 is filled; 0.0008 filled at $62,500.00.')
    expect(renderOrderReport({ proposalId: pid, orderId: orderId('order-1'), symbol: 'BTC/USD', side: 'sell', type: 'stop', qty: 1,
      stopPrice: 60_000, timeInForce: 'gtc', status: 'partially_filled', filledQty: 0.5, capped: false }))
      .toBe('Placed sell 1 BTC/USD stop stop $60,000.00 (gtc); order order-1 is partially filled; 0.5 filled.')
    expect(renderOrderReport({ ...report, status: 'cancel_requested' })).toBe('Cancellation requested for order order-1 (buy BTC/USD).')
  })
})
