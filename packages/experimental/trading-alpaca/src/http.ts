/**
 * Alpaca REST client: key headers resolved per request, JSON bodies,
 * rate-limit retries for reads only, and broker failures mapped to VenueError.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/http
 */
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaKeys } from './types.ts'

/** Client construction options. */
export interface AlpacaHttpOptions {
  /** Trading API base URL. */
  readonly tradingUrl: string
  /** Market data API base URL. */
  readonly dataUrl: string
  /** Per-request timeout, milliseconds. */
  readonly timeoutMs: number
  /** Waits before each retry of a rate-limited read. */
  readonly retryDelaysMs: readonly number[]
  /** Resolve the key pair; called once per request. */
  readonly keys: () => Promise<AlpacaKeys>
  /** Wait between retries; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Alpaca answered 2xx but the body could not be read; the request may have taken effect. */
export class AcceptedUnreadableError extends VenueError {
  /** @param message - what could not be read. */
  constructor(message: string) {
    super(message, 'unavailable')
  }
}

/** Query string and JSON body for one request. */
export interface RequestOptions {
  /** Query parameters; `undefined` values are omitted. */
  readonly query?: Readonly<Record<string, string | number | undefined>>
  /** JSON request body. */
  readonly body?: unknown
  /**
   * Last check before each send, run after the keys resolve; a throw sends nothing and rejects the request with
   * that error. Order submission uses it to re-check the Halt.
   */
  readonly beforeSend?: (() => void) | undefined
}

function parseJson(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (parseError) {
    // Not JSON (an HTML error page from a proxy); each caller decides what that means.
    void parseError
    return undefined
  }
  return value
}

function toVenueError(status: number, body: unknown): VenueError {
  const record = typeof body === 'object' && body !== null ? body as { code?: unknown; message?: unknown } : {}
  const code = typeof record.code === 'number' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : `HTTP ${String(status)}`
  if (status === 401 || (status === 403 && code === undefined)) {
    return new VenueError(`Alpaca rejected the API keys: ${message}`, 'auth', code)
  }
  if (status === 404) return new VenueError(`Alpaca: ${message}`, 'not-found', code)
  if (status === 429) return new VenueError('Alpaca rate limit reached; try again shortly', 'rate-limited', code)
  if (status >= 500) return new VenueError(`Alpaca is unavailable: ${message}`, 'unavailable', code)
  return new VenueError(`Alpaca rejected the request: ${message}`, 'rejected', code)
}

/** Alpaca REST client. */
export class AlpacaHttp {
  /** @param options - endpoints, timeout, retry waits, and key resolution. */
  constructor(private readonly options: AlpacaHttpOptions) {}

  /**
   * Send one request.
   * @param api - which base URL.
   * @param method - HTTP method; only `GET` is retried on 429.
   * @param path - absolute path such as `/v2/account`.
   * @param options - query and body.
   * @returns the parsed JSON body, or undefined for an empty body.
   * @throws VenueError for every failure.
   */
  async request<T>(
    api: 'trading' | 'data',
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const base = api === 'trading' ? this.options.tradingUrl : this.options.dataUrl
    const url = new URL(`${base.replace(/\/$/, '')}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    for (let attempt = 0; ; attempt++) {
      const keys = await this.options.keys()
      options.beforeSend?.()
      let response: Response
      try {
        response = await fetch(url, {
          method,
          headers: {
            'APCA-API-KEY-ID': keys.keyId,
            'APCA-API-SECRET-KEY': keys.secret,
            ...options.body === undefined ? {} : { 'content-type': 'application/json' },
          },
          ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        })
      } catch (error) {
        throw new VenueError(`Alpaca is unreachable: ${(error as Error).message}`, 'unavailable')
      }
      const retryDelay = method === 'GET' && response.status === 429 ? this.options.retryDelaysMs[attempt] : undefined
      if (retryDelay !== undefined) {
        await response.body?.cancel()
        await this.sleep(retryDelay)
        continue
      }
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        const message = `Alpaca connection dropped while reading the response: ${(error as Error).message}`
        throw response.ok ? new AcceptedUnreadableError(message) : new VenueError(message, 'unavailable')
      }
      if (response.ok) {
        if (text === '') return undefined as T
        const parsed = parseJson(text)
        if (parsed === undefined) throw new AcceptedUnreadableError('Alpaca returned an unreadable response')
        return parsed as T
      }
      throw toVenueError(response.status, text === '' ? undefined : parseJson(text) ?? { message: text })
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms)
    await new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() })
  }
}
