# Phase P1 Report — Platform core + seed + simulator

> **FICTIONAL system-under-test.** No real crypto, keys, money, customers, or firms.
> Phase P1 delivers the mock custody platform on `main` (fixed) and the seven planted
> defects on `defects-planted` (tag `v1-defects`). No Playwright layers yet — those are P2.

## 1. What was built (on `main`)

**Platform (Fastify + Prisma/SQLite, strict TypeScript, ESM):**
- **Domain model** — all §A.1 entities in `prisma/schema.prisma` (17 models): Client, Account,
  Asset, Wallet, LedgerEntry, Transaction, ApprovalPolicy, Approval, AllowlistedAddress,
  ComplianceHold, TravelRuleRecord, AuditLogEntry, ApiKey, WebhookSubscription,
  WebhookDelivery, ProcessedEvent, ChainState. Two migrations.
- **Money** (`src/services/money.ts`) — integer minor units as `bigint`, asset-aware
  `decimals`, one rounding mode (`roundHalfEvenDiv`, banker's rounding). No float in storage.
- **Lifecycles** — deposit (`deposits.ts`) and withdrawal (`withdrawals.ts`) state machines
  per §A.3; gate order allowlist → approval policy → Travel Rule (`>=`) → screening →
  broadcast → confirmations.
- **Dual approval** (`approvals.ts`) — one serialized `$transaction`; unique
  `(transactionId, approverApiKeyId)` constraint; maker-cannot-check enforced atomically;
  APPROVED requires N distinct non-maker approvers.
- **Compliance holds** (`holds.ts`, `lifecycle.ts`) — shared audited resolution path for
  release AND reject; `COMPLIANCE_OFFICER`-only at the route layer.
- **Allowlist cooling-off** (`allowlist.ts`) — activation measured on the sim clock only.
- **Idempotent deposits** — exactly-once crediting keyed `(walletId, chainTxRef)` via
  `ProcessedEvent`.
- **Audit** (`transitions.ts`, `audit.ts`) — every transition writes an append-only entry
  with actor + before/after, in the same DB transaction as the change.
- **Simulator** (`services/simulator.ts`, `routes/simulator.ts`) — full §A.7 control plane:
  chain/advance, clock/set, clock/freeze, tx force (with refund on FAILED), screening/next,
  webhook replay, webhook delay, reset. Hidden entirely when `VAULTCHAIN_ENV=production`.
- **Auth** (`plugins/auth.ts`) — `X-Api-Key`, four roles, explicit per-route `requireRole`
  allowlists (no negative checks); CLIENT keys tenant-bound; cross-tenant reads return 404.
- **API** — every §A.4 endpoint; RFC 9457 `problem+json` errors; cursor pagination.
- **OpenAPI 3.1** (`openapi/vaultchain.yaml`) — hand-authored contract, validates under
  `redocly lint` (0 errors; 47 style warnings, e.g. missing operationIds — cosmetic).
- **Seeds** — `seed.ts` (deterministic, RNG seed 42: 8 fictional clients, 20 accounts,
  48 wallets, 330 transactions, a 5-client omnibus pool) and `seed-demo.ts` (hand-staged
  preconditions for the §D.2 walkthrough). `seed-lib.ts` holds obviously-fictional names.
- **Smoke** (`scripts/smoke.ts`) — 30 assertions over both lifecycles, API-only,
  simulator-driven, zero sleeps. `check-invariant.ts` verifies reconciliation.
- **Docker** — `Dockerfile` + `docker-compose.yml` for `docker compose up` (authored;
  not executed here — see Deferred).

**Planted defects (on `defects-planted`, tag `v1-defects` — never on `main`):**
seven commits, one per bug, messages = `BUG-00x` only:
BUG-001 (float/floor fee), BUG-002 (approval race: no txn + no unique constraint),
BUG-003 (`>` Travel-Rule off-by-one), BUG-004 (cooling-off on `Date.now()`),
BUG-005 (hold release via negative role check), BUG-006 (release writes no audit),
BUG-007 (no ProcessedEvent → replay double-credits). All seven verified to reproduce.

## 2. What was deferred (with rationale — see DECISIONS.md)

- **Admin UI → P3** (D1). §A.5's server-rendered screens are first needed by the P3 UI
  journeys; deferring keeps P1 to platform/API and avoids the `eta` dependency now.
- **Playwright test layers → P2.** P1 is platform-only by the PRD build plan; the smoke
  script + `check-invariant.ts` stand in for "full suite" this phase.
- **Docker `compose up` execution → Docker-enabled env** (D2). Docker isn't installed on
  this build machine; the files are authored per §D.1 and evidence boots the server via
  `tsx`. Compose boot verification is a follow-up.
- **Policy-management endpoint** — not in §A.4; accounts get a default dual-approval policy
  on creation (D17). No runtime policy CRUD in P1.
- **EIP-55 checksum verification → P2+** (D12). P1 normalizes addresses (ETH lowercased);
  full checksum validation is test-layer material.

## 3. New DECISIONS.md entries (summary)

D1 UI→P3 · D2 Docker authored-not-run · D3 pnpm via npm -g · D4 no resting DRAFT state ·
D5 literal SQLite URL · D6 flat 10bps fee, half-even · D7 approvals-below-threshold=1 ·
D8 per-asset confirmations (BTC 3/ETH 12/GBPX 1) · D9 24h sim-clock cooling-off ·
D10 webhooks recorded locally, no outbound HTTP · D11 screening default CLEAN, queue-one ·
D12 lowercase/trim address compare · D13 response-shape validation → P2 contract layer ·
D14 refund amount+fee on forced FAILED (keeps reconciliation) · D15 tsx, no build step ·
D16 CLIENT `GET /clients` self-scoped · D17 default dual-approval policy on account create.

## 4. Evidence (committed — PRD §C.2)

- **`docs/evidence/p1.txt`** (on `main`) — Node/pnpm versions; `pnpm typecheck` (exit 0);
  `pnpm seed` run twice with identical output (determinism); reconciliation invariant across
  48 wallets; `pnpm smoke` (30/30 [PASS], "== SMOKE PASSED =="); and a **boundary contrast**
  running the seven defect scenarios against the fixed platform — all seven CORRECT.
- **`docs/evidence/p1-defects.txt`** (on `defects-planted`) — branch shape; typecheck exit 0;
  the repro harness proving all seven `BUGS.md` Reproduce recipes (repro exit 0).

Reproduce locally:
```
# main (fixed): full suite green
git checkout main
rm -f prisma/vaultchain.db && npx prisma migrate deploy
pnpm typecheck && pnpm seed && npx tsx scripts/check-invariant.ts && pnpm smoke

# defects-planted (tag): all seven reproduce
git checkout v1-defects
rm -f prisma/vaultchain.db && npx prisma migrate deploy
pnpm typecheck && npx tsx scripts/repro-p1-defects.ts
```

## 5. Reviewer findings (code-reviewer charter) + triage

> Note: the harness does not expose the project's `.claude/agents/code-reviewer.md` as a
> dispatchable subagent type, so the review was run by a general-purpose agent carrying the
> code-reviewer charter verbatim, against `main` only. Findings reproduced below unedited.

**Triage outcome:** the reviewer found **0 Critical, 0 Major**, 5 Minor, 4 Nit. Per the
gate, only CRITICALs are auto-fixed → **nothing was changed and steps 1–2 were not re-run**
(no CRITICALs). All Minor/Nit items are left below for your decision, each with a disposition
I recommend but did **not** apply. The reviewer also independently re-ran the suite on `main`
(migrate + typecheck clean; `RECONCILIATION OK` across 48 wallets; `== SMOKE PASSED ==`) and
confirmed the unique indexes, half-even rounding table (0.5→0, 1.5→2, 2.5→2, 3.5→4, 4.5→4),
no `Date.now()` in domain logic, and obviously-fictional seed data.

### Findings (verbatim)

**Critical:** None. &nbsp; **Major:** None.

**Minor**
1. `src/routes/accounts.ts:26` — `POST /accounts` `assets` item schema diverges from the OpenAPI contract. Route declares `assets.items: { type: 'string' }` (no enum); `openapi/vaultchain.yaml:146` requires `enum: [BTC, ETH, GBPX]`. An unknown symbol isn't rejected at validation (400) as the spec implies; the handler loops and throws `notFound` → 404. Direction: add the enum to the route schema (400) or relax the spec — one source of truth.
2. `src/services/simulator.ts:101-104` — `forceTxOutcome('CONFIRMED')` can confirm a withdrawal that was never broadcast/debited (guard only rejects already-terminal states). Produces a physically impossible state + audit trail (`TRANSACTION_CONFIRMED` with no `TRANSACTION_BROADCAST`). Admin-only escape hatch, so arguably acceptable. Direction: restrict CONFIRMED force to `PENDING_CONFIRMATION` (mirror the FAILED path's `wasDebited` reasoning) or document intent.
3. `src/services/withdrawals.ts:190-227` — `attachTravelRule` doesn't validate that the tx actually requires Travel Rule and always writes both records; spurious records can accumulate on domestic/below-threshold transfers, weakening the audit signal. No gate break. Direction: reject (422) when not cross-VASP/below threshold, or note the permissiveness is intentional.
4. `src/services/withdrawals.ts:59-61` — idempotent-replay short-circuit skips the tenant/wallet ownership re-check. A CLIENT reusing another tenant's `idempotencyKey` receives that tenant's withdrawal object (200) — a cross-tenant read bypassing the 404-scoping discipline used everywhere else. Low likelihood (opaque keys). Direction: after fetching `existing`, re-assert `existing.wallet.account.clientId === actor.clientId` for CLIENT callers (404 otherwise).
5. `src/routes/webhooks.ts:64-74` — `GET /webhooks/deliveries` ignores the documented `cursor`/`limit` and returns unbounded `{items}` with no `nextCursor`, unlike every other list endpoint (spec-consistent, but inconsistent with the platform's own pagination convention). Direction: apply cursor pagination or drop the unused query params.

**Nit**
1. `services/webhooks.ts:35` / `simulator.ts:150` / `holds.ts:54` — `new Date()` for `deliveredAt`/`resolvedAt` **metadata** columns (not domain time; gating correctly uses `simNow`). A `Date.now()`-scanning reviewer will hit them; a one-line "wall-clock metadata" comment would preempt the question.
2. `routes/withdrawals.ts:110` / `routes/clients.ts:58` — CLIENT tenant filter uses `clientId ?? ''`; the fallback is dead (a CLIENT key always has a `clientId`). Empty-string sentinel is a slight smell.
3. `services/deposits.ts:86` — `creditDeposit` accepts `CREDITED` as a "creditable" input state (intentional: lets a replayed webhook fall through to the `ProcessedEvent` no-op). Correct; reads oddly; comment mitigates.
4. `scripts/smoke.ts:102-103` — dead probe: `GET /withdrawals` fetched into `depAfter`, immediately `void`-ed. One HTTP round-trip, no assertion; removable.

_No references to any real custody firm or real person were found._

### My recommended disposition (not applied — your call)

| # | Sev | Recommendation | Why |
|---|---|---|---|
| Minor 1 | ▲ **Fix on `main` before P2** | **Genuine spec/impl drift.** A P2 contract test asserting "invalid asset → 400" will legitimately go **red on `main`**, breaking the "main green" DoD. Either align the route (add enum → 400) or relax the spec. This is the one finding that affects the two-branch model. |
| Minor 4 | ▲ **Fix on `main`** (recommend) | Real **tenant-isolation** gap — same class as the platform's 404-scoping discipline. Low likelihood, but security-relevant; the 4-line ownership re-check is cheap. |
| Minor 2 | Defer / document | Admin-only simulator escape hatch; low blast radius. Small guard or a doc note in P2. |
| Minor 3 | Defer | No gate break; tighten with a 422 in P2 if desired. |
| Minor 5 | Defer | Cosmetic consistency; spec already matches the current shape. |
| Nits 1–4 | Optional | Cosmetic; batch into a P2 cleanup commit if wanted. |

I recommend **Minor 1** be resolved before P2 begins (it's the only finding that would break `main`'s green bar once contract tests exist) and **Minor 4** soon after — but I've left the working tree untouched pending your decision, as the gate requires.

### Post-review decisions (pre-P2 cleanup — applied)

Owner decisions on the findings above, executed as a single cleanup commit on `main`:
**Minor 1 fixed** (route `assets` enum aligned to the spec → 400 at validation; D18).
**Minor 4 fixed** (idempotent replay re-asserts tenant ownership, 404 on mismatch; D19 —
P2's authz matrix must include an idempotency-replay cross-tenant case).
**Nit 1 applied** ("wall-clock metadata, not domain time" comments at the three sites).
**Minors 2/3/5 + Nits 2–4 deferred** with one-liners in `docs/DEFERRED.md`.
Typecheck + smoke re-run appended to `docs/evidence/p1.txt`; `defects-planted` rebased and
`v1-defects` re-anchored; all seven repros re-verified post-cleanup.

## 6. Commands for you to run and poke the result

```
# 1. Fixed platform, one command per PRD §D.1 intent (server on :3000):
git checkout main
rm -f prisma/vaultchain.db && npx prisma migrate deploy && pnpm seed
pnpm start        # then hit the API with the seed-printed keys, e.g.:
#   curl -s localhost:3000/health
#   curl -s -H "x-api-key: vck_admin_0000000000000000" localhost:3000/me
#   curl -s -H "x-api-key: vck_operator_a_000000000000" localhost:3000/withdrawals | jq

# 2. Watch the compliance-relevant bug get caught (defect tag):
git checkout v1-defects
rm -f prisma/vaultchain.db && npx prisma migrate deploy
npx tsx scripts/repro-p1-defects.ts    # BUG-003: exact-threshold cross-VASP skips Travel Rule

# 3. Docker (on a Docker-enabled machine):
git checkout main && docker compose up --build   # then curl localhost:3000/health
```

## 7. Phase P1 Definition-of-Done check

- [x] Correct platform built first on `main`; defects planted last on `defects-planted`,
      one commit per `BUG-00x`, tag `v1-defects`.
- [x] `openapi/vaultchain.yaml` validates.
- [x] Seed runs deterministically; `/simulator` advances chain/clock.
- [x] **Typecheck passes on `main`; smoke passes (30/30); output captured to
      `docs/evidence/p1.txt`.**
- [x] Each defect's Reproduce recipe verified on the tag; captured to
      `docs/evidence/p1-defects.txt`.
- [x] Reviewer dispatched; **0 Critical / 0 Major** → no auto-fix, no re-run needed;
      5 Minor + 4 Nit listed in §5 with dispositions for your decision.

**STOP after P1 — do not begin P2.**
