# Plan 2 execution ledger (Alpaca venue)

Per-task reviews, rulings, and deferred minors recorded while executing [02-alpaca-venue.md](02-alpaca-venue.md). Later plans read the deferred items and rulings here.

```text
# SDD ledger — plan: .agents/plans/trading-desk/02-alpaca-venue.md
Spec: .agents/notes/proposed/feature/2026-10-05-trading-desk.md
Branch: feat/trading-desk (main checkout). MERGE_BASE for this plan: 7ef5978bcf (plan revisions committed). Models: opus for every subagent (user preference).
Pre-flight (shared interfaces):
| T2 → T9 | TradingVenueGateway methods (halt Promise<void>, closePosition/flatten, subscribeOrderUpdates(OrderStreamEvent)) vs AlpacaVenue methods | match |
| T3 → T4–T9 | FakeAlpaca (on/requests/delayMs/truncate/headers), accountConfig | match |
| T3 → T9 | Config fields streamBackoffMs, suspendRetryMs, lookupConfirmMs, closeSettleMs, closeSettleChecks, rateLimitRetryMs | match |
| T4 → T5–T9,T11 | AlpacaHttp options {tradingUrl,dataUrl,timeoutMs,retryDelaysMs,keys,sleep?} | match |
| T5 → T6,T8 | decimalString, pathSymbol, mapOrder, mapOrderUpdate | match |
| T6 → T9,T11 | OrderTiming; submitOrder(http,req,timing); closePosition(http,sym,timing); openOrders(http,sym?) | match |
| T7 → T9,T11 | AccountSafety(http,store,timing); halt→Promise<boolean>; haltCounter(); resume(since?) | match |
| T8 → T9,T11 | TradeUpdateStream {url,backoffMs,keys,onEvent,onError} | match |
Self-consistency: T2 FakeVenue matches abstract signatures; T9 core() helper passes timing+safetyTiming; T11 VenueCore deps complete — ok.
Task 1: dispatched implementer a2e3438bdd31ca40a, BASE 7ef5978bcf
Task 1: Ruling: brief Step 1 grep expects no output but matches correct text ("composes the other seven packages" required by the brief; "seven tools" counts model-facing tools) — accept those matches — cost if wrong: none
Task 1: Ruling: implementer also replaced ctx.broker in the Runtime plugins bullet (en/zh) — required by the grep's intent (no ctx.broker left) — cost if wrong: none
Task 1: review: spec ✅; Important x2 (stale "provider for both interfaces" en/zh row; roadmap "seven packages") → fix round 1
Task 1: minor (deferred): trading-alpaca Exposes column omits the trade-updates socket (.md:30)
Task 1: minor (deferred): Market data bullets :61 and :63 overlap on per-asset-class ref-counted wording
Task 1: minor (deferred): "before the interfaces have been exercised" old wording (.md:185 en/zh)
Task 1: minor (deferred): roadmap Plan 2 row omits "unknown-outcome lookup" (plan still covers it)
Task 1: fix round 1/5 (2 addressed, 0 open; commits 42e2c7f..3fabfff)
Task 1: complete (commits 7ef5978..3fabfff, review clean after 1 fix round)
Task 2: dispatched implementer abf8bd03d9520057e, BASE 3fabfff4c6
Task 2: review: spec ✅, Approved, 2 Important plan-mandated (contract JSDoc gaps)
Task 2: Ruling: flatten partial-failure semantics undocumented (plan-mandated) — document: attempts every position, throws VenueError('rejected') naming failures, successful closes stand (matches Task 6); closePosition with no position throws 'not-found' — cost if wrong: JSDoc wording
Task 2: Ruling: OrderStreamEvent gap timing undocumented (plan-mandated) — document: gap delivered only after re-authenticate+re-listen, or once when the stream stops for good (matches Task 8) — cost if wrong: JSDoc wording
Task 2: minor (deferred): BrokerOrderRequest qty/notional exclusivity only by comment (discriminated union possible)
Task 2: minor (deferred): VenueStatus cannot show a pending broker suspension except via reason text
Task 2: minor (deferred): resume() behavior when unconfigured/blocked undocumented
Task 2: minor (deferred): subscribeOrderUpdates listener-throw behavior undocumented
Task 2: minor (deferred): VenueError has no cause/ErrorOptions
Task 2: fix round 1/5 (2 addressed, 0 open; commits b68586c..e74a513)
Task 2: complete (commits 3fabfff..e74a513, review clean after 1 fix round)
Task 3: dispatched implementer aeb23a7c0424c8358, BASE e74a513164
Task 3: Ruling: brief says "6 tests" but its spec has 5 it-blocks — plan miscount; 5 is correct — cost if wrong: none
Task 3: Ruling: only tradingUrl carries the live lock; dataUrl/tradeStreamUrl overrides move no money and come from user config, not model input — cost if wrong: keys sent to a user-chosen data/stream host
Task 3: review: spec ✅, Approved, 0 Critical/Important
Task 3: minor (deferred): fake-alpaca handler exception → unhandled rejection + hung request (wrap in try/catch, answer 500)
Task 3: minor (deferred): fake truncate with empty body does not truncate
Task 3: minor (deferred): no test pins live mode + loopback requiring the flag
Task 3: minor (deferred): http:// non-loopback trading host passes without flag (cleartext keys; user config only)
Task 3: minor (deferred): tests/fake-alpaca.ts:57 is 145 columns
Task 3: minor (deferred): Config numeric counts accept fractions
Task 3: minor (deferred): RecordedRequest omits secret header and raw body text
Task 3: complete (commits e74a513..9dcbd68, review clean)
Task 4: dispatched implementer aacf9882dde0b1e3c, BASE 9dcbd68be8
Task 4: review: spec ✅, Needs fixes (2 Important)
Task 4: Ruling: redirect test (plan-mandated) passes even with redirect 'follow' because port 1 is fetch-blocked — redirect to the fake itself and assert /elsewhere never requested — cost if wrong: none
Task 4: minor (deferred): no explicit timeout test (delayMs > timeoutMs → unavailable)
Task 4: minor (deferred): per-retry key resolution not asserted (keyCalls after 429 retries)
Task 4: minor (deferred): non-redirect 3xx maps to rejected (should be conservative unavailable)
Task 4: minor (deferred): non-JSON error body (HTML) becomes the unbounded error message shown to model/user
Task 4: minor (deferred): unserializable body reported as "unreachable"
Task 4: minor (deferred): request() does not encode paths; callers must encodeURIComponent segments
Task 4: fix round 1/5 (2 addressed, 0 open; commits 6b12442..db15123)
Task 4: minor (deferred): fake returns silent 404 for unregistered routes (a route typo could pass as not-found) — carry to Task 6 dispatch
Task 4: complete (commits 9dcbd68..db15123, review clean after 1 fix round)
Task 5: dispatched implementer a94c36e46da45745e, BASE db151231ab
Task 5: review: spec ✅, Needs fixes (2 Important, plan-mandated)
Task 5: Ruling: mapOrder/mapPosition/mapAsset accept missing id/client_order_id/symbol/asset_class/time_in_force/type/status as plausible strings (plan-mandated) — require non-empty strings via a text() helper (VenueError unavailable); unknown status/type still fold to open/other but missing ones are malformed — cost if wrong: none (fails closed)
Task 5: Ruling: mapPosition trusts side and drops qty sign (plan-mandated) — require side long|short and refuse a qty sign contradicting side — cost if wrong: none (fails closed)
Task 6: Ruling (carried): submitOrder must treat a 2xx order whose clientOrderId differs from the request as unreadable (confirmTwice lookup path) — cost if wrong: one extra lookup
Task 5: minor (deferred): parseSymbol RangeError / TypeError on null records or empty 2xx bodies escape as non-VenueError (Task 8 wraps stream case)
Task 5: minor (deferred): decimal accepts hex/exponent/padded strings; timestamp accepts date-only and offset-less times; negative order qty accepted
Task 5: minor (deferred): bars loop has no guard for empty page + persistent next_page_token; limit ≤ 0 or fractional sent as-is
Task 5: minor (deferred): market.spec does not assert crypto adjustment absent, sort, explicit end
Task 5: note: reviewer briefly created and deleted a probe spec file (read-only breach, tree restored)
Task 5: minor (deferred): mapOrderUpdate missing event folds to 'other'
Task 5: fix round 1/5 (2 addressed, 0 open; commits f4bb68f..fba9568)
Task 5: complete (commits db15123..fba9568, review clean after 1 fix round)
Task 6: dispatched implementer a397955af9ee694b6, BASE fba95687c1
Task 6: Ruling: implementer concern — a 2xx with a dropped or non-JSON body is mapped by http.ts to plain 'unavailable', so submitOrder could say "not placed" for an accepted order — http.ts throws a distinct AcceptedUnreadableError (VenueError subclass, code 'unavailable') for 2xx read failures; submitOrder treats it like an unmappable 2xx (two lookups → unknown-outcome) — cost if wrong: one more error class
Task 6: Ruling: implementer concern — orderByClientId does not verify the looked-up clientOrderId — a mismatch is treated as unknown-outcome — cost if wrong: none (fails closed)
Task 6: Ruling: timeout/network failure after send + two empty lookups reports 'not placed' — the spec's chosen contract (two lookups with lookupConfirmMs wait) — cost if wrong: a slow-to-register order is reported not placed; the user sees it in open orders and the journal reconciles
Task 6: review: spec ✅, Approved, 0 Critical/Important
Task 6: Ruling: ⚠️ whether GET /v2/orders?symbols=BTCUSD matches crypto orders is unverifiable offline — the Task 11 paper test (close with a resting sell) verifies it on the real API — cost if wrong: closePosition skips cancelling and the close fails safely on held qty
Task 6: minor (deferred): close tests do not assert the symbols filter on GET /v2/orders (dropping it would cancel every open order)
Task 6: minor (deferred): flatten does not validate the 207 body (non-array → TypeError; item without numeric status counted as success)
Task 6: minor (deferred): flatten failure tested with one failed item only
Task 6: minor (deferred): duplicate-absent and lookup-fails tests do not assert lookup counts
Task 6: minor (deferred): orders.ts:189 comment omits decimalString RangeError before send
Task 6: minor (deferred): duplicate-id + absent lookup reports rejected with brokerCode 40010001 — Plan 3 must not read that as "not placed"
Task 6: minor (deferred): awkward line wrap orders.spec.ts:402-404
Task 6: complete (commits fba9568..2876901, review clean)
Task 7: dispatched implementer af059de53c424b874, BASE 28769013d5
Task 7: Ruling: implementer concern — withFlattenWindow cleanup/catch saves from the state read at window start, so a Halt arriving mid-window keeps halted but loses its reason — save from this.store.get() instead — cost if wrong: none
Task 9: Ruling (carried): AlpacaVenue's SafetyStateStore must persist saves in call order (chain domain.global.set promises), because halt() saves outside the queue and can overlap a queued operation's save — cost if wrong: none
Task 7: review: spec ✅, Needs fixes (4 Important plan-mandated + 1 test gap)
Task 7: Ruling: fix all five (plan-mandated, kill-switch backstop): (1) failed lift → save pending + confirmSuspension then rethrow; (2) resume returns to keep-halted/confirm branch before applySafeSettings/lift when haltCount !== since; (3) start confirms saved open-window/pending suspension before applySafeSettings (and still if it throws); (4) halt queues the broker confirmation even if the local save fails, then reports the save error; (5) test pending-never-drift with Alpaca down, and an operation after a rejected one — cost if wrong: none (fails closed)
Task 9: Ruling (carried, extended): store.get() returns the latest set() argument synchronously from the moment set() is called (update memory before awaiting domain.global.set); concurrent sets settle last-called-wins even if an earlier write fails; persists chained in call order
Task 7: minor (deferred): a Halt landing during check's read() loses its reason to the drift reason
Task 7: minor (deferred): confirmSuspension discards the failure cause (auth vs down vs keys)
Task 7: minor (deferred): store.set failure in window catch/finally masks the original error (fails safe)
Task 7: minor (deferred): queue liveness depends on run() ending; document in JSDoc
Task 7: minor (deferred): ordering tests use 10/20 ms sleeps against 40/60 ms delays (could flake on loaded CI)
Task 7: Ruling: implementer residuals after fix round — (1) resume-lift applied-but-failed leaves broker unsuspended until next check (reported as drift, re-suspends); (2) failed Halt save + broker confirm writes stale state — cannot occur with the Task 9 store (get() reflects set() immediately), and check re-halts otherwise; (3) start retry schedule can run twice — all fail safe; accepted — cost if wrong: misleading halt reason / up to one drift interval unsuspended
Task 7: fix round 1/5 (5 addressed, 0 open; commits 62d01a6..eba010e)
Task 7: minor (deferred): resume's INITIAL save could land after a concurrent halt save with an out-of-order store — covered by the Task 9 store ruling (call-order persist, last-called wins)
Task 7: complete (commits 2876901..eba010e, review clean after 1 fix round + 1 pre-review fix)
Task 8: dispatched implementer adbc648fa8b979826, BASE eba010eb27
Task 8: Ruling: stop() then start() emits no gap — the stream restarts only when new listeners subscribe after none remained, and a new subscriber must read state itself; documented contract is gap-after-re-listen — cost if wrong: Plan 3 consumer must read state on (re)subscribe
Task 8: note: packages/experimental/webworker-packer/tests/image-loadable.spec.ts fails (ctx.get is not a function) — outside this plan; check at final review whether it predates the branch
Task 8: review: spec ✅, Needs fixes (3 Important)
Task 8: Ruling: an unreadable trade update and an in-stream {action:'error'} frame each also emit a gap (consumers must re-read), beyond the brief's report-and-continue — cost if wrong: extra re-reads
Task 8: Ruling: report a disconnect/connect failure once per outage via onError ('unavailable'), reset on listening (plan-mandated gap: brief swallowed it) — cost if wrong: none
Task 8: minor (deferred): onError not guarded against throwing listeners
Task 8: minor (deferred): synchronous throw from keys() escapes the open handler
Task 8: minor (deferred): non-Error throwables yield "undefined" messages
Task 8: minor (deferred): listening reply not validated for trade_updates
Task 8: minor (deferred): late key-failure test can pass vacuously; "closes" in a test title not asserted
Task 8: minor (deferred): no dead-connection (ping/idle) detection — Plan 3 periodic re-read covers (roadmap)
Task 8: minor (deferred): a non-JSON or non-object frame reports an error without a gap (could hide a lost update; Plan 3 periodic re-read covers)
Task 8: fix round 1/5 (3 addressed, 0 open; commits e9dfac5..9f7c8e3)
Task 8: minor (deferred): receive() lacks a stale-socket guard; a frame in flight at stop() can still emit an update or gap
Task 8: complete (commits eba010e..9f7c8e3, review clean after 1 fix round)
Task 9: dispatched implementer afcffc79b9dc03fa0, BASE 9f7c8e3c0a
Task 9: Ruling: implementer added ctx.inject(['credentials'], prepare) in init because credentials-local registers after the venue's init (composition spec showed unconfigured with zero requests) — accepted as glue — cost if wrong: none
Task 9: Ruling: a persistently failing store makes submitOrder reject with the store error rather than 'halted' — fails closed — cost if wrong: less specific error
Task 9: review: spec ✅, Approved, 0 Critical/Important
Task 9: minor (deferred → Plan 4): keys added later (or a blocked account fixed at Alpaca) do not re-run setup until a call; fix: ctx.on('credentials/reference-updated') → prepare(), or prepare from the drift tick while unconfigured
Task 9: minor (deferred): HMR test unsubscribes before dispose; confirmSuspension retries not cancelled on dispose (bounded ~3.5 s, fails safe)
Task 9: minor (deferred): halted with no keys logs a drift-check failure every tick; no event when a pending suspension is later confirmed
Task 9: minor (deferred): composition test "reports the stream failure" asserts no warning
Task 9: minor (deferred): test lines over 140 columns (venue.spec.ts:55,64,65,289,291; composition.spec.ts:153)
Task 9: minor (deferred): orderedStore.load overwrites any pre-init set (latent)
Task 9: complete (commits 9f7c8e3..14c7bb4, review clean)
Task 10: dispatched implementer ad1674697b14cc80a, BASE 14c7bb49d3
Task 10: Ruling (user instruction): new package READMEs English only — no README.zh.md/sidecars; add to translation-pairing manifest excluded; existing bilingual files keep their mirrored lines — cost if wrong: none (user decision)
Task 10: Ruling: cordis-catalog gate needs a SERVICE_PAGE/EVENT_SCOPE_PAGE for ctx.tradingVenue and trading/* and its generator writes both <page>.md and <page>.zh.md — create docs/subsystems/trading.md with minimal prose (mostly generated regions) plus the zh mirror the generator requires; the user's English-only instruction covers READMEs, not generated subsystem pages — cost if wrong: one small bilingual docs page the user may want removed
Task 10: review: spec ✅ (English-only honored), Needs fixes (1 Important: invalid Loader config example)
Task 10: Ruling: regrade reviewer Minors 2 (rate-limited row claims write retries), 4 ("without keys → unconfigured" ignores saved Halt), 5 (live lock covers tradingUrl only, unstated) and 3 (non-JSON frame logged without gap, unstated) to Important — README misstatements of safety/behavior — fold into fix round 1 — cost if wrong: none
Task 10: minor (deferred): TYPE_LINK_EXEMPTIONS cite src/types.ts instead of the trading README
Task 10: minor (deferred): loadPackageLocalSource duplicates loadRelative's rel computation
Task 10: minor (deferred → Plan 3): tradingVenue seam has no consumer until tool-trading lands
Task 10: note: tool-cordis api-catalog now lists ctx.tradingVenue (allowed per isolation rule; precedent agentTeams/browserUse/computerUse; model-visible via cordis_inspect wherever tool-cordis loads)
Task 10: fix round 1/5 (5 addressed, 0 open; commits 2391b6c..ddb1988)
Task 10: minor (deferred): trading-alpaca README Errors section still says "429 to rate-limited after retries" (reads only)
Task 10: complete (commits 14c7bb4..ddb1988, review clean after 1 fix round)
Task 11: dispatched implementer a3de5264e48a45f8b, BASE ddb19885dd
Task 11: minor (deferred): e2e config retry:2 — a failed test 2 that leaves BTC/USD open makes the retry hit the refusal; the real error is in the first attempt's output
Task 11: review: spec ✅, Needs fixes (4 Important: cleanup leaks, cancelling own close, stream not always stopped, retries)
Task 11: Ruling: regrade Minor 7 (opt-in = keys only; root .env auto-loads) and Minor 5 (unknown-outcome far order not cancelled) to Important — they act on the user's real paper account — require DSH_ALPACA_PAPER_E2E=1 in addition to keys, and cancel the test's own orders by client-order-id stamp in cleanup — cost if wrong: one extra env var to run the test
Task 11: minor (deferred): fixed 3 s stream readiness sleep can miss 'new' (fails closed)
Task 11: fix round 1/5 (6 addressed, 0 open; commits 12e2fab..3ce8412)
Task 11: complete (commits ddb1988..3ce8412, review clean after 1 fix round)
Final: dispatched whole-branch reviewer a29c9cb4fb3192d3d (7ef5978..3ce8412)
Final: review: Ready with fixes — 4 Important (duplicate+absent → rejected; stream never restarts after auth stop; throwing listener hides events from later listeners; exits refused when setup fails non-blocked)
Final: Ruling: regrade Minor 1 (Halt clicked during key resolution can still let a POST out) to Important — money path — re-check isHalted() immediately before the POST — cost if wrong: none
Final: Ruling: regrade Minor 2 (dispose does not flush ordered store; a Halt just before reload can be lost) to Important — kill switch persistence — flush pending writes before domain.close() — cost if wrong: none
Final: Ruling: fold doc items into the fix pass (resume JSDoc, VenueStatus 'unconfigured' meaning, closePosition no-position side effect, alpaca README "429 after retries") — Plan 3 codes against them — cost if wrong: none
Final: minor (deferred): missing keys log a "keys unavailable" warning on every stream reconnect
Final: note: webworker-packer image-loadable.spec failure predates the branch (ea6f61f144, 2026-08-22); not touched
Final: dispatched fix agent adc87f56a770719bb (FIX_BASE 3ce84123a9)
Final: Ruling: a Halt write can still be dropped when the whole storage stack disposes concurrently with the venue (storage-domain closeAll vs. flush) — venue-only reload (the HMR case) is fixed and tested; the residual belongs to the storage packages and is a README Known Limitation — cost if wrong: a Halt clicked in the instant before a full-app shutdown may not persist (Plan 3: halt also re-saves on startup from broker suspend_trade, which start() honors)
Final: Ruling: commits 026bee8..2b69618 fail host tsc individually (fixed by 3521bee) — accept; branch is not bisect-critical and history is already pushed — cost if wrong: harder bisect
Final: Ruling: stream restarts on any credentials/reference-updated event (no-op unless stopped on rejected keys with listeners waiting) — accept — cost if wrong: an extra reconnect attempt
Final: fix wave verified (7 addressed, 0 open; commits 3ce8412..7188046)
Final: minor (deferred): once blocked, the venue stays blocked until restart (a rotated-key 401 on PATCH needs a reload)
Final: minor (deferred): resume() can reject 'blocked' while status stays 'halted' (safe side)
Final: minor (deferred): "once when the stream stops for good" wording slightly stale after restart-on-key-change
```
