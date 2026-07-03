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
