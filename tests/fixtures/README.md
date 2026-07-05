# tests/fixtures — the ONLY cross-suite shared code

Suites (`contract/`, `workflow/`, later `ui/` and `compliance/`) import **only**
from here: `import { test, expect } from '../fixtures'`. No suite imports from
another suite or from `src/`. Fixtures are **frozen during P2b** — suite authors
report needed changes to the integrating session; they never edit this directory.

## Import surface (`index.ts`)

| Export | What it is |
|---|---|
| `test`, `expect` | The composed Playwright test (auth + chain + builders via `mergeTests`) |
| `ApiClient`, `API_BASE`, `ApiResult` | Thin typed wrapper over `APIRequestContext` |
| `ChainApi`, `ChainState` | Type of the `chain` fixture |
| `Build` + handle types, `PAST_COOLING_OFF_MS` | Type of the `build` fixture |

## Fixtures and their contracts

### Auth (worker-scoped `APIRequestContext` per role) — `auth.fixtures.ts`

`asAdmin`, `asOperatorA` (default **maker**), `asOperatorB` (default distinct
**checker**), `asCompliance`, `asClientA` (tenant: seed client #1, Aldgate),
`asClientB` (tenant: seed client #2, Wren & Hart — for cross-tenant probes),
`identities` (role → `{apiKeyId, role, clientId}`; written by the setup project).
Keys are the deterministic mock keys from `scripts/seed-lib.ts`; the server must
be seeded (the `webServer` command does this).

### `chain` (test-scoped) — `chain-clock.fixture.ts`

`state()`, `advanceBlocks(n)`, `advanceClockMs(ms)`, `setClockMs(ms)`,
`freeze()`, `queueScreening('CLEAN'|'FLAG')`, `replayWebhook(deliveryId)`,
`setWebhookDelayMs(ms)`, `reset()`.

**Clock convention (D21/D22): the sim clock/height are platform-global and move
FORWARD ONLY during a run.** Teardown auto-resets **fault state only** (webhook
delay → 0; queued screening → CLEAN if the test queued one). It never rewinds
the clock; `chain.reset()` is for explicit, deliberate use.
**Time-sensitive assertions** ("still inside cooling-off", "not yet confirmed")
belong **only in the workflow project**, which runs serialized (`--workers=1`).
Contract tests may cause clock jumps (via builders) but must never assert on
clock position.

### `build` (test-scoped) — `builders/index.ts`

Seeds via the **real API** (admin/operator contexts), namespaced by
`uniqueRef()` so parallel tests are isolated by construction:
`client()`, `account({assets, segregation, clientId?})` (accounts get the
platform's default dual-approval policy: threshold 1000.00, 2 approvals,
maker≠checker), `fundedWallet({asset, amount})` (deposit + 12 blocks →
credited), `activeAddress({accountId, asset})` (allowlist + clock past
cooling-off), `pendingAddress(...)` (still inside cooling-off),
`withdrawal({walletId, amount, address, vaspId?, idempotencyKey?})` (maker =
operator A → PENDING_APPROVAL).

**Value discipline:** builder defaults sit AWAY from rounding boundaries
(default withdrawal 1500.00 GBPX → exact 1.50 fee), so happy paths behave the
same on `main` and on the planted-defect branch. Boundary-probing values are
chosen explicitly by the test that needs them.

## Other rules for suite authors

- Never assert global counts or whole-table listings — the DB accumulates data
  across tests and local runs (`reuseExistingServer`). Scope queries to your
  own entities (e.g. `?walletId=`).
- Approvals: maker is operator A; use `asOperatorB` + `asAdmin` as the two
  distinct checkers.
- No `waitForTimeout`, no `Date.now()` in assertions — drive state via `chain`.
- The `setup` project must stay a dependency of every suite project.
