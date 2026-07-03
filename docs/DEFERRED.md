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
