# P4 Kickoff — read this first

> **FICTIONAL system-under-test.** Single-file resume pointer for Phase P4 (compliance
> gate + reporter + CI + strict schemas + agents panel + README). Everything below is derived
> from `PRD.md` §C.2/P4·§B.3·§B.5·§B.6·§D, gitignored `BUGS.md` (the answer key),
> `DECISIONS.md`, and `PHASE-P3-REPORT.md`. This file is the map; those are the territory.

## Where things stand (start of P4)

- **`main`** = the FIXED platform. Full pipeline **222 tests, green ×4** (setup → contract
  parallel → workflow serialized → ui serialized/chromium). Reconciliation invariant holds.
  Evidence: `docs/evidence/p1.txt … p3.txt`.
- **`defects-planted`** (tag **`v1-defects`**) = `main` + 7 one-per-`BUG-00x` commits +
  evidence commits. Current mapped failures = **8**: contract `authz-matrix` ×5 (BUG-005),
  workflow ×3 (BUG-001 fee, BUG-004 cooling-off, BUG-007 replay).
- **BUG-002, BUG-003, BUG-006 are still UNCAUGHT — by design.** They are P4's job (the
  `@compliance` gate's primary catches). See BUGS.md "Caught by" + "Independence notes".
- Two-branch invariant: `git merge-base --is-ancestor main defects-planted` must stay true.
  After any `main` change: `git checkout defects-planted && git rebase main && git tag -f v1-defects`.

## ⚠ GATE ZERO — do this BEFORE writing any `@compliance` test (DECISIONS D28)

The P4 audit-completeness and webhook-count assertions depend on the settlement
compare-and-set landing in P1-review Stage 1. **Verify it is present first:**

- `src/services/transitions.ts` exports `claimTransition` (state-guarded `updateMany`, audits only the winner).
- `src/services/simulator.ts` `advanceChain` uses `claimTransition` for settle + `updateMany({confirmations:{lt}})`; `forceTxOutcome` runs inside one `$transaction`.
- `src/services/deposits.ts` `screenAndSettleDeposit` CAS-claims `PENDING_CONFIRMATION → SCREENING` and returns a boolean.
- `src/services/webhooks.ts` `flushDueWebhooks` CAS-guards the `attempts` increment.
If any is missing, STOP and restore it — a pre-CAS platform emits duplicate `TRANSACTION_*`
audit rows / `withdrawal.confirmed` webhooks under parallel advances and will flake exactly
the assertions P4 is about to write.

## P4 build order (compliance FIRST, per the owner's Stage-2 note)

1. **`tests/compliance/` — the `@compliance` gate suite** (its own project, separate CI job,
   §B.3). Encode the RULES at their boundaries, not examples:
   - **Travel Rule** (`travel-rule.spec.ts`): boundary triplet `T-1 / T / T+1` **in GBPX**
     (1:1 fiat, no rate/fee path → independent of BUG-001, per Independence notes). Exactly
     `T` (1000.00, cross-VASP) must require an originator+beneficiary payload before
     broadcast → **catches BUG-003**.
   - **Dual approval / maker-checker** (`dual-approval.spec.ts`): concurrency probe firing
     two approvals via `Promise.all`; assert the final approver set is N distinct non-maker
     approvers → **catches BUG-002**. (Serialized project, but this test drives its own
     concurrency.)
   - **Audit completeness** (`audit-completeness.spec.ts`): scripts a full hold lifecycle,
     **releasing via a `compliance-officer` key** (authorized path, so it runs regardless of
     BUG-005) and asserts an audit entry with actor+before/after for **every** transition,
     `OPEN → RELEASED` included → **catches BUG-006**.
   - **Segregation of duties** (`segregation-of-duties.spec.ts`, `@compliance`): only a
     `compliance-officer` may resolve a hold → **reinforces BUG-005** (primary catch stays
     the P2 contract `authz-matrix`; defence-in-depth, not double-counting — BUGS.md reveal
     table + PRD §B.3).
   - **Net: the gate goes RED on exactly FOUR — BUG-002/003/005/006** — on `v1-defects`.
   - P4 exclusions were carried by P2/P3 (those suites deliberately avoid these boundaries),
     so nothing there should start catching 002/003/006 now.
2. **Custom reporter** (`reporters/compliance-reporter.ts`, §B.4/§B.5): implements the
   Playwright `Reporter` interface (`onBegin`/`onTestEnd`/`onEnd` returning a promise);
   emits a human-readable `gate-summary.md`/`.html` bucketed by rule (e.g. "Travel-Rule
   coverage: 2/3 boundary cases — MISSING at T=1000"). Wire into `playwright.config.ts`
   reporters.
3. **CI** (`.github/workflows/ci.yml`, §B.5): lint · typecheck · api-contract · api-workflow ·
   ui (shard matrix + blob upload) · **compliance-gate as a separate REQUIRED job** (custom
   reporter → `gate-summary` artifact) · `merge-reports` job (`needs` the shards).
4. **D25 strict schemas** (standing decision): move contract response schemas to
   `z.strictObject` AND add `additionalProperties: false` to the OpenAPI response schemas
   **together**, alongside the `contract-drift` agent — so drift fails in both directions.
5. **`.claude/agents` panel** (§D.3): add `compliance-auditor`, `flake-hunter`,
   `contract-drift`, `assertion-critic` + a documented CI review-gate pattern. **Do NOT
   modify or remove the existing `code-reviewer` / `adversarial-auditor` agent files.**
6. **README** (§D): layered (architecture-first + a labelled fintech domain deep-dive),
   one-command run, the BUG-003 walkthrough on the `v1-defects` tag (README reveal policy:
   walk through BUG-003 only; allude to 001/002/004/005/006/007 without location/mechanics —
   BUGS.md reveal table).

## Completion gate (run in this exact order, then STOP)

1. **Evidence** — full pipeline + typecheck on `main` → `docs/evidence/p4.txt`, committed.
2. **Defect-branch sync** — rebase `defects-planted` onto `main`; run the suite there; the
   `@compliance` gate goes RED on **BUG-002/003/005/006**, P2 primaries (001/004/007) still
   red, everything else green → `docs/evidence/p4-defects.txt`; move `v1-defects`.
3. **Review** — dispatch the `code-reviewer` charter (see ops note) on the P4 diff; append
   findings verbatim to the report.
4. **Triage** — fix CRITICALs only + re-run steps 1–2; leave major/minor for owner decision.
5. **Report** — `PHASE-P4-REPORT.md`.

## Ops gotchas (learned this build — do not relearn)

- **Never manually background `scripts/test-serve`.** Killing the `npx` wrapper orphans the
  node server on **:3000**, and `reuseExistingServer` then reuses the stale one — poisons
  defect-branch runs (symptom: `Device or resource busy` on the db + phantom setup
  failures). For invariant checks use `pnpm seed` then `npx tsx scripts/check-invariant.ts`
  synchronously (no server needed). If you hit it: `Get-NetTCPConnection -LocalPort 3000`
  → `Stop-Process`.
- **`code-reviewer` is not a dispatchable subagent type** in this harness. Run its charter
  (from `.claude/agents/code-reviewer.md`) via a `general-purpose` agent.
- **Exit-code-gate multi-runs**: a `grep` pipeline can swallow a non-zero exit. Capture to a
  log and check `$?` per run.
- Parallel-safety for any new contract test that forces/settles: target a `PENDING_APPROVAL`
  withdrawal (settlement-immune), not a pending deposit.

## Commands

```bash
npx playwright test                                   # full pipeline (one command)
npx playwright test --project=compliance --no-deps    # (once P4 adds it) gate only
git checkout v1-defects && rm -f prisma/vaultchain.db && npx playwright test   # watch the catches
pnpm seed && npx tsx scripts/check-invariant.ts        # reconciliation, server-free
```

Seed keys are printed by `pnpm seed` (e.g. compliance officer `vck_compliance_000000000000`).
