import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import { VenueError } from '@deepseek-ai/dsh-experimental-trading-venue'
import { afterEach, describe, expect, it } from 'vitest'
import * as TradingCommand from '../src/command.ts'
import { bootDesk, type Desk } from './harness.ts'

const USAGE = 'Usage: /trading [status | halt [reason] | resume]'
let desk: Desk
afterEach(async () => { await desk.close() })

async function withCommand(): Promise<Desk> {
  desk = await bootDesk()
  await desk.ctx.plugin(CommandRuntime)
  await desk.ctx.plugin(TradingCommand)
  return desk
}

async function command(line: string): Promise<CommandResult | undefined> {
  return (await desk.ctx.commands.execute(desk.agent, line, [], new AbortController().signal))?.result
}

describe('/trading', () => {
  it('shows the derived status, the account mode, and the reason behind the status', async () => {
    await withCommand()
    expect(await command('/trading')).toEqual({ kind: 'success', text: 'Trading status: ready (paper).' })
    expect(await command('/trading status')).toEqual({ kind: 'success', text: 'Trading status: ready (paper).' })
    desk.venue.current = 'halted'
    desk.venue.haltReason = 'account setting no_shorting changed'
    desk.venue.accountMode = 'live'
    expect(await command('/trading status'))
      .toEqual({ kind: 'success', text: 'Trading status: halted (live). Reason: account setting no_shorting changed.' })
  })

  it('halts through the venue with the given reason or a default one', async () => {
    await withCommand()
    expect(await command('/trading halt market looks wrong'))
      .toEqual({ kind: 'success', text: 'Trading halted. Trading status: halted (paper). Reason: market looks wrong.' })
    expect(desk.venue.haltReason).toBe('market looks wrong')
    expect(await command('/trading halt'))
      .toEqual({ kind: 'success', text: 'Trading halted. Trading status: halted (paper). Reason: halted by the user.' })
    desk.venue.haltFailure = new Error('disk full')
    expect(await command('/trading halt again')).toEqual({ kind: 'error',
      text: 'The Halt is in effect but could not be saved: disk full. Trading status: halted (paper). Reason: again.' })
  })

  it('resumes only through venue.resume(), which restores the broker suspension state', async () => {
    await withCommand()
    desk.venue.current = 'halted'
    desk.venue.haltReason = 'user halt'
    expect(await command('/trading resume'))
      .toEqual({ kind: 'success', text: 'Trading resumed. Trading status: ready (paper).' })
    expect(desk.venue.resumeCalls).toBe(1)
    desk.venue.current = 'halted'
    desk.venue.resumeLeavesHalted = true
    expect(await command('/trading resume')).toEqual({ kind: 'error',
      text: 'A Halt arrived while resuming; trading stays halted. Trading status: halted (paper). Reason: user halt.' })
    desk.venue.resumeFailure = new VenueError('the account cannot be made safe', 'blocked')
    expect(await command('/trading resume')).toEqual({ kind: 'error',
      text: 'Could not resume trading: the account cannot be made safe. Trading status: halted (paper). Reason: user halt.' })
    expect(desk.venue.resumeCalls).toBe(3)
  })

  it('refuses any other input', async () => {
    await withCommand()
    for (const line of ['/trading buy', '/trading status now', '/trading resume please']) {
      expect(await command(line)).toEqual({ kind: 'error', text: USAGE })
    }
    expect(desk.venue.resumeCalls).toBe(0)
  })

  it('gives the model no halt, resume, or status capability, and keeps command output out of the model history', async () => {
    await withCommand()
    await command('/trading halt test')
    await command('/trading resume')
    const schemas = desk.ctx.tools.schemas()
    expect(schemas.map(schema => schema.name).sort()).toEqual([
      'cancel_order', 'get_account', 'get_bars', 'get_positions', 'get_quote', 'list_orders', 'place_order',
    ])
    expect(schemas.some(schema => /halt|resume/i.test(schema.name) || /resume/i.test(schema.description))).toBe(false)
    // The output is logged for the UI as command/done, yet derives into no model message.
    expect(desk.events('command/done').map(event => event.data.text)).toEqual([
      'Trading halted. Trading status: halted (paper). Reason: test.', 'Trading resumed. Trading status: ready (paper).',
    ])
    expect(JSON.stringify(desk.session.deriveMessages())).not.toContain('Trading status')
    expect(JSON.stringify(desk.session.deriveMessages())).not.toContain('/trading')
  })

  it('removes /trading when its plugin is disposed', async () => {
    desk = await bootDesk()
    await desk.ctx.plugin(CommandRuntime)
    const plugin = await desk.ctx.plugin(TradingCommand)
    expect(desk.ctx.commands.find(desk.agent, 'trading')).toBeDefined()
    await plugin.dispose()
    expect(desk.ctx.commands.find(desk.agent, 'trading')).toBeUndefined()
    expect(await command('/trading status')).toBeUndefined()
  })
})
