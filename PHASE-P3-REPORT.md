# Phase P3 Report — Pre-batch remediation, admin UI, UI journeys

> **FICTIONAL system-under-test.** P3 ran in the commissioned order: the P2-review
> pre-batch first (on `main`, gate steps 1–2 re-run), then the §A.5 admin UI (D1) and
> the thin UI journey layer.

## 1. What was built

### Pre-batch — P2 review remediation (owner-decided scope)
- **Majors 2–5 accepted** (22 new tests):
  `forced-outcome.spec.ts` (FAILED-after-broadcast refunds amount+fee **exactly**, audited;
  CONFIRMED keeps the debit; contract envelope 200/409/404),
  `withdrawal-hold.spec.ts` (FLAG before broadcast → HELD with balance **untouched**;
  release debits exactly once; reject never debits),
  `webhook-delay.spec.ts` (PENDING until `dueAtSimMs` on the sim clock; short jump doesn't
  flush; past-due delivers, attempts=1),
  `eth-normalization.spec.ts` (checksummed↔lowercase both directions; different address
  blocked regardless of casing — pins D12; 18-dp exact balances).
- **Minor batch**: reset shape test relocated to the serialized workflow project;
  `robust.ts` **deleted**; `freezeTouched` teardown; pagination exact-boundary case;
  holds state-filter pin + 409 re-resolution; `shared.ts` memo-clear on rejection.
- **Nits 12–15**: one cosmetic commit.
- **D26 — the significant discovery**: deleting `robust.ts` exposed the real race it had
  been absorbing. The fixture's `advanceClockMs` was a client-side read-modify-write via
  `clock/set`, so a stale lower target landing after a concurrent higher one could
  **rewind global time** past another worker's cooling-off activation. Root-fixed as the
  P2b contract agent had proposed: **`/simulator/clock/advance`** (atomic relative
  advance; spec + route + shape test + fixture switched together). Two further carriers
  were then hunted down empirically: `advanceChain`'s non-transactional clock write
  (now one DB transaction) and the contract project's absolute `clock/set` shape test
  (relocated to the serialized project). Verified with exit-code-gated runs ×3.
- **D25 recorded**: strict schemas DECIDED-YES, executed in P4 with the contract-drift
  agent (standing policy).

### Admin UI (PRD §A.5, D1) — `a597334`
Four Eta-rendered screens, deliberately plain, `data-testid` everywhere, no framework,
no build step: **login** (API key → httpOnly `vc_key` cookie; not production auth per
§C.1), **approval queue** (filterable, approve/reject per row), **transaction search**
(wallet/type/state/asset filters, cursor paging), **transaction detail** (facts,
approvals, Travel-Rule count, OPEN-hold panel with compliance-only resolve controls,
audit timeline). Reads query prisma directly (internal surface); **every mutation goes
through the same domain services as the API**, so maker-checker and segregation of
duties behave identically in both surfaces. Cookie read + urlencoded form parsing are
hand-rolled (~12 lines) — no new fastify plugins (DEPENDENCIES.md).

### UI test layer — `d58bcdf`
- Setup project now performs a **real `/ui/login` per role** and saves storageState
  (completes D20); `UI_STATE` exported from the fixtures surface.
- `ui` Playwright project: chromium, **serialized** (`workers: 1`), depends on workflow
  (strict pipeline — same global-state reasoning as D21), **CI-only retries** with
  traces (§B.6: the one legitimately timing-prone layer; locally a flake fails loudly).
- **Seven journeys in four files — only what must be UI** (§B.3): login (failure path,
  success + role display, anon deep-link redirect); dual approval from the queue
  (checker approves → still pending at 1-of-2 → **maker refused on-screen** → second
  checker completes → row leaves queue → detail shows PENDING_CONFIRMATION); reject
  path; search filter/exclusion/click-through with **exact fee** on detail; compliance
  hold release from the detail page, including an operator seeing **no resolve controls**
  (segregation of duties rendered, not just enforced).

## 2. What was deferred
- **CI (GitHub Actions), sharding, compliance gate + reporter, D25 strict schemas,
  the `.claude/agents` panel** → P4 (per PRD §C.2).
- **PRD P3 DoD wording "sharded in CI"**: the UI project is shard-*ready* (independent,
  serialized, retries+traces configured) but CI itself is P4-built; noted here rather
  than silently reinterpreted.
- P1/P2 deferral register unchanged except items resolved by the pre-batch
  (docs/DEFERRED.md rows for Minors 2/3/5-class items now covered by tests).

## 3. New DECISIONS.md entries (summary)
D25 strict schemas → P4 (standing policy) · D26 atomic relative clock advance (spec
addition; root cause + two further carriers documented).

## 4. Evidence (committed)
- **`docs/evidence/p3.txt`** (main): typecheck 0; **216 tests × 3 consecutive bare-run
  greens** (fresh + 2× KEEP_DB, exit-code gated) across the full pipeline
  setup → contract (parallel) → workflow (serialized) → ui (serialized, chromium);
  reconciliation invariant (276 wallets); P1 smoke intact.
- **`docs/evidence/p3-defects.txt`** (`v1-defects`): failure map **unchanged — the same
  8** (5× BUG-005 authz rows; BUG-001 half-even fee; BUG-004 cooling-off; BUG-007
  replay double-credit); BUG-002/003/006 still uncaught by design (P4 primaries);
  **all 7 UI journeys pass on the defect branch** — the UI layer is branch-neutral by
  design (fee-exact values, compliance-role hold paths).

Reproduce:
```
# main
git checkout main && rm -f prisma/vaultchain.db
pnpm typecheck && npx playwright test && npx tsx scripts/check-invariant.ts

# v1-defects
git checkout v1-defects && rm -f prisma/vaultchain.db
npx playwright test                               # 5 authz fails (BUG-005), rest dep-skipped
npx playwright test --project=workflow --no-deps  # 3 fails: BUG-001/004/007
npx playwright test --project=ui --no-deps        # 7 pass (branch-neutral)
```

## 5. Reviewer findings (code-reviewer charter) + triage

> Reviewer ran everything itself: typecheck clean; 216 green fresh + KEEP_DB; invariant
> OK; `redocly lint` valid; OpenAPI diff confirms `/simulator/clock/advance` is the only
> spec change. **0 Critical → nothing auto-fixed, steps 1–2 stand.** 3 Major + 6 Minor +
> 6 Nit below, verbatim, with recommended dispositions — nothing applied.

### Critical
None.

### Major
1. **UI read routes have no role or tenant gating — a CLIENT cookie reads everything, cross-tenant** (`src/routes/ui.ts:67-91/:115-145/:148-174`). `POST /ui/login` accepts any ACTIVE key including CLIENT keys; the three GET screens query prisma unscoped. The API deliberately scopes these reads (`loadWithdrawalScoped` 404s cross-tenant; `/audit` is COMPLIANCE_OFFICER/ADMIN) — yet the UI detail page renders the full audit timeline, approvals, and counterparty addresses of any tenant's transaction to any authenticated role. Not §C.1 territory: read-side authorization does not "behave identically in both surfaces" as the file's own header claims. Mutations ARE correctly gated. Direction: reject CLIENT keys at `/ui/login` (it is an *admin* UI per §A.5), or staff-role allowlist on the `/ui` GETs.
2. **The cookie authenticates the JSON API, not just the UI** (`src/plugins/auth.ts:46-48`). The `vc_key` fallback runs for every route; `isUi` only selects the failure mode. A browser holding the cookie can drive all of §A.4 — including ADMIN simulator endpoints — with no `X-Api-Key`. Combined with the globally registered urlencoded parser (`src/app.ts:11-14`), every API endpoint accepts cookie-authenticated HTML-form posts; only implicit `SameSite=Lax` stands before CSRF, and nothing pins Lax as load-bearing. Exactly the "accidental new/changed API surface" the phase was to avoid. Direction: consult the cookie only when `isUi`; scope the urlencoded parser to `/ui`; pin both choices.
3. **D26 incomplete: `advanceChain`'s settlement phase is an unguarded read-modify-write reachable from parallel contract workers** (`src/services/simulator.ts:44-61`). Height/clock now transactional, but the settlement loop runs after: two concurrent advances can both pass `screenAndSettleDeposit`'s non-atomic state check (`transitionTx` updates by id with **no state condition**) → duplicate SCREENING/CONFIRMED audit rows, duplicate `withdrawal.confirmed` webhooks, double screening-queue consumption; and `confirmations` is written unconditionally, so a stale lower height overwrites a higher count — the same lost-update class D26 fixed for the clock. Money is protected only by `creditDeposit`'s ProcessedEvent claim. Nothing asserts on the racy fields today (hence 216 green), but **P4's audit-completeness assertions land directly on this**. Direction: state-conditioned `updateMany` CAS before settling, or settlement inside the transaction.

### Minor
1. `POST /simulator/clock/advance` missing from the authz matrix (denial rows unasserted).
2. `forceTxOutcome` TOCTOU: terminal-state check outside the refund transaction — a concurrent settle can be overwritten CONFIRMED→FAILED *with* refund (silent semantic corruption; not test-reachable today). Guard belongs inside the `$transaction`.
3. Transaction search deviates from §A.5 screen 3: no client filter, no date filter (walletId/type/state/asset instead) — undocumented drift, not a decided narrowing.
4. 404 transaction detail renders the login template to an authenticated user.
5. `/ui/holds/:holdId/resolve` trusts `body.txId` for the redirect and never checks the hold belongs to that transaction; derive the back-link from the hold's own `transactionId`.
6. Unknown `decision` values default to the PERMISSIVE action (≠REJECT → APPROVE / RELEASE). Malformed form input silently approves or releases. Reject unknown decisions.

### Nit
1. Stale "reset window" comment in `tests/contract/webhooks.spec.ts:88-89`. 2. `flushDueWebhooks` can double-increment `attempts` under concurrent advances (latent; same CAS direction as Major 3). 3. `path.startsWith('/ui')` also matches `/uianything`. 4. `GET /ui/logout` mutates state via GET. 5. `queue.eta` next-page href not URL-encoded (functional). 6. Flash text is attacker-suppliable query content — Eta escaping holds everywhere (no XSS), but crafted links can spoof banners.

Charter verdicts otherwise: UI journeys assert server state (maker-refusal genuinely pinned via the second-checker completion); serialization enforced on every invocation path; simulator-force parallel-safety reasoning sound; all spec testids exist; §A.4 contract unchanged beyond the documented addition.

### Triage (gate step 4)

| # | Sev | Action / recommendation (nothing applied — owner decision) |
|---|---|---|
| Major 1 | ▲ **Fix before P4 builds the gate** | The UI contradicting the platform's own tenant-isolation rule is the kind of gap the P4 compliance/authz work would immediately trip over. Small: reject CLIENT at `/ui/login` + staff allowlist on `/ui` GETs, plus a login-refusal journey. |
| Major 2 | ▲ **Fix before P4** | Cookie must be a UI-only credential (`isUi` gate) and the urlencoded parser `/ui`-scoped; add an API probe that a cookie WITHOUT `X-Api-Key` gets 401. Pins SameSite as documented-load-bearing. |
| Major 3 | ▲ **Fix at P4 start** | CAS the settlement (`updateMany` state-conditioned) before the compliance gate's audit-completeness assertions are written — they will otherwise flake on exactly this. |
| Minor 1 | Fold into P4's gate/matrix work (one denial row pair). |
| Minor 2 | Fold into Major 3's CAS commit (same transaction boundary). |
| Minor 3 | Owner call: implement client+date filters or record the narrowing in DECISIONS.md. |
| Minors 4–6 | Small UI-correctness batch; recommend alongside Majors 1–2. |
| Nits 1–6 | Cosmetic batch; Nit 2 folds into Major 3's CAS. |

### Post-report: pre-P4 batch (Stage 1) — APPLIED

Owner commissioned all of the above as a pre-P4 batch on `main` (this supersedes the
"nothing applied" note). Outcome:
- **Major 1 fixed** — `/ui/login` rejects CLIENT keys + staff-role allowlist on all `/ui`
  GETs (both layers); CLIENT login-refusal journey added (D27).
- **Major 2 fixed** — `vc_key` cookie consulted only for `/ui/`; urlencoded parser
  `/ui`-scoped; `SameSite=Lax` documented load-bearing; probes: cookie-without-`X-Api-Key`
  → 401, form-post-on-JSON → 415 (D27).
- **Major 3 + Minor 2 + Nit 2 fixed** — settlement path is compare-and-set
  (`claimTransition`), confirmations only-raise, `forceTxOutcome` terminal-check inside its
  transaction, `flushDueWebhooks` CAS on `attempts` (D28). **⚠ D28 records that no P4
  compliance test may be written before verifying this landed** — the audit-completeness
  assertions depend on it.
- **Minors 4–6 fixed** — 404 renders a real not-found page; hold-resolve redirect derived
  from the hold's own `transactionId`; unknown decision → 400 (+ probe).
- **Minor 1 fixed** — `/simulator/clock/advance` denial rows in the authz matrix.
- **Minor 3** — recorded as D29 (search-filter narrowing; no code change).
- **Nits 1,3–6 fixed** — stale comment, `/ui/` path boundary, logout via POST, URL-encoded
  next-page, flash-spoof accepted-and-noted.
- **Bonus (flake root-cause):** a rare `insufficient-funds` in a full parallel run traced
  to `advanceChain` settling GLOBAL pending deposits (a concurrent worker winning the CAS
  claim mid-credit); `fundedWallet` now confirms the credit is visible before returning.

Gate steps 1–2 re-run: **222 tests × 4 exit-code-gated green on `main`**
(`docs/evidence/p3.txt`), reconciliation OK; defect map **still exactly 8**
(`docs/evidence/p3-defects.txt`), UI now 9 branch-neutral. `v1-defects` re-anchored.
Reference `D25` stands: strict schemas remain P4 work.

## 6. Commands for you to poke the result
```
npx playwright test                    # full pipeline, one command
npx playwright test --project=ui       # journeys (pulls deps; add --no-deps to skip)
pnpm start                             # then browse http://localhost:3000/ui/login
#   sign in with a seed key, e.g. operator: vck_operator_b_000000000000
#   compliance (hold resolution): vck_compliance_000000000000
npx playwright show-report
```

## 7. Phase P3 Definition-of-Done check
- [x] Pre-batch executed in the commissioned order; gate steps 1–2 re-run after it
      (failure map verified unchanged).
- [x] Admin UI: four §A.5 screens, server-rendered, data-testids, mutations via the
      same services as the API.
- [x] UI journeys green (×3 bare runs) with retries+traces configured per §B.6;
      storageState per role produced by the setup project (D20 completed).
- [x] Defect-branch sync: map unchanged, UI journeys branch-neutral, `v1-defects`
      re-anchored.
- [x] Reviewer dispatched; **0 Critical** → nothing auto-fixed, steps 1–2 stand;
      3 Major + 6 Minor + 6 Nit in §5 with recommended dispositions, awaiting owner
      decision (Majors 1–3 recommended as a pre-P4 batch).

**STOP after P3 — do not begin P4.**
