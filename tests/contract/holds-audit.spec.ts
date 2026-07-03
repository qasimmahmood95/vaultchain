// Contract: /holds list/get and /audit (openapi/vaultchain.yaml, tags `holds`,
// `audit`). Read-only against SEEDED holds — this suite never releases or
// rejects a hold (positive hold flows are workflow territory).

import { test, ApiClient } from '../fixtures/index.js';
import { expect, expectProblem } from './support/matchers.js';
import { AuditLogEntrySchema, ComplianceHoldSchema, page } from './schemas/index.js';

test('GET /holds (COMPLIANCE_OFFICER) -> 200 page envelope of ComplianceHold', async ({
  asCompliance,
}) => {
  const res = await new ApiClient(asCompliance).get('/holds?limit=10');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(page(ComplianceHoldSchema));
});

test('GET /holds?state=OPEN -> 200; filter respected; GET /holds/{id} -> 200 ComplianceHold', async ({
  asCompliance,
}) => {
  const api = new ApiClient(asCompliance);
  const list = await api.get<{ items: Array<{ id: string; state: string }> }>('/holds?state=OPEN&limit=10');
  expect(list.status).toBe(200);
  expect(list.json).toMatchSchema(page(ComplianceHoldSchema));
  for (const hold of list.json.items) {
    expect(hold.state).toBe('OPEN');
  }
  // The deterministic seed stages open holds; nothing in this suite resolves them.
  expect(list.json.items.length, 'seed stages open holds').toBeGreaterThan(0);

  const detail = await api.get(`/holds/${list.json.items[0]!.id}`);
  expect(detail.status).toBe(200);
  expect(detail.json).toMatchSchema(ComplianceHoldSchema);
});

test('GET /holds/{unknown} -> 404 problem+json', async ({ asCompliance }) => {
  const res = await new ApiClient(asCompliance).get('/holds/no-such-hold-id');
  expectProblem(res, 404);
});

test('GET /audit (COMPLIANCE_OFFICER) -> 200 page envelope of AuditLogEntry', async ({
  asCompliance,
}) => {
  const res = await new ApiClient(asCompliance).get('/audit?limit=10');
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(page(AuditLogEntrySchema));
});

test('GET /audit?entityType= filter is respected (ADMIN)', async ({ asAdmin, build }) => {
  // Own audit trail: creating a client writes an AuditLogEntry for it.
  const client = await build.client();
  const res = await new ApiClient(asAdmin).get(
    `/audit?entityType=Client&entityId=${client.id}&limit=10`,
  );
  expect(res.status).toBe(200);
  expect(res.json).toMatchSchema(page(AuditLogEntrySchema));
  const items = (res.json as { items: Array<{ entityType: string; entityId: string }> }).items;
  expect(items.length, 'client creation is audited').toBeGreaterThan(0);
  for (const entry of items) {
    expect(entry.entityType).toBe('Client');
    expect(entry.entityId).toBe(client.id);
  }
});
