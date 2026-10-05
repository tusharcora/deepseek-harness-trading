/**
 * Account safety at the broker: no shorting, a 1x margin multiplier, Halt through `suspend_trade`, a journaled
 * flatten window for closing positions while halted, and drift detection. Every operation runs exclusively.
 * Halt is saved locally before Alpaca is contacted, so an outage never leaves the desk running; an unconfirmed
 * suspension stays pending and is retried. These settings bound an agent that only places orders; an agent holding
 * the keys can change them, which the drift check detects and answers with a Halt.
 *
 * @module @deepseek-ai/dsh-experimental-trading-alpaca/safety
 */
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import type { AlpacaHttp } from './http.ts'

/** Persisted Halt state. */
export interface SafetyState {
  /** Whether trading is halted. */
  readonly halted: boolean
  /** Readable cause of the current Halt; empty when running. */
  readonly haltReason: string
  /** Whether a flatten window is open (suspension lifted to close positions). */
  readonly flattenWindowOpen: boolean
  /** Whether the broker suspension for the current Halt is not yet confirmed. */
  readonly suspendPending: boolean
}

/** Durable storage for {@link SafetyState}. */
export interface SafetyStateStore {
  /** Read the saved state. */
  get(): SafetyState
  /** Save the state; resolves when durable. */
  set(state: SafetyState): Promise<void>
}

/** Retry schedule for confirming a suspension. */
export interface SafetyTiming {
  /** Waits before each retry; one retry per entry. */
  readonly suspendRetryMs: readonly number[]
  /** Wait implementation. */
  readonly sleep: (ms: number) => Promise<void>
}

/** State of a desk that has never halted. */
export const INITIAL_SAFETY_STATE: SafetyState = { halted: false, haltReason: '', flattenWindowOpen: false, suspendPending: false }

interface AccountConfiguration {
  readonly no_shorting?: unknown
  readonly max_margin_multiplier?: unknown
  readonly suspend_trade?: unknown
}

const SAFE = { no_shorting: true, max_margin_multiplier: '1' } as const
const CRASH_REASON = 'the desk stopped while closing positions; trading stays halted'
const PATH = '/v2/account/configurations'

/** Enforces and watches the account's safety settings. */
export class AccountSafety {
  private queue: Promise<unknown> = Promise.resolve()
  private haltCount = 0

  /**
   * @param http - REST client.
   * @param store - durable Halt state.
   * @param timing - suspension retry schedule.
   */
  constructor(private readonly http: AlpacaHttp, private readonly store: SafetyStateStore, private readonly timing: SafetyTiming) {}

  /**
   * Whether trading is halted.
   * @returns the saved Halt flag.
   */
  isHalted(): boolean {
    return this.store.get().halted
  }

  /**
   * Recover an interrupted flatten window or a pending suspension first, so the broker is suspended even when the
   * safety settings are then refused; apply the safety settings, then restore Halt from saved state or the broker's
   * suspension.
   * @returns whether the desk starts halted and why.
   * @throws VenueError `blocked` when Alpaca does not keep the safety settings.
   */
  start(): Promise<{ halted: boolean; reason: string }> {
    return this.exclusive(async () => {
      const recovered = this.store.get()
      if (recovered.flattenWindowOpen) {
        await this.store.set({ halted: true, haltReason: CRASH_REASON, flattenWindowOpen: false, suspendPending: true })
      }
      if (this.store.get().suspendPending) await this.confirmSuspension()
      const config = await this.applySafeSettings()
      const saved = this.store.get()
      if (saved.halted || config.suspend_trade === true) {
        const reason = saved.halted ? saved.haltReason : 'trading was suspended at Alpaca'
        const pending = config.suspend_trade !== true
        await this.store.set({ halted: true, haltReason: reason, flattenWindowOpen: false, suspendPending: pending })
        if (pending) await this.confirmSuspension()
        return { halted: true, reason }
      }
      return { halted: false, reason: '' }
    })
  }

  /**
   * Halt: save the Halt at once (not behind the queue), then suspend at the broker with retries in the queue. The
   * suspension is attempted even when the save fails.
   * @param reason - readable cause.
   * @returns true when Alpaca confirmed the suspension; false leaves it pending for {@link check} to retry.
   * @throws the store's error when saving the Halt failed, after the suspension attempt.
   */
  async halt(reason: string): Promise<boolean> {
    this.haltCount++
    const state: SafetyState = { ...this.store.get(), halted: true, haltReason: reason, suspendPending: true }
    const [save] = await Promise.allSettled([this.store.set(state)])
    const confirmed = await this.exclusive(() => this.confirmSuspension())
    if (save.status === 'rejected') throw save.reason
    return confirmed
  }

  /**
   * Number of Halts requested so far; pass it to {@link resume} to make Halts requested after this point win.
   * @returns the Halt counter.
   */
  haltCounter(): number {
    return this.haltCount
  }

  /**
   * Re-apply the safety settings and lift the Halt, unless a Halt was requested after `since`; then the desk stays
   * halted and the suspension is restored. A Halt requested before the resume runs skips the lift entirely.
   * @param since - Halt counter when the user asked to resume; defaults to now.
   * @returns when the broker and saved state agree.
   */
  resume(since: number = this.haltCount): Promise<void> {
    return this.exclusive(async () => {
      if (this.haltCount === since) {
        await this.applySafeSettings()
        if (this.haltCount === since) {
          await this.suspend(false)
          if (this.haltCount === since) {
            await this.store.set(INITIAL_SAFETY_STATE)
            return
          }
        }
      }
      await this.store.set({ ...this.store.get(), suspendPending: true })
      await this.confirmSuspension()
    })
  }

  /**
   * Run reduce-only work. While halted, the suspension is lifted only for the work: the open window is saved first so
   * a crash inside it is recovered on the next start, and afterwards the suspension is restored or left pending.
   * @param run - the closing work.
   * @returns the work's result.
   */
  withFlattenWindow<T>(run: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const state = this.store.get()
      if (!state.halted) return run()
      await this.store.set({ ...state, flattenWindowOpen: true })
      try {
        await this.suspend(false)
      } catch (error) {
        // The lift may have reached Alpaca before failing: restore the suspension before rethrowing.
        await this.store.set({ ...this.store.get(), flattenWindowOpen: false, suspendPending: true })
        await this.confirmSuspension()
        throw error
      }
      try {
        return await run()
      } finally {
        await this.store.set({ ...this.store.get(), flattenWindowOpen: false, suspendPending: true })
        await this.confirmSuspension()
      }
    })
  }

  /**
   * Retry a pending suspension, then compare the broker's settings with the expected ones and halt on any difference.
   * @returns the drift reason after halting, or undefined when the settings hold.
   */
  check(): Promise<string | undefined> {
    return this.exclusive(async () => {
      if (this.store.get().suspendPending) await this.confirmSuspension()
      const state = this.store.get()
      const config = await this.read()
      const changed: string[] = []
      if (config.no_shorting !== SAFE.no_shorting) changed.push('no_shorting')
      if (config.max_margin_multiplier !== SAFE.max_margin_multiplier) changed.push('max_margin_multiplier')
      if (!state.suspendPending && (config.suspend_trade === true) !== state.halted) changed.push('suspend_trade')
      if (changed.length === 0) return undefined
      const reason = `account settings changed at Alpaca: ${changed.join(', ')}`
      await this.store.set({ halted: true, haltReason: reason, flattenWindowOpen: false, suspendPending: true })
      await this.confirmSuspension()
      return reason
    })
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async confirmSuspension(): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.suspend(true)
        await this.store.set({ ...this.store.get(), suspendPending: false })
        return true
      } catch (error) {
        // Unreachable broker or missing keys: the Halt is already saved; keep the suspension pending.
        void error
        const wait = this.timing.suspendRetryMs[attempt]
        if (wait === undefined) return false
        await this.timing.sleep(wait)
      }
    }
  }

  private async read(): Promise<AccountConfiguration> {
    return this.http.request<AccountConfiguration>('trading', 'GET', PATH)
  }

  private async suspend(on: boolean): Promise<void> {
    await this.http.request('trading', 'PATCH', PATH, { body: { suspend_trade: on } })
  }

  private async applySafeSettings(): Promise<AccountConfiguration> {
    const current = await this.read()
    if (current.no_shorting === SAFE.no_shorting && current.max_margin_multiplier === SAFE.max_margin_multiplier) return current
    await this.http.request('trading', 'PATCH', PATH, { body: SAFE })
    const verified = await this.read()
    if (verified.no_shorting !== SAFE.no_shorting || verified.max_margin_multiplier !== SAFE.max_margin_multiplier) {
      throw new VenueError('Alpaca did not accept no_shorting=true and max_margin_multiplier=1; trading stays blocked', 'blocked')
    }
    return verified
  }
}
