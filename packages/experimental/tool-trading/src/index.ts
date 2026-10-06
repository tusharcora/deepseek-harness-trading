/**
 * Trading order executor and model-facing trading tools. The package root default-exports the executor service at
 * `ctx.tradingExecutor`; `@deepseek-ai/dsh-experimental-tool-trading/tools` registers the seven tools.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading
 */
import { TradingExecutor } from './executor.ts'

export { Config } from './config.ts'
export { TradingExecutor } from './executor.ts'
export type { ProposedCancel, ProposedOrder } from './order-args.ts'
export type * from './types.ts'

export default TradingExecutor
