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
```
# main — everything green
git checkout main && rm -f prisma/vaultchain.db
pnpm typecheck && pnpm test && npx tsx scripts/check-invariant.ts

# v1-defects — watch the four P2 catches fire
git checkout v1-defects && rm -f prisma/vaultchain.db
pnpm test:contract   # 5 fails: authz-matrix hold-resolution rows (BUG-005)
pnpm test:workflow   # 3 fails: cooling-off (BUG-004), replay (BUG-007), 15.00 fee (BUG-001)
```

## 5. Reviewer findings (code-reviewer charter) + triage

_[pending reviewer return — findings will be appended verbatim; CRITICALs fixed with
steps 1–2 re-run; major/minor left for owner decision.]_

## 6. Commands for you to poke the result
```
pnpm test                                  # both suites, fresh seeded server
pnpm test:contract                         # 176 parallel contract tests
pnpm test:workflow                         # 22 serialized workflow tests
KEEP_DB=1 pnpm test                        # accumulated-DB robustness rerun
npx playwright show-report                 # HTML report of the last run
git checkout v1-defects && pnpm test:workflow   # watch BUG-001/004/007 get caught
```

## 7. Phase P2 Definition-of-Done check
- [x] Fixtures built first, documented, frozen; suites share nothing but `fixtures/`.
- [x] `contract/` and `workflow/` built by two independent agents; merged; **green on
      `main`** locally (evidence captured).
- [x] Same suites red on `v1-defects` for exactly BUG-001/004/005/007 (API-layer
      primaries); BUG-002/003/006 left for the P4 gate. Cross-checked and mapped.
- [x] Full suite + typecheck pass on `main`, output captured (`docs/evidence/p2.txt`).
- [ ] Reviewer findings + triage (§5 — pending).

**STOP after P2 — do not begin P3.**
