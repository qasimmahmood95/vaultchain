// @compliance — segregation of duties: hold resolution (PRD §A.4, §B.3).
//
// THE RULE: a screening hold is resolved — released OR rejected — only by a
// COMPLIANCE_OFFICER. Operations staff (operator) and admin can see the queue
// but must never resolve; segregation between operations and compliance is
// the control itself.
//
// This is deliberate REINFORCEMENT of the P2 contract authz-matrix (which owns
// the primary role×endpoint catch): the matrix asserts response codes row by
// row; this spec asserts the RULE end-to-end — a real hold, every unauthorized
// role refused on BOTH surfaces (API and admin UI), the hold verifiably
// untouched, and the authorized path completing the lifecycle. Defence in
// depth, not double-counting (PRD §B.3).
//
// The UI probes drive the real /ui form endpoints with the storageState the
// setup project captured via /ui/login — the P3 staff-gating (D27) is part of
// the rule. Rendering of the resolve controls stays P3's UI journey.

import { test, expect, ApiClient, API_BASE, UI_STATE } from '../fixtures/index.js';
import { flaggedDepositHold, type HoldResponse } from './support/helpers.js';

const RULE = { type: 'rule', description: 'SOD-HOLD-RESOLUTION' };

test(
  'API surface: only the compliance officer resolves a hold — release AND reject',
  { tag: '@compliance', annotation: [RULE] },
  async ({ asOperatorA, asOperatorB, asAdmin, asCompliance, asClientA, build, chain }) => {
    const operatorA = new ApiClient(asOperatorA);
    const operatorB = new ApiClient(asOperatorB);
    const admin = new ApiClient(asAdmin);
    const compliance = new ApiClient(asCompliance);
    const clientA = new ApiClient(asClientA);

    const unauthorized: [string, ApiClient][] = [
      ['operator', operatorB],
      ['admin', admin],
      ['client', clientA],
    ];

    // --- RELEASE ------------------------------------------------------------
    const first = await flaggedDepositHold({ operator: operatorA, compliance, build, chain });
    for (const [role, api] of unauthorized) {
      const res = await api.post(`/holds/${first.hold.id}/release`);
      expect(res.status, `${role} must not release a hold`).toBe(403);
    }
    // The refused attempts changed nothing: the hold is verifiably still OPEN.
    const stillOpen = await compliance.get<HoldResponse>(`/holds/${first.hold.id}`);
    expect(stillOpen.json.state).toBe('OPEN');

    // The authorized path completes: compliance releases, the deposit credits.
    const release = await compliance.post<HoldResponse>(`/holds/${first.hold.id}/release`);
    expect(release.status).toBe(200);
    expect(release.json.state).toBe('RELEASED');
    const released = await compliance.get<HoldResponse>(`/holds/${first.hold.id}`);
    expect(released.json.transaction?.state).toBe('CREDITED');

    // --- REJECT (a fresh hold — same rule, other decision) --------------------
    const second = await flaggedDepositHold({ operator: operatorA, compliance, build, chain });
    for (const [role, api] of unauthorized) {
      const res = await api.post(`/holds/${second.hold.id}/reject`);
      expect(res.status, `${role} must not reject a hold`).toBe(403);
    }
    const secondOpen = await compliance.get<HoldResponse>(`/holds/${second.hold.id}`);
    expect(secondOpen.json.state).toBe('OPEN');

    const reject = await compliance.post<HoldResponse>(`/holds/${second.hold.id}/reject`);
    expect(reject.status).toBe(200);
    expect(reject.json.state).toBe('REJECTED');
    const rejected = await compliance.get<HoldResponse>(`/holds/${second.hold.id}`);
    expect(rejected.json.transaction?.state).toBe('REJECTED'); // deposit never credited
  },
);

test(
  'UI surface: the admin-UI resolve form is refused for every non-compliance session',
  { tag: '@compliance', annotation: [RULE] },
  async ({ playwright, asOperatorA, asCompliance, build, chain }) => {
    const operatorA = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);
    const { hold } = await flaggedDepositHold({ operator: operatorA, compliance, build, chain });
    const resolvePath = `/ui/holds/${hold.id}/resolve`;

    // No session at all: the UI bounces straight to login.
    const anon = await playwright.request.newContext({ baseURL: API_BASE });
    const anonRes = await anon.post(resolvePath, { form: { decision: 'RELEASE' }, maxRedirects: 0 });
    expect(anonRes.status()).toBe(303);
    expect(anonRes.headers()['location']).toBe('/ui/login');
    await anon.dispose();

    // Operator session: RELEASE refused (303 back to the transaction, error flash).
    const operatorUi = await playwright.request.newContext({ baseURL: API_BASE, storageState: UI_STATE.operatorB });
    const opRes = await operatorUi.post(resolvePath, { form: { decision: 'RELEASE' }, maxRedirects: 0 });
    expect(opRes.status()).toBe(303);
    expect(opRes.headers()['location']).toContain(`/ui/transactions/${hold.transactionId}`);
    expect(opRes.headers()['location']).toContain('kind=err');
    await operatorUi.dispose();

    // Admin session: REJECT refused the same way — the rule covers both decisions.
    const adminUi = await playwright.request.newContext({ baseURL: API_BASE, storageState: UI_STATE.admin });
    const adRes = await adminUi.post(resolvePath, { form: { decision: 'REJECT' }, maxRedirects: 0 });
    expect(adRes.status()).toBe(303);
    expect(adRes.headers()['location']).toContain('kind=err');
    await adminUi.dispose();

    // Server state is the arbiter: none of those form posts resolved anything.
    const stillOpen = await compliance.get<HoldResponse>(`/holds/${hold.id}`);
    expect(stillOpen.json.state).toBe('OPEN');

    // The compliance session resolves through the very same form.
    const complianceUi = await playwright.request.newContext({ baseURL: API_BASE, storageState: UI_STATE.compliance });
    const coRes = await complianceUi.post(resolvePath, { form: { decision: 'RELEASE' }, maxRedirects: 0 });
    expect(coRes.status()).toBe(303);
    expect(coRes.headers()['location']).toContain('kind=ok');
    await complianceUi.dispose();

    const released = await compliance.get<HoldResponse>(`/holds/${hold.id}`);
    expect(released.json.state).toBe('RELEASED');
    expect(released.json.transaction?.state).toBe('CREDITED');
  },
);
