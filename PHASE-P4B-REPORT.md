# Phase P4b Report — strict schemas, CI, agents panel, README, and the deferred review

> **FICTIONAL system-under-test.** P4b completes Phase P4: the D25 strict-schema pass, the
> CI workflows, the `.claude/agents` test-quality panel, the README, a real clean-clone
> verification, and the combined P4a+P4b code review that P4a deferred. `main` stays green
> (231 tests); `v1-defects` now maps **12** failures (the pre-P4 eight plus the four
> `@compliance` gate cases).

## 1. What was built

- **D25 strict response schemas (item 1).** `openapi/vaultchain.yaml` response schemas are
  closed — `additionalProperties: false` on flat schemas, `unevaluatedProperties: false` on
  the three `allOf` composites (the JSON-Schema-2020-12-correct keyword; the composed bases
  `Account`/`Transaction`/`WalletRaw` carry none, by necessity). The contract-layer zod
  schemas moved to `z.strictObject` (`.extend()` inherits strictness). Tightened **together**
  in one commit, then the contract suite surfaced **two real drifts**, each fixed in its own
  commit per D18 (see §2). `D33` recorded.
- **ESLint (item 8).** A minimal, correctness-only `eslint.config.js` (typescript-eslint,
  type-aware `no-floating-promises` / `no-misused-promises` / `await-thenable` — the flake
  class §B.6 bans). No style rules that fight the hand formatting; `no-explicit-any` is
  documented off (boundary JSON/audit payloads) rather than mass-edited. The two dead-code
  items it flagged were removed in their **own** commit, separate from the CI wiring.
- **CI (items 2 + 7).** `.github/workflows/ci.yml` implements §B.5's job graph:
  `lint` (ESLint **and** markdownlint — item 7) → `typecheck` → {`api-contract`,
  `api-workflow`, `ui` (4-way shard + blob upload), `compliance-gate` (REQUIRED)} →
  `merge-reports` (Pages). The serialization architecture is respected and documented (D34);
  after the review, the required gate runs isolated (`--no-deps`, browser-free) so a UI flake
  cannot red it. `review.yml` is the §D.3 advisory PR gate — honest, `continue-on-error`,
  never required. Both YAMLs are parser-validated; authored-but-not-executed here (no GHA
  runner), like the Dockerfile (D2).
- **Agents panel (item 3).** `compliance-auditor`, `flake-hunter`, `contract-drift`,
  `assertion-critic` added to `.claude/agents/`; the two build-process agents
  (`code-reviewer`, `adversarial-auditor`) untouched. The panel was run against the finished
  suites and triaged (§6).
- **README (item 4).** The §D.1 nine sections: FICTIONAL banner, architecture-first pitch, a
  collapsible fintech domain deep-dive, the one-command run, the architecture diagram, the
  §D.2 BUG-003 walkthrough with the **real** red gate-summary excerpt from
  `p4a-defects.txt`, the two build stories (parallel-build stress; the D26 saga) quoting the
  evidence, the self-audit panel + CI review gate, flake/CI/report-reading, and an honest
  fictional / NOT-demonstrated scope section. Reveal policy respected exactly: BUG-003 walked
  through; the rest alluded to without location or mechanics; BUG-005 is only "an
  authorization gap." `npm run demo` added (isolated compliance gate).
- **Clean-clone verification (item 5).** §5.

## 2. The D25 drifts (fixed per D18, each its own commit)

The strict schemas did their job — they caught real drift the loose schemas had hidden:

1. **Raw-row leak** (`72c03b3` tighten → `73e604c` fix). `GET /holds/{id}`'s embedded
   `transaction` and `POST /simulator/tx/{id}/force` returned the **full Prisma row** —
   leaking internal columns (`createdByApiKeyId`, `broadcastBlockHeight`, …) the spec never
   declares. Fixed server-side with a shared `serializeTransactionRaw()` projection to the
   compact `TransactionRaw`. The spec is the source of truth (D18).
2. **Nested array-item objects** (`3e8bb8b`). The `contract-drift` **panel agent** caught
   that the `approvals[]` / `travelRule[]` item objects were still open in the spec
   (`unevaluatedProperties` does not reach array-item subschemas) while their zod schemas were
   strict — an asymmetry. Closed both with `additionalProperties: false` (the `payload` map
   stays open, matching `z.record`). The panel earning its keep on this phase's own work.

## 3. What was deferred

- **The final adversarial gate** — see §8. It is the sole remaining step and is **not** this
  session.
- A post-P4 **test-hardening batch** from the panel + review (all non-critical): registered
  in `docs/DEFERRED.md` and detailed with dispositions in §6–§7.
- The **Docker `compose up`** boot stays unverified (no Docker here; D2) — recorded in
  `docs/DEFERRED.md`, not claimed; the clean-clone used the tsx path instead.

## 4. New DECISIONS.md entries (summary)

`D33` — strict response schemas: `additionalProperties: false` on flat schemas,
`unevaluatedProperties: false` on `allOf` composites; the composed bases rely on the strict
zod oracle for standalone strictness; two drifts surfaced and fixed.
`D34` — CI job graph maps the strict serialized pipeline to isolated per-project jobs; only
`ui` is sharded; the required `compliance-gate` runs isolated (`--no-deps`) so it stands
beside the other jobs rather than subsuming them (adopted from the combined-review Minor 1).

## 5. Evidence (committed)

- **`docs/evidence/p4b.txt`** (`main`): typecheck 0; ESLint clean; markdownlint clean;
  redocly valid; **full pipeline 231 green ×2** (exit-code-gated); reconciliation OK (48
  wallets); gate-summary GREEN; **plus a real clean-clone run** — a fresh `git clone` of
  `main` (BUGS.md absent, as it must be), `pnpm install` → `prisma generate` →
  `playwright install chromium` → `npx playwright test` = **231 green**, gate GREEN. Docker
  unavailable, so the tsx path was used and the gap recorded in `DEFERRED.md`.
- **`docs/evidence/p4b-defects.txt`** (`v1-defects`): the **12-failure map** —
  contract 5 (BUG-005) + workflow 3 (BUG-001/004/007) + compliance 4 (BUG-002/003/005/006);
  UI branch-neutral (9 pass). `npm run demo` goes **RED**, gate-summary names "MISSING at
  T=1000.00". The BUG-005 ↔ P4b-drift-fix rebase conflict in `holds.ts` imports was resolved
  to keep **both** `denyRole` (the planted defect) and `serializeTransactionRaw` (the fix);
  defect-branch typecheck 0.

## 6. The agents panel — run + triage (item 3)

Run against the finished suites via the panel charters. **Zero critical across all four.**
Triaged like reviewer findings: fix criticals, report the rest. One finding was promoted to a
fix because it completes a P4b deliverable (contract-drift, §2.2); the remainder are a
recommended post-P4 hardening batch (registered in `DEFERRED.md`).

- **`flake-hunter` — clean bill (0/0/0/0).** No `waitForTimeout`/`Date.now()`, no
  shared-state or order-dependence flips, no floating promises the ESLint rule cannot see. It
  noted the clean bill is conditional on the serialization guardrails holding (the downstream
  projects staying `workers:1`, `contract` never gaining a clock-position assertion).
- **`contract-drift` — 1 minor, FIXED (§2.2).** Otherwise full both-directions parity
  confirmed property-by-property.
- **`compliance-auditor` — 0 critical; 3 major, 3 minor, 2 nit, all reported.** Chiefly:
  audit-completeness sweeps cover representative lifecycles, not literally *every* terminal
  branch (reject/cancel/withdrawal-hold) though the comments imply "every"; the Travel-Rule
  boundary is GBPX-only, so the BTC/ETH fiat-**conversion** boundary is untested (this is by
  the §A.3.3 independence design — adding it would couple to BUG-001 on the defect branch, so
  it must be a main-only coverage addition); SoD does not probe CLIENT on the UI surface.
- **`assertion-critic` — 0 critical; 3 major, 3 minor, 2 nit, all reported.** Chiefly: the
  travel-rule T+1 case asserts the originator payload but not the beneficiary; a workflow
  audit assertion uses `arrayContaining` where the compliance twin already proves an exact
  ordered sequence is achievable; a couple of `toContain` checks would not catch a duplicate
  emission.

**Corroboration:** `compliance-auditor` m3 and `assertion-critic` 5 independently flagged the
same T-1 `not.toContain` weakness (vacuous on an empty audit list) — a strong candidate for
the hardening batch. **Disposition:** none of these are correctness bugs in the platform; they
are test-strength/coverage improvements. Recommended as an owner-decided batch (strengthen
the T+1 beneficiary assertion and the exact-sequence audit checks; add a CLIENT UI-surface SoD
probe; a main-only BTC/ETH Travel-Rule boundary case). Left unfixed to hold the gate line
(fix criticals only) and keep the defect map stable.

## 7. The deferred combined review (P4a + P4b) + triage (item 6)

The `code-reviewer` charter was dispatched on the full `28f0bfd..HEAD` diff (the review P4a
deferred). It verified typecheck / ESLint / contract / compliance itself and confirmed the
gate-summary byte-identical and the D25/D33 parity complete. **Zero critical, zero major.**

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Minor | The REQUIRED `compliance-gate` re-ran the whole suite via its dep chain, so a UI/workflow flake could red it — against §B.5's "regardless of the other jobs". | **FIXED** (`f33b4dc`): gate now runs `--project=setup --project=compliance --no-deps` (the `npm run demo` command) — isolated, browser-free, beside the other jobs. D34 updated. |
| 2 | Minor | Reporter tag-filter vs project `grep` are two gating mechanisms that must stay in sync; nothing enforces it. | Report. Both are present and load-bearing on different invocations; documented fragility, no change. |
| 3 | Minor | `flaggedDepositHold` "settle backlog then FLAG" is only safe because compliance is serialized — invariant invisible at the call site. | Report. Safe today; a candidate one-line "no other OPEN hold" assertion folds into the hardening batch. |
| 4–6 | Nit | Optional-trailing-field strictness limit (inherent); Travel-Rule `JSON.parse` guard (pre-existing, out of scope); a `DEFERRED.md` working-tree artifact (since committed). | Report; no action. |

Only Minor 1 warranted a change; it was the reviewer's single "most worth attention" item and
completes the CI deliverable's own §B.5 intent. Gate steps 1–2 were re-run after it (main 231
green; defect map still 12; `v1-defects` re-anchored).

## 8. The sole remaining step — the final adversarial gate (NOT this session)

Per PRD §D.3 and the phase brief, the final gate is the **`adversarial-auditor`** charter run
in a **separate, fresh session that must never have read `BUGS.md`** — discovering the planted
defects independently is the whole point of that exercise. **This session has read `BUGS.md`
and therefore cannot be that gate.** It is deliberately left un-run here; it is the one
outstanding item before the repo is made public.

## 9. Phase P4b Definition-of-Done check

- [x] D25 executed: openapi + zod tightened together; both drifts it surfaced fixed per D18,
      each its own commit; contract 183 green.
- [x] `ci.yml` per §B.5 (lint incl. markdownlint + ESLint, typecheck, api-contract,
      api-workflow, ui sharded 4-way + blob merge → Pages, compliance-gate REQUIRED +
      gate-summary artifact); `review.yml` advisory; serialization respected and documented;
      both parser-validated.
- [x] Agents panel added (4) without touching the existing two; run against the suites and
      triaged (0 critical).
- [x] README: nine sections; real red gate-summary; the two build stories quoting evidence;
      reveal policy exact (BUG-003 walked; BUG-005 = "an authorization gap"); honest scope
      paragraph.
- [x] Clean-clone verified for real (fresh clone → one command → 231 green, gate GREEN);
      Docker gap recorded in `DEFERRED.md`, not claimed.
- [x] Deferred P4a+P4b review dispatched; **0 critical / 0 major**; the one actionable Minor
      fixed with gate steps 1–2 re-run; the rest reported with dispositions.
- [x] `main` full pipeline + typecheck green, captured to `docs/evidence/p4b.txt`.
- [x] `defects-planted` rebased; **12-failure map** verified (8 + the four gate cases);
      `npm run demo` RED; `v1-defects` re-anchored; `docs/evidence/p4b-defects.txt` committed.
- [ ] **Final adversarial gate** — deferred to a separate BUGS.md-blind session (§8).

**STOP after P4b — the only remaining step is the independent adversarial gate (§8).**
