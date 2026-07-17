// Scenario 3 — read-path baseline (P5). Cursor-paged list endpoints at
// REALISTIC volume: the standard seed plus an at-scale, ledger-consistent
// block of 20k withdrawals + 20k deposits (+ audit rows). First a full
// cursor-chain walk proves paging is CORRECT at volume (complete, duplicate-
// free, terminating); then autocannon drives sustained GET load per target
// while the harness collects every response time off the instance's
// `response` event — autocannon's summary histogram exposes p90/p97.5/p99
// but not p95, so exact p50/p95/p99 are computed from the full sample set
// (D36) and autocannon contributes connection management + req/s.

import autocannon from 'autocannon';
import { PrismaClient } from '@prisma/client';
import { RAW_KEYS } from '../../scripts/seed-lib.js';
import type { PerfConfig, Baselines, ReadTargetBaseline } from '../support/config.js';
import { seedReadPathScale } from '../support/db.js';
import { PerfApi } from '../support/http.js';
import { check, withinMultiple, type Check, type ScenarioOutcome } from '../support/outcome.js';
import { resetDatabase, startServer } from '../support/server.js';
import { round2, summarize } from '../support/stats.js';

interface TargetRun {
  name: string;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  non2xx: number;
  errors: number;
}

export async function runReadPath(cfg: PerfConfig, baselines: Baselines | null): Promise<ScenarioOutcome> {
  const c = cfg.readPath;

  resetDatabase();
  const prisma = new PrismaClient();
  let expectedWithdrawals: number;
  try {
    await seedReadPathScale(prisma, { withdrawals: c.scaleWithdrawals, deposits: c.scaleDeposits });
    expectedWithdrawals = await prisma.transaction.count({ where: { type: 'WITHDRAWAL' } });
  } finally {
    await prisma.$disconnect();
  }

  const server = await startServer(cfg.port);
  try {
    const operator = new PerfApi(server.baseUrl, RAW_KEYS.operatorA);

    // -- Correctness first: walk the ENTIRE cursor chain.
    const seen = new Set<string>();
    let duplicates = 0;
    let pages = 0;
    let deepCursor: string | null = null;
    const expectedPages = Math.ceil(expectedWithdrawals / c.walkLimit);
    let cursor: string | null = null;
    for (;;) {
      const path: string = `/withdrawals?limit=${c.walkLimit}${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await operator.get(path);
      if (res.status !== 200) throw new Error(`cursor walk: ${res.status} at page ${pages}`);
      const body = res.json as { items: { id: string }[]; nextCursor: string | null };
      pages += 1;
      for (const item of body.items) {
        if (seen.has(item.id)) duplicates += 1;
        seen.add(item.id);
      }
      if (pages === Math.floor(expectedPages / 2)) deepCursor = body.nextCursor;
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
      if (pages > expectedPages + 5) throw new Error('cursor walk: chain did not terminate');
    }

    const walkOk = seen.size === expectedWithdrawals && duplicates === 0;
    const summaryLines: string[] = [
      `data volume: ${expectedWithdrawals} withdrawals (+${c.scaleDeposits} scale deposits, + the standard seed)`,
      `cursor walk: ${pages} pages of ${c.walkLimit} -> ${seen.size}/${expectedWithdrawals} rows, ${duplicates} duplicates`,
    ];

    // -- Sustained GET load per target, exact percentiles from samples.
    if (deepCursor === null) throw new Error('cursor walk: no deep cursor captured');
    const targets: { name: string; url: string; apiKey: string }[] = [
      { name: 'withdrawals-first-page', url: `${server.baseUrl}/withdrawals?limit=${c.pageLimit}`, apiKey: RAW_KEYS.operatorA },
      {
        name: 'withdrawals-deep-page',
        url: `${server.baseUrl}/withdrawals?limit=${c.pageLimit}&cursor=${deepCursor}`,
        apiKey: RAW_KEYS.operatorA,
      },
      { name: 'audit-first-page', url: `${server.baseUrl}/audit?limit=${c.pageLimit}`, apiKey: RAW_KEYS.compliance },
    ];

    const runs: TargetRun[] = [];
    summaryLines.push('target                    req/s     p50 ms    p95 ms    p99 ms    non-2xx');
    for (const target of targets) {
      const run = await runCannon(target.name, target.url, target.apiKey, c);
      runs.push(run);
      summaryLines.push(
        `${target.name.padEnd(26)}${String(run.rps).padEnd(10)}${String(run.p50Ms).padEnd(10)}${String(run.p95Ms).padEnd(10)}` +
          `${String(run.p99Ms).padEnd(10)}${run.non2xx}`,
      );
    }

    const totalNon2xx = runs.reduce((a, r) => a + r.non2xx, 0);
    const totalErrors = runs.reduce((a, r) => a + r.errors, 0);
    const hardChecks: Check[] = [
      check(
        'cursor paging correct at volume',
        walkOk,
        `${seen.size}/${expectedWithdrawals} unique rows over ${pages} pages, ${duplicates} duplicates`,
      ),
      check('all load responses 2xx', totalNon2xx === 0, `${totalNon2xx} non-2xx responses`),
      check('no socket errors/timeouts', totalErrors === 0, `${totalErrors} autocannon errors`),
    ];

    const regressionChecks: Check[] = [];
    const baselinePatch: Record<string, ReadTargetBaseline> = {};
    for (const run of runs) {
      baselinePatch[run.name] = { p95Ms: run.p95Ms, p99Ms: run.p99Ms, rps: run.rps };
      const base = baselines?.readPath?.[run.name];
      if (base) {
        regressionChecks.push(
          withinMultiple(`${run.name} p95`, run.p95Ms, base.p95Ms, c.regression.p95Multiplier, 'ms'),
          withinMultiple(`${run.name} p99`, run.p99Ms, base.p99Ms, c.regression.p99Multiplier ?? c.regression.p95Multiplier, 'ms'),
        );
      }
    }

    return {
      name: 'read-path-baseline',
      summaryLines,
      hardChecks,
      regressionChecks,
      baselinePatch: { readPath: baselinePatch },
    };
  } finally {
    await server.stop();
  }
}

function runCannon(
  name: string,
  url: string,
  apiKey: string,
  c: PerfConfig['readPath'],
): Promise<TargetRun> {
  return new Promise((resolve, reject) => {
    const samples: number[] = [];
    let non2xx = 0;
    const instance = autocannon(
      {
        url,
        connections: c.connections,
        duration: c.durationSec,
        headers: { 'x-api-key': apiKey },
      },
      (err, result) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const stats = summarize(samples);
        resolve({
          name,
          rps: round2(result.requests.average),
          p50Ms: stats.p50Ms,
          p95Ms: stats.p95Ms,
          p99Ms: stats.p99Ms,
          non2xx,
          errors: result.errors + result.timeouts,
        });
      },
    );
    instance.on('response', (_client, statusCode, _resBytes, responseTime) => {
      samples.push(responseTime);
      if (statusCode < 200 || statusCode >= 300) non2xx += 1;
    });
  });
}
