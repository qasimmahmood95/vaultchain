// Contract: /health and /me (openapi/vaultchain.yaml, tag `core`) plus the
// 401 error contract (missing AND invalid X-Api-Key → RFC 9457 problem).

import type { APIRequestContext } from '@playwright/test';
import { test, ApiClient } from '../fixtures/index.js';
import { RAW_KEYS } from '../../scripts/seed-lib.js';
import { expect, expectProblem } from './support/matchers.js';
import { HealthSchema, MeSchema, ProblemSchema } from './schemas/index.js';

test('GET /health -> 200 {status:"ok"} without auth', async ({ request }) => {
  const res = await new ApiClient(request).get('/health');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(HealthSchema);
});

const ME_CASES = [
  ['asAdmin', 'admin', 'ADMIN'],
  ['asOperatorA', 'operatorA', 'OPERATOR'],
  ['asOperatorB', 'operatorB', 'OPERATOR'],
  ['asCompliance', 'compliance', 'COMPLIANCE_OFFICER'],
  ['asClientA', 'clientA', 'CLIENT'],
  ['asClientB', 'clientB', 'CLIENT'],
] as const;

for (const [fixtureName, identityName, expectedRole] of ME_CASES) {
  test(`GET /me as ${identityName} -> 200 with role ${expectedRole}`, async ({
    asAdmin,
    asOperatorA,
    asOperatorB,
    asCompliance,
    asClientA,
    asClientB,
    identities,
  }) => {
    const contexts: Record<(typeof ME_CASES)[number][0], APIRequestContext> = {
      asAdmin,
      asOperatorA,
      asOperatorB,
      asCompliance,
      asClientA,
      asClientB,
    };
    const res = await new ApiClient(contexts[fixtureName]).get('/me');
    expect(res.status).toBe(200);
    expect(res.json).toMatchSchema(MeSchema);

    const me = res.json as { apiKeyId: string; role: string; clientId: string | null };
    expect(me.role).toBe(expectedRole);
    // Stability against the setup project's resolved identity.
    expect(me).toEqual(identities[identityName]);
    if (expectedRole === 'CLIENT') {
      expect(me.clientId, 'CLIENT keys are tenant-bound').not.toBeNull();
    } else {
      expect(me.clientId, 'non-CLIENT keys carry no tenant binding').toBeNull();
    }
  });
}

test('GET /me without X-Api-Key -> 401 problem+json', async ({ request }) => {
  const res = await new ApiClient(request).get('/me');
  expectProblem(res, 401, 'missing key');
});

test('GET /me with a bogus X-Api-Key -> 401 problem+json', async ({ request }) => {
  const res = await request.get('/me', { headers: { 'x-api-key': 'vc_bogus_key_that_never_existed' } });
  expect(res.status()).toBe(401);
  expect(res.headers()['content-type'] ?? '').toContain('application/problem+json');
  const body: unknown = await res.json();
  expect(body).toMatchSchema(ProblemSchema);
  expect((body as { status?: number }).status).toBe(401);
});

test('the vc_key UI cookie does NOT authenticate the JSON API -> 401 (D27)', async ({ request }) => {
  // A browser holding a valid UI session cookie must not be able to drive the
  // §A.4 API without X-Api-Key — the cookie is a UI-only credential.
  const res = await request.get('/me', {
    headers: { cookie: `vc_key=${encodeURIComponent(RAW_KEYS.admin)}` },
  });
  expect(res.status(), 'cookie alone must not authenticate a JSON endpoint').toBe(401);
  expect(res.headers()['content-type'] ?? '').toContain('application/problem+json');
});

test('the JSON API rejects urlencoded form posts -> 415 (parser is /ui-scoped, D27)', async ({ asOperatorA }) => {
  // Even WITH a valid X-Api-Key, a §A.4 endpoint must not accept HTML form
  // bodies — that parser lives only on /ui.
  const res = await asOperatorA.post('/clients', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: 'legalName=Form+Co&type=INSTITUTION&jurisdiction=GB',
  });
  expect(res.status()).toBe(415);
});
