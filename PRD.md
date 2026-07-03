# VaultChain — Product Requirements Document

> **⚠️ This is a deliberately FICTIONAL system.** "VaultChain" is a mock digital-asset
> custody platform built for one reason: to be a realistic **system-under-test** for a
> showcase-grade test-automation architecture. There is **no real blockchain, no real
> keys, no real money, and no real customers.** Regulatory details (FATF Travel Rule,
> maker-checker, wallet segregation) are modelled *generically and realistically* for
> testing purposes — they are **not legal advice** and do not claim jurisdictional
> accuracy. UK/FATF flavour is used because the author works in that space.

**The platform is the stage; the test suite is the star.** Every platform feature below
exists only to justify a specific testing pattern. If a feature does not earn its place by
enabling an interesting test, it is out of scope.

| | |
|---|---|
| **Author** | Senior SDET (~7 yrs regulated fintech / digital-asset custody) |
| **Purpose** | Portfolio piece demonstrating large-scale Playwright + TypeScript test architecture |
| **Audience** | *Layered.* Architecture-first for any senior SDET; a labelled domain deep-dive for fintech reviewers |
| **Platform stack** | TypeScript · Node 22 LTS · Fastify · SQLite via Prisma · Eta server-rendered views |
| **Test stack** | Playwright Test · TypeScript · Zod (contract schemas) · custom reporter · GitHub Actions |
| **Run everything** | `docker compose up -d && npx playwright test` |

---

## Table of contents

- [A. The Platform (mock, minimal, realistic)](#a-the-platform-mock-minimal-realistic)
- [B. The Test Architecture (the showcase)](#b-the-test-architecture-the-showcase)
- [C. Scope Discipline](#c-scope-discipline)
- [D. The Story](#d-the-story)
- [Appendix 1 — Research basis & sources](#appendix-1--research-basis--sources)
- [Appendix 2 — Glossary](#appendix-2--glossary)

---

# A. The Platform (mock, minimal, realistic)

## A.0 Design rule: every feature justifies a test

The platform is intentionally small. This table is the contract for scope creep — if a
proposed feature has no entry in the right-hand column, it does not get built.

| Platform feature | Testing pattern it exists to justify |
|---|---|
| Multi-asset amounts with per-asset decimals (BTC 8, ETH 18, GBPX 2) | Exact-money assertions; decimal/rounding boundary tests; ledger reconciliation invariant |
| Omnibus **and** segregated wallets | Balance-attribution tests; "sum of client ledgers == wallet balance" invariant |
| Deposit lifecycle w/ simulated confirmations | Deterministic async testing via a controllable fake-chain clock |
| Withdrawal lifecycle w/ dual approval | State-machine tests; **maker-checker** enforcement; concurrency/atomicity tests |
| Approval policies (threshold, N-of-M, maker≠checker) | Data-driven policy tests; role separation |
| Address allowlist + cooling-off window | Time-dependent logic tests (fake-clock fixture); normalization edge cases |
| Compliance (screening) holds | Workflow gating; authz on release; audit completeness |
| Travel Rule data exchange above threshold | **Boundary testing** at the threshold; the `@compliance` gate |
| Append-only audit log | Audit-completeness assertions; observability-as-contract |
| API-key roles (client/operator/compliance-officer/admin) | Authorization matrix; tenant-isolation (IDOR) tests |
| Webhook stubs (signed, retryable) | Idempotency tests; async delivery with simulator replay/delay |
| `/simulator` control plane | The hooks that make **all** of the above deterministic |

## A.1 Domain model

```
Client ──1:N── Account ──1:N── Wallet ──1:N── Transaction
  │               │                              │
  │               ├── ApprovalPolicy             ├── Approval (N per withdrawal)
  │               ├── AllowlistedAddress         ├── ComplianceHold
  │               └── (segregationModel)         └── TravelRuleRecord
  │
ApiKey (role) ──> Client (client-scoped) | global (operator/compliance/admin)
AuditLogEntry (append-only, references any entity)
WebhookSubscription ──1:N── WebhookDelivery
ChainState / SimulatorState (single-row control plane)
```

### Entities (fields abbreviated; full shapes live in `prisma/schema.prisma`)

- **Client** — `id`, `legalName`, `type` (INDIVIDUAL | INSTITUTION), `jurisdiction`,
  `vaspId?` (for Travel Rule counterparties), `status`, `createdAt`. *A VASP-style
  institutional client or an individual.*
- **Account** — `id`, `clientId`, `label`, `segregationModel` (SEGREGATED | OMNIBUS),
  `status`. Segregation is set at account level and dictates how wallet balances map to
  client ledgers.
- **Asset** — `symbol` (BTC | ETH | GBPX), `name`, `decimals` (8 | 18 | 2),
  `chain` (mock), `minWithdrawal`, `requiredConfirmations`. **GBPX** is a fictional mock
  GBP-pegged stablecoin.
- **Wallet** — `id`, `accountId`, `assetSymbol`, `segregationModel`, `depositAddress`,
  `balanceMinor` (integer minor units, stored as string). An omnibus wallet is shared;
  a segregated wallet belongs to one client's ledger 1:1.
- **LedgerEntry** — `id`, `walletId`, `clientId`, `direction` (CREDIT | DEBIT),
  `amountMinor`, `txId`, `createdAt`. The per-client sub-ledger that makes omnibus
  attribution testable. **Invariant:** `Σ(ledger for wallet) == wallet.balanceMinor`.
- **Transaction** — `id`, `walletId`, `type` (DEPOSIT | WITHDRAWAL), `assetSymbol`,
  `amountMinor`, `feeMinor`, `state`, `counterpartyAddress`, `counterpartyVaspId?`,
  `confirmations`, `idempotencyKey?`, `createdAt`, `updatedAt`. State machines in §A.3.
- **ApprovalPolicy** — `id`, `accountId`, `assetSymbol?`, `thresholdMinor`,
  `approvalsRequired` (N), `makerCannotCheck` (bool). Above `thresholdMinor`, a
  withdrawal needs `approvalsRequired` distinct approvers, none of whom is the maker.
- **Approval** — `id`, `transactionId`, `approverApiKeyId`, `approverRole`, `decision`
  (APPROVE | REJECT), `createdAt`. Uniqueness `(transactionId, approverApiKeyId)` is
  part of the *intended* design (see planted defect BUG-002).
- **AllowlistedAddress** — `id`, `accountId`, `assetSymbol`, `address`, `label`,
  `addedByApiKeyId`, `activatesAt` (cooling-off), `status`. Withdrawals may only target
  active allowlisted addresses.
- **ComplianceHold** — `id`, `transactionId`, `reason`, `state` (OPEN | RELEASED |
  REJECTED), `openedBy`, `resolvedBy?`, `createdAt`, `resolvedAt?`. Placed by screening;
  released only by a compliance-officer (intended).
- **TravelRuleRecord** — `id`, `transactionId`, `direction` (ORIGINATOR | BENEFICIARY),
  `payload` (JSON: name, accountRef, physical address, dateOfBirth — see §A.3.3),
  `createdAt`. Required for cross-VASP transfers at/above the threshold.
- **AuditLogEntry** — `id`, `actorApiKeyId?`, `actorRole?`, `action`, `entityType`,
  `entityId`, `before` (JSON), `after` (JSON), `createdAt`. **Append-only** (no update/
  delete route). Completeness is a `@compliance` assertion.
- **ApiKey** — `id`, `keyHash`, `role` (CLIENT | OPERATOR | COMPLIANCE_OFFICER | ADMIN),
  `clientId?` (set for CLIENT role → tenant binding), `status`.
- **WebhookSubscription** / **WebhookDelivery** — subscription `url`, `secret`,
  `events[]`; delivery `event`, `payload`, `signature` (HMAC-SHA256), `attempts`,
  `status`, `deliveredAt?`.
- **ChainState** (single row) — `blockHeight`, `simClockMs`, `frozen`, plus injected
  fault flags (see §A.7).

### The three assets and why they exist

| Symbol | Decimals | Role in the test story |
|---|---|---|
| **BTC** | 8 | Baseline UTXO-style asset; long confirmation counts for the fake-clock tests |
| **ETH** | 18 | Big-number handling; checksummed-vs-lowercase address normalization edge case |
| **GBPX** | 2 | Fiat-like stablecoin; the **decimal rounding** defect and Travel-Rule fiat threshold live here |

## A.2 Persistence & money representation

- **SQLite via Prisma.** Migrations under `prisma/migrations` tell a schema-evolution
  story; the typed Prisma client keeps handlers small. One file DB (`vaultchain.db`) or
  in-memory for unit-speed runs.
- **Money is never a float in storage.** Amounts are persisted as **integer minor units**
  in a string column, interpreted using the asset's `decimals`. A single `MoneyService`
  owns all string↔minor-unit conversion and rounding. *(This is the blast radius for the
  planted rounding defect — see `BUGS.md` / BUG-001.)*
- **Determinism first.** No `Date.now()` in domain logic — time comes from `ChainState.
  simClockMs` (see planted defect BUG-004 for the one place it doesn't, on purpose).

## A.3 Lifecycles (state machines)

### A.3.1 Deposit

```
DETECTED ──> PENDING_CONFIRMATION ──(confirmations ≥ required)──> SCREENING
                                                                    │
                                              (clean) ──> CREDITED  │
                                              (flag)  ──> HELD ──(release)──> CREDITED
                                                              └────(reject)──> REJECTED
```
- Confirmations advance **only** via the simulator (`POST /simulator/chain/advance`),
  never wall-clock. Credit writes a `LedgerEntry` and an `AuditLogEntry`.
- Idempotency: a deposit is credited **exactly once** per on-chain event, keyed by
  `(walletId, chainTxRef)`. *(Blast radius for BUG-007, webhook double-credit.)*

### A.3.2 Withdrawal

```
DRAFT ──> PENDING_APPROVAL ──(N distinct approvals, maker≠checker)──> APPROVED
   │             │                                                       │
   │             └──(reject / expire)──> REJECTED / EXPIRED              ▼
   │                                                              TRAVEL_RULE_CHECK
   │                                                     (payload present if ≥ threshold)
   │                                                                     │
   └──(cancel)──> CANCELLED                                              ▼
                                                                     SCREENING
                                                         (clean)──> BROADCAST ──> PENDING_CONFIRMATION
                                                         (flag) ──> HELD                    │
                                                                                (conf ≥ req)▼
                                                                                        CONFIRMED
                                                                     (sim fault)──> FAILED
```
Gates, in order: **allowlist** (target must be active) → **approval policy**
(threshold, N approvals, maker≠checker) → **Travel Rule** (payload required at/above
threshold for cross-VASP) → **screening** → broadcast → confirmations.

### A.3.3 Travel Rule (generic-realistic model)

Modelled on FATF Recommendation 16 / the "Travel Rule" as commonly implemented by VASPs.
Kept generic; thresholds and fields are illustrative for testing, not a compliance spec.

- **Threshold:** transfers whose fiat-equivalent value is **at or above 1,000** to/from
  **another VASP** require a Travel Rule data exchange. Below the threshold, only reduced
  data is required. **GBPX is fiat-pegged 1:1**, so a GBPX amount *is* its own
  fiat-equivalent — no conversion is applied.
- **Mock fiat rate (decided): a fixed constant, not simulator-controllable.** BTC/ETH
  fiat-equivalents use a hard-coded `MOCK_FIAT_RATES` config (illustratively BTC = 60,000
  GBPX, ETH = 3,000 GBPX, GBPX = 1). Rationale (per §A.0): a movable rate would need its
  own justifying test pattern, and the Travel-Rule boundary tests use **GBPX directly**
  (below), so it earns none — a movable rate would add surface without a showcase pattern.
  A future rate-driven suite would be a roadmap item, not current scope.
- **Originator data (required at/above threshold):** name, account/wallet reference,
  physical address (or, where permitted, an alternative such as date of birth).
- **Beneficiary data (required at/above threshold):** name, account/wallet reference.
- **The planted boundary defect (BUG-003)** lives exactly here: `> 1000` where the policy
  is "at or above" → a transfer of *exactly* the threshold slips through without a
  `TravelRuleRecord`. This is what the `@compliance` gate is designed to catch.
  **Independence:** the boundary triplet exercises this in **GBPX** (1:1, no rate and no
  fee/rounding path), so BUG-003 is catchable regardless of BUG-001's state — see the
  Independence notes in `BUGS.md`.

## A.4 REST API (OpenAPI 3.1, contract-first)

**The spec is the contract.** `openapi/vaultchain.yaml` (OpenAPI 3.1) is hand-authored and
is the **source of truth**. Fastify route schemas validate requests/responses at runtime;
the **contract test layer independently re-encodes the spec as Zod schemas**, so
implementation drift is caught by an independent oracle rather than a shared type. *(This
independence is deliberate — a single generated type couldn't detect a spec/impl mismatch.)*

- **Auth:** header `X-Api-Key: <key>`. Four roles: `client`, `operator`,
  `compliance-officer`, `admin`. `client` keys are tenant-bound to one `clientId`.
  No OAuth, no sessions, no password flows (see Non-Goals, §C.1).
- **Errors:** RFC 9457 `application/problem+json` with a stable `type`/`title`/`status`.
- **Pagination:** cursor-based (`?cursor=&limit=`) on list endpoints.

### Endpoint map (role = minimum role required)

| Method & path | Role | Purpose |
|---|---|---|
| `GET /health` | – | Liveness |
| `GET /me` | any | Resolve caller's role / client binding |
| `POST /clients` · `GET /clients` · `GET /clients/{id}` | admin / operator | Client CRUD (read scoped for `client`) |
| `POST /accounts` · `GET /accounts/{id}` | operator / owner | Account create & read (**tenant-scoped**; authz-matrix + isolation cases) |
| `GET /accounts/{id}/wallets` · `GET /wallets/{id}` | owner / operator | Wallet & balance read |
| `POST /accounts/{id}/allowlist` · `GET .../allowlist` · `DELETE .../allowlist/{addrId}` | operator | Manage allowlist (cooling-off, BUG-004) |
| `POST /wallets/{id}/deposits/simulate` | operator | Register an inbound deposit (sim only) |
| `POST /withdrawals` | client / operator | Create withdrawal (DRAFT → PENDING_APPROVAL) |
| `GET /withdrawals` · `GET /withdrawals/{id}` | owner / operator | Read / search |
| `POST /withdrawals/{id}/approvals` | operator / admin | Approve or reject (maker≠checker, BUG-002) |
| `POST /withdrawals/{id}/cancel` | client / operator | Cancel own draft |
| `POST /withdrawals/{id}/travel-rule` | operator / compliance-officer | Attach originator/beneficiary payload |
| `GET /holds` · `GET /holds/{id}` | compliance-officer / operator | Screening hold queue |
| `POST /holds/{id}/release` · `POST /holds/{id}/reject` | **compliance-officer** | Resolve a hold (authz, BUG-005; audit, BUG-006) |
| `GET /audit` | compliance-officer / admin | Query the append-only audit log |
| `POST /webhooks/subscriptions` · `GET .../subscriptions` | operator | Manage webhook stubs |
| `POST /simulator/...` | admin (dev/test only) | Control plane, see §A.7 |

### Webhook stubs

- Events: `deposit.detected`, `deposit.credited`, `withdrawal.approved`,
  `withdrawal.broadcast`, `withdrawal.confirmed`, `hold.opened`, `hold.released`.
- Delivery is signed (`X-VaultChain-Signature: sha256=…` HMAC over the raw body),
  recorded in `WebhookDelivery`, and **retried with backoff**. The simulator can force a
  **duplicate** or **delayed** delivery — the hook for idempotency tests (BUG-007).

## A.5 Admin UI (thin, server-rendered, deliberately plain)

Server-rendered with Fastify + Eta templates and a few lines of vanilla progressive
enhancement. **No React/Vue/framework, no build step for the UI.** It exists only to give
the UI test layer a small, meaningful surface. Exactly four screens:

1. **Login** — paste an API key; sets an httpOnly cookie mirroring the key's role. (Not a
   real auth flow — see Non-Goals.)
2. **Approval queue** — withdrawals in `PENDING_APPROVAL`; approve/reject buttons that
   respect maker≠checker. *The* screen for the UI journey that must be UI.
3. **Transaction search** — filter by client, asset, state, date; paginated results.
4. **Transaction detail** — read-only timeline (states + audit entries) and, for holds, a
   compliance-officer release/reject control.

Design is intentionally spartan (semantic HTML, `data-testid` attributes everywhere, no
CSS framework). The point is *testability*, not polish.

## A.6 Seeded realism

- **`scripts/seed.ts`** — deterministic (fixed RNG seed) so every run is reproducible.
  Generates: ~8 clients (mix of individuals + institutional VASP counterparties), ~20
  accounts (both segregation models), wallets across all three assets, ~300 historical
  transactions in assorted terminal + in-flight states, allowlist entries (some still in
  cooling-off), a handful of open holds, and a complete back-fill of audit entries.
- **`scripts/seed-demo.ts`** — a smaller, hand-curated dataset that stages each planted
  defect's preconditions so the §D.2 walkthrough runs on the `v1-defects` tag in one command
  (`git checkout v1-defects && npm run demo`; red gate — `main` stays green).
- **Intentional edge cases** (legit tricky data the suite must handle *correctly* — these
  are **not** bugs): ETH checksummed vs lowercase addresses; dust/zero-value amounts;
  18-dp ETH big numbers; an omnibus wallet shared by 5 clients; duplicate-`idempotencyKey`
  withdrawal retries; Unicode client names for UI search; pagination on exact page
  boundaries; a transfer of *exactly* the Travel Rule threshold.
- **Planted defects** are documented in the **gitignored `BUGS.md`** (the answer key) and
  are committed to the long-lived **`defects-planted`** branch (immutable tag
  **`v1-defects`**) — **never to `main`**, which carries the fixed platform. Run against the
  tag, the suite catches them; the README walks through one (BUG-003) without spoiling the
  rest. See the branch model in §C.0.

## A.7 Simulation controls (`/simulator`)

The control plane that makes async, time-, and chain-dependent flows **deterministic**.
Enabled only when `VAULTCHAIN_ENV != production` and guarded behind the `admin` role.

| Endpoint | Effect |
|---|---|
| `POST /simulator/chain/advance` `{blocks}` | Advance block height / confirmations by N |
| `POST /simulator/clock/set` `{ms}` · `/clock/freeze` | Set or freeze the simulated clock |
| `POST /simulator/tx/{id}/force` `{outcome}` | Force a transaction to `CONFIRMED`/`FAILED` |
| `POST /simulator/screening/next` `{outcome}` | Make the next screening decision clean/flag |
| `POST /simulator/webhooks/{id}/replay` | Re-deliver a webhook (idempotency probe) |
| `POST /simulator/webhooks/delay` `{ms}` | Delay all deliveries by N ms |
| `POST /simulator/reset` | Reset chain/clock/fault state (not the DB) |

These endpoints are the reason the async tests need **zero arbitrary `sleep()`** — the
suite advances the world explicitly and asserts on the resulting state.

---

# B. The Test Architecture (the showcase)

> This is the actual deliverable. The platform above is scaffolding; everything below is
> the point.

## B.0 Principles

1. **API-first.** State is created via API/DB, not through the UI. The UI layer tests only
   what *must* be exercised through a browser.
2. **Determinism over waiting.** No `waitForTimeout`. Async flows are driven by the
   simulator; assertions are on explicit state.
3. **Independence.** No shared mutable state between tests. Each test seeds and owns its
   data (unique client/account per test via factories).
4. **Layers are independently buildable.** Suites share **nothing but `fixtures/`** — so
   the four suites can be built by four parallel agents/sessions without merge collisions.
5. **Compliance is a gate, not a suite.** `@compliance`-tagged tests run as a **separate,
   required** CI job with a dedicated human-readable report.

## B.1 Repository layout

```
vaultchain/
├─ src/                      # the platform (Phase P1) — owned, not shared with test layers
├─ prisma/                   # schema + migrations
├─ openapi/vaultchain.yaml   # the contract (source of truth)
├─ scripts/{seed,seed-demo}.ts
├─ tests/
│  ├─ fixtures/              # ← the ONLY cross-layer shared code (Phase P2, built FIRST)
│  │  ├─ auth.fixtures.ts        # role-based API keys + UI storageState
│  │  ├─ builders/               # data-builder factories (client, account, withdrawal…)
│  │  ├─ api-client.ts           # typed thin wrapper over APIRequestContext
│  │  ├─ chain-clock.fixture.ts  # fake-chain time control (wraps /simulator)
│  │  ├─ world.fixture.ts        # composes the above via mergeTests
│  │  └─ index.ts                # single import surface: `import { test, expect } from '../fixtures'`
│  ├─ contract/             # API contract tests (Zod)          — parallel-buildable
│  ├─ workflow/             # API workflow / lifecycle tests    — parallel-buildable
│  ├─ ui/                   # thin UI journeys                  — parallel-buildable
│  └─ compliance/           # @compliance gate suite           — parallel-buildable
├─ reporters/compliance-reporter.ts
├─ .claude/agents/          # the repo's own auditor panel (§D.3)
├─ .github/workflows/ci.yml
├─ playwright.config.ts
├─ docker-compose.yml
├─ README.md
└─ BUGS.md                  # gitignored answer key
```

## B.2 Fixtures (Phase P2 — built FIRST, before any suite)

Fixtures are the shared foundation and the reason the four suites don't collide. They are
composed with **`mergeTests`** so each concern is an independently-owned module.

- **Role-based auth (`auth.fixtures.ts`).** Worker-scoped fixtures yielding an
  `APIRequestContext` per role (`asClient`, `asOperator`, `asComplianceOfficer`,
  `asAdmin`) with the `X-Api-Key` header pre-set. For UI, a **`setup` project** logs each
  role in once and saves `storageState`, which UI tests reuse — no repeated logins.
- **Data-builder factories (`builders/`).** `aClient()`, `anAccount({segregation})`,
  `aWithdrawal({amount, asset, aboveThreshold})` etc. — fluent builders that seed via the
  API and return typed handles. Every builder namespaces its data (unique labels) so tests
  are isolated by construction.
- **API-first seeding.** Builders hit the real API (or Prisma for speed where no endpoint
  exists), so setup exercises the same paths users do and stays fast.
- **Fake-chain time control (`chain-clock.fixture.ts`).** A test-scoped fixture exposing
  `chain.advance(blocks)`, `chain.setClock(ms)`, `chain.freeze()`, `chain.replayWebhook()`
  — thin wrappers over `/simulator`, auto-reset in teardown. **This fixture is what makes
  the async suites deterministic.**
- **Composition (`world.fixture.ts` / `index.ts`).** `mergeTests(authTest, dataTest,
  chainTest)` → a single `test`/`expect` every suite imports. TypeScript infers all
  fixture types, so suites get autocomplete on `asOperator`, `chain`, builders, etc.

## B.3 The four suites

| Suite | Runs via | What it proves | Notably does **not** |
|---|---|---|---|
| **`contract/`** | API | Every response matches the spec (Zod schemas re-encode `openapi.yaml`); status codes, error shapes, pagination envelopes, enum domains | Test business logic |
| **`workflow/`** | API | Full lifecycles end-to-end: deposit→credit, withdrawal→dual-approval→broadcast→confirm, holds, allowlist cooling-off, idempotency, ledger reconciliation invariant | Touch the UI |
| **`ui/`** | Browser | Only journeys that *must* be UI: login, **approve from the queue**, **transaction search**. Uses API-seeded state; asserts the rendered timeline + audit entries | Re-test API logic through the DOM |
| **`compliance/`** (`@compliance`) | API (+1 UI check) | Travel-Rule payload present for **all** transfers at/above threshold; dual-approval + maker≠checker enforced; **segregation of duties** (hold resolution restricted to compliance-officer); **audit-log completeness** for every state-changing action | — |

**Contract layer detail.** Each response schema is a Zod object; a custom
`expect(...).toMatchSchema(schema)` matcher validates and pretty-prints diffs. Because the
schemas are authored independently from the server types, a field the server drops or
renames (spec drift) fails the contract layer — the job the `contract-drift` auditor agent
also polices statically (§D.3).

**Compliance layer detail.** These tests encode the *rules*, not just examples:
boundary triplets around the Travel-Rule threshold (`T-1`, `T`, `T+1`); a concurrency
probe firing two approvals via `Promise.all` to assert maker≠checker holds under race; a
segregation-of-duties check that only a `compliance-officer` may resolve a hold; and a
lifecycle-completeness sweep asserting an `AuditLogEntry` (with actor + before/after)
exists for **every** transition. This suite is designed to fail loudly on
BUG-002/003/005/006 — BUG-005's **primary** catch is the P2 contract authz-matrix, re-asserted
here as deliberate defence-in-depth (not double-counting).

## B.4 Playwright configuration

```ts
// playwright.config.ts (sketch)
export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,      // see flake policy §B.6 (UI only in practice)
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['blob'],                            // for shard merge in CI
    ['./reporters/compliance-reporter.ts'],
  ],
  use: { trace: 'on-first-retry', baseURL: process.env.BASE_URL },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },        // API-key → storageState
    { name: 'contract',   testDir: 'tests/contract',   dependencies: ['setup'] },
    { name: 'workflow',   testDir: 'tests/workflow',   dependencies: ['setup'] },
    { name: 'ui',         testDir: 'tests/ui',         dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'] } },
    { name: 'compliance', testDir: 'tests/compliance', dependencies: ['setup'],
      grep: /@compliance/ },
  ],
});
```

Rationale: **projects** isolate the layers and let CI target them individually; the
**`setup` project** produces auth state once; **`blob`** enables shard-merge; the
**custom reporter** emits the compliance gate summary (§B.5).

## B.5 CI (GitHub Actions)

Jobs, with the compliance gate as a **separate required job** and a merge step that
stitches sharded blobs into one HTML report.

```
lint ─┐
      ├─> typecheck ─┬─> api-contract ───────────────┐
                     ├─> api-workflow ───────────────┤
                     ├─> ui (matrix: shard 1..4) ─────┼─> merge-reports ─> pages artifact
                     └─> compliance-gate  (REQUIRED) ─┘        │
                              │                                └─> gate-summary artifact
                     (custom reporter → human-readable gate summary)
```

- **`lint`** — ESLint incl. `@typescript-eslint/no-floating-promises` (catches missing
  `await` before Playwright calls).
- **`typecheck`** — `tsc --noEmit` across `src/` and `tests/`.
- **`api-contract` / `api-workflow`** — the two API projects; fast, no browser.
- **`ui`** — sharded via `strategy.matrix: { shard: [1,2,3,4] }` +
  `--shard=${{matrix.shard}}/4`, `fullyParallel`, Linux runners; uploads `blob-report/`.
- **`compliance-gate`** — **required** branch-protection check. Runs `--grep @compliance`,
  runs the custom reporter, and uploads `gate-summary.md`/`.html` as an artifact. A red
  gate blocks merge regardless of the other jobs.
- **`merge-reports`** — `needs` the shard job; downloads all blobs into `all-blob-reports/`
  and runs `npx playwright merge-reports --reporter html` → published to Pages.

### Custom reporter (`reporters/compliance-reporter.ts`)

Implements the Playwright `Reporter` interface — `onBegin`, `onTestEnd`, `onEnd` — to emit
a human-readable **compliance gate summary** (not just pass/fail): for each rule
(Travel-Rule coverage, dual-approval, audit completeness) it lists the assertions run, the
boundary cases exercised, and any gaps, then writes `gate-summary.md` + `.html`. `onEnd`
returns a promise (Playwright awaits it) so the file is flushed before the job finishes.

```ts
// sketch
class ComplianceReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) { /* bucket by @compliance rule tag */ }
  async onEnd(result: FullResult) { /* render gate-summary.{md,html}; return status */ }
}
export default ComplianceReporter;
```

## B.6 Flake-handling strategy (documented on purpose)

| Situation | Policy | Why |
|---|---|---|
| **API contract + workflow** | **0 retries.** A failure is a real failure. | These are deterministic by construction (simulator, no real network). Retrying would hide races like BUG-002. |
| **UI journeys** | **2 retries on CI**, trace `on-first-retry`. | Browser/render timing is the only legitimately non-deterministic layer; retries + trace triage beat chasing ghosts. |
| **`@compliance` gate** | **0 retries, required.** | A compliance assertion that only passes on retry is not passing. |
| **Known-flaky test** | Tag `@quarantine`, **excluded from required jobs**, tracked in `docs/quarantine.md` with an owner + exit criterion, run in a non-blocking nightly. | Quarantine is a holding pen with a deadline, never a graveyard. |
| **Any test needing `sleep`** | Rejected in review by the `flake-hunter` agent (§D.3). | Use the simulator/`chain` fixture instead. |

Exit criteria for quarantine: a fix PR that (a) reproduces the flake in a loop
(`--repeat-each=20`) red, then green, and (b) removes the tag. Anything in quarantine >2
weeks without progress is deleted, not carried.

---

# C. Scope Discipline

## C.0 Branch model (main = fixed, defects-planted = demo)

VaultChain uses **two long-lived branches** so a required CI gate and a bug-catching demo
can coexist without `main` ever being red:

- **`main` — the FIXED platform.** All seven defects are corrected here. The full suite,
  typecheck, and the **required `compliance-gate` job run green**. Branch protection and CI
  badges track `main`. This is the default clone experience.
- **`defects-planted` — the DEMO branch.** A protected, long-lived branch carrying the
  seven planted defects, with an **immutable tag `v1-defects`** at its tip. The *same* test
  suite, run here, goes **red** on each defect's target — this is what the README
  walkthrough (§D.2) shows. Its CI is expected-red and is **not** a branch-protection gate.
- **Keeping them in sync.** `defects-planted` is `main` **plus seven defect commits** (one
  per `BUG-00x`, see §C.2/P1). When platform or test code changes on `main`, rebase
  `defects-planted` onto `main` and re-cut the `v1-defects` tag, so the demo always reflects
  the current architecture with only the defects re-applied. The gitignored `BUGS.md` answer
  key doubles as the rebase checklist.

## C.1 Explicit non-goals

- **No real cryptography or blockchain.** Addresses are opaque strings; "confirmations"
  are a counter advanced by the simulator; no signing, no key management, no nodes.
- **No real user auth.** API keys only. No passwords, OAuth, sessions, MFA, or account
  recovery. The UI "login" just exchanges a key for a role cookie.
- **No production hardening.** No rate-limiting, secrets vaulting, HA, migrations rollback
  drills, or perf/load work. Security tests are limited to the **authorization matrix** and
  **tenant isolation** — appropriate for a functional test showcase, not a pentest.
- **No frontend framework / build.** Server-rendered HTML only; the UI is deliberately
  minimal and unstyled.
- **No third-party integrations.** No real screening vendor, no real Travel-Rule protocol
  (TRP/IVMS101 wire format is *modelled*, not implemented), no real webhooks endpoints —
  deliveries are recorded locally.
- **Not a compliance product.** Regulatory logic is generic-realistic for testing only.

## C.2 Phased build plan (sized for long autonomous sessions)

Each phase ends with a **Definition of Done that always includes: "full test suite and
typecheck pass on `main`, with terminal output captured to `docs/evidence/p1.txt`…`p4.txt`."**
Throughout, **green means green on `main`** (the fixed platform); the planted-defect demo
lives only on `defects-planted` / `v1-defects` (§C.0). **Evidence files under
`docs/evidence/` are committed deliberately** — they are part of the portfolio's verifiable
build history and are intentionally *not* gitignored.

### Phase P1 — Platform core + seed + simulator
Build the **correct** `src/` (Fastify app, Prisma schema + migrations, domain services, all
endpoints in §A.4), the `/simulator` control plane, both seed scripts, and
`openapi/vaultchain.yaml` — **on `main`, with the defects fixed**. Then, as the **final P1
step**, cut the **`defects-planted`** branch and plant the seven defects there as **one
commit per bug, each message referencing its `BUG-00x` ID**; tag the tip `v1-defects`.
`main` is never knowingly shipped with a planted defect.
- **DoD (on `main`):** server boots via `docker compose up`; `openapi.yaml` validates; seed
  runs deterministically; `/simulator` advances chain/clock; **typecheck passes**; a smoke
  script exercising one deposit + one withdrawal end-to-end is captured to evidence.
  Separately, `defects-planted` exists with seven labelled commits and the `v1-defects` tag.
  *(No Playwright suites yet — output captured is the smoke script + typecheck.)*

### Phase P2 — Fixtures, then API test layers (parallelisable)
**P2a (serial, first):** build everything in `tests/fixtures/` (§B.2) and the `setup`
project. **P2b (parallel):** with fixtures frozen, `contract/` and `workflow/` can be
built by **two independent agents/sessions** — they share only `fixtures/`.
- **DoD:** fixtures typecheck and are documented; `contract/` and `workflow/` **run green
  on `main`** (fixed platform) locally and in CI. The same suites, run against the
  `v1-defects` tag, go **red** on their target defects (BUG-001/004/005/007 — these four have
  the API layer as their **primary** catch; BUG-002/003/006 are the P4 gate's primaries, and
  BUG-005 is additionally **reinforced** there as defence-in-depth, not double-counting) — a
  quick cross-check that the bug-catching tests actually catch. **Full suite + typecheck pass on
  `main`, output captured.**

### Phase P3 — UI + journeys
Build `tests/ui/` (login, approval queue, transaction search) against API-seeded state and
the shared `storageState`. Add `data-testid`s to templates as needed.
- **DoD:** UI journeys run green and sharded in CI; traces attach on retry; **full suite +
  typecheck pass, output captured.**

### Phase P4 — Compliance gate + CI + README polish
Build `tests/compliance/`, the custom reporter, the full `.github/workflows/ci.yml`
(incl. the required gate job + shard merge), the `.claude/agents/` panel + CI review-gate
pattern (§D.3), and the README (§D.1).
- **DoD:** on `main`, `compliance-gate` is a **required check and is green**; run against
  the `v1-defects` tag it goes **red** on exactly the four `@compliance` cases — BUG-002
  (dual-approval), BUG-003 (Travel-Rule), BUG-005 (segregation of duties), BUG-006
  (audit-completeness) — with `gate-summary`
  showing the missing boundary case; the `gate-summary` artifact renders in
  both cases; the README's one-command run works from a clean clone of `main`, and the §D.2
  walkthrough works from the `v1-defects` tag; **full suite + typecheck pass on `main`,
  output captured.**

**Parallelism note for autonomous sessions:** the only ordering constraints are
P1 → P2a → {P2b, P3 partial} → P4. Because suites share nothing but `fixtures/`, P2b's two
API layers and P3's UI layer can each be a separate long session (or subagent) once
fixtures are frozen. This is the concrete reason for the "no shared files between layers"
rule in §B.0.

---

# D. The Story

## D.1 README outline (layered for both audiences)

1. **What this is** — a fictional custody platform that exists to be tested; the test
   architecture is the deliverable. Big bold **FICTIONAL** banner.
2. **Who it's for** — *architecture-first* pitch any senior SDET gets in 60 seconds…
3. **…then a labelled "Domain deep-dive (for fintech readers)"** — omnibus vs segregated,
   maker-checker, Travel Rule threshold, screening holds. Collapsible/clearly sectioned so
   non-domain readers can skip it.
4. **Run everything with one command** — `docker compose up -d && npx playwright test`
   (green on `main`); the §D.2 bug-catch demo runs on the tag: `git checkout v1-defects && npm run demo` (red gate).
5. **The architecture at a glance** — the four layers, the fixtures-only sharing rule, the
   simulator-for-determinism idea, the compliance gate. One diagram.
6. **"Watch it catch a real bug"** — the §D.2 walkthrough.
7. **The suite audits itself** — the `.claude/agents` panel + CI review gate (§D.3).
8. **Flake policy, CI, and how to read the reports** — links to `gate-summary` + merged
   HTML report.
9. **Scope & non-goals** — set expectations honestly (mirror §C.1).

## D.2 Walkthrough: one planted bug, caught (Travel-Rule off-by-one, BUG-003)

The README walks a reader through the crown-jewel catch, because it ties the domain to the
gate:

1. **The rule.** "A cross-VASP transfer whose value is **at or above 1,000** must carry
   originator + beneficiary Travel-Rule data before broadcast."
2. **The defect.** The withdrawal service checks `amountFiat > 1000` — strictly greater —
   so a transfer of **exactly 1,000** is allowed to broadcast with **no `TravelRuleRecord`**.
3. **The test that catches it.** In `tests/compliance/travel-rule.spec.ts`, a boundary
   triplet built with the data factory, **denominated in GBPX (1:1 fiat, no rate/rounding
   path — so this is independent of BUG-001)**: `T-1` (no payload required), `T` (payload
   required), `T+1` (payload required). The `T` case seeds a cross-VASP withdrawal at
   exactly the threshold, advances it toward broadcast via the `chain` fixture, and asserts
   a `TravelRuleRecord` exists. **It fails on `T`** — off-by-one exposed.
4. **How the reader runs it.** `git checkout v1-defects` (the immutable planted-defects
   tag), then `docker compose up -d && npx playwright test` (or `npm run demo`). The
   `compliance-gate` goes **red**; `gate-summary.md` shows *"Travel-Rule coverage: 2/3
   boundary cases — MISSING at threshold value T=1000"*; the trace/attachment shows the
   withdrawal reaching `BROADCAST` with no record. Back on `main` (defect fixed) the same
   run is green.
5. **The point.** The bug is a one-character boundary error in domain code; the value is
   an *independent, executable encoding of the rule* that fails precisely at the boundary —
   which is exactly what a compliance gate is for. (The README notes the other planted
   defects exist and are caught by their layers, without spoiling them.)

## D.3 The suite that audits itself — `.claude/agents` panel + CI review gate

VaultChain ships with its own adversarial reviewers: a small **panel** of custom Claude
Code subagents (in `.claude/agents/`, version-controlled and team-shareable) **plus a
documented CI-invoked review gate**. The narrative: *a test project mature enough to
distrust its own tests.*

**Two distinct agent sets live in `.claude/agents/`:** this **test-quality panel**
(`compliance-auditor`, `flake-hunter`, `contract-drift`, `assertion-critic`) is **portfolio
content** — part of what the repo demonstrates — whereas the two **build-process agents**
already present, **`code-reviewer`** and **`adversarial-auditor`**, are development tooling
used to *build* the repo. Phase P4 **adds the panel without modifying or removing** those
two existing agent files.

| Agent | Adversarial question it asks | Looks at |
|---|---|---|
| **`compliance-auditor`** | "Is every compliance rule actually asserted, at its boundary, by a `@compliance` test?" | `compliance/` vs the rules in this PRD; flags un-covered rules or example-only (non-boundary) tests |
| **`flake-hunter`** | "What here is non-deterministic?" | Bans `waitForTimeout`/`Date.now()` in tests, shared mutable state, order dependence, un-awaited promises |
| **`contract-drift`** | "Do the Zod contract schemas still match `openapi.yaml`?" | Diffs `contract/` schemas against the spec; flags fields present in one but not the other |
| **`assertion-critic`** | "Would this test pass even if the feature were broken?" | Hunts weak/absent assertions, `expect(true)`, snapshot-only checks, tests with no failing mode |

- **Local use:** `claude` with these agents run as a pre-PR panel; each returns findings
  ranked by severity, the main agent merges into one verdict (*Ready / Needs attention /
  Needs work*).
- **CI review gate (documented pattern):** a `.github/workflows/review.yml` job invokes a
  reviewer agent on PR diffs touching `tests/**`, posting findings as a PR comment. It is
  **advisory (non-blocking)** by default — documented that way deliberately, with a note on
  how to promote it to required once the team trusts its signal. The README is honest that
  this is a *pattern demonstration*, not a claim that an LLM should gate merges unattended.

The meta-point for reviewers: the repo doesn't just *have* tests — it encodes an opinion
about what good tests are, and enforces that opinion with its own tooling.

---

# Appendix 1 — Research basis & sources

Public sources consulted for domain and tooling realism (regulator publications, standards
bodies, vendor engineering blogs, and official Playwright/Claude Code docs). Regulatory
detail is kept generic; nothing here is legal advice.

**Custody domain — wallet segregation & operations**
- [Fidelity Digital Assets — The Omnibus Model for Custody](https://www.fidelitydigitalassets.com/research-and-insights/omnibus-model-custody)
- [Fortris — Omnibus vs segregated accounts in digital asset management](https://www.fortris.com/blog/omnibus-vs-segregated-account-digital-assets)
- [BitGo — Custodial wallets for institutions](https://www.bitgo.com/products/custody-wallets/)
- [DFNS — Core banking platform for digital assets](https://dfns.co/)
- [KPMG — Evaluating custody of digital assets (PDF)](https://kpmg.com/kpmg-us/content/dam/kpmg/frv/pdf/2022/hot-topic-evaluating-custody-of-digital-assets.pdf)

**FATF Travel Rule (Recommendation 16) — VASP originator/beneficiary data & thresholds**
- [FATF — Best Practices: Travel Rule Supervision, June 2025 (PDF)](https://www.fatf-gafi.org/content/dam/fatf-gafi/recommendations/Best-Practices-Travel-Rule-Supervision.pdf)
- [Sumsub — FATF Travel Rule: Crypto Compliance in 2026](https://sumsub.com/blog/what-is-the-fatf-travel-rule/)
- [Elliptic — What is the Travel Rule?](https://www.elliptic.co/blockchain-basics/what-is-the-travel-rule)
- [Mayer Brown — FATF Revises AML Standards for Certain Funds Transfers (2025)](https://www.mayerbrown.com/en/insights/publications/2025/08/fatf-revises-aml-standards-for-certain-funds-transfers)
- [21 Analytics — FATF Recommendation 16 update: Travel Rule data changes](https://www.21analytics.ch/blog/fatf-recommendation-16-updated/)
- [Moody's — FATF Recommendation 16: key insights for compliance](https://www.moodys.com/web/en/us/kyc/resources/insights/fatf-recommendation-16-possible-implications-and-data-insights-for-compliance.html)
- [Notabene — What is the Crypto Travel Rule?](https://notabene.id/crypto-travel-rule-101/what-is-the-crypto-travel-rule)

**Playwright + TypeScript test architecture (2026)**
- [Playwright — Best Practices](https://playwright.dev/docs/best-practices)
- [Playwright — Test sharding](https://playwright.dev/docs/test-sharding)
- [Playwright — Reporters](https://playwright.dev/docs/test-reporters) · [Reporter API](https://playwright.dev/docs/api/class-reporter)
- [Qaskills — Playwright fixtures: the complete advanced guide (2026)](https://qaskills.sh/blog/playwright-fixtures-advanced-guide)
- [BrowserStack — Getting started with Playwright and TypeScript in 2026](https://www.browserstack.com/guide/playwright-typescript)
- [Tim Deschryver — Playwright API testing with Zod](https://timdeschryver.dev/blog/playwright-api-testing-with-zod)
- [ScrollTest — API contract testing with Playwright: REST + UI in one test](https://scrolltest.com/api-contract-testing-playwright-rest-ui-one-test/)

**Claude Code subagents**
- [Claude Code Docs — Create custom subagents](https://code.claude.com/docs/en/sub-agents)

---

# Appendix 2 — Glossary

- **VASP** — Virtual Asset Service Provider; a regulated entity that transfers/custodies
  crypto on behalf of clients. Travel-Rule data is exchanged **between** VASPs.
- **Omnibus wallet** — one on-chain wallet pooling many clients' assets; per-client
  ownership tracked in the custodian's books (here, `LedgerEntry`).
- **Segregated wallet** — a wallet dedicated to a single client's assets.
- **Maker-checker (dual control)** — the maker who initiates an action cannot be a checker
  who approves it; high-value actions need N distinct approvers.
- **Travel Rule** — the requirement that originator/beneficiary information travel with a
  transfer at/above a value threshold (modelled here at 1,000 fiat-equivalent).
- **Compliance hold** — a screening-triggered pause on a transaction, resolved by a
  compliance officer.
- **Fake-chain clock / simulator** — the deterministic control plane that advances
  confirmations and time so async flows can be tested without waiting.
```
