# Phase P5 Report — the performance layer (contention correctness under load)

> **FICTIONAL system-under-test.** P5 is ADDITIVE: a standalone perf layer under `perf/`
> that pressure-tests the platform's concurrency-correctness claims at N the functional
> suites never reach, with thresholds in committed config and honesty documented in
> `PERFORMANCE.md`. The functional pipeline is untouched: `main` stays 237 green; the
> defect-branch map stays exactly 12.

## 1. What was built

- **Tooling decision (item 1, D36).** k6 vs Artillery vs autocannon, decided by one
  constraint: every P5 assertion is **DB truth** (approval-row uniqueness, the ledger
  invariant, cursor-chain completeness), so the load driver must share a runtime with the
  Prisma client and the seed machinery. k6 scripts run in a Go-embedded JS engine (no
  Node modules, no Prisma, a non-npm binary against the clean-clone story); Artillery is
  Node but YAML-first and HTTP-metric-centric. **Chosen: autocannon + a thin TypeScript
  harness** — autocannon (one pure-Node dev dependency, justified in `DEPENDENCIES.md`)
  drives the sustained read-path load; the write-contention scenarios are orchestrated TS
  volleys/worker-loops (the compliance gate's own `Promise.all` pattern, scaled). SQLite's
  single-connection write serialisation (D35) is named up front as the known ceiling:
  the point is contention **correctness**, not big numbers.
- **Layer shape (D37).** Not a Playwright project: `pnpm perf` runs a `tsx` harness where
  each scenario boots its OWN fresh server (reset → migrate → seed → spawned node child)
  on dedicated port **3100** and kills it after. Deliberately not wired into the required
  CI path (latency baselines are machine-relative; the same correctness claims are
  CI-gated at small N by the compliance volley and the workflow invariant sweep).
- **Scenario 1 — `approval-contention`** (`perf/scenarios/approval-contention.ts`).
  Volleys of N ∈ {2…512} simultaneous approval attempts on ONE shared dual-approval
  withdrawal, each approver double-submitting (so both contention classes fire at once:
  distinct-approver state racing AND same-approver double-submit). Asserted per volley
  and per run: zero 5xx, only the designed 201/409, **exactly two** winners, distinct
  approvers, the expected final state, and a post-run DB `groupBy` sweep for duplicate
  `(transactionId, approver)` rows. Records the per-level latency/throughput table and
  the **knee point** (§2).
- **Scenario 2 — `reconciliation-under-load`** (`perf/scenarios/reconciliation-load.ts`).
  8 worker loops sustain a seeded 60/40 mix of deposits (register + chain advance) and
  withdrawals (create + checker approval → broadcast debit) for 60 seconds, then
  `Σ(ledger) == wallet.balanceMinor` must hold on **every** wallet (the workers' and the
  whole seeded book) — the no-lost-update proof — with zero 5xx and zero off-design
  statuses.
- **Scenario 3 — `read-path-baseline`** (`perf/scenarios/read-path.ts`). An at-scale,
  **ledger-consistent** seed block (20k CONFIRMED withdrawals + 20k CREDITED deposits +
  audit rows, explicit deterministic ids via `createMany`), then: a full cursor-chain
  walk proving paging is complete/duplicate-free/terminating at volume, and autocannon
  load per target (withdrawals first page, withdrawals deep page, audit first page) with
  **exact p50/p95/p99 computed from per-response samples** — autocannon's summary
  histogram exposes p90/p97.5/p99 but not p95, so the harness collects every
  `response`-event sample and computes its own percentiles.
- **Thresholds in config, not prose (item 3).** `perf/perf.config.json` (hand-authored
  parameters + regression multipliers) and `perf/baselines.json` (machine-written by
  `pnpm perf:baseline`, committed, with machine provenance). `pnpm perf` exits non-zero
  on any HARD violation (5xx, duplicate approvals, invariant breach, broken paging) or
  any regression beyond the multipliers. The failure path is **negative-tested in the
  evidence**: tamper a baseline → `== PERF FAILED ==`, exit 1.
- **Docs (item 4).** `PERFORMANCE.md` — honesty over impressiveness: what the numbers
  mean (absolute correctness bounds, a real regression envelope, the knee as queueing
  theory) and what they don't (capacity, cross-machine comparability, a stable knee
  constant). One README §8 subsection framed as **contention correctness under load**;
  the §9 non-goals bullet amended to match.

## 2. The numbers (this machine; see the honesty caveats in PERFORMANCE.md)

From `docs/evidence/p5.txt` (12-core win32, Node 26):

- **Contention:** throughput climbs 75 → 341 rps between concurrency 2 and 32, then
  saturates — 513 rps @128, 596 @256, 598 @512: the last doubling of offered concurrency
  bought +0.4%. p95 roughly doubles per level past saturation (242ms @128 → 409ms @256 →
  852ms @512): each request's latency is its queue position × a ~2ms service time,
  exactly what one pooled SQLite connection predicts. **Knee: a band (~128–512 across
  runs, 500–630 rps plateau), recorded as informational, deliberately not a threshold.**
  The envelope stops at 512 because p95 there approaches Prisma's 2s
  transaction-acquisition timeout — past it the failure mode changes from "slow" to
  "timeout". The correctness bar never moved: 3,066 contended requests per run, zero
  5xx, zero duplicates, exactly two winners every volley up to 512 simultaneous attempts.
- **Sustained load:** ~1,600–1,700 requests over 60s (~27–28 req/s, chain-advance
  settlement the dominant cost), invariant **HOLDS** across all 56 wallets, zero 5xx.
- **Read path:** cursor walk 201 pages → 20,093/20,093 unique rows, 0 duplicates;
  p95 12–22ms, p99 13–45ms across the three targets at ~40k-row volume; deep-page ≈
  first-page (the cursor rides the indexed PK).

## 3. What was deferred

- Nothing new deferred from the P5 commission itself. The reviewer's 1 Major + 4 Minor +
  4 Nit are reported verbatim in §6 with recommended dispositions, **none applied** (gate
  policy: fix Criticals only; there were none).
- Standing register (`docs/DEFERRED.md`) unchanged: the Docker-compose gap and the
  post-P4 test-hardening batch remain open.

## 4. New DECISIONS.md entries (summary)

`D36` — perf tooling: autocannon + thin TS harness; k6/Artillery rejected on the
DB-truth-runtime constraint; D35 named as the known ceiling.
`D37` — perf layer shape: standalone `tsx` harness, own fresh server per scenario on
:3100, config/baselines split, exit-code contract, deliberately not a required CI job.

## 5. Evidence + defect-branch sync

- **`docs/evidence/p5.txt`** (`main`, committed): typecheck 0; ESLint + markdownlint 0;
  **full functional pipeline 237 green ×2** (exit-code gated via `PIPESTATUS`, fresh DB
  each); reconciliation invariant OK (140 wallets post-suite); **`pnpm perf` PASSED** —
  all hard checks and all regression checks against the committed baselines, full
  scenario tables embedded; the **negative path proven** (tampered baseline → two FAILs,
  exit 1, baselines restored byte-identical to HEAD); the knee-point analysis.
- **Defect-branch sync:** `defects-planted` rebased onto `main` **cleanly** (the P5 diff
  shares no files with the seven planted commits); defect-branch typecheck 0; the
  **12-failure map verified exactly unchanged** — bare run: 5 contract (BUG-005, rest
  dep-skipped); `--project=workflow --no-deps`: 3 (BUG-001/004/007);
  `--project=ui --no-deps`: 9 pass (branch-neutral); `--project=compliance --no-deps`:
  4 (BUG-002/003/005/006). `v1-defects` re-anchored to the new tip. Per the commission
  ("re-capture evidence there if anything shifted"): **nothing shifted**, so no new
  defect-branch evidence file was cut — the P4b capture remains the current one.
- Not yet pushed to `origin` (owner action): `main`, `defects-planted` + the re-anchored
  `v1-defects` tag need a push (branch + tag force-push, per the established protocol).

Reproduce:

```bash
git checkout main
pnpm perf                                  # all three scenarios vs committed baselines (~4 min)
pnpm perf -- --scenario=approval-contention
pnpm perf:baseline                         # re-record baselines on YOUR machine (commit the diff)
```

## 6. Reviewer findings (code-reviewer charter) + triage

> Dispatched per the standing note: the harness does not expose `code-reviewer` as a
> dispatchable subagent type, so a fresh-context general-purpose agent carried the
> charter verbatim. It ran everything itself: typecheck 0, lint 0, 237 green on a fresh
> DB, `pnpm perf` all-PASS with numbers closely reproducing the committed evidence, and
> confirmed its own run left `perf/baselines.json` untouched. **0 Critical → nothing
> auto-fixed; gate steps 1–2 stand.** Findings verbatim below; dispositions are
> recommendations only, awaiting owner decision.

### Critical

None found.

### Major

1. **`perf/scenarios/reconciliation-load.ts:107` (with `perf/support/db.ts:34`) — the
   scenario's headline assertion is structurally blind to the failure class it claims to
   interrogate.** The header says the contention is "the global chain-advance settlement
   loop and its D28 CAS claims", but the only post-load truth check is
   `Σ(ledger) == balance`. A duplicate settlement executes `creditDeposit`'s single
   `$transaction` twice — incrementing the balance AND writing a second ledger CREDIT
   *consistently* — so the invariant still holds and the scenario stays green while the
   client is credited twice. Same shape for a double debit at broadcast. The invariant
   catches lost updates (torn balance/ledger pairs), not exactly-once violations.
   Direction: add a post-load DB sweep in approval-contention's style — exactly one
   PRINCIPAL CREDIT per CREDITED deposit (and one ProcessedEvent per
   `(walletId, chainTxRef)`), exactly one PRINCIPAL DEBIT + one FEE DEBIT per broadcast
   withdrawal.

### Minor

1. **`perf/scenarios/approval-contention.ts:84,100`** — the scenario's only regression
   gate goes silently vacuous if `referenceLevel` is absent from `levels`
   (`p95AtReference` stays 0 → guaranteed PASS; `perf:baseline` would record 0).
   `loadConfig()` does a bare `JSON.parse` cast with no validation. Direction: validate
   config invariants at load.
2. **`perf/scenarios/read-path.ts:115` / `perf/support/config.ts:58-64`** — baselines
   record metrics no check consumes (`readPath.*.rps`, `maxThroughputRps`), implying
   gating that doesn't exist; only `reconciliationLoad` has a throughput floor.
   Direction: gate them or mark them informational like the knee.
3. **`perf/support/server.ts:42-57`** — the readiness poll could adopt a stray server
   already holding :3100 (mainly a POSIX/CI hazard; Windows' `rmSync` fails loudly
   first), and no `SIGINT`/`exit` hook reaps the child, so an interrupted perf run is
   exactly how such an orphan gets created. Direction: verify a per-boot nonce/PID
   before declaring ready; register signal hooks.
4. **`perf/support/config.ts:80-90`** — a partial baseline re-record
   (`perf:baseline -- --scenario=x`) overwrites the file-level `recordedAt`/`machine`
   stamps, falsifying provenance for the untouched scenarios. Direction: stamp per
   scenario block, or refuse partial updates.

### Nit

1. **`perf/support/stats.ts:52-58`** — `findKnee` reports a "knee" even when throughput
   never saturates within the envelope; the summary sentence is unconditional.
   Direction: qualify when max sits at the final level.
2. **`perf/support/http.ts:22-30`** — no timeout/AbortSignal: a wedged server hangs the
   run instead of failing it. Direction: `AbortSignal.timeout(...)` above the 2s cliff.
3. **`perf/scenarios/reconciliation-load.ts:119,131-144`** — nothing asserts every op
   kind actually ran (`count > 0` per op); a `depositShare: 1` edit or rng regression
   silently drops the withdraw/approve path from "mixed load". Direction: hard-check
   nonzero counts.
4. **`perf/scenarios/read-path.ts:53,68`** — the walk's termination guard couples to the
   server's `limit` clamp (100): raising `walkLimit` past 100 in config trips a false
   "chain did not terminate". Direction: derive pages from the first response's actual
   item count, or validate `walkLimit <= 100` at config load.

### Triage (gate step 4 — nothing applied, per the gate; recommendations only)

| # | Sev | Recommendation |
|---|---|---|
| Major 1 | ▲ **Accept as a small follow-up batch item** | A genuinely correct observation: the invariant proves no-lost-update but not exactly-once, and the file's own header oversells it. The exactly-once sweep is ~25 lines in the established `groupBy` style and would make the scenario's claim match its header. Until then, exactly-once IS pinned functionally (workflow replay test + the compliance audit-trail equality), just not at large N. |
| Minor 1 | Fold into the same batch | A ~10-line `loadConfig` validation closes the "config edit disarms the gate" hole — worth it since config-tunability is the design. |
| Minor 2 | Fold into the same batch (or document) | Cheapest honest fix: name the informational fields in the config `$comment` + PERFORMANCE.md; a read-path throughput floor is optional. |
| Minor 3 | Report only | Real but low-blast-radius here (Windows fails loudly via the file lock; the port is dedicated). A boot-nonce readiness check is the right shape if the layer ever runs on CI. |
| Minor 4 | Fold into the same batch | Per-scenario provenance stamps are ~5 lines and protect exactly the honesty PERFORMANCE.md promises. |
| Nits 1–4 | Batch when files next open | Each is a few lines; none affects current correctness of the committed runs. |

## 7. Commands for you to poke the result

```bash
pnpm perf                                        # the full layer, ~4 min, exit-code honest
pnpm perf -- --scenario=reconciliation-under-load
cat perf/perf.config.json perf/baselines.json    # thresholds vs recorded numbers
cat docs/evidence/p5.txt                         # the committed run + knee analysis
```

## 8. Phase P5 Definition-of-Done check

- [x] Tooling decision recorded (D36) with the SQLite ceiling named; layer shape as D37.
- [x] Three scenarios: scripted, seeded, repeatable; approval contention asserts the CAS
      (no duplicate approvals, no 5xx) at 2→512 with the knee found and RECORDED;
      reconciliation under 60s sustained mixed load ends with the invariant passing;
      read-path p95/p99 at ~40k-row volume with cursor paging proven correct.
- [x] Thresholds in config, not prose: committed `perf.config.json` + `baselines.json`;
      regression → exit 1, negative-tested in the evidence.
- [x] `PERFORMANCE.md` (honesty over impressiveness) + README §8 subsection
      ("contention correctness under load") + §9 non-goal amended.
- [x] Gate 1: full pipeline (237 ×2) + perf scenarios captured REAL to
      `docs/evidence/p5.txt` with the knee-point analysis; committed.
- [x] Gate 2: `defects-planted` rebased; 12-failure map verified unchanged;
      `v1-defects` re-anchored. Nothing shifted → no evidence re-capture (per commission).
- [x] Gate 3: code-reviewer charter dispatched as a fresh-context general-purpose agent
      (charter not dispatchable by name — noted); it ran everything itself.
- [x] Gate 4: **0 Critical** → nothing auto-fixed, steps 1–2 stand; 1 Major + 4 Minor +
      4 Nit reported verbatim with dispositions, awaiting owner instruction.
- [x] Gate 5: this report.

**STOP after P5.** Owner actions on the table: the §6 triage decisions (chiefly Major 1's
exactly-once sweep) and pushing `main` + `defects-planted` + the re-anchored `v1-defects`
to origin.

## Post-report: triage applied — ALL findings fixed (owner instruction)

The owner commissioned all nine findings, in the order Nits → Major → Minors (this
supersedes §6's "nothing applied"):

- **Nits 1–4 FIXED** (`868a586`): `findKnee` reports saturation status and the summary no
  longer claims a knee on a still-climbing curve; `PerfApi` requests carry a 30s
  `AbortSignal` (a wedged server fails the run, never hangs it); the reconciliation
  scenario hard-checks every op kind actually ran; the cursor walk derives its page math
  from the first response's ACTUAL page size, decoupled from the server's limit clamp.
- **Major 1 FIXED** (`0124cfb`): `checkExactlyOnce` sweep after the 60s window — exactly
  one PRINCIPAL CREDIT + one ProcessedEvent per credited deposit, exactly one PRINCIPAL +
  one FEE DEBIT per debited withdrawal — as a hard check, closing the consistent-
  double-settlement blindspot; the scenario header and PERFORMANCE.md no longer oversell
  the invariant. Live: **exactly-once HOLDS over 499 credited deposits + 340 debited
  withdrawals**.
- **Minors 1–4 FIXED** (`dac6188`): `loadConfig` validates config invariants loudly at
  load (incl. the referenceLevel-disarm hole and the walkLimit/pageLimit server clamp);
  read-path throughput floor-gated per target (`minThroughputFactor` 0.33) with the two
  remaining informational baseline fields declared as such; `startServer` pre-flight
  refuses to adopt a stray server on :3100 and spawned children are reaped on
  SIGINT/SIGTERM/exit; `perf:baseline` refuses partial re-records (one machine, one
  coherent snapshot).

**Gate re-run after the fixes** (addendum in `docs/evidence/p5.txt`): typecheck + lint 0;
functional pipeline **237 green** (exit-code gated); **`pnpm perf` PASSED** with all new
hard checks and the throughput floors live against the unchanged committed baselines;
both refusal paths exercised for real (partial re-record → exit 2; invalid config →
loud error, exit 1).

**Fresh-context RE-REVIEW** (same charter, new agent; it ran typecheck/lint/237
suite/`pnpm perf` itself, plus live probes of all three refusal/guard paths and a
`findKnee` unit probe): **all nine fixes verified CLOSED** — including confirming the
exactly-once sweep has real teeth (`LedgerEntry` carries no unique constraint, so a
duplicate row genuinely fails it) — and **0 Critical / 0 Major / 0 Minor new findings**.
Three residual nits from the re-review were fixed on the spot and re-verified green
(full `pnpm perf` PASS): the readiness poll's fetch is now bounded like every other
fetch in the layer (2s); `assertConfig` requires strictly ascending levels (the
knee/saturation report assumes the last level is the highest); the sweep's
ProcessedEvent count>1 leg is commented as a constraint-guaranteed tripwire, not
independent verification. Defect branch resynced after each batch — the **12-failure
map verified unchanged both times**, `v1-defects` re-anchored.
