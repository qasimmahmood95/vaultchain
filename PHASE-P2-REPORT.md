# Phase P2 Report — Fixtures, then the two API test layers

> **FICTIONAL system-under-test.** P2 delivers the fixture foundation (§B.2) and the two
> API suites (§B.3: contract + workflow), built by **two parallel subagents** over frozen
> fixtures — the architecture's "independently buildable layers" claim, exercised for real.

## 1. What was built

### P2a — fixtures (single-threaded, then FROZEN)

`tests/fixtures/` per §B.2 — the only cross-suite shared code:

- **auth.fixtures.ts** — worker-scoped `APIRequestContext` per role; deliberate
  maker/checker split (`asOperatorA`/`asOperatorB`) and two tenant-bound client keys
  (`asClientA`/`asClientB`) for cross-tenant probes.
- **global.setup.ts** (the `setup` project) — verifies every role key against `/me`,
  writes `.auth/identity.json` (API-key analogue of storageState; D20).
- **chain-clock.fixture.ts** — wraps `/simulator`; teardown auto-resets **fault state
  only** (webhook delay, queued screening); the global sim clock is **forward-only**
  during a run (D21/D22). `chain.reset()` exists for explicit use.
- **builders/** — API-seeding factories (`client`, `account`, `fundedWallet`,
  `activeAddress`, `pendingAddress`, `withdrawal`), namespaced via `uniqueRef()`;
  **value discipline**: defaults avoid the .5-minor fee boundary so happy paths behave
  identically on `main` and `v1-defects`.
- **world.fixture.ts** — `mergeTests(authTest, chainClockTest).extend({ build })`;
  **index.ts** single import surface; **README.md** documents every contract + suite rules.
- **playwright.config.ts** — `setup`/`contract`/`workflow` projects; webServer boots a
  fresh-seeded server (`scripts/test-serve.ts`); **retries 0** (§B.6: API layers are
  deterministic by construction); contract fully parallel, workflow serialized
  (`--workers=1`) because the sim clock is platform-global state (D21).

### P2b — two parallel subagents (isolated worktrees, own port + own SQLite file)

- **CONTRACT** (174 tests): hand-written **zod v4 schemas re-encoding
  `openapi/vaultchain.yaml`** (never generated, never importing `src/` — an independent
  oracle), `toMatchSchema` matcher with pretty-printed zod issues, response-shape +
  status/error(problem+json)/pagination/enum coverage, and a **113-test authz matrix**:
  role×endpoint rows, tenant-isolation 404s, the D19 cross-tenant idempotency-replay
  regression, maker-cannot-check, simulator/audit role gates, hold-resolution 403s.
- **WORKFLOW** (21 tests, serialized): both lifecycles with **exact-money assertions**
  (half-even triplet 15.00/25.00/30.00; ETH 18-dp round-trip), allowlist cooling-off
  422→201 via the chain fixture, duplicate-idempotencyKey dedup + **webhook-replay
  exactly-once**, screening holds (release→credit, reject→uncredited), omnibus lifecycle,
  full audit-action trail for the withdrawal path.

### The parallel-build story actually worked — including its failure mode

The workflow agent hit a **load-breaking fixture defect** (`workerRole` used an
identifier first param; Playwright requires a destructuring pattern — every fixtures
import threw). Per the territory rules it did NOT edit the frozen fixtures: it shimmed
locally, shipped green, and **reported the defect back**. The integrating session fixed
it on `main` (`e3d30c5`), messaged the still-running contract agent to `git merge main`,
and de-shimmed the workflow suite afterwards (9 import lines repointed, shim deleted,
22/22 re-verified). Exactly the §B.0 independence model under stress.

### Integration fixes (main session)

- **D18, second occurrence** (found by the contract agent): the allowlist route schema
  lacked the spec's `assetSymbol` enum (unknown symbol → handler 404 instead of
  validation 400). Fixed per the standing D18 decision + probe added beside the original
  D18 regression test.

## 2. What was deferred

- **UI journeys, storageState, browser install** → P3 (D20/D23).
- **Compliance gate suite + custom reporter + CI** → P4. BUG-002/003/006 are deliberately
  uncaught in P2 (their primaries are the gate; verified still-uncaught on `v1-defects`).
- **Omnibus per-client ledger attribution** → invariant sweep only (D24): §A.4 exposes no
  ledger endpoint by design; `scripts/check-invariant.ts` runs post-suite in evidence.
- **`/simulator/reset` shape-test relocation** (contract agent suggestion): reset rewinds
  the global clock, hazardous under parallel workers; currently handled by a self-healing
  test + `support/robust.ts`. Candidate move to the serialized workflow project in P3/P4.
- Deferral register additions: see §5 triage table.

## 3. New DECISIONS.md entries (summary)

D20 setup writes `.auth/identity.json`, not storageState (no UI yet) · D21 time-sensitive
assertions only in the serialized workflow project · D22 forward-only global sim clock;
fault-only fixture teardown · D23 no browser binaries in P2 · D24 omnibus attribution =
post-suite invariant sweep; BUG-001's practical catch is the exact half-even fee assertion
(BUGS.md updated to match) · D18 re-applied to the allowlist route (2nd occurrence).

## 4. Evidence (committed)

- **`docs/evidence/p2.txt`** (main): typecheck exit 0; **176 contract (parallel, 6
  workers) + 22 workflow (serialized) — all green**; post-suite reconciliation invariant
  across 69 wallets; P1 smoke still green.
- **`docs/evidence/p2-defects.txt`** (defects-planted / `v1-defects`): the same suites →
  **8 failures, every one mapped to a P2-primary defect**:
  BUG-001 (15.00 fee '0.01'≠'0.02' — the 25.00 case passes on both branches because floor
  and half-even agree at 2.5; 15.00 is the discriminator), BUG-004 (in-window withdrawal
  201≠422), BUG-005 (5 authz rows 200/409≠403), BUG-007 (replay double-credit).
  BUG-002/003/006 uncaught **by design** (P4 gate). 171+19 unrelated tests green there.

Reproduce:

```bash
# main — everything green
git checkout main && rm -f prisma/vaultchain.db
pnpm typecheck && pnpm test && npx tsx scripts/check-invariant.ts

# v1-defects — watch the four P2 catches fire
git checkout v1-defects && rm -f prisma/vaultchain.db
pnpm test:contract   # 5 fails: authz-matrix hold-resolution rows (BUG-005)
pnpm test:workflow   # 3 fails: cooling-off (BUG-004), replay (BUG-007), 15.00 fee (BUG-001)
```

## 5. Reviewer findings (code-reviewer charter) + triage

> Reviewer ran everything itself (typecheck; fresh + KEEP_DB suite runs; invariant sweep;
> schema-fidelity spot-checks; isolation greps) — plus one adversarial run that proved the
> Critical. Verbatim findings below; triage table follows.

### Critical

1. **The workflow project is not actually serialized — the PRD's canonical invocation runs it red. Empirically confirmed: 3/22 fail.** `playwright.config.ts:39-45` claims `fullyParallel: false` is "belt-and-braces: within-file serial even if someone runs this project with more than one worker." That claim is false: `fullyParallel: false` only serializes tests *within* a file; separate spec files still fan out across the worker pool. The only real enforcement of D21 is the `--workers=1` flag buried in the `package.json` scripts. The PRD's documented one-command run (`npx playwright test`) — and the plain `npx playwright test --project=workflow` any reviewer of this portfolio will type — bypass that flag. I ran `npx playwright test --project=workflow` on a fresh DB: **3 failed** (idempotency webhook replay, money-precision 30.00 control, screening-hold — flagged deposit credited `750.00` because another file's `advanceBlocks` consumed/pre-empted its screening). Time-sensitive assertions racing on the global clock is exactly the flake class §B.6 bans, and D21 does not license leaving the standard entrypoint broken. **Direction:** Playwright 1.61 supports per-project `workers` — add `workers: 1` to the workflow project and correct the comment.

### Major

2. **`/simulator/tx/{id}/force` is tested by nothing — the D14 refund path that moves money is unpinned.** No contract shape test (spec'd 200/409/404 uncovered; `TransactionRawSchema` only exercised indirectly) and no workflow test for the FAILED lifecycle: a compensating-credit bug (e.g. refunding amount without fee) would break the ledger invariant with no test failing before the post-suite sweep. FAILED is in PRD §A.3.2 and no P4 exclusion covers it. **Direction:** workflow test — broadcast, force FAILED, assert exact balance restoration + refund audit entries; contract test for the envelope.
3. **Withdrawal-side screening holds are untested; `screening-hold.spec.ts` covers deposits only.** `screenAndBroadcast` (FLAG → HELD, release → resume with the debit on resume) is a separate code path; P4 owns hold-release *authz*/*audit*, not the withdrawal-hold lifecycle. A bug that debited before the hold, or double-debited on release, is invisible. **Direction:** mirror the two deposit-hold tests for a withdrawal.
4. **Delayed webhook delivery (D10) is never exercised with a non-zero delay.** Only a shape test posting `ms: '0'` exists; the PENDING→DELIVERED transition driven by `dueAtSimMs`/`flushDueWebhooks` has no test. §A.0 justifies webhooks with "replay/**delay**"; replay is covered, delay is not, and it isn't on P4's list. **Direction:** serialized workflow test — set delay, trigger event, assert PENDING with future dueAtSimMs, advance clock, assert DELIVERED.
5. **ETH address normalization is untested — a PRD-named edge case with no owner phase.** §A.6 lists "ETH checksummed vs lowercase"; D12 fixes platform behaviour; every allowlist test uses opaque GBPX strings. **Direction:** one workflow pair on an ETH wallet: allowlist mixed-case, withdraw lowercase → 201; different-cased non-allowlisted → 422.

### Minor

6. **The `/simulator/reset` shape test lives in the fully-parallel contract project and drags ~150 lines of recovery machinery behind it** (`support/robust.ts`); its one-shot recovery leaves a second-order re-poisoning window, and the obligation to use `robust.ts` helpers for funds-dependent contract tests is documented nowhere in the fixtures README. Moving the one test to the serialized workflow project deletes the hazard and `robust.ts` with it.
7. **Chain fixture teardown gap: `frozen` is not reset.** No P2 test calls `freeze()`, but the first P3/P4 test that freezes and fails mid-test leaves the global clock frozen for the rest of the run. Track `freezeTouched` and unfreeze, or drop `freeze()` from the surface until needed.
8. **Contract schemas cannot detect additive drift.** Non-strict `z.object()` means server-added fields pass silently; only drops/renames fail. Faithful to the spec (responses don't set additionalProperties:false), but §B.3 sells this layer as the drift oracle. Consider `z.strictObject` + tightening the spec.
9. **Pagination exact-boundary case untested.** 5 items with limit 2 always ends on a partial page; an implementation emitting a trailing empty page would pass. "Pagination on exact page boundaries" is a named §A.6 edge case. Add a count divisible by the limit.
10. **`GET /holds?state=OPEN` filter assertion is vacuous on a fresh DB** (everything is OPEN on first run); the spec'd 409 on re-resolving a hold is asserted nowhere. Cheap fix in workflow: after resolving, assert absence under state=OPEN and 409 on second release.
11. **`shared.ts` memoizes a rejected promise** — one transient failure becomes ~dozens of authz-matrix failures in that worker. Clear the memo on rejection.

### Nit

12. Stale comment in `tests/workflow/support/helpers.ts:4-6` referencing the deleted `world.js` shim.
13. Dead export `WebhookEventSchema` in `tests/contract/schemas/webhooks.ts`.
14. `chain.state()` skips the ok-check — non-2xx surfaces as a cryptic JSON.parse error.
15. `GET /withdrawals?state=` filter param never exercised (walletId is).

Reviewer's fidelity sweep: no zod schema found LOOSER than the spec; isolation rules hold
(no suite imports src/**, another suite, or fixture internals past `fixtures/index.js`);
no `waitForTimeout`/`Date.now()` anywhere in tests/.

### Triage (gate step 4)

| # | Sev | Action taken / recommendation |
|---|---|---|
| 1 | **Critical** | **FIXED** (`61611a7`): `workers: 1` moved into the workflow project config, AND workflow now `dependencies: ['setup','contract']` so a single bare invocation can't interleave contract's clock jumps with workflow's time-sensitive assertions (same defect class across projects — found while verifying the fix). `pnpm test` simplified to `playwright test`. Reviewer's exact repro re-run green; gate steps 1–2 re-run: `main` 197/197 fresh + KEEP_DB, defect branch same 8-failure map, `v1-defects` re-anchored. D21 amended. |
| 2 | Major | Not fixed (owner decision). Recommend: **accept into P3 scope** — genuine coverage gap on a money-moving path; two tests (~30 lines). |
| 3 | Major | Not fixed. Recommend: **accept into P3 scope** — mirror tests, small. |
| 4 | Major | Not fixed. Recommend: **accept into P3 scope** — one serialized test. |
| 5 | Major | Not fixed. Recommend: **accept into P3 scope** — one test pair; also pins D12. |
| 6 | Minor | Not fixed. Recommend: move reset test to workflow + delete `robust.ts` in the same P3 batch (aligns with the contract agent's own suggestion). |
| 7 | Minor | Not fixed. Recommend: `freezeTouched` teardown flag (3 lines) in the next fixture-open window (fixtures are frozen this phase per §B.2 rules). |
| 8 | Minor | Not fixed. Recommend: owner call — strict schemas are a philosophy change (both spec + schemas tighten together); good P4 companion to the `contract-drift` agent. |
| 9–11 | Minor | Not fixed. Recommend: fold into the P3 test-quality batch (each is a few lines). |
| 12–15 | Nit | Not fixed. Cosmetic batch whenever files are next open. |

## 6. Commands for you to poke the result

```bash
pnpm test                                  # = npx playwright test: setup -> contract (parallel) -> workflow (serialized)
pnpm test:contract                         # contract only
npx playwright test --project=workflow --no-deps   # fast workflow-only iteration
KEEP_DB=1 pnpm test                        # accumulated-DB robustness rerun
npx playwright show-report                 # HTML report of the last run

# defect tag: watch the P2 catches fire
git checkout v1-defects && rm -f prisma/vaultchain.db
npx playwright test                              # 5 authz-matrix fails (BUG-005); workflow dep-skipped
npx playwright test --project=workflow --no-deps # 3 fails: BUG-004, BUG-007, BUG-001
```

## 7. Phase P2 Definition-of-Done check

- [x] Fixtures built first, documented, frozen; suites share nothing but `fixtures/`.
- [x] `contract/` and `workflow/` built by two independent agents; merged; **green on
      `main`** locally (evidence captured).
- [x] Same suites red on `v1-defects` for exactly BUG-001/004/005/007 (API-layer
      primaries); BUG-002/003/006 left for the P4 gate. Cross-checked and mapped.
- [x] Full suite + typecheck pass on `main`, output captured (`docs/evidence/p2.txt`,
      incl. the post-triage re-run: bare invocation 197/197 fresh + KEEP_DB).
- [x] Reviewer dispatched; **1 Critical fixed** (config-level serialization + project
      dependency) with gate steps 1–2 re-run; 4 Major + 6 Minor + 4 Nit listed in §5
      with recommendations, awaiting owner decision.

**STOP after P2 — do not begin P3.**
