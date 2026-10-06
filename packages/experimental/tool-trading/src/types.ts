/**
 * Types shared by the trading executor, its tools, and the session events and journal entries it records.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/types
 */
import type {
  AssetClass, BrokerOrder, BrokerOrderId, ClientOrderId, OrderRequest, OrderStatus, ProposalId, RiskCheck, Side, SubmissionPlan,
  Timeframe, TradingMode, VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'

/** Who proposed an order: the in-app dsh agent, or Claude Code over the MCP endpoint. */
export type ProposalSource = 'dsh-agent' | 'claude-code-mcp'

/** Best bid and ask shown with a proposal. */
export interface ProposalQuote {
  /** Best bid. */
  readonly bid: number
  /** Best ask. */
  readonly ask: number
}

/** A checked order proposal, recorded as `trading/proposal` before the user is asked. */
export interface TradingOrderProposal {
  /** Discriminant. */
  readonly kind: 'order'
  /** Executor-minted id; keys the approval, the journal entry, and the client order id. */
  readonly proposalId: ProposalId
  /** In-app tool call id; absent for MCP proposals. */
  readonly callId?: ToolCallId
  /** Proposing agent. */
  readonly source: ProposalSource
  /** Account mode the order would trade in. */
  readonly mode: TradingMode
  /** The order as proposed. */
  readonly order: OrderRequest
  /** The agent's one-to-three-sentence reason, shown with the approval request. */
  readonly rationale: string
  /** Bid and ask at the first check. */
  readonly quote: ProposalQuote
  /** Whether the instrument's market was open at the first check. */
  readonly marketOpen: boolean
  /** Price the estimate and the cap use (limit, stop, or the touch); 0 for an unpriced reduce-only exit. */
  readonly referencePrice: number
  /** Estimated order value in dollars. */
  readonly estimatedNotional: number
  /** Estimated value as a fraction of equity. */
  readonly equityPct: number
  /** Whether the order only reduces a position, as of the first check. */
  readonly reduceOnly: boolean
  /** Broker-facing type, prices, and time in force planned at the first check. */
  readonly plan: SubmissionPlan
  /** The instrument's price tick. */
  readonly priceIncrement: number
  /** Every risk check in display order. */
  readonly checks: readonly RiskCheck[]
}

/** A cancellation proposal for one open order. */
export interface TradingCancelProposal {
  /** Discriminant. */
  readonly kind: 'cancel'
  /** Executor-minted id. */
  readonly proposalId: ProposalId
  /** In-app tool call id; absent for MCP proposals. */
  readonly callId?: ToolCallId
  /** Proposing agent. */
  readonly source: ProposalSource
  /** Account mode. */
  readonly mode: TradingMode
  /** The open order as the broker reported it at the check. */
  readonly order: BrokerOrder
  /** The agent's reason. */
  readonly rationale: string
}

/** Payload of the `trading/proposal` session event. */
export type TradingProposal = TradingOrderProposal | TradingCancelProposal

/** Payload of the `trading/order` session event: what happened when an approved proposal was sent. */
export interface TradingOrderEvent {
  /** Proposal that was sent. */
  readonly proposalId: ProposalId
  /** Outcome; `unknown` means the order may exist and must be looked up before proposing again. */
  readonly outcome: 'submitted' | 'cancelled' | 'failed' | 'unknown'
  /** Broker order id, when known. */
  readonly orderId?: BrokerOrderId
  /** Broker order status, when submitted. */
  readonly status?: OrderStatus
  /** Readable failure reason. */
  readonly message?: string
}

/** Payload of the `trading/fill` session event: one fill of a desk order. */
export interface TradingFillEvent {
  /** Proposal the order came from. */
  readonly proposalId: ProposalId
  /** Broker order id. */
  readonly orderId: BrokerOrderId
  /** Instrument ticker. */
  readonly ticker: string
  /** Direction. */
  readonly side: Side
  /** Quantity of this fill. */
  readonly fillQty: number
  /** Price of this fill, when reported. */
  readonly fillPrice?: number
  /** Total filled quantity after this fill. */
  readonly filledQty: number
  /** Average fill price so far, when reported. */
  readonly filledAvgPrice?: number
  /** Order status after this fill. */
  readonly status: OrderStatus
  /** Fill time, UTC epoch milliseconds. */
  readonly t: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A checked order or cancellation proposal — log-only, appended before the user is asked. The tool body
     * submits only a proposal whose own event was committed and whose tool call received an `allowed-once` decision.
     */
    'trading/proposal': TradingProposal
    /** The outcome of sending an approved proposal to the broker — log-only. */
    'trading/order': TradingOrderEvent
    /** One fill of a desk order from the broker's order stream or reconciliation — log-only. */
    'trading/fill': TradingFillEvent
  }
}

/** Lifecycle of a journaled proposal. */
export type JournalStatus =
  | 'proposed' | 'denied' | 'rejected' | 'submitted' | 'partially_filled' | 'filled' | 'canceled' | 'expired' | 'failed' | 'unknown'

/** One proposal in the trading journal (storage domain `trading_journal`, table `entries`, keyed by proposal id). */
export interface JournalEntry {
  /** Proposal id; the table key. */
  readonly proposalId: ProposalId
  /** Session whose log records the proposal; links the entry to the proposing message. */
  readonly sessionId: SessionId
  /** In-app tool call id. */
  readonly callId?: ToolCallId
  /** Proposing agent. */
  readonly source: ProposalSource
  /** Order or cancellation. */
  readonly kind: 'order' | 'cancel'
  /** Instrument ticker. */
  readonly ticker: string
  /** Direction. */
  readonly side: Side
  /** Ordered quantity. */
  readonly qty?: number
  /** Ordered dollar amount. */
  readonly notional?: number
  /** The agent's reason. */
  readonly rationale: string
  /** Idempotency key sent to the broker (order proposals only). */
  readonly clientOrderId?: ClientOrderId
  /** Broker order id once known. */
  readonly orderId?: BrokerOrderId
  /** Current lifecycle status. */
  readonly status: JournalStatus
  /** Filled quantity so far. */
  readonly filledQty: number
  /** Average fill price so far. */
  readonly filledAvgPrice?: number
  /** Trading day of the proposal, `YYYY-MM-DD` in America/New_York. */
  readonly day: string
  /** Creation time, UTC epoch milliseconds. */
  readonly createdAt: number
  /** Last update time, UTC epoch milliseconds. */
  readonly updatedAt: number
  /** Readable reason for the current status. */
  readonly note?: string
}

/** Who is proposing and where the proposal is recorded. */
export interface ProposalContext {
  /** Session whose log records the proposal, its order, and its fills. */
  readonly session: Session
  /** Proposing agent. */
  readonly source: ProposalSource
  /** In-app tool call id; MCP calls have none. */
  readonly callId?: ToolCallId
}

/**
 * Outcome of a proposal's first check. `duplicate` returns the pending proposal an identical MCP proposal from the same
 * session already created.
 */
export type ProposeResult =
  | { readonly kind: 'denied'; readonly reasons: readonly string[] }
  | { readonly kind: 'pending'; readonly proposalId: ProposalId; readonly summary: string }
  | { readonly kind: 'duplicate'; readonly proposalId: ProposalId; readonly summary: string }

/**
 * `get_quote` result. Tool results are JSON values: the report types are type aliases with mutable arrays so each is
 * assignable to `JsonValue`.
 */
export type QuoteReport = {
  readonly symbol: string
  readonly assetClass: AssetClass
  readonly bid: number
  readonly ask: number
  readonly mid: number
  readonly ageSeconds: number
  readonly marketOpen: boolean
}

/** `get_account` result. */
export type AccountReport = {
  readonly mode: TradingMode
  readonly status: VenueStatus
  readonly equity: number
  readonly cash: number
  readonly buyingPower: number
  readonly dayPl: number
  readonly dayPlPct: number
  readonly tradingBlocked: boolean
}

/** One `get_positions` row. */
export type PositionReport = {
  readonly symbol: string
  readonly qty: number
  readonly qtyAvailable: number
  readonly avgEntryPrice: number
  readonly currentPrice: number
  readonly marketValue: number
  readonly unrealizedPl: number
}

/** One open broker order in `list_orders`. */
export type OrderRow = {
  readonly orderId: BrokerOrderId
  readonly symbol: string
  readonly side: Side
  readonly type: string
  readonly qty?: number
  readonly notional?: number
  readonly limitPrice?: number
  readonly stopPrice?: number
  readonly timeInForce: string
  readonly filledQty: number
  readonly status: OrderStatus
}

/** One desk order proposed today, in `list_orders`. */
export type JournalRow = {
  readonly proposalId: ProposalId
  readonly symbol: string
  readonly side: Side
  readonly qty?: number
  readonly notional?: number
  readonly status: JournalStatus
  readonly filledQty: number
  readonly filledAvgPrice?: number
  readonly orderId?: BrokerOrderId
  readonly note?: string
}

/** `list_orders` result. */
export type OrdersReport = {
  readonly open: OrderRow[]
  readonly today: JournalRow[]
}

/** `place_order` / `cancel_order` result. */
export type OrderReport = {
  readonly proposalId: ProposalId
  readonly orderId: BrokerOrderId
  readonly symbol: string
  readonly side: Side
  readonly type: string
  readonly qty?: number
  readonly notional?: number
  readonly limitPrice?: number
  readonly stopPrice?: number
  readonly timeInForce: string
  /** Broker status, or `cancel_requested` for an accepted cancellation. */
  readonly status: string
  readonly filledQty: number
  readonly filledAvgPrice?: number
  /** Whether a market order was sent as a capped limit. */
  readonly capped: boolean
}

/** Indicators `get_bars` can add to its summary. */
export type IndicatorName = 'sma' | 'ema' | 'rsi' | 'macd' | 'bollinger'

/** `get_bars` request after argument validation. */
export interface BarsRequest {
  readonly symbol: string
  readonly timeframe: string
  readonly limit?: number
  readonly indicators?: readonly IndicatorName[]
}

/** One swing high or low. */
export type SwingPoint = {
  readonly t: number
  readonly price: number
}

/** `get_bars` result. `bars` rows are `[t, open, high, low, close, volume]`, oldest first. */
export type BarsReport = {
  readonly symbol: string
  readonly timeframe: Timeframe
  readonly count: number
  readonly summary: {
    readonly last: number
    readonly high: number
    readonly low: number
    readonly changePct: number
    readonly swingHighs: SwingPoint[]
    readonly swingLows: SwingPoint[]
  } | null
  readonly indicators: {
    readonly sma20?: number | null
    readonly ema20?: number | null
    readonly rsi14?: number | null
    readonly macd?: { readonly macd: number | null; readonly signal: number | null; readonly histogram: number | null }
    readonly bollinger?: { readonly upper: number | null; readonly middle: number | null; readonly lower: number | null }
  }
  readonly bars: number[][]
}
