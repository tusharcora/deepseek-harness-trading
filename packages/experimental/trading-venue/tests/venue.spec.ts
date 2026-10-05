import { Context } from '@deepseek-ai/cordis'
import type {
  AccountSnapshot, Asset, Bar, BrokerOrder, OrderStreamEvent, PositionSnapshot, Quote, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { describe, expect, it } from 'vitest'
import TradingVenueGateway, { VenueError } from '../src/index.ts'

class FakeVenue extends TradingVenueGateway {
  status(): VenueStatus { return 'ready' }
  async account(): Promise<AccountSnapshot> { return { equity: 1, cash: 1, lastEquity: 1, buyingPower: 1, tradingBlocked: false } }
  async positions(): Promise<PositionSnapshot[]> { return [] }
  async openOrders(): Promise<BrokerOrder[]> { return [] }
  async asset(): Promise<Asset> { throw new VenueError('no assets', 'not-found') }
  async marketOpen(): Promise<boolean> { return true }
  async latestQuote(): Promise<Quote> { return { bid: 1, ask: 1, t: 0 } }
  async bars(): Promise<Bar[]> { return [] }
  async submitOrder(): Promise<BrokerOrder> { throw new VenueError('read-only fake', 'rejected') }
  async cancelOrder(): Promise<void> {}
  async closePosition(): Promise<BrokerOrder> { throw new VenueError('read-only fake', 'rejected') }
  async flatten(): Promise<BrokerOrder[]> { return [] }
  async halt(): Promise<void> {}
  async resume(): Promise<void> {}
  subscribeOrderUpdates(_listener: (event: OrderStreamEvent) => void): () => void { return () => {} }
}

describe('TradingVenueGateway', () => {
  it('registers an implementation at ctx.tradingVenue and removes it on dispose', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FakeVenue)
    expect(ctx.get('tradingVenue')).toBeInstanceOf(FakeVenue)
    await fiber.dispose()
    expect(ctx.get('tradingVenue')).toBeUndefined()
  })
})

describe('VenueError', () => {
  it('carries a desk code and the broker code', () => {
    const error = new VenueError('insufficient buying power', 'rejected', 40310000)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'VenueError', message: 'insufficient buying power', code: 'rejected', brokerCode: 40310000 })
    expect(new VenueError('down', 'unavailable').brokerCode).toBeUndefined()
  })
})
