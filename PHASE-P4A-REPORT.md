# Phase P4a Report — Compliance gate suite + reporter

> **FICTIONAL system-under-test.** P4a delivers items 1–2 of the P4 scope only: the
> `tests/compliance/` gate suite and `reporters/compliance-reporter.ts`. CI, D25 strict
> schemas, the `.claude/agents` panel, and the README are **P4b** (separate session).
> **⚠ The reviewer dispatch was deliberately SKIPPED this phase** — see §5.

## 0. Precondition (gate zero, D28) — verified before any test was written

The D28 settlement compare-and-set was confirmed present on `main` by direct read:
`claimTransition` (state-guarded `updateMany`, winner-only audit) in
`src/services/transitions.ts`; `advanceChain` settles via CAS with only-raise
confirmations and `forceTxOutcome` runs its terminal check inside one `$transaction`
(`src/services/simulator.ts`); `screenAndSettleDeposit` CAS-claims
`PENDING_CONFIRMATION → SCREENING` and returns a boolean (`src/services/deposits.ts`);
`flushDueWebhooks` CAS-guards the `attempts` increment (`src/services/webhooks.ts`).
Nothing was missing; no compensation in tests was needed. The audit-completeness
assertions below (exact ordered trails = no-duplicates) lean directly on this.

## 1. What was built

### `tests/compliance/` — the `@compliance` gate suite (9 tests, 4 rule-encoding specs)

Wired as a `compliance` Playwright project: serialized (`workers: 1`), **last** in the
strict pipeline (`dependencies: ['setup', 'ui']`), `grep: /@compliance/`, retries
**0 explicitly** (§B.6: a compliance assertion that only passes on retry is not passing).
Browser-free (D30). Each test maps itself to a control via a static
`{ type: 'rule', description: '<CONTROL-ID>' }` annotation the reporter buckets on.

- **`travel-rule.spec.ts` (TR-16-BOUNDARY)** — the boundary triplet **denominated in
  GBPX** (1:1 fiat; no rate/fee path → independent of any money-precision defect):
  `T-1=999.99` proceeds to broadcast with **no** record and never enters
  `TRAVEL_RULE_CHECK`; `T=1000.00` and `T+1=1000.01` cannot leave `TRAVEL_RULE_CHECK`
  without originator **and** beneficiary data — an incomplete originator (no physical
  address/DoB) is 422 and does **not** open the gate. **Record contents asserted, not
  counts**: both directions present and every filed payload field round-trips exactly.
- **`dual-approval.spec.ts` (MC-DUAL-APPROVAL)** — the concurrency probe: one withdrawal
  above the policy threshold (N=2), then a single `Promise.all` volley of three
  simultaneous decisions — the **maker**, checker B, and **checker B again** — with no
  serializing awaits between the fires. Asserts volley statuses `[201, 403, 409]`,
  post-volley state still `PENDING_APPROVAL` with exactly ONE approval row, and the final
  approver set = exactly **N distinct non-maker** approvers after a legitimate second
  checker completes it. **Stress variant (D31)** = the same probe under
  `npx playwright test --project=compliance --no-deps --grep "dual approval" --repeat-each=10`
  (documented in the spec header; run green ×10 on `main`, see evidence).
- **`segregation-of-duties.spec.ts` (SOD-HOLD-RESOLUTION)** — asserts the RULE on **both
  surfaces**, as deliberate reinforcement of BUG-005's primary catch in the P2 authz
  matrix (defence-in-depth, not a matrix re-run): API — operator/admin/client are 403 on
  **release AND reject**, the hold verifiably still OPEN, then the compliance officer
  completes both lifecycles; UI — the real `/ui/holds/:id/resolve` form is driven with
  storageState request contexts (anon → login redirect; operator RELEASE and admin REJECT
  → error-flash redirect with the hold untouched; compliance resolves through the same
  form). The P3 stage-1 UI gating (D27) is thereby part of the pinned rule.
- **`audit-completeness.spec.ts` (AUD-COMPLETENESS)** — three scripted lifecycles asserting
  an `AuditLogEntry` with **actor + before/after** for **every** transition via **exact
  ordered sequence equality** — which simultaneously proves nothing is *missing* (the
  hold-release omission class) and nothing is *duplicated* (the concurrency class D28
  protects): deposit with a screening hold (`HOLD_OPENED`/`HOLD_RELEASED` both present,
  resolver identified, before/after exact); withdrawal through approval → Travel Rule →
  broadcast → confirmation (10-entry trail); simulator-forced FAILED after broadcast with
  the refund observed (balance restored) and `PENDING_CONFIRMATION → FAILED` audited.

### `reporters/compliance-reporter.ts` — the gate summary (§B.5)

Implements the Playwright `Reporter` interface (`onBegin`/`onEnd`, `onEnd` awaited so the
files flush; `printsToStdio() → false`). Buckets `@compliance` results by control ID and
writes **`gate-summary.md` + `gate-summary.html`** beside `playwright.config.ts`, listing
per control: assertions run, boundary cases exercised (from `{ type: 'boundary' }`
annotations), pass/fail, and **gaps** — controls with no passing evidence, unmapped
compliance tests, and named boundary misses (on the defect branch:
*"Travel-Rule coverage: 2/3 boundary cases — MISSING at T=1000.00"*, exactly the §D.2
walkthrough line). **Deterministic by design (D32)**: no wall-clock timestamps or
durations, stable location-based ordering — verified byte-identical across consecutive
full-pipeline runs. `flaky` counts as failing (§B.6). Writes nothing when no
`@compliance` test ran, so partial runs cannot clobber the last real gate artifact.

## 2. What was deferred (P4b — separate session)

- **CI** (`.github/workflows/ci.yml` incl. the required `compliance-gate` job + shard
  merge), **D25 strict schemas** (standing decision: `z.strictObject` + OpenAPI
  `additionalProperties: false` together, with the `contract-drift` agent), the
  **`.claude/agents` panel** (§D.3 — without modifying `code-reviewer` /
  `adversarial-auditor`), and the **README** (§D.1, BUG-003 walkthrough).
- **The P4a review itself** — see §5.

## 3. New DECISIONS.md entries (summary)

- **D30** — compliance project serialized LAST in the strict pipeline, browser-free; the
  §B.3 "+1 UI check" asserted at the HTTP layer via storageState request contexts.
  Corollary: the gate resolves actor identities via `/me` **at runtime**, never
  `.auth/identity.json` — DB ids are per-seed cuids, so `--no-deps` after a reseed (the
  defect-branch evidence protocol) would otherwise compare stale ids (found empirically:
  2 failures on the first `--project=compliance --no-deps` run, fixed at the root).
- **D31** — the dual-approval stress variant is a documented `--repeat-each` invocation of
  the SAME probe, keeping the defect-branch failure map 1:1 with the four gate cases.
- **D32** — `gate-summary.{md,html}` are deterministic, gitignored run artifacts at the
  repo root; no-op when no `@compliance` test ran.

## 4. Evidence (committed)

- **`docs/evidence/p4a.txt`** (`main`): typecheck exit 0; **231 tests × 4 consecutive
  exit-code-gated green runs** (222 prior + 9 compliance) across the full pipeline
  setup → contract (parallel) → workflow → ui → compliance (serialized); gate-summary
  **GREEN, every control evidenced, no gaps**, byte-identical across runs; stress variant
  ×10 green; gate-only `--no-deps` invocation green; reconciliation invariant OK
  (seed-fresh 48 wallets, post-suite 135); full `gate-summary.md` embedded.
- **`docs/evidence/p4a-defects.txt`** (`defects-planted` / `v1-defects`): the gate goes
  **RED on exactly the four cases**, each failing for its OWN planted reason —
  BUG-002 (volley `[201,201,403]`: duplicate checker double-counted), BUG-003 (exactly-T
  reached `PENDING_CONFIRMATION` with no record), BUG-005 (operator release → 200,
  reinforcement), BUG-006 (hold trail missing `HOLD_RELEASED`). P2 primaries unchanged
  (contract 5 × BUG-005; workflow BUG-001/004/007); UI 9/9 branch-neutral; SoD UI test
  branch-neutral as designed (the planted guard is in the API route).
  **Total mapped failure map: 8 → 12** — the +4 are exactly the commissioned gate cases.
  Defect-branch `gate-summary.md` (embedded) names the Travel-Rule boundary gap.

Reproduce:
```
# main — everything green, gate GREEN
git checkout main && rm -f prisma/vaultchain.db
pnpm typecheck && npx playwright test && cat gate-summary.md

# v1-defects — watch the gate catch its four
git checkout v1-defects && rm -f prisma/vaultchain.db
npx playwright test                                  # 5 authz fails (BUG-005); rest dep-skipped
npx playwright test --project=workflow --no-deps     # 3 fails: BUG-001/004/007
npx playwright test --project=ui --no-deps           # 9 pass (branch-neutral)
npx playwright test --project=compliance --no-deps   # 4 fails: BUG-002/003/005/006
cat gate-summary.md                                  # RED; "MISSING at T=1000.00"

# stress variant (D31)
npx playwright test --project=compliance --no-deps --grep "dual approval" --repeat-each=10
```

## 5. Review — DEFERRED to P4b (explicitly, per the P4a commission)

The completion gate for this phase was amended by the owner: evidence capture and the
defect-branch sync ran (steps 1–2 above), but the **reviewer dispatch and triage were
skipped**. P4b's session will review **P4a and P4b together** (one charter dispatch over
the combined diff). Until then, the P4a diff (commits `a86b760`, `a793626` on `main`;
`bc0d7bc` on `defects-planted`) is **unreviewed** beyond its own passing gates.

## 6. Phase P4a Definition-of-Done check

- [x] Gate zero: D28 CAS verified present before any compliance test was written; no
      test-side compensation needed.
- [x] `tests/compliance/` per §B.3, `@compliance`-tagged, serialized pipeline position
      per the config (last, after ui), retries 0.
- [x] Travel-Rule boundary triplet in GBPX; record contents asserted, not counts.
- [x] Dual-approval concurrency probe (volley includes the maker; no serializing awaits);
      `--repeat-each` stress invocation documented and run green.
- [x] Segregation of duties: release AND reject, API and UI surfaces, as BUG-005
      reinforcement.
- [x] Audit completeness: three scripted lifecycles, actor + before/after for every
      transition, hold release included, NO duplicates (exact ordered equality).
- [x] Reporter: control-bucketed `gate-summary.md`/`.html`, boundary accounting, gaps,
      awaited `onEnd`, deterministic output (byte-identical verified).
- [x] `main`: compliance green, gate-summary all-covered/no-gaps; ×4 full-pipeline
      exit-code-gated greens; evidence committed (`docs/evidence/p4a.txt`).
- [x] `v1-defects`: red on exactly BUG-002/003/005/006; map = 8 + 4 = **12**;
      gate-summary names the Travel-Rule boundary gap; evidence committed
      (`docs/evidence/p4a-defects.txt`); `defects-planted` rebased, tag re-anchored.
- [x] Reviewer dispatch + triage **SKIPPED by commission** — deferred to P4b (§5).

**STOP after P4a — do not begin P4b (CI, strict schemas, agents panel, README).**
