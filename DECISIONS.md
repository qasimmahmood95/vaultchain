# DECISIONS.md — ambiguity resolutions (smaller-scope choices)

Per the P1 working rules: where the PRD doesn't answer, make the smaller-scope choice,
record it here, continue. None of these change the API contract in `openapi/vaultchain.yaml`.

- **D1 — Admin UI deferred to P3.** PRD §C.2/P1 scopes P1 to the API/simulator/seeds;
  §A.5's server-rendered UI is first needed by the P3 UI journeys, so it (and the `eta`
  dependency) lands there.
- **D2 — Docker authored, not executed, in this environment.** Docker is not installed on
  the P1 build machine. `Dockerfile` + `docker-compose.yml` are written per PRD §D.1;
  evidence captures boot the server directly via `tsx`. Compose boot verification is a
  follow-up for a Docker-enabled environment (noted in the phase report).
- **D3 — pnpm installed via `npm i -g pnpm`.** Node 26 no longer bundles corepack; global
  install is the smallest working path. Version pinned in `package.json#packageManager`.
- **D4 — No separate DRAFT resting state.** PRD §A.4 labels creation "DRAFT →
  PENDING_APPROVAL"; a withdrawal is created directly in `PENDING_APPROVAL` (DRAFT is
  transient, both transitions audited as one creation event). "Cancel own draft" =
  cancel while still `PENDING_APPROVAL`.
- **D5 — SQLite URL is a literal** (`file:./vaultchain.db`, resolving under `prisma/`),
  so a fresh clone runs with zero env configuration. The file is gitignored.
- **D6 — Fees:** flat `WITHDRAWAL_FEE_BPS = 10` (0.1%) config constant, all assets;
  deposits are fee-free. Fee is debited (own ledger row) at `BROADCAST` alongside the
  amount. Half-even rounding on integer minor units per PRD §A.2.
- **D7 — Approval count below policy threshold = 1** (maker≠checker still enforced);
  at/above `thresholdMinor` the policy's `approvalsRequired` distinct non-maker approvers.
- **D8 — requiredConfirmations:** BTC 3, ETH 12, GBPX 1 (seeded on the Asset rows).
- **D9 — Allowlist cooling-off = 24h of sim-clock time** (`COOLING_OFF_MS`), constant.
- **D10 — Webhook deliveries are recorded locally and marked DELIVERED immediately**; no
  outbound HTTP (PRD §C.1 non-goal). Retry/backoff surfaces as simulator-driven `attempts`
  increments; `delay` marks deliveries PENDING until the sim clock passes the delay.
- **D11 — Screening default CLEAN;** `POST /simulator/screening/next` queues the next
  decision (consumed once). One queue, applies to whichever screening runs next.
- **D12 — Address normalization is lowercase/trim comparison** (ETH lowercased; BTC/GBPX
  trimmed). Full EIP-55 checksum *verification* is P2+ test-layer material, not platform
  scope.
- **D13 — Response-body validation deferred to the P2 contract layer.** Fastify validates
  request bodies/params at runtime; response shape enforcement is exactly the contract
  suite's job (PRD §B.3) and is not duplicated in the platform.
- **D14 — Forced failure after broadcast refunds** amount + fee (compensating CREDIT
  ledger rows, audited) so the reconciliation invariant survives simulator-forced FAILED.
- **D15 — Runtime is `tsx` (no build/dist step) in P1.** Smallest thing that boots; a
  compiled build is not needed until something consumes the platform as a package (never,
  per non-goals).
- **D16 — `GET /clients` for a `client` role returns only its own client** (self-scoped
  list), matching the §A.4 note "read scoped for client".
- **D17 — `POST /accounts` auto-creates a default approval policy** (threshold 100000
  minor, 2 approvals, maker≠checker) so no account can exist without maker-checker
  controls, and the pure-API smoke can exercise dual approval without touching the DB.
  There is deliberately no policy-management endpoint in P1 (§A.4 doesn't list one).
- **D18 — Route schemas mirror the OpenAPI contract; the spec is the source of truth.**
  The `POST /accounts` `assets` enum was missing from the route schema (unknown symbols
  reached the handler and 404'd instead of rejecting 400 at validation). Caught by the
  P1 fresh-eyes review **before the P2 contract suite existed** — exactly the drift class
  the contract layer is built to catch, and now part of that layer's rationale: the Zod
  schemas re-encode the spec independently so this divergence fails a test, not a review.
- **D19 — Idempotent replays are tenant-scoped.** `POST /withdrawals` with a reused
  `idempotencyKey` re-asserts wallet ownership for CLIENT callers (404 on mismatch)
  instead of returning another tenant's withdrawal by key. **P2's authz matrix must
  include an idempotency-replay cross-tenant case** so this stays pinned by a test.
- **D20 — P2's `setup` project writes `.auth/identity.json`, not browser storageState.**
  §B.2's storageState is a UI-login artifact; no UI exists until P3. The setup project
  verifies every role key against `/me` and persists the resolved identities — the API-key
  analogue. Browser storageState lands in P3 with the login page.
- **D21 — Time-sensitive assertions live only in the serialized `workflow` project.** The
  sim clock/block height are platform-global; running clock-dependent assertions in
  parallel is exactly the shared-state flake source §B.6 bans. Serialization is enforced
  **in playwright.config.ts** (`workers: 1` on the workflow project — supported since
  Playwright's per-project workers), so every invocation path is safe, not just the npm
  scripts. Additionally the workflow project **depends on contract**, so a single bare
  invocation never interleaves contract's clock jumps with workflow's time-sensitive
  assertions. (Amended after P2 review CRITICAL-1: the original script-only `--workers=1`
  left `npx playwright test` unserialized and red; the project dependency closes the same
  hole across projects.) `pnpm test` is now just `playwright test`; fast workflow-only
  iteration: `--project=workflow --no-deps`. CI splits the projects into separate jobs
  anyway (§B.5).
- **D22 — The sim clock moves FORWARD ONLY during a suite run.** The `chain` fixture's
  teardown resets fault state only (webhook delay, queued screening) — never the clock —
  because a mid-run rewind would corrupt parallel workers. `chain.reset()` exists for
  explicit use. Corollary: builder-induced clock jumps are harmless to any test that
  doesn't assert on clock position.
- **D23 — No browser binaries in P2.** The API layers use request contexts only;
  `playwright install chromium` becomes a P3 prerequisite.
- **D24 — Per-client omnibus ledger attribution is NOT API-testable in P2, by design.**
  §A.4 deliberately exposes no ledger-entry endpoint, so the workflow suite asserts
  omnibus *lifecycle* behaviour only; the Σ(ledger)==balance invariant (including the
  seeded 5-client pool) is enforced by `scripts/check-invariant.ts`, which the phase
  evidence runs after the full suite. Direct attribution assertions become possible if a
  ledger read surface is ever added (that would be a PRD §A.4 contract change, not a test
  decision). Consequence: BUG-001's practical catch is the exact half-even fee assertion
  in `tests/workflow/money-precision.spec.ts` plus the post-suite invariant sweep — BUGS.md
  "Caught by" updated to match.
