// P1 smoke (PRD §C.2/P1 DoD): one deposit lifecycle and one above-threshold
// cross-VASP withdrawal lifecycle, END TO END via the HTTP API, driven only
// by the simulator — no sleeps, no wall-clock. Exits non-zero on any failure.

import { execSync } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { RAW_KEYS } from './seed-lib.js';

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${name}${!condition && detail ? ` — ${detail}` : ''}`);
}

async function api(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-api-key': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function main(): Promise<void> {
  console.log('== VaultChain P1 smoke ==');
  console.log('-- reseeding (demo seed) --');
  execSync('npx tsx scripts/seed-demo.ts', { stdio: 'pipe' });

  const app = buildApp();
  await app.listen({ port: PORT, host: '127.0.0.1' });

  try {
    const OP_A = RAW_KEYS.operatorA;
    const OP_B = RAW_KEYS.operatorB;
    const ADMIN = RAW_KEYS.admin;
    const CO = RAW_KEYS.compliance;

    // --- Setup via API only: subscription, client, account(+wallet+policy), allowlist ---
    console.log('-- setup via API --');
    const sub = await api('POST', '/webhooks/subscriptions', OP_A, {
      url: 'https://hooks.smoke.example/sink',
      secret: 'smoke-secret-0001',
      events: ['deposit.detected', 'deposit.credited', 'withdrawal.broadcast', 'withdrawal.confirmed'],
    });
    check('webhook subscription created', sub.status === 201);

    const client = await api('POST', '/clients', ADMIN, {
      legalName: 'Smoke Test Custodian Ltd',
      type: 'INSTITUTION',
      jurisdiction: 'GB',
      vaspId: 'vasp-smoke',
    });
    check('client created', client.status === 201);
    const clientId = client.json.id as string;

    const account = await api('POST', '/accounts', OP_A, {
      clientId,
      label: 'Smoke settlement account',
      segregationModel: 'SEGREGATED',
      assets: ['GBPX'],
    });
    check('account created (default dual-approval policy)', account.status === 201);
    const wallets = account.json.wallets as { id: string; assetSymbol: string }[];
    const walletId = wallets[0]!.id;

    const allow = await api('POST', `/accounts/${account.json.id as string}/allowlist`, OP_A, {
      assetSymbol: 'GBPX',
      address: 'vc-ext-gbpx-smoke-dest',
      label: 'Smoke payout destination',
    });
    check('address allowlisted (cooling-off starts)', allow.status === 201);

    // Cross the cooling-off boundary on the SIM clock — never by waiting.
    const state = await api('GET', '/simulator/state', ADMIN);
    const now = BigInt(state.json.simClockMs as string);
    const afterCoolingOff = (now + 86_400_000n + 1n).toString();
    const clock = await api('POST', '/simulator/clock/set', ADMIN, { ms: afterCoolingOff });
    check('sim clock advanced past cooling-off', clock.status === 200);

    // --- Deposit lifecycle ---
    console.log('-- deposit lifecycle --');
    const dep = await api('POST', `/wallets/${walletId}/deposits/simulate`, OP_A, {
      amount: '5000.00',
      chainTxRef: 'smoke-dep-1',
    });
    check('deposit registered PENDING_CONFIRMATION', dep.status === 201 && dep.json.state === 'PENDING_CONFIRMATION');
    const depId = dep.json.id as string;

    const adv1 = await api('POST', '/simulator/chain/advance', ADMIN, { blocks: 1 });
    check('chain advanced 1 block (GBPX needs 1 conf)', adv1.status === 200 && (adv1.json.settled as number) >= 1);

    const depAfter = await api('GET', '/withdrawals', OP_A); // deposits aren't listed here; read the wallet
    void depAfter;
    const walletAfterDep = await api('GET', `/wallets/${walletId}`, OP_A);
    check(
      'deposit credited: balance 5000.00',
      walletAfterDep.json.balance === '5000.00',
      `balance=${String(walletAfterDep.json.balance)}`,
    );

    const deliveries = await api('GET', '/webhooks/deliveries', OP_A);
    const events = (deliveries.json.items as { event: string }[]).map((d) => d.event);
    check(
      'deposit.detected + deposit.credited deliveries recorded',
      events.includes('deposit.detected') && events.includes('deposit.credited'),
      `events=${events.join(',')}`,
    );

    // --- Withdrawal lifecycle: above policy threshold AND Travel Rule threshold ---
    console.log('-- withdrawal lifecycle (1500.00 GBPX, cross-VASP) --');
    const wd = await api('POST', '/withdrawals', OP_A, {
      walletId,
      amount: '1500.00',
      counterpartyAddress: 'vc-ext-gbpx-smoke-dest',
      counterpartyVaspId: 'vasp-foxwhelp',
      idempotencyKey: 'smoke-wd-000001',
    });
    check('withdrawal created PENDING_APPROVAL', wd.status === 201 && wd.json.state === 'PENDING_APPROVAL');
    const wdId = wd.json.id as string;

    const makerTry = await api('POST', `/withdrawals/${wdId}/approvals`, OP_A, { decision: 'APPROVE' });
    check('maker cannot check (403)', makerTry.status === 403, `status=${makerTry.status}`);

    const firstApproval = await api('POST', `/withdrawals/${wdId}/approvals`, OP_B, { decision: 'APPROVE' });
    check(
      'first approval recorded, still PENDING_APPROVAL',
      firstApproval.status === 201 && firstApproval.json.state === 'PENDING_APPROVAL',
    );

    const secondApproval = await api('POST', `/withdrawals/${wdId}/approvals`, ADMIN, { decision: 'APPROVE' });
    check(
      'second approval -> TRAVEL_RULE_CHECK (payload required at/above threshold)',
      secondApproval.status === 201 && secondApproval.json.state === 'TRAVEL_RULE_CHECK',
      `state=${String(secondApproval.json.state)}`,
    );

    const tr = await api('POST', `/withdrawals/${wdId}/travel-rule`, CO, {
      originator: { name: 'Smoke Test Custodian Ltd', accountRef: walletId, physicalAddress: '1 Fictional Lane, London' },
      beneficiary: { name: 'Foxwhelp Markets OÜ', accountRef: 'vc-ext-gbpx-smoke-dest' },
    });
    check(
      'travel rule attached -> screening clean -> PENDING_CONFIRMATION',
      tr.status === 201 && tr.json.state === 'PENDING_CONFIRMATION',
      `state=${String(tr.json.state)}`,
    );

    const walletAfterWd = await api('GET', `/wallets/${walletId}`, OP_A);
    check(
      'balance debited amount+fee: 3498.50',
      walletAfterWd.json.balance === '3498.50',
      `balance=${String(walletAfterWd.json.balance)}`,
    );

    const adv2 = await api('POST', '/simulator/chain/advance', ADMIN, { blocks: 1 });
    check('chain advanced -> withdrawal CONFIRMED', adv2.status === 200);
    const wdFinal = await api('GET', `/withdrawals/${wdId}`, OP_A);
    check('withdrawal state CONFIRMED', wdFinal.json.state === 'CONFIRMED', `state=${String(wdFinal.json.state)}`);

    // --- Idempotency probe ---
    const replay = await api('POST', '/withdrawals', OP_A, {
      walletId,
      amount: '1500.00',
      counterpartyAddress: 'vc-ext-gbpx-smoke-dest',
      counterpartyVaspId: 'vasp-foxwhelp',
      idempotencyKey: 'smoke-wd-000001',
    });
    check(
      'idempotency: same key returns SAME withdrawal (200, no duplicate)',
      replay.status === 200 && replay.json.id === wdId,
    );

    // --- Audit completeness for the withdrawal ---
    const audit = await api('GET', `/audit?entityType=Transaction&entityId=${wdId}&limit=100`, CO);
    const actions = (audit.json.items as { action: string }[]).map((a) => a.action);
    const expected = [
      'WITHDRAWAL_CREATED',
      'WITHDRAWAL_APPROVAL_RECORDED',
      'TRANSACTION_APPROVED',
      'TRANSACTION_TRAVEL_RULE_CHECK',
      'TRAVEL_RULE_ATTACHED',
      'TRANSACTION_SCREENING',
      'TRANSACTION_BROADCAST',
      'TRANSACTION_PENDING_CONFIRMATION',
      'TRANSACTION_CONFIRMED',
    ];
    for (const action of expected) {
      check(`audit trail contains ${action}`, actions.includes(action), `have=${actions.join(',')}`);
    }

    // --- Ledger reconciliation invariant ---
    console.log('-- reconciliation invariant --');
    const invariant = execSync('npx tsx scripts/check-invariant.ts', { encoding: 'utf8' });
    process.stdout.write(invariant.split('\n').map((l) => `  ${l}`).join('\n'));
    check('reconciliation invariant holds', invariant.includes('RECONCILIATION OK'));

    console.log(`\n== SMOKE ${failures === 0 ? 'PASSED' : `FAILED (${failures} failing checks)`} ==`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
