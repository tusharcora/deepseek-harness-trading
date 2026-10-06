import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrokerOrderRequest, ClientOrderId, OrderRequest, ProposalId } from '@deepseek-ai/dsh-experimental-trading'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalBook } from '../src/book.ts'
import {
  brokerRequest, drifted, heldBySells, openBuyNotional, openExposure, planOrder, remainingQty, takeSnapshot,
} from '../src/snapshot.ts'
import type { TradingOrderProposal } from '../src/types.ts'
import FakeVenue, { acceptedOrder } from './fake-venue.ts'

const btc = { assetClass: 'crypto', ticker: 'BTC/USD' } as const
const aapl = { assetClass: 'equity', ticker: 'AAPL' } as const
const cid = brandString<ClientOrderId>('c')
const request = (overrides: Partial<BrokerOrderRequest>): BrokerOrderRequest =>
  ({ symbol: btc, side: 'buy', type: 'limit', timeInForce: 'gtc', clientOrderId: cid, ...overrides })

let ctx: Context
let venue: FakeVenue
beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(FakeVenue)
  venue = ctx.get('tradingVenue') as FakeVenue
})
afterEach(async () => { await ctx.fiber.dispose() })

describe('takeSnapshot', () => {
  it('reads account, position, open orders, reservations, and the day count in one snapshot', async () => {
    venue.held = [{ symbol: btc, qty: 0.01, qtyAvailable: 0.01, avgEntryPrice: 60_000, currentPrice: 62_830, marketValue: 628.3,
      unrealizedPl: 28.3 }]
    venue.open = [
      acceptedOrder(request({ qty: 0.002, limitPrice: 60_000 }), { filledQty: 0.001 }),
      acceptedOrder(request({ side: 'sell', qty: 0.003, limitPrice: 70_000 })),
      acceptedOrder(request({ symbol: aapl, type: 'market', notional: 500, timeInForce: 'day' })),
      acceptedOrder(request({ symbol: aapl, type: 'market', qty: 1, timeInForce: 'day' })),
    ]
    const book = new ProposalBook()
    const pending: TradingOrderProposal = {
      kind: 'order', proposalId: brandString<ProposalId>('p1'), source: 'dsh-agent', mode: 'paper',
      order: { symbol: btc, side: 'buy', qty: 0.004, type: 'market', timeInForce: 'gtc' }, rationale: 'r',
      quote: { bid: 1, ask: 1 }, marketOpen: true, referencePrice: 62_500, estimatedNotional: 250, equityPct: 0,
      reduceOnly: false, plan: { type: 'market', timeInForce: 'gtc', capped: false }, priceIncrement: 0.01, checks: [],
    }
    book.add(pending, SessionId('s'), { ticker: 'BTC/USD', side: 'buy', qty: 0.004, notional: 250 })
    const days: string[] = []
    const journal = { submittedOn: (day: string) => { days.push(day); return 2 } }
    const now = Date.UTC(2026, 9, 5, 14)
    const snapshot = await takeSnapshot(btc, { venue, book, journal, now })
    expect(days).toEqual(['2026-10-05'])
    expect(snapshot.risk).toMatchObject({
      now, marketOpen: true, equity: 100_000, cash: 100_000, lastEquity: 100_000, ordersToday: 3, halted: false,
      exposure: { positionQty: 0.01, openSellQty: 0.003, pendingBuyQty: 0.004, pendingSellQty: 0 },
    })
    expect(snapshot.risk.exposure.openBuyQty).toBeCloseTo(0.001, 10)
    expect(snapshot.risk.committedBuyNotional).toBeCloseTo(60 + 500 + 250, 6)
    const excluded = await takeSnapshot(btc, { venue, book, journal, now, excluding: brandString<ProposalId>('p1') })
    expect(excluded.risk).toMatchObject({ ordersToday: 2, exposure: { pendingBuyQty: 0 } })
    venue.current = 'halted'
    expect((await takeSnapshot(aapl, { venue, book, journal, now })).risk).toMatchObject({ halted: true, exposure: { positionQty: 0 } })
  })
})

describe('order math', () => {
  it('measures remaining quantity and open buy value', () => {
    const notional = acceptedOrder(request({ type: 'market', notional: 100 }), { filledQty: 0.5 })
    expect(remainingQty(acceptedOrder(request({ qty: 3 }), { filledQty: 1 }), 0)).toBe(2)
    expect(remainingQty(notional, 50)).toBe(1.5)
    expect(remainingQty(notional, 0)).toBe(0)
    expect(openExposure([acceptedOrder(request({ qty: 1, limitPrice: 10 }))], 'AAPL', 10)).toEqual({ openBuyQty: 0, openSellQty: 0 })
    expect(openBuyNotional([
      acceptedOrder(request({ type: 'market', notional: 100 }), { filledQty: 1, filledAvgPrice: 40 }),
      acceptedOrder(request({ type: 'stop', qty: 2, stopPrice: 30 })),
      acceptedOrder(request({ side: 'sell', qty: 5, limitPrice: 1_000 })),
    ])).toBe(60 + 60)
  })

  it('explains a sell the position covers but resting sells or pending sell proposals already claim', () => {
    const sell: OrderRequest = { symbol: btc, side: 'sell', qty: 0.001, type: 'market', timeInForce: 'gtc' }
    const exposure = { positionQty: 0.001, openBuyQty: 0, openSellQty: 0.001, pendingBuyQty: 0, pendingSellQty: 0 }
    expect(heldBySells(sell, 0.001, exposure)).toEqual(['0.001 BTC/USD is held by open sell orders; cancel them first'])
    expect(heldBySells(sell, 0.001, { ...exposure, openSellQty: 0.0004, pendingSellQty: 0.0003 })).toEqual([
      '0.0004 BTC/USD is held by open sell orders; cancel them first',
      '0.0003 BTC/USD is reserved by sell proposals awaiting approval; wait for their decision first',
    ])
    expect(heldBySells(sell, 0.001, { ...exposure, openSellQty: 0 })).toEqual([])
    expect(heldBySells(sell, 0.001, { ...exposure, openSellQty: 0, pendingSellQty: 0.001 })).toEqual([
      '0.001 BTC/USD is reserved by sell proposals awaiting approval; wait for their decision first',
    ])
    expect(heldBySells(sell, 0.002, exposure)).toEqual([])
    expect(heldBySells({ ...sell, side: 'buy' }, 0.001, exposure)).toEqual([])
    expect(heldBySells(sell, 0.001, { ...exposure, positionQty: 0 })).toEqual([])
  })

  it('detects drift only between two usable prices', () => {
    expect(drifted(100, 101.5, 0.01)).toBe(true)
    expect(drifted(100, 100.9, 0.01)).toBe(false)
    expect(drifted(0, 150, 0.01)).toBe(false)
    expect(drifted(100, 0, 0.01)).toBe(false)
  })

  it('caps a market order at the approved price and refuses an unusable price or a zero cap', () => {
    const market: OrderRequest = { symbol: btc, side: 'buy', qty: 0.0002, type: 'market', timeInForce: 'gtc' }
    expect(planOrder(market, 62_835, 0.01, false, 0.01)).toEqual({ type: 'limit', limitPrice: 63_463.35, timeInForce: 'ioc', capped: true })
    expect(planOrder({ ...market, side: 'sell' }, 0, 0.01, true, 0.01)).toEqual({ type: 'market', timeInForce: 'gtc', capped: false })
    expect(() => planOrder(market, Number.NaN, 0.01, false, 0.01))
      .toThrow('the approved price is not usable for a price cap; propose again')
    expect(() => planOrder(market, 0.001, 0.01, false, 0.01))
      .toThrow('the price cap rounds to zero at this price tick; propose a limit order instead')
  })

  it('copies exactly one size and the bracket into the broker request', () => {
    const order: OrderRequest = {
      symbol: aapl, side: 'buy', qty: 2, type: 'stop_limit', limitPrice: 231, stopPrice: 230, timeInForce: 'day',
      bracket: { takeProfit: 250, stopLoss: 220 },
    }
    expect(brokerRequest(order, { type: 'stop_limit', limitPrice: 231, stopPrice: 230, timeInForce: 'day', capped: false }, cid))
      .toEqual({ ...order, clientOrderId: cid })
    expect(brokerRequest({ symbol: btc, side: 'buy', notional: 50, type: 'market', timeInForce: 'gtc' },
      { type: 'market', timeInForce: 'gtc', capped: false }, cid))
      .toEqual({ symbol: btc, side: 'buy', notional: 50, type: 'market', timeInForce: 'gtc', clientOrderId: cid })
  })
})
