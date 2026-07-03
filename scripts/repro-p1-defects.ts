// Defect-branch repro harness — proves each BUGS.md "Reproduce" recipe on
// defects-planted. NOT committed (removed after evidence capture).
import { execSync } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { feeFor, roundHalfEvenDiv } from '../src/services/money.js';
import { RAW_KEYS } from './seed-lib.js';

const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;

async function api(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-api-key': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} };
}

const results: string[] = [];
function rec(bug: string, reproduced: boolean, detail: string) {
  results.push(`${reproduced ? 'REPRODUCED    ' : 'NOT-REPRODUCED'}  ${bug}: ${detail}`);
}

async function main(): Promise<void> {
  // BUG-001: fee uses float/floor rather than exact half-even (money boundary case).
  const correct = roundHalfEvenDiv(1500n * 10n, 10_000n); // 1.5 -> half-even -> 2
  const buggy = feeFor(1500n, 10n);
  rec('BUG-001', buggy !== correct, `feeFor(1500,10)=${buggy}, correct half-even=${correct} (.5 boundary truncated)`);

  execSync('npx tsx scripts/seed-demo.ts', { stdio: 'pipe' });
  const app = buildApp();
  await app.listen({ port: PORT, host: '127.0.0.1' });
  try {
    const ADMIN = RAW_KEYS.admin;
    const OP_A = RAW_KEYS.operatorA;
    const OP_B = RAW_KEYS.operatorB;
    const CO = RAW_KEYS.compliance;

    const client = await api('POST', '/clients', ADMIN, { legalName: 'Repro Co', type: 'INSTITUTION', jurisdiction: 'GB', vaspId: 'vasp-repro' });
    const cid = client.json.id as string;
    const acct = await api('POST', '/accounts', OP_A, { clientId: cid, label: 'repro', segregationModel: 'SEGREGATED', assets: ['GBPX'] });
    const walletId = (acct.json.wallets as { id: string }[])[0]!.id;
    const st = await api('GET', '/simulator/state', ADMIN);
    await api('POST', '/simulator/clock/set', ADMIN, { ms: (BigInt(st.json.simClockMs as string) + 90_000_000n).toString() });
    await api('POST', `/accounts/${acct.json.id as string}/allowlist`, OP_A, { assetSymbol: 'GBPX', address: 'vc-ext-gbpx-repro', label: 'dest' });
    await api('POST', `/wallets/${walletId}/deposits/simulate`, OP_A, { amount: '9000.00', chainTxRef: 'repro-dep' });
    await api('POST', '/simulator/chain/advance', ADMIN, { blocks: 1 });

    // BUG-002: two approvals from ONE non-maker operator reach APPROVED.
    const wd2 = await api('POST', '/withdrawals', OP_A, { walletId, amount: '2000.00', counterpartyAddress: 'vc-ext-gbpx-repro', idempotencyKey: 'repro-b2-0001' });
    await api('POST', `/withdrawals/${wd2.json.id as string}/approvals`, OP_B, { decision: 'APPROVE' });
    const a2 = await api('POST', `/withdrawals/${wd2.json.id as string}/approvals`, OP_B, { decision: 'APPROVE' });
    const wd2f = await api('GET', `/withdrawals/${wd2.json.id as string}`, OP_A);
    const approvers = (wd2f.json.approvals as { approverApiKeyId: string }[]) ?? [];
    const distinct = new Set(approvers.map((a) => a.approverApiKeyId)).size;
    const progressed = ['APPROVED', 'SCREENING', 'BROADCAST', 'PENDING_CONFIRMATION', 'TRAVEL_RULE_CHECK', 'CONFIRMED'].includes(wd2f.json.state as string);
    rec('BUG-002', a2.status === 201 && progressed && distinct < 2, `2 approvals from ONE operator -> state=${wd2f.json.state as string}, distinctApprovers=${distinct}`);

    // BUG-003: exactly-threshold cross-VASP, driven to APPROVED (two distinct approvers),
    // then broadcast WITHOUT any Travel-Rule record — the `>` off-by-one skips the gate.
    const wd3 = await api('POST', '/withdrawals', OP_A, { walletId, amount: '1000.00', counterpartyAddress: 'vc-ext-gbpx-repro', counterpartyVaspId: 'vasp-foxwhelp', idempotencyKey: 'repro-b3-0001' });
    await api('POST', `/withdrawals/${wd3.json.id as string}/approvals`, OP_B, { decision: 'APPROVE' });
    await api('POST', `/withdrawals/${wd3.json.id as string}/approvals`, ADMIN, { decision: 'APPROVE' });
    const wd3f = await api('GET', `/withdrawals/${wd3.json.id as string}`, OP_A);
    const trCount = ((wd3f.json.travelRule as unknown[]) ?? []).length;
    const pastGate = ['BROADCAST', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(wd3f.json.state as string);
    rec('BUG-003', pastGate && trCount === 0, `exactly 1000.00 cross-VASP, 2 approvals -> state=${wd3f.json.state as string}, travelRuleRecords=${trCount} (skipped TRAVEL_RULE_CHECK)`);

    // BUG-004: a fresh address, still inside its SIM-clock cooling-off window, is usable
    // immediately because isActive() reads wall-clock Date.now() (2026) >> activatesAt (sim 2025+24h).
    // Correct behaviour (main) blocks with 422; buggy branch allows (201).
    const acct4 = await api('POST', '/accounts', OP_A, { clientId: cid, label: 'repro4', segregationModel: 'SEGREGATED', assets: ['GBPX'] });
    const w4 = (acct4.json.wallets as { id: string }[])[0]!.id;
    await api('POST', `/wallets/${w4}/deposits/simulate`, OP_A, { amount: '5000.00', chainTxRef: 'repro-dep4' });
    await api('POST', '/simulator/chain/advance', ADMIN, { blocks: 1 }); // +60s sim time — far short of the 24h cooling-off
    await api('POST', `/accounts/${acct4.json.id as string}/allowlist`, OP_A, { assetSymbol: 'GBPX', address: 'vc-ext-gbpx-repro4', label: 'fresh' });
    // Deliberately do NOT advance the sim clock past cooling-off.
    const wd4 = await api('POST', '/withdrawals', OP_A, { walletId: w4, amount: '100.00', counterpartyAddress: 'vc-ext-gbpx-repro4', idempotencyKey: 'repro-b4-0001' });
    rec('BUG-004', wd4.status === 201, `fresh address within sim-clock cooling-off wrongly usable: status=${wd4.status} (correct=422 cooling-off; wall-clock bypass)`);

    // BUG-005: OPERATOR can release a compliance hold.
    const holds = await api('GET', '/holds?state=OPEN', CO);
    const holdId = (holds.json.items as { id: string }[])[0]!.id;
    const rel = await api('POST', `/holds/${holdId}/release`, OP_A);
    rec('BUG-005', rel.status === 200, `operator POST /holds/{id}/release -> status=${rel.status} (expected 403)`);

    // BUG-006: releasing a hold writes no audit entry.
    const audit6 = await api('GET', `/audit?entityType=ComplianceHold&entityId=${holdId}&limit=50`, CO);
    const actions6 = ((audit6.json.items as { action: string }[]) ?? []).map((a) => a.action);
    rec('BUG-006', !actions6.includes('HOLD_RELEASED'), `hold ${holdId} audit actions=[${actions6.join(',')}] (HOLD_RELEASED missing)`);

    // BUG-007: replaying deposit.detected double-credits.
    const acct7 = await api('POST', '/accounts', OP_A, { clientId: cid, label: 'repro7', segregationModel: 'SEGREGATED', assets: ['GBPX'] });
    const w7 = (acct7.json.wallets as { id: string }[])[0]!.id;
    const dep7 = await api('POST', `/wallets/${w7}/deposits/simulate`, OP_A, { amount: '1000.00', chainTxRef: 'repro-dep7' });
    await api('POST', '/simulator/chain/advance', ADMIN, { blocks: 1 });
    const before7 = await api('GET', `/wallets/${w7}`, OP_A);
    const deliveries = await api('GET', '/webhooks/deliveries?event=deposit.detected', OP_A);
    const dd = ((deliveries.json.items as { id: string; payload: string }[]) ?? []).find((d) => (JSON.parse(d.payload) as { transactionId?: string }).transactionId === (dep7.json.id as string));
    await api('POST', `/simulator/webhooks/${dd!.id}/replay`, ADMIN);
    const after7 = await api('GET', `/wallets/${w7}`, OP_A);
    rec('BUG-007', before7.json.balance !== after7.json.balance, `balance before replay=${before7.json.balance as string}, after=${after7.json.balance as string} (double-credit)`);
  } finally {
    await app.close();
  }

  console.log(results.join('\n'));
  if (results.some((r) => r.startsWith('NOT-REPRODUCED'))) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
