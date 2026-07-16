# Adversarial Gate Report — VaultChain

Final adversarial audit before public release. Executed per the charter in
`.claude/agents/adversarial-auditor.md`: find behaviours the platform gets
**wrong that the test suite fails to catch**, and prove every claim with a
minimal reproduction. No speculation — only demonstrated findings.

- **Auditor blindness honoured.** Did not read `BUGS.md`/`*bugs*`,
  `docs/evidence/**`, `docs/P4-KICKOFF.md`, or any `PHASE-P*-REPORT.md`, and did
  no git archaeology against `v1-defects` (no diff vs `main`, no commit/blame
  inspection). Each checkout was treated as an opaque codebase.
- **Environment.** `pnpm install --frozen-lockfile` + `npx prisma generate` OK.
  `npx playwright install chromium` was **blocked by the sandbox** (browser CDN
  returned `403 host not permitted`); the pre-installed Chromium is v1194 while
  Playwright 1.61 wants v1228, so the `ui` project could not run. This is out of
  scope: the compliance, contract, and workflow layers are browser-free and are
  the audit's subject.
- **Method.** Probes drove the real application in-process via Fastify
  `app.inject()` against a freshly migrated + seeded SQLite DB (no manually
  backgrounded server; the Playwright `webServer` was used only for the suite
  runs in Phase 2b). Throwaway probes lived outside the tree and are deleted.

---

## Phase 1 — `main` (the fixed platform): behaviours no test catches

The suite is green on `main`. Below are behaviours the platform gets **wrong**
that **no test catches**, each proven by a reproduction. Severity accounts for
whether the surface is production-reachable: the `/simulator/*` control plane is
**disabled in production** (`VAULTCHAIN_ENV=production` → the routes are never
registered), so simulator-only findings are dev/test-scoped. They are still
in-scope: the charter names "simulator edge states … forced failures
mid-lifecycle" as a priority attack surface.

### F1 — `forceTxOutcome('CONFIRMED')` marks a not-yet-broadcast withdrawal CONFIRMED with **no debit** (Medium; simulator/dev-only)

`src/services/simulator.ts::forceTxOutcome` only rejects **already-terminal**
states before confirming. For `CONFIRMED` it does an unconditional
`transitionTx(tx, 'CONFIRMED')` — with **no** debit and **no** check that the
withdrawal was ever broadcast. Forcing `CONFIRMED` from any non-terminal state
(`PENDING_APPROVAL`, `APPROVED`, `TRAVEL_RULE_CHECK`, `SCREENING`, `HELD`)
produces a *settled* withdrawal whose money never left the wallet, emits a
`withdrawal.confirmed` webhook, and bypasses approvals + screening. From `HELD`
it also overrides the compliance hold (which stays `OPEN`). Reconciliation still
passes because no ledger row was written.

The symmetric `FAILED` path is carefully guarded (refund only if actually
debited) and is tested (`forced-outcome.spec.ts`); `CONFIRMED` has no equivalent
guard and no test forces it from a pre-broadcast state.

**Reproduction** (create → force CONFIRMED from `PENDING_APPROVAL`):

```
POST /withdrawals {walletId, amount:"1500.00", counterpartyAddress}     -> 201 PENDING_APPROVAL
POST /simulator/tx/<id>/force {outcome:"CONFIRMED"}                      -> 200 CONFIRMED
```

Observed:

```
withdrawal created state: PENDING_APPROVAL
balance before force: 10000.00
force CONFIRMED -> status: 200 state: CONFIRMED
balance AFTER force CONFIRMED: 10000.00 (minor 1000000)
ledger DEBIT rows for this withdrawal: 0
reconciliation: ledgerSum=1000000 balance=1000000 HOLDS=true
withdrawal.confirmed webhook deliveries referencing this tx: 1
```

From `HELD` (screening-flagged), same call: `-> 200 CONFIRMED`, `balance
unchanged`, `DEBIT rows 0`, `hold still OPEN: true`.

**Should a test have caught it?** Yes. `forced-outcome.spec.ts` pins forced
`CONFIRMED` only *after* broadcast (asserts the debit stays). A case forcing
`CONFIRMED` from a pre-broadcast state — asserting either a clean rejection or
that no "confirmed" withdrawal exists without a debit — is missing.

### F2 — bodyless `POST` + `Content-Type: application/json` returns **500** on production endpoints (Medium; production-reachable)

`src/app.ts`'s `setErrorHandler` has branches for `ApiProblem` and for
validation errors (`err.validation`), then falls through to a generic **500**.
Fastify's JSON body parser rejects an empty body with
`FST_ERR_CTP_EMPTY_JSON_BODY` (a `FastifyError`, not a validation error), so any
**no-body POST** sent with `Content-Type: application/json` — a default many
HTTP clients set — hits the 500 fall-through instead of succeeding or returning
`problem+json`. This contradicts the PRD §A.4 promise of RFC 9457 problem+json
for every error shape, and blocks real operations on the bodyless production
endpoints `POST /holds/{id}/release`, `POST /holds/{id}/reject`, and
`POST /withdrawals/{id}/cancel`.

**Reproduction:**

```
POST /withdrawals/<id>/cancel   (Content-Type: application/json, empty body)  -> 500
POST /withdrawals/<id>/cancel   (no Content-Type header,        empty body)   -> 200
POST /holds/<id>/release        (Content-Type: application/json, empty body)  -> 500  (hold stays OPEN — no-op)
POST /holds/<id>/release        (no Content-Type header,        empty body)   -> 200
```

Server log for the 500: `FST_ERR_CTP_EMPTY_JSON_BODY "Body cannot be empty when
content-type is set to 'application/json'"`.

**Should a test have caught it?** Yes. The test client
(`tests/fixtures/api-client.ts`) sends bodyless POSTs with **no** `data`, so
Playwright never sets a JSON content-type — the suite never exercises this path,
even though the authz-matrix and audit-completeness suites POST to these exact
endpoints. A content-type contract check on the no-body endpoints is missing.

### F3 — concurrent Travel-Rule attach is not idempotent/atomic → duplicate compliance records + duplicate audit rows (Medium; production-reachable)

`src/services/withdrawals.ts::attachTravelRule` reads the state, creates the
`ORIGINATOR`/`BENEFICIARY` records, then (for `TRAVEL_RULE_CHECK`) calls
`screenAndBroadcast`, which does an **unconditional** `transitionTx(...,
'SCREENING')` — no compare-and-set, no unique constraint. Two concurrent
`POST /withdrawals/{id}/travel-rule` on a `TRAVEL_RULE_CHECK` withdrawal both
pass the state check and both write records/audit rows.

**Reproduction** (two attaches via `Promise.all` on one `TRAVEL_RULE_CHECK` tx):

```
r1: 201 PENDING_CONFIRMATION
r2: 409 not-broadcastable ("Withdrawal is PENDING_CONFIRMATION; cannot broadcast")
TravelRuleRecords: 4  -> ORIGINATOR,ORIGINATOR,BENEFICIARY,BENEFICIARY   (expected 2)
audit actions: ... TRAVEL_RULE_ATTACHED, TRAVEL_RULE_ATTACHED, TRANSACTION_SCREENING, TRANSACTION_SCREENING, TRANSACTION_BROADCAST, TRANSACTION_PENDING_CONFIRMATION
duplicate TRAVEL_RULE_ATTACHED audit rows: 2; duplicate TRANSACTION_SCREENING rows: 2
```

The losing request duplicated the Travel-Rule compliance records and wrote a
second `TRAVEL_RULE_ATTACHED` + a second `TRANSACTION_SCREENING` audit row —
directly violating the "exactly once" property the audit-completeness gate is
built around. **A single withdrawal now carries two originator and two
beneficiary records.**

I additionally attempted to force a genuine **double-debit / double-broadcast**
on this same non-CAS path (the structural risk is real: `transitionTx` can
rewind `PENDING_CONFIRMATION → SCREENING` and `broadcastWithdrawal` re-accepts
`SCREENING`). It did **not** reproduce in **28 attempts** (2-way and 4-way
concurrent volleys) — the `broadcastWithdrawal` `$transaction` under
`connection_limit=1` serialized the balance mutation every time. I therefore
report only the demonstrated duplication, and flag the double-debit as an
un-reproduced structural risk on the same path, not as a proven finding.

**Should a test have caught it?** Yes. `audit-completeness.spec.ts` asserts exact
ordered trails to catch duplicate `TRANSACTION_*` rows, but only for **sequential**
flows; no test attaches Travel-Rule data concurrently. The maker-checker path was
hardened against exactly this class (unique constraint + `$transaction`); the
Travel-Rule attach path was not.

### F4 — forced terminal outcome on a `HELD` tx orphans the compliance hold; releasing it is non-atomic (Low; simulator-triggered)

Forcing `FAILED`/`CONFIRMED` on a `HELD` withdrawal (F1) leaves the
`ComplianceHold` `OPEN` on a now-terminal transaction. `releaseHold`
(`src/services/lifecycle.ts`) then runs `resolveHoldCore` (which **commits**
`hold → RELEASED` and writes a `HOLD_RELEASED` audit) **before**
`broadcastWithdrawal`, which throws `409 not-broadcastable`. The caller sees the
409, yet the hold is now `RELEASED` with a `HOLD_RELEASED` audit entry while the
transaction stays `FAILED` and nothing broadcast — an inconsistent state and a
misleading audit trail from a non-atomic compensation.

**Reproduction:**

```
(dual-approve with FLAG queued) -> HELD ; POST /simulator/tx/<id>/force {FAILED} -> FAILED, hold OPEN
POST /holds/<hold>/release      -> 409 not-broadcastable
hold state after release: RELEASED | tx state: FAILED
hold audit actions: HOLD_OPENED, HOLD_RELEASED
```

**Should a test have caught it?** A `forced-outcome`/holds test that forces a
terminal outcome on a `HELD` transaction and then asserts the hold is not left
orphaned (and that a failed release does not record `HOLD_RELEASED`) would catch
it. None exists.

### F5 — force `CONFIRMED` on a pending **deposit** yields an illegitimate state + wrong event, no credit (Low; simulator/dev-only)

`forceTxOutcome('CONFIRMED')` on a `PENDING_CONFIRMATION` **deposit** transitions
it to `CONFIRMED` — a state deposits never legitimately reach (they end
`CREDITED`) — emits a `withdrawal.confirmed` webhook (wrong event type for a
deposit), and never credits the wallet.

**Reproduction:**

```
deposit state: PENDING_CONFIRMATION
POST /simulator/tx/<id>/force {CONFIRMED} -> 200 CONFIRMED
-> emitted a 'withdrawal.confirmed' webhook: true ; credited (ProcessedEvent): false
```

**Should a test have caught it?** A simulator-force contract/workflow test that
asserts `force` is rejected (or has deposit-appropriate semantics) for a deposit
would catch it. None exists.

### Phase 1 — surfaces probed with **nothing found** (evidence-backed)

These priority surfaces were attacked and behaved **correctly** on `main`:

- **Maker-checker enforcement & concurrency.** Maker cannot approve (`403`); the
  same operator approving twice concurrently yields **1** approval row + a `409`
  for the loser (still `PENDING_APPROVAL`); two distinct concurrent approvals
  produce exactly **1** `TRANSACTION_APPROVED` and settle once. No bypass.
- **Asset decimal & fee rounding.** Round-half-even holds exactly at `.5`
  boundaries: fee for `5.00 → 0`, `15.00 → 2`, `25.00 → 2`, `1500.00 → 150`.
- **Allowlist normalization & scoping.** ETH allowlisted lowercase matches an
  UPPERCASE withdrawal target (case-insensitive); an address allowlisted on
  account A is rejected (`422 address-not-allowlisted`) when used from account B.
- **Travel-Rule threshold direction.** `requiresTravelRule` uses `>=` on `main`
  — exactly-1000 cross-VASP is correctly gated.

### Phase 1 severity summary

- **High / Critical:** nothing found.
- **Medium:** F1 (force-CONFIRMED without debit), F2 (empty-JSON-body → 500),
  F3 (concurrent Travel-Rule attach duplication).
- **Low:** F4 (orphaned hold / non-atomic release), F5 (force-CONFIRMED on a
  deposit).
- **Informational (not defects):** omnibus withdrawals attribute the DEBIT
  sub-ledger row to the account owner (`account.clientId`), not a per-co-client
  identity — but the API has no "withdraw on behalf of co-client" concept, so
  this is a modelling simplification; the wallet-level reconciliation invariant
  still holds.

---

## Phase 2 — the `v1-defects` tag (seven planted defects)

Checked out `tags/v1-defects` (detached), deleted `prisma/vaultchain.db`, ran
`prisma migrate deploy` + `seed`, and treated the code as opaque.

### 2a — Discovered & proven from code-reading + probes (before running the suite)

All **seven** planted defects were located by reading this branch's source
against the PRD/spec and proven with probes. `PROVEN` lines are the probe output.

| # | Defect | Location | Proof (observed) |
|---|--------|----------|------------------|
| D1 | **Travel-Rule boundary off-by-one** — `requiresTravelRule` uses `>` not `>=`, so *exactly* 1000.00 bypasses | `services/withdrawals.ts:35` | Exactly-1000 cross-VASP after dual approval → `state PENDING_CONFIRMATION`, `TravelRuleRecords: 0` (correct = `TRAVEL_RULE_CHECK`) |
| D2 | **Rounding** — `feeFor` uses `Number`/`Math.floor` (float + truncation) instead of bigint round-half-even | `services/money.ts:55` | `15.00 GBPX fee = 1` (correct 2); `1.234567890123456789 ETH fee = …3456` (correct bigint `…3457`) — float precision loss |
| D3 | **Maker-checker** — Approval `@@unique` dropped, `addApproval` no longer a `$transaction`, counts approval **rows** not distinct approvers | `schema.prisma` (`Approval`), `services/approvals.ts` | One operator approves a 2-of-N withdrawal **twice** → `approval rows=2, DISTINCT approvers=1, state PENDING_CONFIRMATION` |
| D4 | **Cooling-off** — `isActive` compares against `Date.now()` (wall clock) instead of `simNow` (sim clock) | `services/allowlist.ts:50` | Withdrawal to a just-added address (still cooling-off on the sim clock) → `201 PENDING_APPROVAL` (correct = `422 address-in-cooling-off`) |
| D5 | **Audit omission** — `resolveHoldCore` writes an audit entry only for `REJECTED`, not `RELEASED` | `services/holds.ts:57` | Released hold's audit trail = `[HOLD_OPENED]` (correct `[HOLD_OPENED, HOLD_RELEASED]`) |
| D6 | **Webhook idempotency** — `creditDeposit` dropped the `ProcessedEvent` exactly-once claim; `CREDITED` remains "creditable" | `services/deposits.ts` | Replayed `deposit.credited` → balance `1050000 → 1100000`, `CREDIT ledger rows=2` (correct = no-op) |
| D7 | **Authorization** — hold resolve routes use `denyRole('CLIENT')` (negative check) not `requireRole('COMPLIANCE_OFFICER')` | `plugins/auth.ts` (`denyRole`), `routes/holds.ts:44,50` | OPERATOR release of a compliance hold → `200` (correct = `403`) |

Every planted defect was discovered blind and demonstrated before running the
suite.

### 2b — Suite run & reconciliation

Ran the bare suite, then each browser-free project in isolation
(`--project=setup --project=<name> --no-deps`; the `ui` project could not run —
no browser). Results:

- **contract** — 6 failed / 177 passed:
  `authz-matrix.spec.ts:423` × 5 (release/reject as operatorA/operatorB/admin →
  expected 403) and `holds-audit.spec.ts:17` (a cascade: the now-succeeding
  authz tests resolved the seeded open holds, so "seed stages open holds" saw 0).
- **workflow** — 3 failed / 29 passed: `allowlist-cooling-off.spec.ts:13`,
  `idempotency.spec.ts:53` (webhook replay double-credit),
  `money-precision.spec.ts:31` (15.00 fee).
- **compliance** (the gate) — **GATE: RED**, 4 failed / 7 passed:
  `travel-rule.spec.ts:52` (T=1000.00), `dual-approval.spec.ts:25`,
  `segregation-of-duties.spec.ts:24`, `audit-completeness.spec.ts:45`.
  `gate-summary.md` names the missing boundary: *"Travel-Rule coverage: 2/3 …
  MISSING at T=1000.00"*.

**List 1 — proven defects a failing test also catches (all 7):**

| Defect | Caught by |
|--------|-----------|
| D1 Travel-Rule | `compliance/travel-rule.spec.ts:52` |
| D2 rounding | `workflow/money-precision.spec.ts:31` |
| D3 maker-checker | `compliance/dual-approval.spec.ts:25` |
| D4 cooling-off | `workflow/allowlist-cooling-off.spec.ts:13` |
| D5 audit omission | `compliance/audit-completeness.spec.ts:45` |
| D6 webhook idempotency | `workflow/idempotency.spec.ts:53` |
| D7 authorization | `contract/authz-matrix.spec.ts:423` (×5) + `compliance/segregation-of-duties.spec.ts:24` (+ `contract/holds-audit.spec.ts:17` cascade) |

**List 2 — failing tests pointing at defects I missed:** none. Every failure maps
to a defect I had already discovered and proven. No planted defect went
undetected.

**List 3 — wrong behaviour proven on `v1-defects` that NO test fails on:** the
Phase-1 structural findings (which are **not** the planted defects and are not
targeted by the defect suite) are present and uncaught on this branch too.
Verified directly here: F1 (`force CONFIRMED from PENDING_APPROVAL → CONFIRMED,
balance unchanged, DEBIT rows 0`) and F2 (`bodyless cancel + JSON content-type →
500`). By code identity, F3/F4/F5 (unchanged code paths) apply equally.

---

## Overall gate assessment

- **Blind detection:** 7/7 planted defects discovered and proven **before**
  running the suite; **0** missed.
- **Safety-net validation:** every planted defect is caught by at least one
  failing test; the compliance gate goes **RED** and names the boundary.
- **Gate's real output (behaviours no test catches):** **no High/Critical.**
  **Medium:** F1, F2, F3. **Low:** F4, F5. These are the gap between system and
  safety net and are the audit's substantive result. F2 and F3 are
  production-reachable; F1/F4/F5 live on the `/simulator` surface, which is
  disabled in production but is an explicit charter attack surface.

**Triage and publication are the owner's decision.** This report recommends no
fixes and changes no `src/`/`tests/` code.

### Reproduction notes

Probes drove the app via Fastify `app.inject()` against a migrated + seeded DB
(`npx prisma migrate deploy && npx tsx scripts/seed.ts`) using the seed's printed
mock keys (admin/operatorA/operatorB/compliance). Simulator endpoints require the
`ADMIN` key and a non-production `VAULTCHAIN_ENV`. Suite reproduction:
`npx playwright test --project=setup --project=<contract|workflow|compliance> --no-deps`
on the `v1-defects` tag (delete `prisma/vaultchain.db` first).
