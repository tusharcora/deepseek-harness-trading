/**
 * Alpaca account reads and order operations. Submission never duplicates and never reports "not placed" for an
 * order that may exist: after a duplicate-id rejection, a failure in transit, or an accepted but unreadable
 * response, it looks the order up by client order id, twice, before reporting anything.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/orders
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  AccountSnapshot, BrokerOrder, BrokerOrderId, BrokerOrderRequest, ClientOrderId, PositionSnapshot, TradingSymbol,
} from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { AcceptedUnreadableError, type AlpacaHttp } from './http.ts'
import { decimalString, mapAccount, mapOrder, mapPosition, pathSymbol } from './map.ts'
import type { RawRecord } from './types.ts'

/** Alpaca's documented error code for a reused client order id. */
const DUPLICATE_CLIENT_ORDER_ID = 40010001
/** Message Alpaca sends for a reused client order id under its generic validation code `42210000`. */
const DUPLICATE_CLIENT_ORDER_ID_MESSAGE = 'client_order_id must be unique'

function isDuplicateClientOrderId(error: VenueError): boolean {
  return error.brokerCode === DUPLICATE_CLIENT_ORDER_ID
    || (error.code === 'rejected' && error.message.toLowerCase().includes(DUPLICATE_CLIENT_ORDER_ID_MESSAGE))
}

/** Waits used by submission confirmation and position closing. */
export interface OrderTiming {
  /** Wait before the second confirming lookup, milliseconds. */
  readonly confirmDelayMs: number
  /** Wait between checks that a symbol's cancelled orders are gone, milliseconds. */
  readonly settleDelayMs: number
  /** Maximum such checks before closing anyway. */
  readonly settleChecks: number
  /** Wait implementation. */
  readonly sleep: (ms: number) => Promise<void>
}

interface MultiStatus { readonly symbol?: string; readonly status: number; readonly body?: RawRecord }

function orderBody(request: BrokerOrderRequest): Record<string, unknown> {
  return {
    symbol: request.symbol.ticker,
    side: request.side,
    type: request.type,
    time_in_force: request.timeInForce,
    client_order_id: request.clientOrderId,
    ...request.qty === undefined ? {} : { qty: decimalString(request.qty) },
    ...request.notional === undefined ? {} : { notional: decimalString(request.notional) },
    ...request.limitPrice === undefined ? {} : { limit_price: decimalString(request.limitPrice) },
    ...request.stopPrice === undefined ? {} : { stop_price: decimalString(request.stopPrice) },
    ...request.bracket === undefined ? {} : {
      order_class: 'bracket',
      take_profit: { limit_price: decimalString(request.bracket.takeProfit) },
      stop_loss: { stop_price: decimalString(request.bracket.stopLoss) },
    },
  }
}

/**
 * Find an order by its client order id.
 * @param http - REST client.
 * @param id - client order id.
 * @returns the order, or undefined when Alpaca has none.
 * @throws VenueError `unknown-outcome` when Alpaca answers with an order carrying a different client order id.
 */
export async function orderByClientId(http: AlpacaHttp, id: ClientOrderId): Promise<BrokerOrder | undefined> {
  let raw: RawRecord
  try {
    raw = await http.request<RawRecord>('trading', 'GET', '/v2/orders:by_client_order_id', { query: { client_order_id: id } })
  } catch (error) {
    if (error instanceof VenueError && error.code === 'not-found') return undefined
    throw error
  }
  const order = mapOrder(raw)
  if (order.clientOrderId !== id) {
    throw new VenueError(`Alpaca returned order ${order.id} for client order id ${id}`, 'unknown-outcome')
  }
  return order
}

async function lookup(http: AlpacaHttp, id: ClientOrderId): Promise<BrokerOrder | undefined> {
  try {
    return await orderByClientId(http, id)
  } catch (error) {
    throw new VenueError(
      `Alpaca did not confirm order ${id}; check open orders before proposing again (${(error as Error).message})`,
      'unknown-outcome',
    )
  }
}

async function confirmTwice(http: AlpacaHttp, id: ClientOrderId, timing: OrderTiming): Promise<BrokerOrder | undefined> {
  const first = await lookup(http, id)
  if (first !== undefined) return first
  await timing.sleep(timing.confirmDelayMs)
  return lookup(http, id)
}

/**
 * Submit an order without ever creating a duplicate or misreporting a placed order.
 * @param http - REST client.
 * @param request - planned order.
 * @param timing - confirmation wait.
 * @param beforeSend - last check run immediately before the POST is sent; a throw sends nothing and is rethrown.
 * @returns the accepted or already-existing order.
 * @throws VenueError `unknown-outcome` when Alpaca may hold the order but did not confirm it.
 */
export async function submitOrder(
  http: AlpacaHttp, request: BrokerOrderRequest, timing: OrderTiming, beforeSend?: () => void,
): Promise<BrokerOrder> {
  let raw: RawRecord
  try {
    raw = await http.request<RawRecord>('trading', 'POST', '/v2/orders', { body: orderBody(request), beforeSend })
  } catch (error) {
    // A non-VenueError comes from resolving the keys, before anything was sent; so does a `beforeSend` refusal,
    // which carries a code (such as `halted`) that none of the branches below handles.
    if (!(error instanceof VenueError)) throw error
    if (error instanceof AcceptedUnreadableError) return confirmAccepted(http, request.clientOrderId, timing)
    if (isDuplicateClientOrderId(error)) {
      // Alpaca says the id exists, so an empty lookup means it is not readable yet, never that nothing was placed.
      const existing = await confirmTwice(http, request.clientOrderId, timing)
      if (existing !== undefined) return existing
      throw new VenueError(
        `Alpaca reports client order id ${request.clientOrderId} as already used but no order with it could be read; `
        + 'check open orders before proposing again',
        'unknown-outcome',
      )
    }
    if (error.code !== 'unavailable') throw error
    const found = await confirmTwice(http, request.clientOrderId, timing)
    if (found !== undefined) return found
    throw new VenueError('Alpaca is unavailable; the order was not placed', 'unavailable')
  }
  return readOwnOrder(raw, request.clientOrderId) ?? confirmAccepted(http, request.clientOrderId, timing)
}

/** Alpaca answered 2xx, so it accepted something: read the order back instead of trusting the body. */
async function confirmAccepted(http: AlpacaHttp, id: ClientOrderId, timing: OrderTiming): Promise<BrokerOrder> {
  const found = await confirmTwice(http, id, timing)
  if (found !== undefined) return found
  throw new VenueError(`Alpaca accepted order ${id} but it could not be read back`, 'unknown-outcome')
}

/** Map a submission response, treating a body that names another client order id as unreadable. */
function readOwnOrder(raw: RawRecord, id: ClientOrderId): BrokerOrder | undefined {
  let order: BrokerOrder
  try {
    order = mapOrder(raw)
  } catch (mapError) {
    // A 2xx body that cannot be mapped still means Alpaca accepted something; the caller reads the order back.
    void mapError
    return undefined
  }
  return order.clientOrderId === id ? order : undefined
}

/**
 * Read the account.
 * @param http - REST client.
 * @returns the account snapshot.
 */
export async function account(http: AlpacaHttp): Promise<AccountSnapshot> {
  return mapAccount(await http.request<RawRecord>('trading', 'GET', '/v2/account'))
}

/**
 * Read open positions.
 * @param http - REST client.
 * @returns every open position.
 */
export async function positions(http: AlpacaHttp): Promise<PositionSnapshot[]> {
  return (await http.request<RawRecord[]>('trading', 'GET', '/v2/positions')).map(mapPosition)
}

/**
 * Read open orders, optionally for one instrument.
 * @param http - REST client.
 * @param symbol - instrument filter.
 * @returns up to 500 open orders.
 */
export async function openOrders(http: AlpacaHttp, symbol?: TradingSymbol): Promise<BrokerOrder[]> {
  const query = { status: 'open', limit: 500, symbols: symbol === undefined ? undefined : pathSymbol(symbol) }
  return (await http.request<RawRecord[]>('trading', 'GET', '/v2/orders', { query })).map(mapOrder)
}

/**
 * Cancel one order.
 * @param http - REST client.
 * @param id - broker order id.
 * @returns when Alpaca accepted the cancellation.
 */
export async function cancelOrder(http: AlpacaHttp, id: BrokerOrderId): Promise<void> {
  await http.request('trading', 'DELETE', `/v2/orders/${encodeURIComponent(id)}`)
}

/**
 * Cancel the instrument's open orders (they hold the shares), wait for them to clear, then close the position.
 * While Alpaca rejects the close for insufficient balance or qty (it has not yet released the coins held by the cancelled orders),
 * the close is retried up to `timing.settleChecks` times, `timing.settleDelayMs` apart; then that rejection is thrown.
 * @param http - REST client.
 * @param symbol - instrument.
 * @param timing - settle waits.
 * @returns the closing order.
 */
export async function closePosition(http: AlpacaHttp, symbol: TradingSymbol, timing: OrderTiming): Promise<BrokerOrder> {
  let resting = await openOrders(http, symbol)
  for (const order of resting) {
    try {
      await cancelOrder(http, brandString<BrokerOrderId>(order.id))
    } catch (cancelError) {
      // An order already cancelled with its bracket sibling, or filling: the settle poll below decides.
      void cancelError
    }
  }
  for (let check = 0; check < timing.settleChecks && resting.length > 0; check++) {
    await timing.sleep(timing.settleDelayMs)
    resting = await openOrders(http, symbol)
  }
  const path = `/v2/positions/${encodeURIComponent(pathSymbol(symbol))}`
  for (let retry = 0; ; retry++) {
    try {
      return mapOrder(await http.request<RawRecord>('trading', 'DELETE', path))
    } catch (error) {
      if (retry >= timing.settleChecks || !isCoinsHeld(error)) throw error
      await timing.sleep(timing.settleDelayMs)
    }
  }
}

/** Alpaca's rejection of a close while coins held by just-cancelled orders are not yet released. */
function isCoinsHeld(error: unknown): boolean {
  return error instanceof VenueError && error.code === 'rejected' && /insufficient (balance|qty)/i.test(error.message)
}

/**
 * Cancel every open order and close every position.
 * @param http - REST client.
 * @returns the closing orders.
 * @throws VenueError `rejected` naming every position Alpaca could not close.
 */
export async function flatten(http: AlpacaHttp): Promise<BrokerOrder[]> {
  const results = await http.request<MultiStatus[]>('trading', 'DELETE', '/v2/positions', { query: { cancel_orders: 'true' } })
  const failed = results.filter(result => result.status >= 400)
  if (failed.length > 0) {
    throw new VenueError(`Alpaca could not close: ${failed.map(f => `${String(f.symbol)} (${String(f.status)})`).join(', ')}`, 'rejected')
  }
  return results.flatMap(result => (result.body === undefined ? [] : [mapOrder(result.body)]))
}
