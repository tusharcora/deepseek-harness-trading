/**
 * The trading order executor at `ctx.tradingExecutor`: the only broker path the trading tools offer. A proposal is
 * validated, checked against the limits and reserved under the account lock, journaled, and recorded as
 * `trading/proposal`; the user is asked; after an `allowed-once` decision it is re-checked and submitted under the lock
 * again. The in-app tools call these methods; `proposeOrder` and `proposeCancel` also serve the planned MCP endpoint.
 *
 * @module @deepseek-ai/dsh-experimental-tool-trading/executor
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import {
  type BrokerOrder, type BrokerOrderRequest, checkRisk, type ClientOrderId, isTimeframe, type OrderRequest, type OrderStatus,
  type OrderStreamEvent, type OrderUpdate, type ProposalId, type RiskLimits, TIMEFRAMES, validateOrder, type VenueStatus,
} from '@deepseek-ai/dsh-experimental-trading'
import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type z from '@deepseek-ai/schemastery'
import { barsReport, WARMUP_BARS } from './bars.ts'
import { ProposalBook } from './book.ts'
import { Config, riskLimitsOf, validateConfig } from './config.ts'
import {
  APPROVAL_OFF, BLOCKED, cancelSummary, compact, failureOf, fillText, HALTED, isInsufficientBalance, KEYS_MISSING, NO_AGENT,
  NO_CHECKED_PROPOSAL, PRICE_MOVED, proposalSummary, TRADING_BLOCKED,
} from './format.ts'
import { clientOrderIdFor, mintProposalId, tradingDay } from './ids.ts'
import { type InFlightEntry, Journal, type JournalPatch, tradingJournalSpec } from './journal.ts'
import { AccountLock } from './lock.ts'
import { parseCancelOrder, parsePlaceOrder, type ProposedCancel, type ProposedOrder, symbolOf, tickViolations } from './order-args.ts'
import { brokerRequest, drifted, heldBySells, planOrder, takeSnapshot } from './snapshot.ts'
import type {
  AccountReport, BarsReport, BarsRequest, JournalEntry, JournalRow, JournalStatus, OrderReport, OrderRow, OrdersReport,
  PositionReport, ProposalContext, ProposeResult, QuoteReport, TradingCancelProposal, TradingFillEvent, TradingOrderEvent,
  TradingOrderProposal, TradingProposal,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tradingExecutor: TradingExecutor
  }
}

type FirstCheck =
  | { readonly kind: 'denied'; readonly reasons: readonly string[]; readonly journal: boolean }
  | { readonly kind: 'checked'; readonly proposal: TradingOrderProposal }

/** Tools whose calls must pass the executor: they reach the broker. */
const ORDER_TOOLS: ReadonlySet<string> = new Set(['place_order', 'cancel_order'])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

function refusal(status: VenueStatus): string | undefined {
  switch (status) {
    case 'ready': return undefined
    case 'halted': return HALTED
    case 'blocked': return BLOCKED
    case 'unconfigured': return KEYS_MISSING
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(status, 'VenueStatus')
  }
}

function denied(reasons: readonly string[]): ProposeResult {
  return { kind: 'denied', reasons }
}

function journalStatus(status: OrderStatus): JournalStatus {
  return status === 'open' ? 'submitted' : status
}

/** Plugin name on the fill notices an agent receives. */
const PLUGIN_NAME = '@deepseek-ai/dsh-experimental-tool-trading'

/**
 * Journal status order: a later, lower-ranked view of an order (a stale submit result or snapshot) never moves it back.
 * `failed` ranks lowest so a broker view of an order the desk recorded as failed corrects the record.
 */
const RANK: Readonly<Record<JournalStatus, number>> = {
  failed: 0, proposed: 0, submitted: 1, unknown: 1, partially_filled: 2, filled: 3, canceled: 3, expired: 3, rejected: 3, denied: 3,
}

/** Broker final statuses: once journaled, a later view never replaces them; only the filled quantity may still grow. */
const BROKER_FINAL: ReadonlySet<JournalStatus> = new Set(['filled', 'canceled', 'expired', 'rejected'])

const NOT_PLACED = 'the broker has no order with this id, so it was not placed'

/** Below this difference an update's own fill quantity is the quantity the fold adds. */
const QTY_EPSILON = 1e-9

/** A broker number the journal may store: a non-finite value serializes as `null` and the journal would refuse to reopen. */
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value)

function orderEntry(
  proposalId: ProposalId, order: OrderRequest, rationale: string, context: ProposalContext, now: number, status: JournalStatus,
  clientOrderId: ClientOrderId | undefined, note: string | undefined,
): JournalEntry {
  return compact<JournalEntry>({
    proposalId, sessionId: context.session.id, callId: context.callId, source: context.source, kind: 'order',
    ticker: order.symbol.ticker, side: order.side, qty: order.qty, notional: order.notional, rationale, clientOrderId,
    orderId: undefined, status, filledQty: 0, filledAvgPrice: undefined, day: tradingDay(now), createdAt: now, updatedAt: now, note,
  })
}

function orderReport(proposalId: ProposalId, order: BrokerOrder, status: string, capped: boolean): OrderReport {
  return compact<OrderReport>({
    proposalId, orderId: order.id, symbol: order.symbol.ticker, side: order.side, type: order.type, qty: order.qty,
    notional: order.notional, limitPrice: order.limitPrice, stopPrice: order.stopPrice, timeInForce: order.timeInForce, status,
    filledQty: order.filledQty, filledAvgPrice: order.filledAvgPrice, capped,
  })
}

/** The order executor service. */
export class TradingExecutor extends Service {
  static inject = ['tradingVenue', 'tools', 'storageDomain', 'sessions', 'agents']
  static Config: z<Partial<Config>, Config> = Config

  private readonly settings: Config
  private readonly limits: RiskLimits
  private readonly book = new ProposalBook()
  private readonly lock = new AccountLock()
  private readonly journalReady = Promise.withResolvers<Journal>()
  /** Serializes every journal write about a submitted order: the submit result, stream updates, and reconciliation. */
  private readonly updates = new AccountLock()

  /**
   * @param ctx - plugin context.
   * @param config - risk limits, drift tolerance, `get_bars` limits, and timers.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tradingExecutor')
    this.settings = validateConfig(config)
    this.limits = riskLimitsOf(this.settings)
    ctx.on('session/event', (session, event) => { this.observe(session.id, event) })
    // Steps 1–4 run here, before the body. A downstream deny or cancel stands; anything else is replaced by the
    // executor's own check and an ask. A listener prepended ahead that answers without delegating leaves no checked
    // proposal, so the body fails closed.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (!ORDER_TOOLS.has(exec.name)) return next()
      const downstream = await next()
      if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
      return this.gate(exec)
    })
    // Guards run after the ask resolves and have no allow, so a Halt during the approval still stops the call.
    ctx.tools.guard(exec => ORDER_TOOLS.has(exec.name) && ctx.tradingVenue.status() === 'halted' ? HALTED : undefined)
    // Whatever ended the call (a guard, a later denial, an interrupted turn), its reservation must not outlive it.
    ctx.on('tools/result', (exec) => {
      const sessionId = exec.agent?.session.id
      if (!ORDER_TOOLS.has(exec.name) || sessionId === undefined) return
      const settled = this.book.settleCall(sessionId, exec.callId)
      if (settled === undefined) return
      const note = ctx.tradingVenue.status() === 'halted' ? 'not sent: trading is halted' : 'not sent'
      this.journalLater(settled.proposal.proposalId, { status: 'rejected', note })
    })
  }

  /** Open the trading journal, follow the venue's order stream, and reconcile at startup and every `reconcileMs`. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(tradingJournalSpec)
    this.ctx.effect(() => async () => { await domain.close() }, 'tool-trading journal close')
    this.journalReady.resolve(new Journal(domain))
    this.ctx.effect(() => {
      const off = this.ctx.tradingVenue.subscribeOrderUpdates((event) => { this.onOrderEvent(event) })
      const timer = setInterval(() => { this.reconcileLater() }, this.settings.reconcileMs)
      timer.unref()
      return () => {
        off()
        clearInterval(timer)
      }
    }, 'tool-trading order updates')
    // A new subscriber gets no gap for what happened before it subscribed; read the broker state now.
    this.reconcileLater()
  }

  /**
   * The venue's status, read synchronously; the tools refuse orders unless it is `ready`.
   * @returns the venue's derived status.
   */
  status(): VenueStatus {
    return this.ctx.tradingVenue.status()
  }

  /**
   * The configured `get_bars` window, for the tool schema.
   * @returns how many bars `get_bars` shows by default and at most.
   */
  barWindow(): { readonly defaultCount: number; readonly cap: number } {
    return { defaultCount: this.settings.barsDefault, cap: this.settings.barsCap }
  }

  /**
   * Read the latest quote and the market session for one instrument.
   * @param symbolText - instrument name as typed.
   * @returns the latest quote, its age, and whether the market is open.
   */
  async quote(symbolText: string): Promise<QuoteReport> {
    const symbol = symbolOf(symbolText)
    const venue = this.ctx.tradingVenue
    const [quote, marketOpen] = await Promise.all([venue.latestQuote(symbol), venue.marketOpen(symbol)])
    return {
      symbol: symbol.ticker, assetClass: symbol.assetClass, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2,
      ageSeconds: Math.max(0, Math.round((Date.now() - quote.t) / 1000)), marketOpen,
    }
  }

  /**
   * Read recent bars with warm-up for the indicators. A request without a limit gets `barsDefault` bars; a larger
   * limit is cut to `barsCap`.
   * @param request - symbol, timeframe, optional count and indicators.
   * @returns the bars report over at most `barsCap` bars.
   * @throws Error when the timeframe is unknown or the limit is not a whole number of at least 1.
   */
  async bars(request: BarsRequest): Promise<BarsReport> {
    const symbol = symbolOf(request.symbol)
    const timeframe = request.timeframe
    if (!isTimeframe(timeframe)) throw new Error(`timeframe must be one of ${TIMEFRAMES.join(', ')}`)
    const limit = request.limit ?? this.settings.barsDefault
    if (!(Number.isInteger(limit) && limit >= 1)) throw new Error('limit must be a whole number of at least 1')
    const shown = Math.min(limit, this.settings.barsCap)
    const bars = await this.ctx.tradingVenue.bars(symbol, timeframe, { limit: shown + WARMUP_BARS })
    return barsReport(symbol, timeframe, bars, shown, request.indicators ?? [])
  }

  /**
   * Read the account, its mode, and the venue status.
   * @returns the account with day profit or loss against the previous close.
   */
  async account(): Promise<AccountReport> {
    const venue = this.ctx.tradingVenue
    const account = await venue.account()
    const dayPl = account.equity - account.lastEquity
    return {
      mode: venue.mode(), status: venue.status(), equity: account.equity, cash: account.cash, buyingPower: account.buyingPower,
      dayPl, dayPlPct: account.lastEquity > 0 ? dayPl / account.lastEquity * 100 : 0, tradingBlocked: account.tradingBlocked,
    }
  }

  /**
   * Read the broker's open positions.
   * @returns open positions.
   */
  async positions(): Promise<PositionReport[]> {
    return (await this.ctx.tradingVenue.positions()).map(position => ({
      symbol: position.symbol.ticker, qty: position.qty, qtyAvailable: position.qtyAvailable, avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice, marketValue: position.marketValue, unrealizedPl: position.unrealizedPl,
    }))
  }

  /**
   * Read the broker's open orders and today's journal entries for order proposals.
   * @returns the broker's open orders and today's desk orders.
   */
  async orders(): Promise<OrdersReport> {
    const [open, journal] = await Promise.all([this.ctx.tradingVenue.openOrders(), this.journalReady.promise])
    return {
      open: open.map(order => compact<OrderRow>({
        orderId: order.id, symbol: order.symbol.ticker, side: order.side, type: order.type, qty: order.qty, notional: order.notional,
        limitPrice: order.limitPrice, stopPrice: order.stopPrice, timeInForce: order.timeInForce, filledQty: order.filledQty,
        status: order.status,
      })),
      today: journal.on(tradingDay(Date.now())).filter(entry => entry.kind === 'order').map(entry => compact<JournalRow>({
        proposalId: entry.proposalId, symbol: entry.ticker, side: entry.side, qty: entry.qty, notional: entry.notional,
        status: entry.status, filledQty: entry.filledQty, filledAvgPrice: entry.filledAvgPrice, orderId: entry.orderId, note: entry.note,
      })),
    }
  }

  /**
   * Steps 1–4 for an order: validate, then under the account lock snapshot, check, and reserve; journal the proposal and
   * append `trading/proposal`. A risk denial is journaled; an identical pending MCP proposal is returned instead.
   * @param input - the order and its rationale.
   * @param context - proposing session, source, and call id.
   * @returns the denial, or the pending proposal and its approval summary.
   */
  async proposeOrder(input: ProposedOrder, context: ProposalContext): Promise<ProposeResult> {
    const venue = this.ctx.tradingVenue
    const early = venue.status()
    if (early === 'halted') return denied([HALTED])
    if (early === 'blocked') return denied([BLOCKED])
    const { order, rationale } = input
    const sessionId = context.session.id
    if (context.source === 'claude-code-mcp') {
      const duplicate = this.book.findDuplicate(sessionId, order)
      if (duplicate !== undefined) {
        return { kind: 'duplicate', proposalId: duplicate.proposalId, summary: proposalSummary(duplicate, this.settings.driftTolerance) }
      }
    }
    // The first venue call also runs the venue's own setup when it has not completed (keys added, broker back).
    const asset = await venue.asset(order.symbol)
    const invalid = [...validateOrder(order, asset).map(violation => violation.message), ...tickViolations(order, asset.priceIncrement)]
    if (invalid.length > 0) return denied(invalid)
    const journal = await this.journalReady.promise
    const proposalId = mintProposalId()
    const now = Date.now()
    const checked = await this.lock.run(async (): Promise<FirstCheck> => {
      const gate = refusal(venue.status())
      if (gate !== undefined) return { kind: 'denied', reasons: [gate], journal: false }
      const snapshot = await takeSnapshot(order.symbol, { venue, book: this.book, journal, now })
      if (snapshot.account.tradingBlocked) return { kind: 'denied', reasons: [TRADING_BLOCKED], journal: false }
      const risk = checkRisk(order, snapshot.risk, this.limits)
      if (!risk.ok) {
        const failed = risk.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`)
        return { kind: 'denied', reasons: [...heldBySells(order, risk.quantity, snapshot.risk.exposure), ...failed], journal: true }
      }
      const plan = planOrder(order, risk.referencePrice, this.settings.driftTolerance, risk.reduceOnly, asset.priceIncrement)
      const proposal = compact<TradingOrderProposal>({
        kind: 'order', proposalId, callId: context.callId, source: context.source, mode: venue.mode(), order, rationale,
        quote: { bid: snapshot.quote.bid, ask: snapshot.quote.ask }, marketOpen: snapshot.marketOpen,
        referencePrice: risk.referencePrice, estimatedNotional: risk.estimatedNotional,
        equityPct: snapshot.account.equity > 0 ? risk.estimatedNotional / snapshot.account.equity : 0,
        reduceOnly: risk.reduceOnly, plan, priceIncrement: asset.priceIncrement, checks: risk.checks,
      })
      const reservation = { ticker: order.symbol.ticker, side: order.side, qty: risk.quantity, notional: risk.estimatedNotional }
      this.book.add(proposal, sessionId, reservation)
      return { kind: 'checked', proposal }
    })
    if (checked.kind === 'denied') {
      if (checked.journal) {
        await journal.put(orderEntry(proposalId, order, rationale, context, now, 'denied', undefined, checked.reasons.join('; ')))
      }
      return denied(checked.reasons)
    }
    const entry = orderEntry(proposalId, order, rationale, context, now, 'proposed', clientOrderIdFor(sessionId, proposalId), undefined)
    await this.record(journal, checked.proposal, entry, context)
    return { kind: 'pending', proposalId, summary: proposalSummary(checked.proposal, this.settings.driftTolerance) }
  }

  /**
   * Steps 1–4 for a cancellation: the order must be open at the broker.
   * @param input - broker order id and rationale.
   * @param context - proposing session, source, and call id.
   * @returns the denial, or the pending proposal and its approval summary.
   */
  async proposeCancel(input: ProposedCancel, context: ProposalContext): Promise<ProposeResult> {
    const venue = this.ctx.tradingVenue
    const open = await venue.openOrders()
    const gate = refusal(venue.status())
    if (gate !== undefined) return denied([gate])
    const order = open.find(candidate => candidate.id === input.orderId)
    if (order === undefined) return denied([`no open order has id ${input.orderId}; call list_orders for the current ids`])
    const journal = await this.journalReady.promise
    const proposalId = mintProposalId()
    const now = Date.now()
    const proposal = compact<TradingCancelProposal>({
      kind: 'cancel', proposalId, callId: context.callId, source: context.source, mode: venue.mode(), order, rationale: input.rationale,
    })
    this.book.add(proposal, context.session.id)
    await this.record(journal, proposal, compact<JournalEntry>({
      proposalId, sessionId: context.session.id, callId: context.callId, source: context.source, kind: 'cancel',
      ticker: order.symbol.ticker, side: order.side, qty: order.qty, notional: order.notional, rationale: input.rationale,
      clientOrderId: undefined, orderId: order.id, status: 'proposed', filledQty: 0, filledAvgPrice: undefined, day: tradingDay(now),
      createdAt: now, updatedAt: now, note: undefined,
    }), context)
    return { kind: 'pending', proposalId, summary: cancelSummary(proposal) }
  }

  /**
   * Look up the proposal created for an in-app tool call.
   * @param sessionId - session of the tool call.
   * @param callId - in-app tool call id.
   * @returns the unsettled proposal the pre-execute listener created for that call.
   */
  proposalForCall(sessionId: SessionId, callId: ToolCallId): ProposalId | undefined {
    return this.book.forCall(sessionId, callId)
  }

  /** The pre-execute decision for an order tool call: deny, or ask with the checked proposal's summary. */
  private async gate(exec: ToolExecution): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent === undefined) return { kind: 'deny', reason: NO_AGENT }
    const approval = this.ctx.get('approval')
    const policy = approval === undefined ? 'never' : approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'
    if (policy === 'never') return { kind: 'deny', reason: APPROVAL_OFF }
    const context: ProposalContext = { session: agent.session, source: 'dsh-agent', callId: exec.callId }
    try {
      const result = await this.proposeFromArgs(exec.name, exec.arguments, context)
      if (result.kind === 'denied') return { kind: 'deny', reason: result.reasons.join('\n') }
      return { kind: 'ask', reason: result.summary }
    } catch (error) {
      return { kind: 'deny', reason: failureOf(error).message }
    }
  }

  private async proposeFromArgs(tool: string, args: unknown, context: ProposalContext): Promise<ProposeResult> {
    if (tool === 'place_order') {
      const parsed = parsePlaceOrder(args)
      return parsed.ok ? this.proposeOrder(parsed.value, context) : denied(parsed.reasons)
    }
    const parsed = parseCancelOrder(args)
    return parsed.ok ? this.proposeCancel(parsed.value, context) : denied(parsed.reasons)
  }

  /**
   * Steps 5–8. Fails closed: only a proposal whose own `trading/proposal` event committed and whose call received an
   * `allowed-once` decision is sent; under the account lock it is re-snapshotted, re-checked, planned with the
   * post-approval reduce-only answer, and submitted with its client order id. The proposal settles whatever happens.
   * @param proposalId - the proposal.
   * @param sessionId - the session that proposed it.
   * @returns the submitted order or accepted cancellation.
   * @throws Error with a model-facing reason.
   */
  async execute(proposalId: ProposalId, sessionId: SessionId): Promise<OrderReport> {
    const entry = this.book.get(proposalId)
    if (entry === undefined || entry.sessionId !== sessionId || entry.state !== 'approved') throw new Error(NO_CHECKED_PROPOSAL)
    entry.state = 'submitting'
    try {
      return entry.proposal.kind === 'order'
        ? await this.submitOrder(entry.proposal, sessionId)
        : await this.submitCancel(entry.proposal, sessionId)
    } finally {
      this.book.settle(proposalId)
    }
  }

  /**
   * Re-read the broker's open orders and look up every journaled order still in flight, recording fills the stream did
   * not deliver. Runs at startup, on every order-stream gap, and every `reconcileMs`, because a socket that hangs
   * without closing reports no gap. An order the broker has no record of, never reported, and whose entry has not changed
   * for two reconciliation intervals is marked not placed (a timed-out submission may still be processing at the broker
   * until then); nothing is resubmitted. A failed lookup leaves that order in flight for the next pass.
   * @returns when every in-flight order was checked.
   */
  async reconcile(): Promise<void> {
    const journal = await this.journalReady.promise
    const inFlight = journal.inFlight()
    if (inFlight.length === 0) return
    const venue = this.ctx.tradingVenue
    const open = new Map<ClientOrderId, BrokerOrder>((await venue.openOrders()).map(order => [order.clientOrderId, order]))
    for (const entry of inFlight) {
      try {
        const order = open.get(entry.clientOrderId) ?? await venue.order(entry.clientOrderId)
        await this.updates.run(() => order === undefined ? this.markNotPlaced(journal, entry) : this.foldOrder(order))
      } catch (error) {
        this.warn(`could not reconcile ${entry.proposalId}: ${(error as Error).message}`)
      }
    }
  }

  private onOrderEvent(event: OrderStreamEvent): void {
    switch (event.kind) {
      case 'gap':
        this.reconcileLater()
        break
      case 'update': {
        const { update } = event
        this.updates.run(() => this.foldOrder(update.order, update)).catch((error: unknown) => {
          this.warn(`could not record an order update: ${(error as Error).message}`)
        })
        break
      }
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default: assertNever(event, 'OrderStreamEvent')
    }
  }

  private reconcileLater(): void {
    this.reconcile().catch((error: unknown) => { this.warn(`order reconciliation failed: ${(error as Error).message}`) })
  }

  /**
   * Mark an in-flight order the broker has no record of as not placed. An order the broker reported before (the entry
   * has a broker order id), or whose entry changed within the last two `reconcileMs`, stays in flight: until then the
   * broker may still be processing a submission whose outcome was unknown.
   */
  private async markNotPlaced(journal: Journal, entry: InFlightEntry): Promise<void> {
    if (journal.get(entry.proposalId)?.orderId !== undefined) return
    if (Date.now() - entry.updatedAt <= 2 * this.settings.reconcileMs) return
    await journal.update(entry.proposalId, { status: 'failed', note: NOT_PLACED }, Date.now())
  }

  private async submitOrder(proposal: TradingOrderProposal, sessionId: SessionId): Promise<OrderReport> {
    const venue = this.ctx.tradingVenue
    const journal = await this.journalReady.promise
    const tolerance = this.settings.driftTolerance
    let sent: { readonly order: BrokerOrder; readonly capped: boolean }
    try {
      sent = await this.lock.run(async () => {
        const gate = refusal(venue.status())
        if (gate !== undefined) throw new Error(gate)
        const snapshot = await takeSnapshot(proposal.order.symbol, {
          venue, book: this.book, journal, now: Date.now(), excluding: proposal.proposalId,
        })
        const recheck = checkRisk(proposal.order, snapshot.risk, this.limits)
        const failing = recheck.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`)
        if (failing.length > 0) failing.unshift(...heldBySells(proposal.order, recheck.quantity, snapshot.risk.exposure))
        if (failing.length > 0 || drifted(proposal.referencePrice, recheck.referencePrice, tolerance)) {
          throw new Error([PRICE_MOVED, ...failing].join('; '))
        }
        const plan = planOrder(proposal.order, proposal.referencePrice, tolerance, recheck.reduceOnly, proposal.priceIncrement)
        const request = brokerRequest(proposal.order, plan, clientOrderIdFor(sessionId, proposal.proposalId))
        // In flight from here: after a restart that cuts the submission short, reconciliation looks the order up.
        await this.updates.run(() => journal.update(proposal.proposalId, { status: 'unknown' }, Date.now()))
        return { order: await this.send(request, recheck.reduceOnly), capped: plan.capped }
      })
    } catch (error) {
      const failure = failureOf(error)
      if (failure.outcome === 'unknown') this.warn(`outcome of ${proposal.proposalId} unknown: ${(error as Error).message}`)
      await this.updates.run(() => this.recordFailure(journal, proposal.proposalId, failure.outcome, failure.message))
      this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: failure.outcome, message: failure.message })
      throw new Error(failure.message)
    }
    const { order, capped } = sent
    // The same fold as stream updates: a fill the stream delivered before this result arrived is never overwritten.
    await this.updates.run(() => this.foldOrder(order)).catch((error: unknown) => {
      this.warn(`journal update for ${proposal.proposalId} failed: ${(error as Error).message}`)
    })
    this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: 'submitted', orderId: order.id, status: order.status })
    return orderReport(proposal.proposalId, order, order.status, capped)
  }

  private async submitCancel(proposal: TradingCancelProposal, sessionId: SessionId): Promise<OrderReport> {
    const venue = this.ctx.tradingVenue
    const journal = await this.journalReady.promise
    try {
      const gate = refusal(venue.status())
      if (gate !== undefined) throw new Error(gate)
      await venue.cancelOrder(proposal.order.id)
    } catch (error) {
      const failure = failureOf(error)
      await this.updateJournal(journal, proposal.proposalId, { status: 'failed', note: failure.message })
      this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: 'failed', message: failure.message })
      throw new Error(failure.message)
    }
    await this.updateJournal(journal, proposal.proposalId, { status: 'canceled' })
    this.recordOrder(sessionId, { proposalId: proposal.proposalId, outcome: 'cancelled', orderId: proposal.order.id })
    return orderReport(proposal.proposalId, proposal.order, 'cancel_requested', false)
  }

  /** Submit; a crypto exit refused for insufficient balance right after a fill is retried with the same client order id. */
  private async send(request: BrokerOrderRequest, reduceOnly: boolean): Promise<BrokerOrder> {
    const retries = reduceOnly && request.symbol.assetClass === 'crypto' ? this.settings.exitRetryMs : []
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.ctx.tradingVenue.submitOrder(request)
      } catch (error) {
        const delay = retries[attempt]
        if (delay === undefined || !isInsufficientBalance(error)) throw error
        await sleep(delay)
      }
    }
  }

  /**
   * Fold one broker view of a desk order into the journal. The submit result, every stream update, and every
   * reconciliation lookup go through here, serialized on `updates`: status only moves forward, a broker final status
   * (`filled`, `canceled`, `expired`, `rejected`) is never replaced, the filled quantity only grows, and only its growth
   * is reported, so each filled quantity produces exactly one `trading/fill` and one notice. A broker view that moves an
   * entry off `failed` or `unknown` removes the failure note.
   */
  private async foldOrder(order: BrokerOrder, update?: OrderUpdate): Promise<void> {
    const journal = await this.journalReady.promise
    const entry = journal.byClientOrderId(order.clientOrderId)
    if (entry === undefined) return
    const observed = journalStatus(order.status)
    const status = BROKER_FINAL.has(entry.status) || RANK[observed] < RANK[entry.status] ? entry.status : observed
    const filledQty = finite(order.filledQty) ? Math.max(order.filledQty, entry.filledQty) : entry.filledQty
    const delta = filledQty - entry.filledQty
    if (delta <= 0 && status === entry.status && order.id === entry.orderId) return
    const corrected = status !== entry.status && (entry.status === 'failed' || entry.status === 'unknown')
    const next = await journal.update(entry.proposalId, compact<JournalPatch>({
      status, orderId: order.id, filledQty, filledAvgPrice: finite(order.filledAvgPrice) ? order.filledAvgPrice : entry.filledAvgPrice,
      note: corrected ? null : undefined,
    }), Date.now())
    if (delta > 0) await this.reportFill(next, order, delta, update)
  }

  /**
   * Record a failed submission. When the order stream already reported the order (a fill can arrive before a failed
   * confirmation), the stream's status stands and only the note is added.
   */
  private async recordFailure(journal: Journal, id: ProposalId, outcome: JournalStatus, note: string): Promise<void> {
    const seen = journal.get(id)?.orderId !== undefined
    await this.updateJournal(journal, id, seen ? { note } : { status: outcome, note })
  }

  /**
   * Record a fill as `trading/fill` in the proposing session (when it is live) and queue a notice for that session's
   * agent's next request; an idle agent is not woken. Claude Code proposals get no notice: Claude Code reads fills
   * through tool results and `list_orders`. The update's own fill quantity and price are reported when they account for
   * the whole new quantity; otherwise (a missed update, a view without a fill, an unpriced fill) the new quantity is
   * reported at the order's average price.
   */
  private async reportFill(entry: JournalEntry, order: BrokerOrder, delta: number, update?: OrderUpdate): Promise<void> {
    const own = update !== undefined && finite(update.fillQty) && finite(update.fillPrice)
      && Math.abs(update.fillQty - delta) < QTY_EPSILON
    const fill = compact<TradingFillEvent>({
      proposalId: entry.proposalId, orderId: order.id, ticker: order.symbol.ticker, side: order.side,
      fillQty: own ? update.fillQty : delta, fillPrice: own ? update.fillPrice : entry.filledAvgPrice, filledQty: entry.filledQty,
      filledAvgPrice: entry.filledAvgPrice, status: order.status, t: update?.t ?? Date.now(),
    })
    const session = this.ctx.sessions.get(entry.sessionId)
    if (session === undefined) return
    session.append('trading/fill', fill)
    await this.ctx.sessions.flush(session)
    if (entry.source !== 'dsh-agent') return
    try {
      this.ctx.agents.get(entry.sessionId)?.inject(createUserMessage({
        content: [{ type: 'text', text: fillText(fill) }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
      }))
    } catch (error) {
      this.warn(`could not tell the agent about a fill: ${(error as Error).message}`)
    }
  }

  /** Journal a proposal and append its session event; a failure settles the reservation before rethrowing. */
  private async record(journal: Journal, proposal: TradingProposal, entry: JournalEntry, context: ProposalContext): Promise<void> {
    try {
      await journal.put(entry)
      context.session.append('trading/proposal', proposal)
    } catch (error) {
      this.book.settle(proposal.proposalId)
      throw error
    }
  }

  /** Fold the session events the book projects: the proposal's own event and the approval pair of its call. */
  private observe(sessionId: SessionId, event: SessionEvent): void {
    switch (event.type) {
      case 'trading/proposal':
        this.book.markLogged(sessionId, event.data.proposalId)
        break
      case 'approval/asked':
        if (ORDER_TOOLS.has(event.data.toolName)) this.book.linkApproval(sessionId, event.data.callId, event.data.id)
        break
      case 'approval/decided': {
        const settled = this.book.decide(event.data.id, event.data.outcome)
        if (settled === undefined) break
        this.journalLater(settled.proposal.proposalId, { status: 'rejected', note: `approval ${event.data.outcome}` })
        break
      }
      default:
        // SessionEventMap is merge-extensible; no other event changes the book.
        break
    }
  }

  /** Record a submission outcome in the proposing session; a failed append never turns a placed order into a failure. */
  private recordOrder(sessionId: SessionId, event: TradingOrderEvent): void {
    try {
      this.ctx.sessions.get(sessionId)?.append('trading/order', compact<TradingOrderEvent>({
        proposalId: event.proposalId, outcome: event.outcome, orderId: event.orderId, status: event.status, message: event.message,
      }))
    } catch (error) {
      this.warn(`could not record the order outcome: ${(error as Error).message}`)
    }
  }

  private async updateJournal(journal: Journal, id: ProposalId, patch: JournalPatch): Promise<void> {
    try {
      await journal.update(id, patch, Date.now())
    } catch (error) {
      this.warn(`journal update for ${id} failed: ${(error as Error).message}`)
    }
  }

  private journalLater(id: ProposalId, patch: JournalPatch): void {
    void this.journalReady.promise.then(journal => this.updateJournal(journal, id, patch))
  }

  private warn(message: string): void {
    this.ctx.logger.warn(`tool-trading: ${message}`)
  }
}
