// Scenario 1 — approval contention (P5). N concurrent approval attempts on a
// SHARED withdrawal at increasing concurrency, asserting the maker-checker
// CAS holds at every level: racing losers get their DESIGNED 409s, never a
// 5xx, and the (transactionId, approverApiKeyId) uniqueness is intact in the
// DB afterwards. Each approver fires twice per volley, so both contention
// classes are exercised at once: distinct-approver racing (state flip) and
// same-approver double-submit (unique-constraint claim).
//
// The knee point is the concurrency where throughput saturates (>= 90% of
// max observed — see stats.findKnee): with every write transaction
// serialized behind one SQLite connection (D35), latency beyond the knee
// buys queue depth, not throughput.

import { PrismaClient } from '@prisma/client';
import { RAW_KEYS } from '../../scripts/seed-lib.js';
import type { PerfConfig, Baselines } from '../support/config.js';
import { seedPerfOperators, perfOperatorKey } from '../support/db.js';
import { PerfApi } from '../support/http.js';
import { check, withinMultiple, type Check, type ScenarioOutcome } from '../support/outcome.js';
import { resetDatabase, startServer } from '../support/server.js';
import { findKnee, median, round2, summarize, type LevelPoint } from '../support/stats.js';

interface VolleyResult {
  wallMs: number;
  latenciesMs: number[];
  statuses: Map<number, number>;
  problems: string[];
}

export async function runApprovalContention(cfg: PerfConfig, baselines: Baselines | null): Promise<ScenarioOutcome> {
  const c = cfg.approvalContention;
  const maxApprovers = Math.max(...c.levels) / c.attemptsPerApprover;

  resetDatabase();
  const prisma = new PrismaClient();
  const summaryLines: string[] = [];
  const hardChecks: Check[] = [];
  try {
    await seedPerfOperators(prisma, maxApprovers);
    const server = await startServer(cfg.port);
    try {
      const admin = new PerfApi(server.baseUrl, RAW_KEYS.admin);
      const maker = new PerfApi(server.baseUrl, RAW_KEYS.operatorA);

      // -- Setup: one funded GBPX wallet with an active payout address.
      // No counterparty VASP on the withdrawals -> domestic -> no Travel-Rule
      // gate; 1500.00 is above the default policy threshold -> dual approval.
      const client = await admin.mustPost(
        '/clients',
        { legalName: 'Perf Contention Client (fictional)', type: 'INSTITUTION', jurisdiction: 'GB' },
        'create client',
      );
      const account = await maker.mustPost(
        '/accounts',
        { clientId: client.id as string, label: 'perf contention account', segregationModel: 'SEGREGATED', assets: ['GBPX'] },
        'create account',
      );
      const wallet = (account.wallets as { id: string }[])[0];
      if (!wallet) throw new Error('setup: account has no wallet');
      await maker.mustPost(
        `/wallets/${wallet.id}/deposits/simulate`,
        { amount: c.fundingAmount, chainTxRef: 'perf-contention-funding' },
        'fund wallet',
      );
      await admin.mustPost('/simulator/chain/advance', { blocks: 2 }, 'advance chain');
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const w = await maker.get(`/wallets/${wallet.id}`);
        if (w.status === 200 && (w.json as { balanceMinor: string }).balanceMinor !== '0') break;
        await admin.mustPost('/simulator/chain/advance', { blocks: 1 }, 'advance chain (credit poll)');
      }
      const address = 'vc-ext-gbpx-perf-contention';
      await maker.mustPost(
        `/accounts/${account.id as string}/allowlist`,
        { assetSymbol: 'GBPX', address, label: 'perf payout destination' },
        'allowlist address',
      );
      await admin.mustPost('/simulator/clock/advance', { ms: (25n * 3_600_000n).toString() }, 'pass cooling-off');

      // -- The volleys.
      let total5xx = 0;
      let totalUnexpectedStatus = 0;
      const volleyProblems: string[] = [];
      const points: LevelPoint[] = [];
      let p95AtReference = 0;

      summaryLines.push(
        'level  approvers  reps  p95 ms    p99 ms    median wall ms  throughput rps  statuses',
      );
      for (const level of c.levels) {
        const approverCount = level / c.attemptsPerApprover;
        const volleys: VolleyResult[] = [];
        for (let rep = 0; rep < c.repetitions; rep += 1) {
          volleys.push(await runVolley({ maker, server: server.baseUrl, walletId: wallet.id, address, level, approverCount, cfg: c }));
        }
        const latencies = volleys.flatMap((v) => v.latenciesMs);
        const stats = summarize(latencies);
        const wallMedian = median(volleys.map((v) => v.wallMs));
        const throughput = round2(level / (wallMedian / 1000));
        points.push({ concurrency: level, throughputRps: throughput });
        if (level === c.referenceLevel) p95AtReference = stats.p95Ms;

        const statuses = new Map<number, number>();
        for (const v of volleys) for (const [s, n] of v.statuses) statuses.set(s, (statuses.get(s) ?? 0) + n);
        for (const [s, n] of statuses) {
          if (s >= 500) total5xx += n;
          else if (s !== 201 && s !== 409) totalUnexpectedStatus += n;
        }
        for (const v of volleys) volleyProblems.push(...v.problems);

        const statusStr = [...statuses.entries()]
          .sort(([a], [b]) => a - b)
          .map(([s, n]) => `${s}x${n}`)
          .join(' ');
        summaryLines.push(
          `${String(level).padEnd(7)}${String(approverCount).padEnd(11)}${String(c.repetitions).padEnd(6)}` +
            `${String(stats.p95Ms).padEnd(10)}${String(stats.p99Ms).padEnd(10)}${String(round2(wallMedian)).padEnd(16)}` +
            `${String(throughput).padEnd(16)}${statusStr}`,
        );
      }

      const knee = findKnee(points);
      const maxThroughput = Math.max(...points.map((p) => p.throughputRps));
      summaryLines.push(
        `knee point: concurrency ${knee} (first level reaching >=90% of max throughput ${maxThroughput} rps — beyond it, added concurrency buys queue depth, not throughput)`,
      );

      // -- DB truth: no approver ever recorded two decisions on one withdrawal.
      const dupGroups = await prisma.approval.groupBy({
        by: ['transactionId', 'approverApiKeyId'],
        _count: { _all: true },
        having: { approverApiKeyId: { _count: { gt: 1 } } },
      });

      hardChecks.push(
        check('no 5xx under contention', total5xx === 0, `${total5xx} responses >= 500`),
        check(
          'losers get designed statuses (201/409 only)',
          totalUnexpectedStatus === 0,
          `${totalUnexpectedStatus} responses outside {201, 409}`,
        ),
        check(
          'no duplicate approvals (DB sweep)',
          dupGroups.length === 0,
          `${dupGroups.length} (transactionId, approver) pairs with >1 row`,
        ),
        check(
          'per-volley state machine correct',
          volleyProblems.length === 0,
          volleyProblems.length === 0 ? 'every volley: exact winner count, distinct approvers, expected final state' : volleyProblems.slice(0, 5).join(' | '),
        ),
      );

      const regressionChecks: Check[] = [];
      if (baselines?.approvalContention) {
        regressionChecks.push(
          withinMultiple(
            `p95 at concurrency ${c.referenceLevel}`,
            p95AtReference,
            baselines.approvalContention.p95MsAtReferenceLevel,
            c.regression.p95Multiplier,
            'ms',
          ),
        );
      }

      return {
        name: 'approval-contention',
        summaryLines,
        hardChecks,
        regressionChecks,
        baselinePatch: {
          approvalContention: {
            p95MsAtReferenceLevel: p95AtReference,
            kneeConcurrency: knee,
            maxThroughputRps: maxThroughput,
          },
        },
      };
    } finally {
      await server.stop();
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function runVolley(opts: {
  maker: PerfApi;
  server: string;
  walletId: string;
  address: string;
  level: number;
  approverCount: number;
  cfg: PerfConfig['approvalContention'];
}): Promise<VolleyResult> {
  const { maker, level, approverCount } = opts;
  const wd = await maker.mustPost(
    '/withdrawals',
    { walletId: opts.walletId, amount: opts.cfg.withdrawalAmount, counterpartyAddress: opts.address },
    'create shared withdrawal',
  );
  const txId = wd.id as string;

  const shots: PerfApi[] = [];
  for (let i = 1; i <= approverCount; i += 1) {
    const approver = new PerfApi(opts.server, perfOperatorKey(i));
    for (let a = 0; a < opts.cfg.attemptsPerApprover; a += 1) shots.push(approver);
  }

  const started = performance.now();
  const responses = await Promise.all(shots.map((api) => api.post(`/withdrawals/${txId}/approvals`, { decision: 'APPROVE' })));
  const wallMs = performance.now() - started;

  const statuses = new Map<number, number>();
  for (const r of responses) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);

  // State-machine truth for THIS volley, read back through the API.
  const problems: string[] = [];
  const n201 = statuses.get(201) ?? 0;
  const expected201 = Math.min(2, approverCount);
  if (n201 !== expected201) problems.push(`level ${level}: ${n201} winners, expected ${expected201}`);

  const detail = await maker.get(`/withdrawals/${txId}`);
  if (detail.status !== 200) {
    problems.push(`level ${level}: detail read failed (${detail.status})`);
  } else {
    const body = detail.json as { state: string; approvals: { approverApiKeyId: string }[] };
    const approverIds = body.approvals.map((a) => a.approverApiKeyId);
    if (approverIds.length !== n201) {
      problems.push(`level ${level}: ${approverIds.length} approval rows for ${n201} winners`);
    }
    if (new Set(approverIds).size !== approverIds.length) {
      problems.push(`level ${level}: duplicate approver in recorded approvals`);
    }
    // A completed dual approval progresses APPROVED -> (Travel Rule skipped,
    // domestic) -> SCREENING (clean) -> BROADCAST -> PENDING_CONFIRMATION in
    // the winning request; broadcast is momentary (the debit lands there).
    const expectedState = approverCount >= 2 ? 'PENDING_CONFIRMATION' : 'PENDING_APPROVAL';
    if (body.state !== expectedState) {
      problems.push(`level ${level}: state ${body.state}, expected ${expectedState}`);
    }
  }

  return { wallMs, latenciesMs: responses.map((r) => r.ms), statuses, problems };
}
