// Contract: /clients create/list/get (openapi/vaultchain.yaml, tag `clients`).

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { ClientSchema, page } from './schemas/index.js';

test('POST /clients (ADMIN) -> 201 Client', async ({ asAdmin, build }) => {
  const res = await new ApiClient(asAdmin).post('/clients', {
    legalName: `Contract Client ${build.uniqueRef('cl').slice(0, 14)} (fictional)`,
    type: 'INSTITUTION',
    jurisdiction: 'GB',
    vaspId: build.uniqueRef('vasp'),
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(ClientSchema);
});

test('POST /clients without vaspId -> 201 with vaspId null (nullable, still present)', async ({
  asAdmin,
  build,
}) => {
  const res = await new ApiClient(asAdmin).post('/clients', {
    legalName: `Contract Individual ${build.uniqueRef('ci').slice(0, 12)} (fictional)`,
    type: 'INDIVIDUAL',
    jurisdiction: 'GB',
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchSchema(ClientSchema);
  expect((res.json as { vaspId: string | null }).vaspId).toBeNull();
});

test('GET /clients (OPERATOR) -> 200 page envelope of Client', async ({ asOperatorA }) => {
  const res = await new ApiClient(asOperatorA).get('/clients?limit=5');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(page(ClientSchema));
});

test('GET /clients as CLIENT -> 200 self-scoped: exactly its own client', async ({
  asClientA,
  identities,
}) => {
  const res = await new ApiClient(asClientA).get('/clients');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(page(ClientSchema));
  const items = (res.json as { items: Array<{ id: string }> }).items;
  // Scoped to the caller's own tenant — never a global-count assertion.
  expect(items).toHaveLength(1);
  expect(items[0]!.id).toBe(identities['clientA']!.clientId);
});

test('GET /clients/{id} -> 200 Client', async ({ asAdmin, build }) => {
  const created = await build.client();
  const res = await new ApiClient(asAdmin).get(`/clients/${created.id}`);
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(ClientSchema);
  expect((res.json as { id: string }).id).toBe(created.id);
});

test('POST /clients with a malformed body -> 400 problem+json', async ({ asAdmin }) => {
  // legalName missing entirely: request-shape validation failure.
  const res = await new ApiClient(asAdmin).post('/clients', { type: 'INSTITUTION', jurisdiction: 'GB' });
  expectProblem(res, 400);
});

test('GET /clients/{unknown} -> 404 problem+json', async ({ asAdmin, build }) => {
  const res = await new ApiClient(asAdmin).get(`/clients/${build.uniqueRef('no-such-client')}`);
  expectProblem(res, 404);
});
