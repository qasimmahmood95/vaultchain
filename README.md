# VaultChain

> ## ⚠️ This is a deliberately FICTIONAL system
>
> "VaultChain" is a **mock** digital-asset custody platform. There is **no real
> blockchain, no real keys, no real money, and no real customers.** It exists for
> exactly one reason: to be a realistic **system-under-test** for the thing this
> repository is actually about — a **showcase-grade Playwright + TypeScript test
> architecture.** The platform is the stage; **the test suite is the star.**

[![compliance gate](https://img.shields.io/badge/compliance--gate-required-brightgreen)](.github/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-231%20green%20on%20main-brightgreen)](docs/evidence/)
[![fictional](https://img.shields.io/badge/platform-fictional-blue)](#9-scope--non-goals)

---

## 1. What this is

A small, realistic custody platform (deposits, withdrawals with dual approval, a
FATF-style Travel Rule, compliance holds, an append-only audit log) wrapped in a
four-layer Playwright test suite that treats **testing as the product**. Every
platform feature exists only to justify a specific testing pattern; if a feature
does not earn an interesting test, it is not built.

The repository ships with **seven planted defects on a separate branch** and a
test suite that catches them — including a compliance gate that fails loudly on a
one-character boundary bug. The `main` branch is the **fixed** platform: the full
suite and the required compliance gate run green.

## 2. Who it's for (architecture-first, 60 seconds)

If you are a senior SDET, here is the whole thing at a glance:

- **Four layers, one shared foundation.** `contract/` (Zod re-encodes the OpenAPI
  spec as an independent oracle), `workflow/` (end-to-end lifecycles), `ui/` (only
  the journeys that *must* be a browser), and a `@compliance/` **gate**. The four
  suites share **nothing but `tests/fixtures/`** — so they are independently
  buildable, and in fact were built by parallel agents.
- **Determinism over waiting.** No `waitForTimeout`, no `Date.now()` in tests. A
  `/simulator` control plane advances chain confirmations and a simulated clock;
  tests drive state explicitly and assert on the result.
- **Compliance is a gate, not a suite.** `@compliance`-tagged tests run as a
  separate, **required** CI job with a human-readable `gate-summary` report that
  names *which boundary case is missing* when it fails.
- **The suite distrusts itself.** A panel of version-controlled review agents
  (`.claude/agents/`) audits the tests for weak assertions, non-determinism, and
  contract drift, plus a documented CI review-gate pattern.

Jump to [the architecture](#5-the-architecture-at-a-glance) or
[watch it catch a real bug](#6-watch-it-catch-a-real-bug).

## 3. Domain deep-dive (for fintech readers)

<details>
<summary>Expand — omnibus vs segregated, maker-checker, Travel Rule, holds.</summary>

- **Omnibus vs segregated wallets.** An omnibus wallet pools many clients' assets
  under one on-chain address; per-client ownership is tracked in a `LedgerEntry`
  sub-ledger. A segregated wallet belongs to one client. The invariant
  `Σ(ledger for a wallet) == wallet.balance` must hold for **every** asset at all
  times — a reconciliation sweep enforces it after every suite run.
- **Maker-checker (dual control).** A withdrawal above policy threshold needs *N
  distinct* approvers, none of whom is the maker who created it. This is enforced
  atomically (a DB transaction plus a unique constraint), so it holds even when
  two approvals race.
- **Travel Rule.** Modelled on FATF Recommendation 16: a cross-VASP transfer whose
  fiat-equivalent value is **at or above 1,000** must carry originator and
  beneficiary data before it can broadcast. The threshold is inclusive — *exactly*
  1,000 counts. (Thresholds and fields here are illustrative for testing, not a
  compliance spec.)
- **Compliance (screening) holds.** Screening can pause a transaction in a hold
  that **only a compliance officer** may resolve (release or reject) — segregation
  of duties between operations and compliance.
- **Determinism.** Confirmations and time never come from the wall clock; they come
  from the `/simulator`, so async and time-dependent flows are testable without
  sleeping.

</details>

## 4. Run everything with one command

```bash
# The fixed platform — full suite green on `main`:
docker compose up -d && npx playwright test
```

Prefer no Docker? The suite boots the server itself:

```bash
pnpm install && npx prisma generate
npx playwright test        # boots a fresh-seeded server, runs all four layers
```

Watch the planted-defect demo on the immutable tag (see §6):

```bash
git checkout v1-defects
npm run demo               # the @compliance gate, standalone — goes RED
cat gate-summary.md        # names the missing boundary case
```

## 5. The architecture at a glance

```text
        tests/fixtures/  ← the ONLY cross-layer shared code
        (auth · builders · api-client · chain-clock · mergeTests)
                 │
   ┌─────────────┼─────────────┬───────────────┐
   ▼             ▼             ▼               ▼
contract/     workflow/       ui/          compliance/     ← @compliance GATE
(Zod vs        (lifecycles,   (only what    (rules at their
 OpenAPI)       reconciled)    must be UI)   boundaries)
   │             │             │               │
   └── fully     └── serialized (workers:1) ────┘
       parallel      global sim-clock state
                                 │
                         /simulator control plane
                   (advance chain · set/advance clock · force
                    outcomes · screening queue · webhook replay)
```

- **Layers share only `fixtures/`.** No suite imports another suite or `src/`. That
  is what let two agents build `contract/` and `workflow/` in parallel over a
  frozen fixture foundation.
- **The simulator is the determinism engine.** Every async flow is driven through
  it; the `chain` fixture wraps it and auto-resets fault state in teardown.
- **The contract layer is an independent oracle.** Its Zod schemas re-encode
  `openapi/vaultchain.yaml` by hand — never generated — so a spec/impl mismatch
  fails a test rather than passing silently. As of the strict-schema pass, the
  schemas are closed (`z.strictObject`) and the spec is closed to match
  (`additionalProperties: false`), so drift fails in **both** directions.
- **The compliance gate** runs last, serialized, and emits `gate-summary.md`/`.html`.

### Notes from the build (two true stories)

**The parallel-build model, under stress.** `contract/` and `workflow/` were built
by two independent agents over the frozen `fixtures/`. The workflow agent hit a
load-breaking fixture defect — a fixture used an identifier as its first parameter
where Playwright requires a destructuring pattern, so *every* fixtures import
threw. Per the territory rules it did **not** edit the frozen fixtures: it shimmed
locally, shipped green, and reported the defect back. The integrating session fixed
it on `main`, told the still-running contract agent to `git merge main`, then
de-shimmed the workflow suite (9 import lines repointed, shim deleted, 22/22
re-verified). Exactly the "no shared files between layers" independence model —
tested for real.

**The D26 saga — deleting the crutch exposed the race.** A P2 review flagged a
~150-line "robustness" helper that funds-dependent contract tests leaned on.
Deleting it exposed the race it had been quietly absorbing: the fixture's
clock-advance was a client-side read-modify-write, so *"a stale lower target
landing after a concurrent higher one could **rewind global time** past another
worker's cooling-off activation."* The fix was not a bigger crutch but a smaller
platform: a new atomic **`/simulator/clock/advance`** (a single DB transaction
that can never rewind). Two further carriers of the same class were then hunted
down empirically — `advanceChain`'s non-transactional clock write (now one
transaction) and an absolute `clock/set` shape test (relocated to the serialized
project) — and the class was eradicated, verified with exit-code-gated runs ×3.
The process slip that let the crutch exist in the first place is owned in
`DECISIONS.md` (D26), not hidden.

## 6. Watch it catch a real bug

The crown-jewel catch ties the domain to the gate: a **Travel-Rule off-by-one**.

1. **The rule.** A cross-VASP transfer whose value is **at or above 1,000** must
   carry originator + beneficiary Travel-Rule data before it can broadcast.
2. **The defect (on `v1-defects`).** The withdrawal service checks
   `amountFiat > 1000` — strictly greater — so a transfer of **exactly 1,000**
   slips through to broadcast with **no Travel-Rule record**.
3. **The test that catches it.** `tests/compliance/travel-rule.spec.ts` encodes the
   rule as a boundary triplet **denominated in GBPX** (1:1 fiat — no rate or
   rounding path, so the catch is independent of any money-precision bug):
   `T-1 = 999.99`, `T = 1000.00`, `T+1 = 1000.01`. The `T` case seeds a cross-VASP
   withdrawal at *exactly* the threshold and asserts it cannot leave
   `TRAVEL_RULE_CHECK` without the payload. **It fails at `T`.**
4. **What the reader sees.** On `v1-defects`, the compliance gate goes red and
   `gate-summary.md` names the missing boundary — this is the **real** output
   captured in [`docs/evidence/p4a-defects.txt`](docs/evidence/):

   ```text
   **GATE: RED** — 4 failing assertion(s) / 4 gap(s) across 9 assertion run(s).

   ## TR-16-BOUNDARY
   Travel Rule — originator + beneficiary data required at/above the 1000.00 fiat threshold
   - Status: **FAIL**
   - Assertions run: 3 (1 failed)
   - Travel-Rule coverage: 2/3 boundary cases — MISSING at T=1000.00
     - ✓ [T-1=999.99] … proceeds to broadcast without a Travel Rule record
     - ✗ [T=1000.00] … cannot leave TRAVEL_RULE_CHECK without originator AND beneficiary data
     - ✓ [T+1=1000.01] … gated identically — record required before broadcast

   ## Gaps
   - TR-16-BOUNDARY: control violated — MISSING at T=1000.00
   ```

5. **The point.** The bug is a one-character boundary error in domain code; the
   value is an *independent, executable encoding of the rule* that fails precisely
   at the boundary — which is exactly what a compliance gate is for. Back on `main`
   (defect fixed), the same run is green.

**The other planted defects** exist and are each caught by their own layer — a
rounding/reconciliation bug, a maker-checker concurrency bug, a cooling-off timing
bug, an audit-completeness omission, a webhook idempotency bug, and an
authorization gap that the role-matrix suite pins down — but this README walks
through only the Travel-Rule case, and does not spoil the rest.

## 7. The suite that audits itself

VaultChain ships its own adversarial reviewers — a small **panel** of
version-controlled Claude Code subagents in [`.claude/agents/`](.claude/agents/),
team-shareable, plus a documented CI review-gate pattern. The meta-point: a test
project mature enough to distrust its own tests.

| Agent | The adversarial question it asks |
|---|---|
| `compliance-auditor` | Is every compliance rule asserted **at its boundary**, not just by an example? |
| `flake-hunter` | What here is non-deterministic — timing, ordering, shared state, un-awaited promises? |
| `contract-drift` | Do the Zod schemas still match `openapi.yaml`, field for field, both directions? |
| `assertion-critic` | Would this test still pass if the feature were **broken**? |

Two build-process agents (`code-reviewer`, `adversarial-auditor`) also live there —
they are development tooling, kept distinct from the portfolio panel above.

**CI review gate.** [`.github/workflows/review.yml`](.github/workflows/review.yml)
runs a reviewer agent on PRs that touch `tests/**` and posts its findings as a
comment. It is **advisory / non-blocking by default**, and honestly so: this is a
demonstration of the *pattern*, not a claim that an LLM should gate merges
unattended. The file documents how to promote it to a required check once a team
trusts the signal.

## 8. Flake policy, CI, and how to read the reports

- **Flake policy.** API contract + workflow: **0 retries** — a failure is a real
  failure, and retrying would hide a race like the maker-checker bug. UI: 2 retries
  on CI with a trace on first retry (browser timing is the one legitimately
  non-deterministic layer). The `@compliance` gate: **0 retries, required** — a
  compliance assertion that only passes on retry is not passing.
- **CI** ([`ci.yml`](.github/workflows/ci.yml)) mirrors the layers as jobs: `lint`
  (ESLint + markdownlint) → `typecheck` → `api-contract`, `api-workflow`, `ui`
  (4-way shard), and `compliance-gate` (the **required** check) → `merge-reports`
  stitches the sharded UI blobs into one HTML report published to Pages. The
  serialized projects (`workflow`, `compliance`) are never sharded; each CI job is
  an isolated server (see `DECISIONS.md` D34).
- **Reading the reports.** `gate-summary.md` / `.html` bucket the compliance
  results by control and name any missing boundary. The merged Playwright HTML
  report carries traces for UI retries. Build evidence for every phase is committed
  under [`docs/evidence/`](docs/evidence/).

### Contention correctness under load (the perf layer)

The platform's whole correctness story — maker-checker CAS, exactly-once crediting,
the ledger invariant — is a claim about **concurrency**, so P5 added a perf layer that
pressure-tests exactly that, at N the functional suites never reach: volleys of up to
**512 simultaneous approval attempts** on one shared withdrawal (zero 5xx, zero
duplicate approvals, exactly two winners, and a measured **knee point** where extra
concurrency stops buying throughput), **60 seconds of sustained mixed load** followed by
the reconciliation invariant holding on every wallet, and a **read-path p95/p99
baseline** with cursor paging proven complete and duplicate-free at ~20k rows.
Thresholds live in [`perf/perf.config.json`](perf/perf.config.json), recorded baselines
in [`perf/baselines.json`](perf/baselines.json), and `pnpm perf` fails (exit ≠ 0) on any
hard violation or regression past the envelope. On SQLite behind a single-connection
pool these are deliberately **not** capacity numbers — [`PERFORMANCE.md`](PERFORMANCE.md)
says exactly what they do and don't mean, honesty first.

## 9. Scope & non-goals

**This is a fictional platform.** Names are obviously invented; the fiat rate and
Travel-Rule threshold are fixed, illustrative constants, not a compliance spec or
legal advice. What this repository deliberately **does not** demonstrate:

- **No real cryptography or blockchain.** Addresses are opaque strings;
  "confirmations" are a simulator counter; no signing, keys, or nodes.
- **No real auth.** API keys only — no passwords, OAuth, sessions, or MFA. The UI
  "login" just exchanges a key for a role cookie.
- **No production hardening.** No rate-limiting, secrets vaulting, or HA. The perf
  layer (§8, [`PERFORMANCE.md`](PERFORMANCE.md)) proves contention *correctness*, not
  capacity — no throughput or soak claims are made. Security testing is scoped to the
  authorization matrix and tenant isolation — appropriate for a functional test
  showcase, not a pentest.
- **No third-party integrations.** No real screening vendor, Travel-Rule wire
  protocol, or outbound webhooks — deliveries are recorded locally.
- **Not a compliance product.** The regulatory logic is generic-realistic for
  testing only.

What it *is* meant to demonstrate is on every other line of this file: a test
architecture with an opinion about what good tests are, and the tooling to enforce
that opinion.
