/**
 * Alpaca REST market data: latest quotes, paged bar history, the market clock, and assets.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/market
 */
import type { Asset, Bar, BarQuery, Quote, Timeframe, TradingSymbol } from '@deepseek-ai/dsh-experimental-trading'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'
import { ALPACA_TIMEFRAMES, mapAsset, mapBar, mapQuote, pathSymbol } from './map.ts'
import type { RawRecord } from './types.ts'

/** Alpaca's maximum bars per page. */
const MAX_PAGE = 10_000
/** Alpaca defaults `start` to the beginning of the current day; ask from here so a newest-first query reaches older history. */
const HISTORY_START = '2015-01-01T00:00:00.000Z'

interface QuotesBody { readonly quotes?: Readonly<Record<string, RawRecord>> }
interface BarsBody { readonly bars?: Readonly<Record<string, readonly RawRecord[]>>; readonly next_page_token?: string | null }

/**
 * Read the latest quote.
 * @param http - REST client.
 * @param symbol - instrument.
 * @param feed - equity feed.
 * @returns the quote.
 */
export async function latestQuote(http: AlpacaHttp, symbol: TradingSymbol, feed: 'iex' | 'sip'): Promise<Quote> {
  const body = symbol.assetClass === 'crypto'
    ? await http.request<QuotesBody>('data', 'GET', '/v1beta3/crypto/us/latest/quotes', { query: { symbols: symbol.ticker } })
    : await http.request<QuotesBody>('data', 'GET', '/v2/stocks/quotes/latest', { query: { symbols: symbol.ticker, feed } })
  const raw = body.quotes?.[symbol.ticker]
  if (raw === undefined) throw new VenueError(`no quote for ${symbol.ticker}`, 'not-found')
  return mapQuote(raw)
}

/**
 * Read up to `query.limit` bars, oldest first, requesting newest-first so the most recent bars come back.
 * @param http - REST client.
 * @param symbol - instrument.
 * @param timeframe - bar timeframe.
 * @param query - range and maximum count.
 * @param feed - equity feed.
 * @param now - current time, used as `end` when the query has none.
 * @returns bars, oldest first.
 */
export async function bars(
  http: AlpacaHttp, symbol: TradingSymbol, timeframe: Timeframe, query: BarQuery, feed: 'iex' | 'sip', now: number,
): Promise<Bar[]> {
  const crypto = symbol.assetClass === 'crypto'
  const path = crypto ? '/v1beta3/crypto/us/bars' : '/v2/stocks/bars'
  const collected: Bar[] = []
  let pageToken: string | undefined
  do {
    const body = await http.request<BarsBody>('data', 'GET', path, {
      query: {
        symbols: symbol.ticker,
        timeframe: ALPACA_TIMEFRAMES[timeframe],
        start: query.start === undefined ? HISTORY_START : new Date(query.start).toISOString(),
        end: new Date(query.end ?? now).toISOString(),
        limit: Math.min(query.limit - collected.length, MAX_PAGE),
        sort: 'desc',
        page_token: pageToken,
        feed: crypto ? undefined : feed,
        adjustment: crypto ? undefined : 'split',
      },
    })
    for (const raw of body.bars?.[symbol.ticker] ?? []) collected.push(mapBar(raw))
    pageToken = body.next_page_token ?? undefined
  } while (pageToken !== undefined && collected.length < query.limit)
  return collected.slice(0, query.limit).reverse()
}

/**
 * Whether the instrument's market is open now.
 * @param http - REST client.
 * @param symbol - instrument.
 * @returns true for crypto; the clock's `is_open` for equities.
 */
export async function marketOpen(http: AlpacaHttp, symbol: TradingSymbol): Promise<boolean> {
  if (symbol.assetClass === 'crypto') return true
  const clock = await http.request<RawRecord>('trading', 'GET', '/v2/clock')
  return clock.is_open === true
}

/**
 * Read broker facts for one instrument.
 * @param http - REST client.
 * @param symbol - instrument.
 * @returns the asset.
 */
export async function asset(http: AlpacaHttp, symbol: TradingSymbol): Promise<Asset> {
  return mapAsset(await http.request<RawRecord>('trading', 'GET', `/v2/assets/${encodeURIComponent(pathSymbol(symbol))}`))
}
