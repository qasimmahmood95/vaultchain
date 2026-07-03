// Role-based auth fixtures (PRD §B.2): one worker-scoped APIRequestContext
// per role, X-Api-Key pre-set. Keys are the deterministic mock keys the seed
// prints (scripts/seed-lib.ts) — this is a fictional platform; they are not
// secrets. The `setup` project (global.setup.ts) verifies each key against
// /me and writes .auth/identity.json before any suite runs.

import { test as base, request, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RAW_KEYS, clientKey } from '../../scripts/seed-lib.js';
import { API_BASE } from './api-client.js';

export interface Identity {
  apiKeyId: string;
  role: string;
  clientId: string | null;
}

export interface AuthWorkerFixtures {
  /** ADMIN — full control incl. /simulator. */
  asAdmin: APIRequestContext;
  /** OPERATOR A — the default maker in tests. */
  asOperatorA: APIRequestContext;
  /** OPERATOR B — the default (distinct) checker. */
  asOperatorB: APIRequestContext;
  /** COMPLIANCE_OFFICER — the only role that may resolve holds. */
  asCompliance: APIRequestContext;
  /** CLIENT key tenant-bound to seed client #1 (Aldgate Digital Partners LLP). */
  asClientA: APIRequestContext;
  /** CLIENT key tenant-bound to seed client #2 (Wren & Hart Capital Ltd) — for cross-tenant probes. */
  asClientB: APIRequestContext;
  /** role name -> {apiKeyId, role, clientId}, resolved by the setup project. */
  identities: Record<string, Identity>;
}

const KEYS: Record<string, string> = {
  admin: RAW_KEYS.admin,
  operatorA: RAW_KEYS.operatorA,
  operatorB: RAW_KEYS.operatorB,
  compliance: RAW_KEYS.compliance,
  clientA: clientKey(1),
  clientB: clientKey(2),
};

const AUTH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.auth');
export const IDENTITY_FILE = path.join(AUTH_DIR, 'identity.json');
export { AUTH_DIR };

async function roleContext(key: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { 'x-api-key': key },
  });
}

type WorkerFixtureTuple = [
  (args: Record<never, never>, use: (ctx: APIRequestContext) => Promise<void>) => Promise<void>,
  { scope: 'worker' },
];

function workerRole(name: keyof typeof KEYS): WorkerFixtureTuple {
  return [
    async (_args, use) => {
      const ctx = await roleContext(KEYS[name]!);
      await use(ctx);
      await ctx.dispose();
    },
    { scope: 'worker' },
  ];
}

export const authTest = base.extend<Record<never, never>, AuthWorkerFixtures>({
  asAdmin: workerRole('admin'),
  asOperatorA: workerRole('operatorA'),
  asOperatorB: workerRole('operatorB'),
  asCompliance: workerRole('compliance'),
  asClientA: workerRole('clientA'),
  asClientB: workerRole('clientB'),
  identities: [
    async ({}, use) => {
      // Written by the setup project; fail with a pointer if it is missing.
      let identities: Record<string, Identity>;
      try {
        identities = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) as Record<string, Identity>;
      } catch {
        throw new Error(`Missing ${IDENTITY_FILE} — the 'setup' project must run first (it is a dependency of every suite project).`);
      }
      await use(identities);
    },
    { scope: 'worker' },
  ],
});

export { KEYS as ROLE_KEYS };
