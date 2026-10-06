import { describe, expect, it } from 'vitest'
import { FakeAlpaca } from './fake-alpaca.ts'

describe('FakeAlpaca', () => {
  it('answers 500 when a responder throws and fails stop() naming the error', async () => {
    const fake = new FakeAlpaca()
    await fake.start()
    fake.on('GET', '/v2/x', () => { throw new Error('responder bug') })
    const response = await fetch(`${fake.url}/v2/x`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: 'responder bug' })
    await expect(fake.stop()).rejects.toThrow('FakeAlpaca failed while answering: responder bug')
    expect(fake.errors).toHaveLength(0)
    await expect(fake.stop()).resolves.toBeUndefined()
  })
})
