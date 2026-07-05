# Deferred findings register

Review findings deliberately **not** fixed yet, so they don't live only inside a phase
report. Each was triaged in `PHASE-P1-REPORT.md` §5; revisit at the phase noted.

| Ref | Finding (one line) | Revisit |
|---|---|---|
| P1 Minor 2 | `forceTxOutcome('CONFIRMED')` can confirm a never-broadcast withdrawal (admin-only simulator escape hatch; physically impossible state, no money impact) — restrict to `PENDING_CONFIRMATION` or document intent | P2 |
| P1 Minor 3 | `attachTravelRule` doesn't require the tx to actually need Travel Rule; spurious records can accumulate on domestic/below-threshold transfers — consider 422 | P2 |
| P1 Minor 5 | `GET /webhooks/deliveries` ignores `cursor`/`limit` and returns unbounded items (spec-consistent, convention-inconsistent) — paginate or drop the params | P2 |
| P1 Nit 2 | CLIENT tenant filters use dead `clientId ?? ''` fallback (empty-string sentinel smell) | P2 cleanup |
| P1 Nit 3 | `creditDeposit` lists `CREDITED` among "creditable" states (intentional replay no-op path; reads oddly, comment mitigates) | leave |
| P1 Nit 4 | `scripts/smoke.ts` dead probe: `GET /withdrawals` fetched and `void`-ed, no assertion | P2 cleanup |
| P4b Docker | `docker compose up` is authored (`Dockerfile` + `docker-compose.yml`, §D.1) but **NOT executed** in this build environment — no Docker installed (continues D2). The P4b clean-clone verification used the `tsx`/`pnpm` path instead (fresh clone → `pnpm install` → `prisma generate` → `playwright install chromium` → `npx playwright test`, 231 green, `docs/evidence/p4b.txt`). The compose boot is unverified, not claimed. | a Docker-enabled env |
| P4b panel | The P4b `.claude/agents` panel run surfaced test-quality findings (0 critical) folded into `PHASE-P4B-REPORT.md` §review — chiefly: audit-completeness sweeps cover representative lifecycles not literally *every* terminal branch; the Travel-Rule boundary is GBPX-only (no BTC/ETH fiat-conversion boundary, by independence design); a few workflow assertions use `arrayContaining`/`toContain` where an exact ordered sequence is stronger. Left for an owner-decided test-hardening batch. | post-P4 |
| P4b flake | The rare parallel-contract `insufficient-funds` flake (global-settlement race in the authz-matrix shared setup) fired once during P4b then passed on re-run; pre-existing (P2/P3 structure), not a P4b regression. Consider raising the `fundedWallet` credit-visibility poll bound or serialising the shared setup. | post-P4 |
