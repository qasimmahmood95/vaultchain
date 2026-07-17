# Dependencies

Every dependency must earn its place. One line of justification each; anything
without a justification here gets removed.

## Runtime

- **fastify** — the HTTP framework named in PRD §"Platform stack"; JSON-schema request
  validation built in, no middleware zoo needed.
- **@prisma/client** — typed SQLite client named in PRD §A.2; gives the migrations story
  and keeps handlers free of hand-rolled SQL.
- **eta** — the server-rendered template engine for the §A.5 admin UI (D1: arrived in P3
  with the UI). No frontend framework, no build step.

## Dev

- **prisma** — CLI for `migrate`/`generate`; dev-only, the runtime uses @prisma/client.
- **typescript** — `strict` typecheck is part of every phase's Definition of Done.
- **tsx** — runs TS directly (server, seeds, smoke) so P1 needs no build/dist step.
- **@types/node** — Node built-ins (crypto, http) under `strict`.

## Dev — test architecture (P2+)

- **@playwright/test** — the test runner the whole showcase is built on (PRD §B).
- **zod** — independent re-encoding of `openapi/vaultchain.yaml` for the contract layer
  (PRD §B.3); deliberately NOT generated from server types so drift is detectable.

## Dev — performance layer (P5)

- **autocannon** — HDR-histogram HTTP load generation for the read-path baseline
  (DECISIONS.md D36); pure-Node dev dependency, no external binary. The write-contention
  scenarios deliberately do NOT use it — they are orchestrated TS volleys whose
  assertions are DB truth.
- **@types/autocannon** — autocannon ships no types; `strict` typecheck is the DoD.

## Deliberately absent

- **@fastify/cookie / @fastify/formbody** — the UI needs one cookie read and one
  urlencoded parser; both are ~6 lines against Node built-ins (plugins/auth.ts, app.ts).
- **dotenv** — the SQLite URL is a literal in `schema.prisma` (DECISIONS.md D5); nothing
  else needs env config.
- **openapi-to-zod generators** — would defeat the contract layer's purpose: a generated
  schema can't catch spec/implementation drift (PRD §A.4).
