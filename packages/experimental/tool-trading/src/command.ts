/**
 * The user's `/trading` command: show the venue status, halt trading, or resume it. A command line runs in the command
 * registry and is never sent to the model, so the agent still has no way to resume a halted desk. Resume goes through
 * the venue, which re-applies the account safety settings and lifts the broker suspension.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { TradingVenueGateway } from '@deepseek-ai/dsh-experimental-trading-venue'

/** Plugin name. */
export const name = 'command-trading'
/** The command registry and the venue it controls. */
export const inject = ['commands', 'tradingVenue']

const USAGE = 'Usage: /trading [status | halt [reason] | resume]'
const DEFAULT_REASON = 'halted by the user'

/**
 * Describe the venue's current state in one line.
 * @param venue - the trading venue.
 * @returns one line with the derived status, the account mode, and the reason behind the status when there is one.
 */
export function statusLine(venue: TradingVenueGateway): string {
  const reason = venue.statusReason()
  return `Trading status: ${venue.status()} (${venue.mode()}).${reason === '' ? '' : ` Reason: ${reason}.`}`
}

async function halt(venue: TradingVenueGateway, reason: string): Promise<CommandResult> {
  try {
    await venue.halt(reason)
  } catch (error) {
    // The venue halts in memory before saving, so the Halt holds for this process even when the save failed.
    return { kind: 'error', text: `The Halt is in effect but could not be saved: ${(error as Error).message}. ${statusLine(venue)}` }
  }
  return { kind: 'success', text: `Trading halted. ${statusLine(venue)}` }
}

async function resume(venue: TradingVenueGateway): Promise<CommandResult> {
  try {
    await venue.resume()
  } catch (error) {
    return { kind: 'error', text: `Could not resume trading: ${(error as Error).message}. ${statusLine(venue)}` }
  }
  if (venue.status() === 'halted') {
    return { kind: 'error', text: `A Halt arrived while resuming; trading stays halted. ${statusLine(venue)}` }
  }
  return { kind: 'success', text: `Trading resumed. ${statusLine(venue)}` }
}

function run(venue: TradingVenueGateway, rawInput: string): Promise<CommandResult> | CommandResult {
  const input = rawInput.trim()
  const space = input.search(/\s/)
  const verb = space === -1 ? input : input.slice(0, space)
  const rest = space === -1 ? '' : input.slice(space).trim()
  switch (verb) {
    case '':
    case 'status':
      return rest === '' ? { kind: 'success', text: statusLine(venue) } : { kind: 'error', text: USAGE }
    case 'halt':
      return halt(venue, rest === '' ? DEFAULT_REASON : rest)
    case 'resume':
      return rest === '' ? resume(venue) : { kind: 'error', text: USAGE }
    default:
      return { kind: 'error', text: USAGE }
  }
}

/**
 * Register `/trading`.
 * @param ctx - context carrying the command registry and the trading venue.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-tool-trading/command'),
    name: 'trading',
    description: 'Show trading status, or halt or resume trading',
    handler: async (invocation: CommandInvocation) => run(ctx.tradingVenue, invocation.rawInput),
  })
}
