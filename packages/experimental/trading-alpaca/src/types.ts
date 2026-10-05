/**
 * Types shared across the Alpaca provider's units.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/types
 */

/** Alpaca API key pair resolved for one request. */
export interface AlpacaKeys {
  /** `APCA-API-KEY-ID` value. */
  readonly keyId: string
  /** `APCA-API-SECRET-KEY` value. */
  readonly secret: string
}

/** Alpaca JSON object as received; fields are read through `map.ts`. */
export type RawRecord = Readonly<Record<string, unknown>>
