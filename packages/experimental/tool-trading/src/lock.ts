/**
 * The per-account lock: one async section at a time, in call order.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/lock
 */

/** Serializes async sections; a failed section does not block the next one. */
export class AccountLock {
  private tail: Promise<void> = Promise.resolve()

  /**
   * Run a section after every earlier one settled.
   * @param section - work that must not overlap other sections.
   * @returns the section's result.
   */
  run<T>(section: () => Promise<T>): Promise<T> {
    const result = this.tail.then(section)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
