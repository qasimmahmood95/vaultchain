// The `setup` project (PRD §B.4): runs before every suite project.
// Verifies each role key against /me and writes .auth/identity.json —
// the API-key analogue of browser storageState (DECISIONS.md D20; real
// storageState arrives with the P3 UI login).

import { test as setup, expect, request } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { API_BASE } from './api-client.js';
import { AUTH_DIR, IDENTITY_FILE, ROLE_KEYS, type Identity } from './auth.fixtures.js';
import { UI_STATE, type UiRole } from './ui-states.js';

const EXPECTED_ROLE: Record<string, string> = {
  admin: 'ADMIN',
  operatorA: 'OPERATOR',
  operatorB: 'OPERATOR',
  compliance: 'COMPLIANCE_OFFICER',
  clientA: 'CLIENT',
  clientB: 'CLIENT',
};

setup('resolve role identities against /me', async () => {
  const identities: Record<string, Identity> = {};
  for (const [name, key] of Object.entries(ROLE_KEYS)) {
    const ctx = await request.newContext({ baseURL: API_BASE, extraHTTPHeaders: { 'x-api-key': key } });
    const res = await ctx.get('/me');
    expect(res.status(), `${name}: /me must authenticate (is the server seeded?)`).toBe(200);
    const me = (await res.json()) as Identity;
    expect(me.role, `${name}: unexpected role`).toBe(EXPECTED_ROLE[name]);
    if (name.startsWith('client')) {
      expect(me.clientId, `${name}: CLIENT keys must be tenant-bound`).not.toBeNull();
    }
    identities[name] = me;
    await ctx.dispose();
  }
  // Distinct-approver sanity: maker-checker tests depend on these being different keys.
  expect(identities.operatorA!.apiKeyId).not.toBe(identities.operatorB!.apiKeyId);
  expect(identities.clientA!.clientId).not.toBe(identities.clientB!.clientId);

  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(IDENTITY_FILE, JSON.stringify(identities, null, 2));
});

setup('UI login per role -> storageState (§B.2: log in once, reuse everywhere)', async () => {
  mkdirSync(AUTH_DIR, { recursive: true });
  for (const role of Object.keys(UI_STATE) as UiRole[]) {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.post('/ui/login', { form: { apiKey: ROLE_KEYS[role]! } });
    // Playwright follows the 303 to /ui/queue; the session cookie is in the jar.
    expect(res.status(), `${role}: UI login must succeed`).toBe(200);
    await ctx.storageState({ path: UI_STATE[role] });
    await ctx.dispose();
  }
});
