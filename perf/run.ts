// P5 perf runner (D36/D37). Usage (from the repo root):
//
//   pnpm perf                         run all scenarios, evaluate against committed baselines
//   pnpm perf -- --scenario=<name>    one of: approval-contention | reconciliation-under-load | read-path-baseline
//   pnpm perf:baseline                run all scenarios and (re)write perf/baselines.json
//
// Exit code is the verdict: non-zero on any HARD correctness violation
// (5xx, duplicate approvals, invariant breach, broken paging) or any
// REGRESSION beyond the perf.config.json tolerances against the committed
// baselines. Baselines are machine-relative; the hard bounds are not.

import { loadBaselines, loadConfig, writeBaselines, type Baselines } from './support/config.js';
import type { ScenarioOutcome } from './support/outcome.js';
import { runApprovalContention } from './scenarios/approval-contention.js';
import { runReconciliationLoad } from './scenarios/reconciliation-load.js';
import { runReadPath } from './scenarios/read-path.js';

const SCENARIOS: Record<string, (cfg: ReturnType<typeof loadConfig>, base: Baselines | null) => Promise<ScenarioOutcome>> = {
  'approval-contention': runApprovalContention,
  'reconciliation-under-load': runReconciliationLoad,
  'read-path-baseline': runReadPath,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const updateBaselines = args.includes('--update-baselines');
  const scenarioArg = args.find((a) => a.startsWith('--scenario='))?.slice('--scenario='.length);

  // Baselines are ONE machine's coherent snapshot (P5 review Minor 4): a
  // partial re-record would merge fresh numbers under a new recordedAt/
  // machine stamp while the untouched scenarios keep numbers from somewhere
  // else — falsifying exactly the provenance PERFORMANCE.md promises.
  if (updateBaselines && scenarioArg) {
    console.error('perf:baseline records ALL scenarios together — a partial re-record would falsify machine provenance for the untouched scenarios. Run `pnpm perf:baseline` with no scenario filter.');
    process.exitCode = 2;
    return;
  }

  const names = scenarioArg ? [scenarioArg] : Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) {
      console.error(`unknown scenario "${name}" — expected one of: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exitCode = 2;
      return;
    }
  }

  const cfg = loadConfig();
  const baselines = loadBaselines();
  if (!updateBaselines && !baselines) {
    console.error('no perf/baselines.json found — run `pnpm perf:baseline` once to record baselines.');
    process.exitCode = 2;
    return;
  }

  let failed = false;
  const patches: Record<string, unknown>[] = [];
  for (const name of names) {
    console.log(`\n=== perf: ${name} ===`);
    const runner = SCENARIOS[name];
    if (!runner) continue;
    const outcome = await runner(cfg, baselines);
    for (const line of outcome.summaryLines) console.log(`  ${line}`);

    console.log('  -- hard checks');
    for (const c of outcome.hardChecks) {
      console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
      if (!c.ok) failed = true;
    }
    if (updateBaselines) {
      patches.push(outcome.baselinePatch);
      console.log('  -- regression checks skipped (recording baselines)');
    } else if (outcome.regressionChecks.length === 0) {
      console.log('  -- no baseline recorded for this scenario (run `pnpm perf:baseline`)');
      failed = true;
    } else {
      console.log('  -- regression checks (vs committed baselines)');
      for (const c of outcome.regressionChecks) {
        console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
        if (!c.ok) failed = true;
      }
    }
  }

  if (updateBaselines) {
    if (failed) {
      console.log('\nHARD checks failed — baselines NOT written (fix correctness first).');
    } else {
      const merged = patches.reduce<Record<string, unknown>>((acc, p) => ({ ...acc, ...p }), {});
      const next = writeBaselines(merged as Partial<Baselines>);
      console.log(`\nbaselines written to perf/baselines.json (recordedAt ${next.recordedAt})`);
    }
  }

  console.log(`\n== PERF ${failed ? 'FAILED' : 'PASSED'} ==`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
