// Perf configuration loading (D37). Two committed files with different owners:
//   perf/perf.config.json — HAND-AUTHORED scenario parameters + tolerances.
//   perf/baselines.json   — MACHINE-WRITTEN recorded numbers (`pnpm perf:baseline`).
// A perf run compares fresh numbers against the committed baselines using the
// configured multipliers; hard correctness bounds apply regardless of baselines.
// Paths are repo-root-relative, like every other script in scripts/ (run via
// the package.json scripts, which execute from the repo root).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

export interface RegressionTolerance {
  p95Multiplier: number;
  p99Multiplier?: number;
  minThroughputFactor?: number;
}

export interface PerfConfig {
  port: number;
  approvalContention: {
    levels: number[];
    attemptsPerApprover: number;
    repetitions: number;
    referenceLevel: number;
    withdrawalAmount: string;
    fundingAmount: string;
    regression: RegressionTolerance;
  };
  reconciliationLoad: {
    durationMs: number;
    workers: number;
    depositShare: number;
    fundingAmount: string;
    withdrawalAmount: string;
    depositAmount: string;
    regression: RegressionTolerance;
  };
  readPath: {
    scaleWithdrawals: number;
    scaleDeposits: number;
    connections: number;
    durationSec: number;
    pageLimit: number;
    walkLimit: number;
    regression: RegressionTolerance;
  };
}

export interface ReadTargetBaseline {
  p95Ms: number;
  p99Ms: number;
  rps: number;
}

export interface Baselines {
  recordedAt: string;
  machine: { node: string; platform: string; cpus: number };
  approvalContention?: {
    p95MsAtReferenceLevel: number;
    kneeConcurrency: number;
    maxThroughputRps: number;
  };
  reconciliationLoad?: { requestsPerSec: number; p95Ms: number };
  readPath?: Record<string, ReadTargetBaseline>;
}

const CONFIG_PATH = 'perf/perf.config.json';
const BASELINES_PATH = 'perf/baselines.json';

export function loadConfig(): PerfConfig {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PerfConfig;
  assertConfig(cfg);
  return cfg;
}

/**
 * Config invariants (P5 review Minor 1): perf.config.json is the file the
 * design invites people to tune, so a bad edit must fail LOUDLY at load —
 * never silently disarm a gate (e.g. a referenceLevel absent from levels
 * would make the contention regression check compare against 0 and always
 * pass).
 */
function assertConfig(cfg: PerfConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`perf.config.json invalid: ${msg}`);
  };

  const ac = cfg.approvalContention;
  if (ac.levels.length === 0) fail('approvalContention.levels must not be empty');
  if (ac.attemptsPerApprover < 1) fail('approvalContention.attemptsPerApprover must be >= 1');
  for (const level of ac.levels) {
    if (level < 1 || level % ac.attemptsPerApprover !== 0) {
      fail(`approvalContention.levels entry ${level} must be a positive multiple of attemptsPerApprover (${ac.attemptsPerApprover})`);
    }
  }
  if (!ac.levels.includes(ac.referenceLevel)) {
    fail(`approvalContention.referenceLevel ${ac.referenceLevel} is not in levels — the p95 regression gate would silently disarm`);
  }
  if (ac.repetitions < 1) fail('approvalContention.repetitions must be >= 1');

  const rl = cfg.reconciliationLoad;
  if (rl.workers < 1) fail('reconciliationLoad.workers must be >= 1');
  if (rl.durationMs < 1_000) fail('reconciliationLoad.durationMs must be >= 1000');
  if (!(rl.depositShare > 0 && rl.depositShare < 1)) {
    fail('reconciliationLoad.depositShare must be strictly between 0 and 1 — both op kinds must be reachable ("mixed" load)');
  }

  const rp = cfg.readPath;
  if (rp.scaleWithdrawals < 1 || rp.scaleDeposits < 1) fail('readPath scale volumes must be >= 1');
  if (rp.connections < 1) fail('readPath.connections must be >= 1');
  if (rp.durationSec < 1) fail('readPath.durationSec must be >= 1');
  if (rp.walkLimit < 1 || rp.walkLimit > 100) fail('readPath.walkLimit must be 1..100 (the server clamps limit to 100)');
  if (rp.pageLimit < 1 || rp.pageLimit > 100) fail('readPath.pageLimit must be 1..100 (the server clamps limit to 100)');

  for (const [name, reg] of Object.entries({
    approvalContention: ac.regression,
    reconciliationLoad: rl.regression,
    readPath: rp.regression,
  })) {
    if (reg.p95Multiplier < 1) fail(`${name}.regression.p95Multiplier must be >= 1`);
    if (reg.p99Multiplier !== undefined && reg.p99Multiplier < 1) fail(`${name}.regression.p99Multiplier must be >= 1`);
    if (reg.minThroughputFactor !== undefined && !(reg.minThroughputFactor > 0 && reg.minThroughputFactor <= 1)) {
      fail(`${name}.regression.minThroughputFactor must be in (0, 1]`);
    }
  }
}

export function loadBaselines(): Baselines | null {
  if (!existsSync(BASELINES_PATH)) return null;
  return JSON.parse(readFileSync(BASELINES_PATH, 'utf8')) as Baselines;
}

/** Merge scenario patches into baselines.json (creates it on first record). */
export function writeBaselines(patch: Partial<Baselines>): Baselines {
  const current = loadBaselines();
  const next: Baselines = {
    ...(current ?? {}),
    ...patch,
    recordedAt: new Date().toISOString(),
    machine: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length },
  };
  writeFileSync(BASELINES_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
