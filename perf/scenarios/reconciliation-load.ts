// Scenario 2 — reconciliation under load (P5). N worker loops sustain a mixed
// deposit/withdrawal stream against the platform for a configured duration
// (default 60s), then the ledger invariant (Σ(ledger) == wallet.balanceMinor,
// EVERY wallet) must hold — the direct no-lost-update proof. Each worker owns
// its wallet so the load is conflict-free BY DESIGN at the domain level; the
// contention is all infrastructural (the single-connection SQLite pool, the
// global chain-advance settlement loop and its D28 CAS claims), which is
// exactly the layer this scenario interrogates.

import { PrismaClient } from '@prisma/client';
import { RAW_KEYS, makeRng } from '../../scripts/seed-lib.js';
import type { PerfConfig, Baselines } from '../support/config.js';
import { checkInvariant } from '../support/db.js';
import { PerfApi } from '../support/http.js';
import { atLeastFactor, check, withinMultiple, type Check, type ScenarioOutcome } from '../support/outcome.js';
import { resetDatabase, startServer } from '../support/server.js';
import { round2, summarize } from '../support/stats.js';

type OpKind = 'deposit' | 'advance' | 'withdraw' | 'approve';

interface Sample {
  op: OpKind;
  status: number;
  ms: number;
}

interface WorkerCtx {
  index: number;
  walletId: string;
  address: string;
  rng: () => number;
}

const EXPECTED_STATUS: Record<OpKind, number> = { deposit: 201, advance: 200, withdraw: 201, approve: 201 };

export async function runReconciliationLoad(cfg: PerfConfig, baselines: Baselines | null): Promise<ScenarioOutcome> {
  const c = cfg.reconciliationLoad;

  resetDatabase();
  const server = await startServer(cfg.port);
  const prisma = new PrismaClient();
  try {
    const admin = new PerfApi(server.baseUrl, RAW_KEYS.admin);
    const maker = new PerfApi(server.baseUrl, RAW_KEYS.operatorA);
    const checker = new PerfApi(server.baseUrl, RAW_KEYS.operatorB);

    // -- Setup: one funded GBPX wallet + active payout address per worker.
    const workers: WorkerCtx[] = [];
    for (let i = 0; i < c.workers; i += 1) {
      const client = await admin.mustPost(
        '/clients',
        { legalName: `Perf Load Client ${i + 1} (fictional)`, type: 'INSTITUTION', jurisdiction: 'GB' },
        'create client',
      );
      const account = await maker.mustPost(
        '/accounts',
        { clientId: client.id as string, label: `perf load account ${i + 1}`, segregationModel: 'SEGREGATED', assets: ['GBPX'] },
        'create account',
      );
      const wallet = (account.wallets as { id: string }[])[0];
      if (!wallet) throw new Error('setup: account has no wallet');
      await maker.mustPost(
        `/wallets/${wallet.id}/deposits/simulate`,
        { amount: c.fundingAmount, chainTxRef: `perf-load-funding-${i + 1}` },
        'fund wallet',
      );
      const address = `vc-ext-gbpx-perf-load-${i + 1}`;
      await maker.mustPost(
        `/accounts/${account.id as string}/allowlist`,
        { assetSymbol: 'GBPX', address, label: 'perf payout destination' },
        'allowlist address',
      );
      workers.push({ index: i + 1, walletId: wallet.id, address, rng: makeRng(4242 + i) });
    }
    await admin.mustPost('/simulator/chain/advance', { blocks: 2 }, 'credit funding deposits');
    for (const w of workers) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const res = await maker.get(`/wallets/${w.walletId}`);
        if (res.status === 200 && (res.json as { balanceMinor: string }).balanceMinor !== '0') break;
        await admin.mustPost('/simulator/chain/advance', { blocks: 1 }, 'advance chain (credit poll)');
      }
    }
    await admin.mustPost('/simulator/clock/advance', { ms: (25n * 3_600_000n).toString() }, 'pass cooling-off');

    // -- Sustained mixed load until the deadline.
    const samples: Sample[] = [];
    const deadline = performance.now() + c.durationMs;
    const startedAt = performance.now();
    await Promise.all(
      workers.map((w) =>
        workerLoop(w, {
          deadline,
          depositShare: c.depositShare,
          depositAmount: c.depositAmount,
          withdrawalAmount: c.withdrawalAmount,
          maker,
          checker,
          admin,
          samples,
        }),
      ),
    );
    const elapsedSec = (performance.now() - startedAt) / 1000;

    // -- The verdict: the invariant, checked over EVERY wallet (workers' AND
    // the seeded book), with the server quiescent.
    const invariant = await checkInvariant(prisma);

    const total = samples.length;
    const rps = round2(total / elapsedSec);
    const fiveXX = samples.filter((s) => s.status >= 500).length;
    const unexpected = samples.filter((s) => s.status < 500 && s.status !== EXPECTED_STATUS[s.op]).length;
    const overall = summarize(samples.map((s) => s.ms));

    const summaryLines: string[] = [
      `duration ${round2(elapsedSec)}s  workers ${c.workers}  requests ${total}  throughput ${rps} req/s`,
      'op        count   p50 ms    p95 ms    p99 ms    max ms',
    ];
    for (const op of ['deposit', 'advance', 'withdraw', 'approve'] as OpKind[]) {
      const stats = summarize(samples.filter((s) => s.op === op).map((s) => s.ms));
      summaryLines.push(
        `${op.padEnd(10)}${String(stats.count).padEnd(8)}${String(stats.p50Ms).padEnd(10)}${String(stats.p95Ms).padEnd(10)}` +
          `${String(stats.p99Ms).padEnd(10)}${String(stats.maxMs)}`,
      );
    }
    summaryLines.push(
      `overall: p50 ${overall.p50Ms}ms  p95 ${overall.p95Ms}ms  p99 ${overall.p99Ms}ms`,
      `invariant: ${invariant.mismatches.length === 0 ? 'HOLDS' : 'BROKEN'} across ${invariant.wallets} wallets`,
    );

    const hardChecks: Check[] = [
      check(
        'reconciliation invariant holds after load',
        invariant.mismatches.length === 0,
        invariant.mismatches.length === 0
          ? `Σ(ledger) == balance for all ${invariant.wallets} wallets`
          : invariant.mismatches
              .slice(0, 3)
              .map((m) => `${m.walletId} drift ${(m.ledger - m.balance).toString()}`)
              .join(' | '),
      ),
      check('no 5xx under sustained load', fiveXX === 0, `${fiveXX} responses >= 500 of ${total}`),
      check('no unexpected statuses', unexpected === 0, `${unexpected} responses off the designed happy path`),
    ];

    const regressionChecks: Check[] = [];
    if (baselines?.reconciliationLoad) {
      regressionChecks.push(
        withinMultiple('overall p95', overall.p95Ms, baselines.reconciliationLoad.p95Ms, c.regression.p95Multiplier, 'ms'),
        atLeastFactor(
          'throughput',
          rps,
          baselines.reconciliationLoad.requestsPerSec,
          c.regression.minThroughputFactor ?? 0.33,
          ' req/s',
        ),
      );
    }

    return {
      name: 'reconciliation-under-load',
      summaryLines,
      hardChecks,
      regressionChecks,
      baselinePatch: { reconciliationLoad: { requestsPerSec: rps, p95Ms: overall.p95Ms } },
    };
  } finally {
    await prisma.$disconnect();
    await server.stop();
  }
}

async function workerLoop(
  w: WorkerCtx,
  env: {
    deadline: number;
    depositShare: number;
    depositAmount: string;
    withdrawalAmount: string;
    maker: PerfApi;
    checker: PerfApi;
    admin: PerfApi;
    samples: Sample[];
  },
): Promise<void> {
  let seq = 0;
  while (performance.now() < env.deadline) {
    seq += 1;
    if (w.rng() < env.depositShare) {
      const dep = await env.maker.post(`/wallets/${w.walletId}/deposits/simulate`, {
        amount: env.depositAmount,
        chainTxRef: `perf-rl-${w.index}-${seq}`,
      });
      env.samples.push({ op: 'deposit', status: dep.status, ms: dep.ms });
      const adv = await env.admin.post('/simulator/chain/advance', { blocks: 1 });
      env.samples.push({ op: 'advance', status: adv.status, ms: adv.ms });
    } else {
      const wd = await env.maker.post('/withdrawals', {
        walletId: w.walletId,
        amount: env.withdrawalAmount,
        counterpartyAddress: w.address,
      });
      env.samples.push({ op: 'withdraw', status: wd.status, ms: wd.ms });
      if (wd.status === 201) {
        const id = (wd.json as { id: string }).id;
        const ap = await env.checker.post(`/withdrawals/${id}/approvals`, { decision: 'APPROVE' });
        env.samples.push({ op: 'approve', status: ap.status, ms: ap.ms });
      }
    }
  }
}
