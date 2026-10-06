/**
 * The seven model-facing trading tools over `ctx.tradingExecutor`. The `trader` agent preset mounts this plugin, so no
 * other agent sees them. `place_order` and `cancel_order` always ask: the executor's pre-execute listener checks the
 * proposal and asks, and the body sends only a checked, approved proposal.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { TIMEFRAMES } from '@deepseek-ai/dsh-experimental-trading'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { INDICATORS, renderBars } from './bars.ts'
import type { TradingExecutor } from './executor.ts'
import { NO_CHECKED_PROPOSAL, renderAccount, renderOrderReport, renderOrders, renderPositions, renderQuote } from './format.ts'
import type { AccountReport, BarsReport, OrderReport, OrdersReport, PositionReport, QuoteReport } from './types.ts'

/** Plugin name. */
export const name = 'tool-trading'
/** Services the tools call. */
export const inject = ['tools', 'tradingExecutor']

const SYMBOL = 'A US stock ticker such as AAPL, or a crypto pair such as BTC/USD (BTCUSD also works).'
const RATIONALE = 'One to three sentences on why, shown to the user with the approval request.'
const PLACE_ORDER = 'Propose a stock or crypto order. The user approves or rejects every order before it reaches the broker; an '
  + 'order that breaks a risk limit is refused with the reasons, and the limits cannot be changed from here. Give exactly one of '
  + 'qty or notional; notional orders are market orders. Crypto orders use time_in_force gtc or ioc and type market, limit, or '
  + 'stop_limit. Fractional and notional stock orders are day orders. A plain stop order is accepted only to reduce a position '
  + 'you hold; use stop_limit otherwise. A market order that adds exposure is sent as a limit near the quoted price, so it may '
  + "not fill in a fast market. take_profit with stop_loss adds a bracket to a whole-share stock order; the bracket's exits are "
  + 'separate broker orders that this desk does not report, so check get_positions after a bracket may have exited. The result '
  + 'reports the order id and status; later fills arrive as messages.'
const OUTPUT = { type: 'json' } as const

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

async function executeCall(executor: TradingExecutor, exec: ToolRunContext): Promise<JsonValue> {
  const sessionId = exec.agent?.session.id
  const proposalId = sessionId === undefined ? undefined : executor.proposalForCall(sessionId, exec.callId)
  if (sessionId === undefined || proposalId === undefined) throw new Error(NO_CHECKED_PROPOSAL)
  return await executor.execute(proposalId, sessionId)
}

/**
 * Register the trading tools.
 * @param ctx - plugin context with the tool registry and the executor.
 */
export function apply(ctx: Context): void {
  const executor = ctx.tradingExecutor
  const window = executor.barWindow()
  ctx.tools.register(defineTool({
    name: 'get_quote',
    description: 'Get the latest bid and ask for a US stock or a crypto pair, how old the quote is, and whether its market is open.',
    parameters: { symbol: { type: 'string', required: true, description: SYMBOL } },
    output: { schema: OUTPUT, render: (_args, value) => text(renderQuote(value as QuoteReport)) },
    isConcurrencySafe: () => true,
    execute: args => executor.quote(args.symbol),
  }))
  ctx.tools.register(defineTool({
    name: 'get_bars',
    description: 'Get recent price bars for a US stock or a crypto pair, oldest first, with a summary: last price, high and low of '
      + 'the window, change, recent swing highs and lows, and the latest value of each requested indicator (sma: SMA 20, ema: '
      + 'EMA 20, rsi: RSI 14, macd: MACD 12/26/9, bollinger: Bollinger 20/2). Returns the last `limit` bars (default '
      + `${window.defaultCount}, at most ${window.cap}) as a CSV table.`,
    parameters: {
      symbol: { type: 'string', required: true, description: SYMBOL },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Bar length.' },
      limit: { type: 'integer', description: 'How many of the most recent bars to return.' },
      indicators: { type: 'array', items: { type: 'string', enum: [...INDICATORS] }, description: 'Indicators to summarize.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(renderBars(value as BarsReport)) },
    isConcurrencySafe: () => true,
    execute: args => executor.bars({
      symbol: args.symbol, timeframe: args.timeframe,
      ...args.limit === undefined ? {} : { limit: args.limit },
      ...args.indicators === undefined ? {} : { indicators: args.indicators },
    }),
  }))
  ctx.tools.register(defineTool({
    name: 'get_account',
    description: 'Get the trading account: paper or live, whether trading is ready or halted, equity, cash, buying power, and '
      + 'profit or loss since the previous close.',
    parameters: {},
    output: { schema: OUTPUT, render: (_args, value) => text(renderAccount(value as AccountReport)) },
    isConcurrencySafe: () => true,
    execute: () => executor.account(),
  }))
  ctx.tools.register(defineTool({
    name: 'get_positions',
    description: 'List open positions with quantity, quantity available to sell, average entry price, current price, market value, '
      + 'and unrealized profit or loss.',
    parameters: {},
    output: { schema: OUTPUT, render: (_args, value) => text(renderPositions(value as PositionReport[])) },
    isConcurrencySafe: () => true,
    execute: () => executor.positions(),
  }))
  ctx.tools.register(defineTool({
    name: 'list_orders',
    description: "List the broker's open orders with their order ids, and the orders proposed through this desk today with their "
      + 'status and fills.',
    parameters: {},
    output: { schema: OUTPUT, render: (_args, value) => text(renderOrders(value as OrdersReport)) },
    isConcurrencySafe: () => true,
    execute: () => executor.orders(),
  }))
  ctx.tools.register(defineTool({
    name: 'place_order',
    description: PLACE_ORDER,
    parameters: {
      symbol: { type: 'string', required: true, description: SYMBOL },
      side: { type: 'string', required: true, enum: ['buy', 'sell'] },
      qty: { type: 'number', description: 'Quantity in shares or coins. Give exactly one of qty or notional.' },
      notional: { type: 'number', description: 'Dollar amount for a market order. Give exactly one of qty or notional.' },
      type: { type: 'string', required: true, enum: ['market', 'limit', 'stop', 'stop_limit'] },
      limit_price: { type: 'number', description: 'Required for limit and stop_limit orders.' },
      stop_price: { type: 'number', description: 'Required for stop and stop_limit orders.' },
      time_in_force: {
        type: 'string', required: true, enum: ['day', 'gtc', 'ioc'],
        description: 'Stocks: day or gtc (fractional and notional orders are day only). Crypto: gtc or ioc.',
      },
      take_profit: { type: 'number', description: 'Bracket take-profit limit price; whole-share stock orders only, with stop_loss.' },
      stop_loss: { type: 'number', description: 'Bracket stop-loss price; whole-share stock orders only, with take_profit.' },
      rationale: { type: 'string', required: true, description: RATIONALE },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(renderOrderReport(value as OrderReport)) },
    execute: (_args, exec) => executeCall(executor, exec),
  }))
  ctx.tools.register(defineTool({
    name: 'cancel_order',
    description: 'Propose cancelling one open order by its order id from list_orders. The user approves or rejects the cancellation.',
    parameters: {
      order_id: { type: 'string', required: true, description: 'Order id from list_orders.' },
      rationale: { type: 'string', required: true, description: RATIONALE },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(renderOrderReport(value as OrderReport)) },
    execute: (_args, exec) => executeCall(executor, exec),
  }))
}
