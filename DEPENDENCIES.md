# Dependencies

Every dependency must earn its place. One line of justification each; anything
without a justification here gets removed.

## Runtime

- **fastify** — the HTTP framework named in PRD §"Platform stack"; JSON-schema request
  validation built in, no middleware zoo needed.
- **@prisma/client** — typed SQLite client named in PRD §A.2; gives the migrations story
  and keeps handlers free of hand-rolled SQL.

## Dev

- **prisma** — CLI for `migrate`/`generate`; dev-only, the runtime uses @prisma/client.
- **typescript** — `strict` typecheck is part of every phase's Definition of Done.
- **tsx** — runs TS directly (server, seeds, smoke) so P1 needs no build/dist step.
- **@types/node** — Node built-ins (crypto, http) under `strict`.

## Dev — test architecture (P2+)

- **@playwright/test** — the test runner the whole showcase is built on (PRD §B).
- **zod** — independent re-encoding of `openapi/vaultchain.yaml` for the contract layer
  (PRD §B.3); deliberately NOT generated from server types so drift is detectable.

## Deliberately absent

- **eta** (templates) — admin UI is P3 scope (see DECISIONS.md D1).
- **dotenv** — the SQLite URL is a literal in `schema.prisma` (DECISIONS.md D5); nothing
  else needs env config.
- **openapi-to-zod generators** — would defeat the contract layer's purpose: a generated
  schema can't catch spec/implementation drift (PRD §A.4).
