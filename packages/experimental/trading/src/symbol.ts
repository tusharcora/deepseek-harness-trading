/**
 * Parsing of user- and model-typed instrument names into canonical symbols.
 *
 * @module @deepseek-ai/dsh-experimental-trading/symbol
 */
import type { TradingSymbol } from './types.ts'

const CRYPTO_QUOTES: readonly string[] = ['USDT', 'USDC', 'USD', 'BTC']
const EQUITY = /^[A-Z]{1,5}(\.[A-Z])?$/
const CRYPTO_BASE = /^[A-Z0-9]{2,10}$/

/**
 * Parse `AAPL`, `brk.b`, `BTC/USD`, or `BTCUSD` into a canonical symbol.
 * @param input - instrument name typed by a user or a model.
 * @returns the canonical symbol.
 * @throws RangeError when the input is neither an equity ticker nor a supported crypto pair.
 */
export function parseSymbol(input: string): TradingSymbol {
  const text = input.trim().toUpperCase()
  const slash = text.indexOf('/')
  if (slash !== -1) {
    const base = text.slice(0, slash)
    const quote = text.slice(slash + 1)
    if (CRYPTO_BASE.test(base) && CRYPTO_QUOTES.includes(quote)) return { assetClass: 'crypto', ticker: `${base}/${quote}` }
    throw new RangeError(`not a supported crypto pair: ${text}`)
  }
  if (EQUITY.test(text)) return { assetClass: 'equity', ticker: text }
  for (const quote of CRYPTO_QUOTES) {
    const base = text.slice(0, text.length - quote.length)
    if (text.endsWith(quote) && CRYPTO_BASE.test(base)) return { assetClass: 'crypto', ticker: `${base}/${quote}` }
  }
  throw new RangeError(`not a symbol: ${text}`)
}
