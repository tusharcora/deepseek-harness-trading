import { describe, expect, it } from 'vitest'
import { AccountLock } from '../src/lock.ts'

describe('AccountLock', () => {
  it('runs one section at a time in call order and keeps going after a failure', async () => {
    const lock = new AccountLock()
    const log: string[] = []
    const gate = Promise.withResolvers<undefined>()
    const first = lock.run(async () => { log.push('first start'); await gate.promise; log.push('first end'); return 1 })
    const second = lock.run(async () => { log.push('second'); throw new Error('boom') })
    const third = lock.run(async () => { log.push('third'); return 3 })
    await Promise.resolve()
    expect(log).toEqual(['first start'])
    gate.resolve(undefined)
    expect(await first).toBe(1)
    await expect(second).rejects.toThrow('boom')
    expect(await third).toBe(3)
    expect(log).toEqual(['first start', 'first end', 'second', 'third'])
  })
})
