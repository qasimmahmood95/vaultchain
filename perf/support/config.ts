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
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PerfConfig;
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
