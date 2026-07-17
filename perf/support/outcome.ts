// The contract between a perf scenario and the runner (D37): every scenario
// returns human-readable summary lines, HARD checks (absolute correctness —
// evaluated always), REGRESSION checks (against committed baselines — already
// evaluated by the scenario when baselines exist), and the baseline patch to
// write in `pnpm perf:baseline` mode.

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ScenarioOutcome {
  name: string;
  summaryLines: string[];
  hardChecks: Check[];
  regressionChecks: Check[];
  baselinePatch: Record<string, unknown>;
}

export function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

/** Regression helper: value must not exceed baseline × multiplier. */
export function withinMultiple(
  name: string,
  value: number,
  baseline: number,
  multiplier: number,
  unit: string,
): Check {
  const bound = baseline * multiplier;
  return check(
    name,
    value <= bound,
    `${value}${unit} vs baseline ${baseline}${unit} (allowed <= ${Math.round(bound * 100) / 100}${unit})`,
  );
}

/** Regression helper: value must not fall below baseline × factor. */
export function atLeastFactor(
  name: string,
  value: number,
  baseline: number,
  factor: number,
  unit: string,
): Check {
  const bound = baseline * factor;
  return check(
    name,
    value >= bound,
    `${value}${unit} vs baseline ${baseline}${unit} (allowed >= ${Math.round(bound * 100) / 100}${unit})`,
  );
}
