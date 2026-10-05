import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AlpacaHttp } from '../src/http.ts'
import { AccountSafety, INITIAL_SAFETY_STATE, type SafetyState, type SafetyStateStore } from '../src/safety.ts'
import { accountConfig, FakeAlpaca, type FakeAccountConfig } from './fake-alpaca.ts'

let fake: FakeAlpaca
let http: AlpacaHttp
let saved: SafetyState
let waits: number[]
const store: SafetyStateStore = { get: () => saved, set: async (state) => { saved = state } }
const unsafe: FakeAccountConfig = { no_shorting: false, max_margin_multiplier: '4', suspend_trade: false }
const safe: FakeAccountConfig = { no_shorting: true, max_margin_multiplier: '1', suspend_trade: false }
const safety = (): AccountSafety => new AccountSafety(http, store, { suspendRetryMs: [3, 4], sleep: async (ms) => { waits.push(ms) } })
/** Make PATCHes that set suspend_trade to `value` fail with 503 while `failing()` is true. */
const failSuspend = (config: FakeAccountConfig, value: boolean, failing: () => boolean): void => {
  fake.on('PATCH', '/v2/account/configurations', (request) => {
    const body = request.body as Partial<FakeAccountConfig>
    if (body.suspend_trade === value && failing()) return { status: 503, body: { message: 'busy' } }
    Object.assign(config, body)
    return { status: 200, body: { ...config } }
  })
}

/** PATCHes that tried to lift the suspension. */
const lifts = (): unknown[] =>
  fake.requests.filter(r => r.method === 'PATCH' && (r.body as Partial<FakeAccountConfig>).suspend_trade === false)

beforeEach(async () => {
  fake = new FakeAlpaca(); await fake.start(); saved = INITIAL_SAFETY_STATE; waits = []
  http = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [],
    keys: async () => ({ keyId: 'k', secret: 's' }) })
})
afterEach(async () => { await fake.stop() })

describe('start', () => {
  it('applies and verifies no shorting and a 1x margin multiplier', async () => {
    const config = accountConfig(fake, unsafe)
    expect(await safety().start()).toEqual({ halted: false, reason: '' })
    expect(config).toMatchObject({ no_shorting: true, max_margin_multiplier: '1', suspend_trade: false })
  })

  it('skips the write when the account is already safe', async () => {
    accountConfig(fake, safe)
    await safety().start()
    expect(fake.requests.map(r => r.method)).toEqual(['GET'])
  })

  it('blocks when Alpaca does not keep the settings', async () => {
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: unsafe }))
    fake.on('PATCH', '/v2/account/configurations', () => ({ status: 200, body: unsafe }))
    await expect(safety().start()).rejects.toMatchObject({
      code: 'blocked', message: 'Alpaca did not accept no_shorting=true and max_margin_multiplier=1; trading stays blocked',
    })
  })

  it('starts halted when the saved flag or the broker suspension is set', async () => {
    const config = accountConfig(fake, { ...safe, suspend_trade: true })
    expect(await safety().start()).toEqual({ halted: true, reason: 'trading was suspended at Alpaca' })
    expect(saved).toMatchObject({ halted: true, suspendPending: false })
    config.suspend_trade = false
    expect((await safety().start()).halted).toBe(true)
    expect(config.suspend_trade).toBe(true)
    expect(saved.suspendPending).toBe(false)
  })

  it('recovers from a crash inside the flatten window by re-suspending and halting', async () => {
    const config = accountConfig(fake, safe)
    saved = { halted: true, haltReason: 'user halt', flattenWindowOpen: true, suspendPending: false }
    expect(await safety().start()).toEqual({ halted: true, reason: 'the desk stopped while closing positions; trading stays halted' })
    expect(config.suspend_trade).toBe(true)
    expect(saved).toEqual({ halted: true, haltReason: 'the desk stopped while closing positions; trading stays halted',
      flattenWindowOpen: false, suspendPending: false })
  })
})

describe('start recovery ordering', () => {
  it('re-suspends after a crash inside the window before applying the safety settings, even when they are refused', async () => {
    const config: FakeAccountConfig = { ...unsafe }
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config } }))
    fake.on('PATCH', '/v2/account/configurations', (request) => {
      const body = request.body as Partial<FakeAccountConfig>
      if (body.suspend_trade !== undefined) config.suspend_trade = body.suspend_trade
      return { status: 200, body: { ...config } }
    })
    saved = { halted: true, haltReason: 'user halt', flattenWindowOpen: true, suspendPending: false }
    await expect(safety().start()).rejects.toMatchObject({ code: 'blocked' })
    expect(config.suspend_trade).toBe(true)
    expect(saved).toEqual({ halted: true, haltReason: 'the desk stopped while closing positions; trading stays halted',
      flattenWindowOpen: false, suspendPending: false })
  })
})

describe('halt and resume', () => {
  it('halts and resumes at the broker and in saved state, re-applying settings on resume', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    expect(await s.halt('user halt')).toBe(true)
    expect(config.suspend_trade).toBe(true)
    expect(saved).toEqual({ halted: true, haltReason: 'user halt', flattenWindowOpen: false, suspendPending: false })
    expect(s.isHalted()).toBe(true)
    config.no_shorting = false
    await s.resume()
    expect(config).toMatchObject({ no_shorting: true, suspend_trade: false })
    expect(saved).toEqual(INITIAL_SAFETY_STATE)
  })

  it('halts locally even when Alpaca cannot be reached, retrying the suspension per the schedule', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    let down = true
    failSuspend(config, true, () => down)
    expect(await s.halt('user halt')).toBe(false)
    expect(saved).toMatchObject({ halted: true, suspendPending: true })
    expect(s.isHalted()).toBe(true)
    expect(waits).toEqual([3, 4])
    expect(fake.requests.filter(r => r.method === 'PATCH')).toHaveLength(3)
    down = false
    expect(await s.check()).toBeUndefined()
    expect(config.suspend_trade).toBe(true)
    expect(saved.suspendPending).toBe(false)
  })

  it('saves a Halt at once, even while a slow operation holds the queue', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config }, delayMs: 60 }))
    const check = s.check()
    await new Promise(resolve => setTimeout(resolve, 10))
    const halting = s.halt('user halt')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(saved).toMatchObject({ halted: true, suspendPending: true })
    await check
    expect(await halting).toBe(true)
    expect(config.suspend_trade).toBe(true)
  })

  it('keeps a Halt requested while a resume is running', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('first')
    fake.on('GET', '/v2/account/configurations', () => ({ status: 200, body: { ...config }, delayMs: 40 }))
    const resuming = s.resume()
    await new Promise(resolve => setTimeout(resolve, 10))
    const halting = s.halt('second')
    await resuming
    await halting
    expect(s.isHalted()).toBe(true)
    expect(saved.haltReason).toBe('second')
    expect(config.suspend_trade).toBe(true)
  })

  it('keeps a Halt requested after the user asked to resume, even when it lands before the resume runs', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('first')
    const since = s.haltCounter()
    expect(await s.halt('second')).toBe(true)
    expect(s.haltCounter()).toBe(since + 1)
    await s.resume(since)
    expect(s.isHalted()).toBe(true)
    expect(saved).toEqual({ halted: true, haltReason: 'second', flattenWindowOpen: false, suspendPending: false })
    expect(config.suspend_trade).toBe(true)
    expect(lifts()).toHaveLength(0)
  })

  it('restores the suspension when a Halt is requested while the resume lifts it', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('first')
    let halting: Promise<boolean> | undefined
    fake.on('PATCH', '/v2/account/configurations', (request) => {
      const body = request.body as Partial<FakeAccountConfig>
      if (body.suspend_trade === false && halting === undefined) halting = s.halt('during lift')
      Object.assign(config, body)
      return { status: 200, body: { ...config } }
    })
    await s.resume()
    expect(await halting).toBe(true)
    expect(lifts()).toHaveLength(1)
    expect(saved).toEqual({ halted: true, haltReason: 'during lift', flattenWindowOpen: false, suspendPending: false })
    expect(config.suspend_trade).toBe(true)
  })

  it('suspends at Alpaca even when saving the Halt fails, then reports the save failure', async () => {
    const config = accountConfig(fake, safe)
    let failNext = true
    const flaky: SafetyStateStore = { get: () => saved, set: async (state) => {
      if (failNext) { failNext = false; throw new Error('disk full') }
      saved = state
    } }
    const s = new AccountSafety(http, flaky, { suspendRetryMs: [], sleep: async () => {} })
    await expect(s.halt('user halt')).rejects.toThrow('disk full')
    expect(config.suspend_trade).toBe(true)
  })

  it('keeps an unconfirmed suspension pending, without reporting drift, while Alpaca stays down', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    failSuspend(config, true, () => true)
    expect(await s.halt('user halt')).toBe(false)
    expect(await s.check()).toBeUndefined()
    expect(saved).toEqual({ halted: true, haltReason: 'user halt', flattenWindowOpen: false, suspendPending: true })
    expect(config.suspend_trade).toBe(false)
  })

  it('halts locally without keys', async () => {
    const keyless = new AlpacaHttp({ tradingUrl: fake.url, dataUrl: fake.url, timeoutMs: 2_000, retryDelaysMs: [],
      keys: async () => { throw new Error('no keys') } })
    const s = new AccountSafety(keyless, store, { suspendRetryMs: [], sleep: async () => {} })
    expect(await s.halt('user halt')).toBe(false)
    expect(saved).toMatchObject({ halted: true, haltReason: 'user halt', suspendPending: true })
  })
})

describe('flatten window', () => {
  it('lifts the suspension only inside the window and restores it even when the work fails', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('user halt')
    const seen: boolean[] = []
    await s.withFlattenWindow(async () => { seen.push(config.suspend_trade, saved.flattenWindowOpen) })
    expect(seen).toEqual([false, true])
    expect(config.suspend_trade).toBe(true)
    expect(saved).toMatchObject({ flattenWindowOpen: false, suspendPending: false })
    await expect(s.withFlattenWindow(async () => { throw new Error('close failed') })).rejects.toThrow('close failed')
    expect(config.suspend_trade).toBe(true)
  })

  it('leaves the suspension pending, not the window open, when restoring fails; check retries it', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('user halt')
    let down = false
    failSuspend(config, true, () => down)
    await s.withFlattenWindow(async () => { down = true })
    expect(saved).toMatchObject({ halted: true, flattenWindowOpen: false, suspendPending: true })
    expect(config.suspend_trade).toBe(false)
    down = false
    expect(await s.check()).toBeUndefined()
    expect(config.suspend_trade).toBe(true)
    expect(saved.suspendPending).toBe(false)
  })

  it('closes the window and rethrows when the suspension cannot be lifted, without running the work', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('user halt')
    failSuspend(config, false, () => true)
    let ran = false
    await expect(s.withFlattenWindow(async () => { ran = true })).rejects.toMatchObject({ code: 'unavailable' })
    expect(ran).toBe(false)
    expect(saved.flattenWindowOpen).toBe(false)
  })

  it('restores the suspension when the lift fails after Alpaca applied it, and later operations still run', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('user halt')
    fake.on('PATCH', '/v2/account/configurations', (request) => {
      const body = request.body as Partial<FakeAccountConfig>
      Object.assign(config, body)
      if (body.suspend_trade === false) return { status: 503, body: { message: 'busy' } }
      return { status: 200, body: { ...config } }
    })
    let ran = false
    await expect(s.withFlattenWindow(async () => { ran = true })).rejects.toMatchObject({ code: 'unavailable' })
    expect(ran).toBe(false)
    expect(config.suspend_trade).toBe(true)
    expect(saved).toMatchObject({ halted: true, flattenWindowOpen: false, suspendPending: false })
    expect(await s.check()).toBeUndefined()
  })

  it('keeps the reason of a Halt requested while the window holds the queue', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('first')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const window = s.withFlattenWindow(async () => { await gate })
    await new Promise(resolve => setTimeout(resolve, 20))
    const halting = s.halt('second')
    release()
    await window
    await halting
    expect(saved).toMatchObject({ halted: true, haltReason: 'second', flattenWindowOpen: false })
    expect(config.suspend_trade).toBe(true)
  })

  it('runs the work directly when not halted', async () => {
    accountConfig(fake, safe)
    const s = safety()
    await s.start()
    const before = fake.requests.length
    expect(await s.withFlattenWindow(async () => 'done')).toBe('done')
    expect(fake.requests.length).toBe(before)
  })

  it('makes a drift check started during the window wait for it, so the lifted suspension is never seen as drift', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('user halt')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const window = s.withFlattenWindow(async () => { await gate })
    await new Promise(resolve => setTimeout(resolve, 20))
    const check = s.check()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(config.suspend_trade).toBe(false)
    release()
    await window
    expect(await check).toBeUndefined()
    expect(config.suspend_trade).toBe(true)
  })
})

describe('check', () => {
  it('reports nothing while the settings hold', async () => {
    accountConfig(fake, safe)
    const s = safety()
    await s.start()
    expect(await s.check()).toBeUndefined()
  })

  it('halts on drift and names every changed setting', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    config.no_shorting = false
    config.max_margin_multiplier = '2'
    expect(await s.check()).toBe('account settings changed at Alpaca: no_shorting, max_margin_multiplier')
    expect(config.suspend_trade).toBe(true)
    expect(s.isHalted()).toBe(true)
    expect(saved.suspendPending).toBe(false)
  })

  it('treats a suspension lifted at Alpaca while halted, or set while running, as drift', async () => {
    const config = accountConfig(fake, safe)
    const s = safety()
    await s.start()
    await s.halt('user halt')
    config.suspend_trade = false
    expect(await s.check()).toBe('account settings changed at Alpaca: suspend_trade')
    const running = safety()
    saved = INITIAL_SAFETY_STATE
    config.suspend_trade = true
    expect(await running.check()).toBe('account settings changed at Alpaca: suspend_trade')
  })
})
