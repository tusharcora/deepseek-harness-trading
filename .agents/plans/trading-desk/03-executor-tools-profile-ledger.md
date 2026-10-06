# Plan 3 execution ledger — order executor, trading tools, trading profile

Plan: [03-executor-tools-profile.md](03-executor-tools-profile.md). Rulings, deferred minors, and fix rounds recorded during subagent-driven execution; commit hashes are redacted.
Spec: .agents/notes/proposed/feature/2026-10-05-trading-desk.md; plan reviewed by user 2026-10-06 (5 changes applied in <sha>)
Pre-flight: table in preflight.md (same workspace). Rulings (each carried into the owning task's dispatch):
Pre-flight F1 (T1): Ruling: add expect(venue.statusReason()).toBe('') to composition.spec first test — covers trading-alpaca index.ts — cost if wrong: one assertion
Pre-flight F2 (T5): Ruling: schema-refusal test puts the bogus entry, closes, asserts reopen rejects invalid-record (DomainTable.put does not validate) — cost if wrong: test rewrite
Pre-flight F3 (T6): Ruling: render series(30) and assert swing highs/lows line — covers bars.ts swing branch — cost if wrong: one test
Pre-flight F4 (T9): Ruling: Claude Code fill test spies Journal.update (source comes from its stored record), not byClientOrderId — cost if wrong: one test
Pre-flight F5 (T7/T9): Ruling: T7 cancel test makes Journal.update reject once and still expects cancel_requested — covers updateJournal catch — cost if wrong: one test
Pre-flight F6: Ruling: journal/report ids use branded ProposalId/BrokerOrderId/ClientOrderId, never bare string (repo convention) — cost if wrong: type churn
Pre-flight F7: Ruling: each task runs only the generators its steps name; T14 runs the full generator set — cost if wrong: a gate fails earlier/later
Pre-flight F8 (T8): Ruling: add docs/tool-catalog.i18n.yaml to T8's git add — cost if wrong: none
Pre-flight F9 (T7/T8): Ruling: check `?? 0`/`?? 'ask'` fallbacks at the coverage step; add one input per fallback if uncovered — cost if wrong: one test
Pre-flight F10: Ruling: citation fixes (tools/result ~line 191, web-app agent-presets ~line 489, statusReason in file list) are informational; implementers locate by symbol — cost if wrong: none
Pre-flight F11: Ruling: rewrap >140-col test lines when touched — cost if wrong: none
Pre-flight F12 (T12): Ruling: bundle-trading tsconfig references only cordis (like agent-team-web-profile) — cost if wrong: tsconfig edit
Pre-flight F13 (T13): Ruling: delete the BUNDLE_PATCH length>0 assertion — cost if wrong: none
Pre-flight F14 (T9): Ruling: onOrderEvent switches on kind with assertNever (closed union rule) — cost if wrong: none
Task 1: dispatched (BASE <sha>)
Task 1: implementer DONE_WITH_CONCERNS (<sha>); deviation: gen-cordis-catalog typeLinkExemptions += TradingMode, ClientOrderId (needed for generator)
Task 1: Ruling: mode() must derive from the resolved trading host (paper host / loopback → paper, else live), not config.mode alone — a live host labeled PAPER is a safety-label bug the spec's LIVE badge exists to prevent — cost if wrong: one small function + test
Task 1: Ruling: statusReason() returning the missing-keys text while setup was merely deferred (Alpaca unavailable) stands for Plan 3 — matches the brief and venue error text; Plan 4 re-runs setup when keys are added — cost if wrong: a misleading reason string
Task 1: review — spec ✅, 1 Important (mode() trusts config.mode; plan-mandated, ruled above), 3 Minor
Task 1: minor (deferred): statusReason() while unconfigured returns missing-keys text even when setup was deferred by an outage (keep last deferred-setup error)
Task 1: minor (deferred): venue.spec asserts statusReason() not '' instead of pinning the block reason verbatim
Task 1: minor (deferred): trading-venue vs trading-alpaca README wording for the unconfigured reason differs
Task 1: fix round 1/5 (1 addressed, 0 open; commits <sha>..<sha>)
Task 1: complete (commits <sha>..<sha>, review clean)
Task 2: dispatched (BASE <sha>)
Task 2: implementer DONE_WITH_CONCERNS (<sha>): hand-written tsconfig alias (gen-tsconfig-paths can't derive it); no-misused-spread false positive disabled with reason (repo pattern) — later tasks spreading Config hit it too
Task 2: review — spec ✅, approved; ⚠️ resolved: event catalogs/acks owned by Task 8 (gen-persistence-catalog) and Task 14 (persistence-changes --record); zod/dsh-util-values used from Tasks 6–8
Task 2: minor (deferred): tests/config.spec.ts file-level no-misused-spread disable broader than needed (use one helper + disable-next-line)
Task 2: minor (deferred): config.ts driftTolerance/barsCap inline range checks duplicate finite/whole helpers (brief code)
Task 2: minor (deferred): tradingDay tested only in EDT; add an EST case
Task 2: complete (commits <sha>..<sha>, review clean)
Task 3: dispatched (BASE <sha>)
Task 3: implementer DONE (<sha>); dropped brief's unused no-control-regex disable (repo precedent)
Task 3: review — spec ✅, approved; ⚠️ carried: Tasks 7/8 must build the approval reason from ProposedOrder/ProposedCancel.rationale (collapsed), never raw args.rationale
Task 3: minor (deferred): order-args.spec U+2028/2029 test input committed as raw invisible chars instead of \u escapes
Task 3: minor (deferred): tickViolations uses absolute 1e-6 step tolerance (latent at ~1e10 steps)
Task 3: minor (deferred): tickViolations skips silently on NaN increment
Task 3: complete (commits <sha>..<sha>, review clean)
Task 4: dispatched (BASE <sha>)
Task 4: implementer DONE_WITH_CONCERNS (<sha>): stale approvalId stays in approvals map on re-link
Task 4: review — spec ✅, approved; ⚠️ carried to Tasks 7–9: settle on expire/fail/fill must be called; tool body requires state==='approved' + own trading/proposal
Task 4: minor (deferred): linkApproval leaves the superseded approvalId in the approvals map (same call/user; delete old id on re-link)
Task 4: minor (deferred): settle deletes the call key without checking it still maps to this proposal (guard calls.get(key)===id)
Task 4: minor (deferred): findDuplicate ignores timeInForce and assetClass (documented) — confirm for Plan 5 dedupe
Task 4: minor (deferred): only 'rejected' non-grant outcome tested; add 'unavailable'
Task 4: complete (commits <sha>..<sha>, review clean)
Task 5: dispatched (BASE <sha>)
Task 5: implementer DONE (<sha>)
Task 5: review — spec ❌ (F6: journal table key bare string), 1 Important, 2 Minor
Task 5: minor (deferred → carry to Task 9 dispatch): put/update don't validate, so a NaN fill number serialises null and blocks the journal reopening — guard finite fill numbers before writing
Task 5: minor (deferred): inFlight() order undocumented
Task 5: fix round 1/5 (1 addressed, 0 open; commits <sha>..<sha>)
Task 5: complete (commits <sha>..<sha>, review clean)
Task 6: dispatched (BASE <sha>)
Task 6: implementer DONE (<sha>)
Task 6: review — spec ✅, approved; ⚠️ carried to Tasks 7/8: get_bars default 100/cap 500 enforced by tool/resolve; plain stop only for reduce-only (checkRisk stop-type)
Task 6: minor (deferred): snapshot.ts planOrder copies planSubmission's capping condition (brief-mandated; drift risk)
Task 6: minor (deferred): mid price wrong when one book side is 0 (open notional remaining qty)
Task 6: minor (deferred): open market qty buys count $0 in committedBuyNotional (documented)
Task 6: minor (deferred): approved-price rejection tested only with NaN; 0-cap only buy side
Task 6: minor (deferred): FakeVenue.known keyed by plain string (test-only)
Task 6: complete (commits <sha>..<sha>, review clean)
Task 7: dispatched (BASE <sha>)
Task 7: implementer DONE_WITH_CONCERNS (<sha>): executor.ts fold/fill-report branches uncovered until Task 9 (brief-sanctioned); typed brand helpers in tests + fixed book.spec host typecheck; gen-cordis-catalog exemptions for ProposalId + 11 report types; extra generated files committed
Task 7: Ruling: order fold locks terminal statuses — once filled/canceled/expired/rejected (rank 3) the status never changes; only cumulative filledQty may grow — a later 'canceled' view replacing 'filled' would misreport a filled order — cost if wrong: one condition + test
Task 7: review — spec ❌ (terminal-status lock ruling), 1 Important, 8 Minor; ⚠️ carried: Task 8 denies place/cancel under policy never/no approval service; Task 8 listener must settle proposals never asked (reservation leak); Task 9 must cover executor.ts fold/fill branches (399,401,404,417,432,435,442)
Task 7: minor (deferred): fold takes view filledAvgPrice even when view filledQty < journal's
Task 7: minor (deferred): immediate-fill submit appends trading/fill before trading/order(submitted)
Task 7: minor (deferred): journal row stays 'proposed' if session.append throws after journal.put
Task 7: minor (deferred): MCP duplicate check runs outside the lock (Plan 5)
Task 7: minor (deferred): crypto exit retries sleep inside the account lock (>3.5 s section) — comment
Task 7: minor (deferred): capped plan limitPrice ?? 0 fallback pinned as "$0.00" text; make limitPrice required when capped
Task 7: minor (deferred): KEYS_MISSING "Settings → Trading" UI wording — spec Error-handling table mandates this exact text (stands)
Task 7: minor (deferred): ToolCallId inserted among Session* keys in gen-cordis-catalog link map
Task 7: fix round 1/5 (1 addressed, 0 open; commits <sha>..<sha>)
Task 7: carry to Task 9: rewrite the two foldOrder tests through the public stream/reconcile path and delete the private-method cast; verify recordFailure (submit catch) never overwrites a status the stream already folded; executor.ts lines 426/444/459/462/469 must reach 100%
Task 7: minor (deferred): a broker-final rejected/canceled entry that later gains fills keeps its status — fill notice could note it
Task 7: minor (deferred): submitCancel writes failed/canceled via updateJournal without ranking (cancel entries)
Task 7: complete (commits <sha>..<sha>, review clean)
Task 8: dispatched (BASE <sha>)
Task 8: implementer DONE_WITH_CONCERNS (<sha>): hand-written zh tool-catalog section + /tools tsconfig alias; executor fold lines still Task 9
Task 8: Ruling: get_bars over-cap limit is clamped to 500, not rejected — spec says "default 100 and capped at 500" — cost if wrong: schema maximum + one test
Task 8: review — spec ✅, approved; ⚠️ README owned by Task 14 (confirmed); ⚠️ get_bars over-cap clamp untested (confirmed gap → fix round 1)
Task 8: minor (deferred): executor gate re-implements ApprovalService private effectivePolicy (overrideOf ?? config.policy ?? 'ask'); overrideOf uses deprecated eventAt scan
Task 8: minor (deferred): no pipeline test for a hook that delegates then upgrades ask→allow (safe via execute state check)
Task 8: minor (deferred): pipeline.spec.ts:176 literal U+2028 instead of   escape
Task 8: minor (deferred): concurrency test for cancel_order asserts little
Task 8: fix round 1/5 (1 addressed, 0 open; commits <sha>..<sha>)
Task 8: complete (commits <sha>..<sha>, review clean)
Task 9: dispatched (BASE <sha>)
Task 9: implementer DONE_WITH_CONCERNS (<sha>); beyond brief: markNotPlaced skips entries with a broker order id; reportFill uses update fill qty/price only when it covers the whole delta
Task 9: Ruling: reconcile is NOT gated on venue.status() — the roadmap gate applies to order paths; halted/blocked/unconfigured desks must still record fills and reads re-run Alpaca setup — cost if wrong: one guard
Task 9: Ruling: reconcile reads open orders/in-flight entries only, not positions — no executor consumer of positions (YAGNI); Plan 4 panel reads positions itself — cost if wrong: one extra read
Task 9: review — spec ✅, approved; 4 Minor; ⚠️ ctx.agents.get root-agent resolution (Task 7 code) → final review
Task 9: Ruling: re-graded Minor 1 to Important by effect — an unknown-outcome order is marked not placed only after a grace period (entry.updatedAt older than 2 × reconcileMs), never on the first empty lookup; a still-processing POST that later fills would otherwise be lost and exposure under-counted — cost if wrong: an unknown entry stays in flight one or two extra reconcile ticks
Task 9: minor (deferred): overlapping reconciles (no single-flight) and one venue.order throw aborts the loop
Task 9: minor (deferred): settle()/fixed 50 ms waits make "nothing changed" assertions inconclusive (brief-mandated)
Task 9: minor (deferred): reported-then-missing entries stay in flight forever (re-queried each reconcile)
Task 9: fix round 1/5 (1 addressed, 0 open; commits <sha>..<sha>)
Task 9: minor (deferred): not-placed test doesn't assert the +2h−1s step left the entry unknown (boundary inversion would pass)
Task 9: minor (deferred): markNotPlaced reads updatedAt from the pre-lock inFlight snapshot, not the in-lock re-read
Task 9: complete (commits <sha>..<sha>, review clean)
Task 10: dispatched (BASE <sha>)
Task 10: implementer DONE (<sha>); carry to Task 14: ./tools export default → lib/types/tools.js vs . → lib/index.js (Task 8 reviewer: matches list-agents precedent) — verify with build + hygiene
Task 10: review — spec ✅, approved; ./tools export confirmed matching list-agents precedent
Task 10: minor (deferred): HMR proof observes only place_order removal; tools/result + session/event listener removal unobserved
Task 10: minor (deferred): composition test never asserts the approval request/reason
Task 10: minor (deferred): composition test doesn't pin injected fill notice text
Task 10: minor (deferred): misconfiguration case doesn't assert the logged RangeError
Task 10: minor (deferred): trading-day boundary flake window; first context disposed twice
Task 10: complete (commits <sha>..<sha>, review clean)
Task 11: dispatched (BASE <sha>)
Task 11: implementer DONE (<sha>); hand-written ./command alias
Task 11: review — spec ✅, approved; ⚠️ README → Task 14, snapshot incl. /trading status → Task 13, Agent Note → Task 14 (confirmed in plan)
Task 11: minor (deferred): error text `${message}. ${statusLine}` can render ".."; non-Error throws print undefined
Task 11: complete (commits <sha>..<sha>, review clean)
Task 12: dispatched (BASE <sha>)
Task 12: implementer DONE_WITH_CONCERNS (<sha>): tool-schemas.expected.json + unknown-default settings test owned by Task 13; README + manifest by Task 14; staged-lint unused-directive warning (full lint needs it)
Task 12: review — spec ✅, approved; ⚠️ carried to Task 13: preset bare rows resolve against the profile baseUrl in a real/installed profile; exact tool-schema allowlist; unknown-default settings test
Task 12: minor (deferred): profile.spec dynamic-eval disable warns in staged lint (use node:vm runInNewContext)
Task 12: minor (deferred): bundle-trading depends on trading + trading-venue directly though nothing imports them (brief-mandated)
Task 12: complete (commits <sha>..<sha>, review clean)
Task 13: dispatched (BASE <sha>)
Task 13: implementer BLOCKED — recording needs DEEPSEEK_API_KEY (none in env/.env); uncommitted work in tree: trading-fake-broker.ts (listen-order fix), trading-desk.snapshot.ts, snapshots/web/trading-desk, corpus registration, tsconfig.host/apps/web tsconfig, scaffold.ts agent-presets composition fix; model-free probe confirmed preset rows resolve, 9 tools, approval→order→fill→inbox splice, /trading status
Task 13: Ruling (user decision): record the snapshot against local Ollama qwen3.6:35b aliased as deepseek-v4-flash (DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1, dummy key); fixture notes its provenance — cost if wrong: re-record with real DeepSeek later. Local side effect: ollama alias deepseek-v4-flash (remove with ollama rm deepseek-v4-flash)
Task 13: implementer DONE_WITH_CONCERNS (<sha>): recorded vs local qwen (labelled deepseek); ANALYZE prompt made explicit (two tool calls with JSON args); record-mode setup timeout 900 s; scaffold.ts agent-presets composition fix
Task 13: review — spec ✅, approved; scaffold agent-presets change verified to leave existing scenarios' pins unchanged
Task 13: minor (deferred): trading-desk.snapshot teardown skips closeDesk if handle.dispose() rejects
Task 13: minor (deferred): fake broker body parse has no rejection path (non-JSON → unhandled rejection)
Task 13: minor (deferred): fixture usage token counts come from Ollama (provenance-documented)
Task 13: minor (deferred → final review): trader prompt carries web-app file-output guidance and workspace-write file policy though the trader has no file tools (model-visible capability text)
Task 13: complete (commits <sha>..<sha>, review clean)
Task 14: dispatched (BASE <sha>)
Task 14: implementer DONE_WITH_CONCERNS (<sha>, <sha>): gen-config-catalog follows a sibling-file default export (spec case added); constraints gate allows bundle-trading `presets` in files; 19 JSDoc descriptions added; README layout per Model Experience gate
Task 14: Ruling: keep the gen-config-catalog extension (follow index.ts default export to its sibling file) rather than moving TradingExecutor into index.ts — tested, smaller blast radius, keeps executor.ts focused — cost if wrong: revert script + move class
Task 14: review — spec ✅, approved; doc-sync/hygiene/constraints pass per report
Task 14: minor (deferred → final review): MCP endpoint described in present tense (gen-doc-graphs note, tool-trading README) — Plan 5 not built
Task 14: minor (deferred → final review): bundle-trading Summary "removes every other way a model could reach the broker" overclaims (Claude Code in terminal can)
Task 14: minor (deferred): persistence record says composition specs "read" each event (they don't)
Task 14: minor (deferred): gen-config-catalog non-sibling default-export import throws a misleading uncaught error; no negative test
Task 14: minor (deferred): README Order-flow step numbers 1–4/5–8 undefined
Task 14: complete (commits <sha>..<sha>, review clean)
Task 15: dispatched (BASE <sha>)
Task 15: implementer DONE_WITH_CONCERNS (<sha>, <sha>); session-scoped cleanup (SHA ids can't carry a prefix); close only after clean-account check; retry 0; paper-only guard
Task 15: controller paper run 1: FAIL — test expected 1 fill notice for the buy; Alpaca filled it in 2 executions (partial 0.00011678 + fill 0.00002422, same ms); executor correctly emitted 2 fills — test assumption wrong; cleanup worked, account flat
Task 15: fix round 1/5 dispatched (test waits on cumulative fill state, asserts fill sums = filledQty)
Task 15: fix round 1 (<sha>) — controller paper run 2: PASS 1/1 (buy+sell via place_order, approval, fills; account flat after)
Task 15: review — spec ✅, approved (incl. fix round 1); ⚠️ manual web desk run not performed
Task 15: Ruling: roadmap Plan 3 "Done" stands without the manual web desk run — the keyless recorded session (real trading profile, trader preset, approval→order→fill→notice, /trading status) and the passing executor paper e2e cover the same path; the manual run is the user's hands-on test and is reported as pending — cost if wrong: revert one roadmap cell
Task 15: minor (deferred): non-Error failure drops cleanup failures; waitFilled times out vaguely if the order event is missing; sell leaves possible dust to cleanup
Task 15: complete (commits <sha>..<sha>, review clean)
Final review: dispatched (range <sha>..HEAD)
Final review: Ready with fixes — 4 Important (client-order-id leak, restart window, bracket legs, reconcile abort) + stale-note re-graded Important + 3 doc fixes; Ruling: bracket legs documented in Plan 3, tracked in Plan 4 — leg tracking needs BrokerOrder legs data + panel; paper-only exposure — cost if wrong: agent unaware of a bracket exit until get_positions; Ruling: stale note re-graded Important — model sees 'not placed' on a filled order — cost: small patch; fix wave dispatched (final-findings.md)
Final fix wave: DONE (<sha>, <sha>) — all must-fix + M1, M3; snapshot tool-schemas refreshed keylessly (place_order description only)
Final fix wave: re-review — all addressed, no new breakage; controller paper re-run: trading-alpaca + tool-trading e2e 3/3 pass, account flat
Final: Ruling: journalLater writes `rejected` without the updates lock/status guard — unreachable in normal flow (execute's finally settles the book before tools/result) — carried to Plan 4 hardening — cost if wrong: an in-flight entry frozen as rejected and dropped from reconcile
Final: minor (deferred): filled row can keep the fixed "outcome unknown" note when the stream fill precedes an unknown-outcome submit error
Final: minor (deferred): reportFill JSDoc wording about Claude Code notices
Final review: clean after one fix wave
