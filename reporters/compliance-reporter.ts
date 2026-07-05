// Compliance gate reporter (PRD §B.5). Implements the Playwright Reporter
// interface to emit a HUMAN-READABLE gate summary — not just pass/fail: for
// each compliance control it lists the assertions run, the boundary cases
// exercised, and any gaps (controls with no passing evidence, missing
// boundaries), then writes gate-summary.md + gate-summary.html at the repo
// root (both gitignored run artifacts; CI uploads them, evidence captures the
// md). `onEnd` returns a promise Playwright awaits, so the files are flushed
// before the job finishes.
//
// DETERMINISM IS A FEATURE: no wall-clock timestamps, no durations, stable
// sort order (declaration order within a file, then file path) — an identical
// run produces identical bytes, so evidence diffs are meaningful.
//
// Tests opt in with tag '@compliance' and map themselves to a control via a
// static annotation: { type: 'rule', description: '<CONTROL-ID>' }. Boundary
// cases add { type: 'boundary', description: 'T=1000.00' } and are accounted
// per control (e.g. "Travel-Rule coverage: 2/3 boundary cases — MISSING at
// T=1000.00").

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter';

/** The compliance controls the gate is expected to evidence (PRD §B.3). */
const CONTROLS: Record<string, { title: string; coverageLabel: string }> = {
  'TR-16-BOUNDARY': {
    title: 'Travel Rule — originator + beneficiary data required at/above the 1000.00 fiat threshold (PRD §A.3.3)',
    coverageLabel: 'Travel-Rule coverage',
  },
  'MC-DUAL-APPROVAL': {
    title: 'Dual approval — N distinct non-maker approvers; maker≠checker holds under concurrency (PRD §A.3.2)',
    coverageLabel: 'Dual-approval coverage',
  },
  'SOD-HOLD-RESOLUTION': {
    title: 'Segregation of duties — only a compliance officer resolves screening holds, on every surface (PRD §A.4)',
    coverageLabel: 'Segregation-of-duties coverage',
  },
  'AUD-COMPLETENESS': {
    title: 'Audit completeness — every state transition audited with actor + before/after, exactly once (PRD §A.1)',
    coverageLabel: 'Audit-completeness coverage',
  },
};

const UNMAPPED = 'UNMAPPED';

interface AssertionRow {
  title: string;
  boundary: string | null;
  file: string;
  line: number;
  runs: number; // executions (repeat-each repetitions each count as a run)
  failed: number;
  skipped: number;
}

interface ControlBucket {
  id: string;
  title: string;
  coverageLabel: string;
  rows: Map<string, AssertionRow>;
}

function annotation(test: TestCase, type: string): string | null {
  const found = test.annotations.find((a) => a.type === type);
  return found?.description ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default class ComplianceReporter implements Reporter {
  private rootDir = process.cwd();
  private rootSuite: Suite | undefined;

  onBegin(config: FullConfig, suite: Suite): void {
    // NOT config.rootDir — that resolves to testDir ('tests/'). The artifacts
    // belong beside playwright.config.ts (the repo root), where CI uploads them.
    this.rootDir = config.configFile ? path.dirname(config.configFile) : process.cwd();
    this.rootSuite = suite;
  }

  printsToStdio(): boolean {
    return false;
  }

  async onEnd(_result: FullResult): Promise<void> {
    const tests = (this.rootSuite?.allTests() ?? []).filter((t) => t.tags.includes('@compliance'));
    // A run that exercised no @compliance tests (e.g. --project=contract) must
    // not clobber the last real gate artifact.
    if (tests.length === 0) return;

    const buckets = this.bucket(tests);
    const md = renderMarkdown(buckets);
    const html = renderHtml(buckets);
    await writeFile(path.join(this.rootDir, 'gate-summary.md'), md, 'utf8');
    await writeFile(path.join(this.rootDir, 'gate-summary.html'), html, 'utf8');
  }

  private bucket(tests: TestCase[]): ControlBucket[] {
    const buckets = new Map<string, ControlBucket>();
    for (const [id, meta] of Object.entries(CONTROLS)) {
      buckets.set(id, { id, title: meta.title, coverageLabel: meta.coverageLabel, rows: new Map() });
    }

    for (const test of tests) {
      const controlId = annotation(test, 'rule') ?? UNMAPPED;
      let bucket = buckets.get(controlId);
      if (!bucket) {
        bucket = {
          id: controlId,
          title:
            controlId === UNMAPPED
              ? 'Compliance-tagged tests with no control mapping (add a { type: "rule" } annotation)'
              : 'Unknown control id (not in the reporter registry)',
          coverageLabel: `${controlId} coverage`,
          rows: new Map(),
        };
        buckets.set(controlId, bucket);
      }

      const key = `${test.location.file}:${test.location.line}:${test.title}`;
      let row = bucket.rows.get(key);
      if (!row) {
        row = {
          title: test.title,
          boundary: annotation(test, 'boundary'),
          file: path.relative(this.rootDir, test.location.file).replace(/\\/g, '/'),
          line: test.location.line,
          runs: 0,
          failed: 0,
          skipped: 0,
        };
        bucket.rows.set(key, row);
      }
      const outcome = test.outcome();
      if (outcome === 'skipped') {
        row.skipped += 1;
      } else {
        row.runs += 1;
        // Gate policy (PRD §B.6): 'flaky' (passed on retry) is NOT passing.
        if (outcome !== 'expected') row.failed += 1;
      }
    }
    return [...buckets.values()];
  }
}

function sortedRows(bucket: ControlBucket): AssertionRow[] {
  return [...bucket.rows.values()].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

interface GateData {
  gateRed: boolean;
  totalRuns: number;
  totalFailed: number;
  gaps: string[];
}

function analyse(buckets: ControlBucket[]): GateData {
  let totalRuns = 0;
  let totalFailed = 0;
  const gaps: string[] = [];

  for (const bucket of buckets) {
    const rows = sortedRows(bucket);
    const runs = rows.reduce((n, r) => n + r.runs, 0);
    const failed = rows.reduce((n, r) => n + r.failed, 0);
    totalRuns += runs;
    totalFailed += failed;

    if (bucket.id === UNMAPPED) {
      gaps.push(`${rows.length} compliance test(s) not mapped to any control`);
      continue;
    }
    if (runs === 0) {
      gaps.push(`${bucket.id}: NO EVIDENCE — no @compliance test exercised this control`);
    } else if (failed > 0) {
      const missing = rows.filter((r) => r.boundary !== null && r.failed > 0).map((r) => r.boundary);
      gaps.push(
        missing.length > 0
          ? `${bucket.id}: control violated — MISSING at ${missing.join(', ')}`
          : `${bucket.id}: control violated — ${failed} failing assertion(s)`,
      );
    }
  }
  return { gateRed: totalFailed > 0 || gaps.length > 0, totalRuns, totalFailed, gaps };
}

/** "<label>: 2/3 boundary cases — MISSING at T=1000.00" (or n/n when green). */
function coverageLine(bucket: ControlBucket): string | null {
  const rows = sortedRows(bucket).filter((r) => r.boundary !== null);
  if (rows.length === 0) return null;
  const passed = rows.filter((r) => r.runs > 0 && r.failed === 0).length;
  const missing = rows.filter((r) => r.failed > 0 || r.runs === 0).map((r) => r.boundary);
  const suffix = missing.length > 0 ? ` — MISSING at ${missing.join(', ')}` : '';
  return `${bucket.coverageLabel}: ${passed}/${rows.length} boundary cases${suffix}`;
}

function renderMarkdown(buckets: ControlBucket[]): string {
  const gate = analyse(buckets);
  const lines: string[] = [];
  lines.push('# VaultChain compliance gate summary');
  lines.push('');
  lines.push('> Emitted by `reporters/compliance-reporter.ts`. Deterministic by design: no');
  lines.push('> timestamps or durations — an identical run produces identical bytes.');
  lines.push('');
  lines.push(
    gate.gateRed
      ? `**GATE: RED** — ${gate.totalFailed} failing assertion(s) / ${gate.gaps.length} gap(s) across ${gate.totalRuns} assertion run(s).`
      : `**GATE: GREEN** — all ${gate.totalRuns} assertion run(s) passed; every control evidenced; no gaps.`,
  );
  lines.push('');

  for (const bucket of buckets) {
    const rows = sortedRows(bucket);
    if (bucket.id === UNMAPPED && rows.length === 0) continue;
    const runs = rows.reduce((n, r) => n + r.runs, 0);
    const failed = rows.reduce((n, r) => n + r.failed, 0);
    lines.push(`## ${bucket.id}`);
    lines.push('');
    lines.push(bucket.title);
    lines.push('');
    lines.push(`- Status: **${runs === 0 ? 'NO EVIDENCE' : failed > 0 ? 'FAIL' : 'PASS'}**`);
    lines.push(`- Assertions run: ${runs} (${failed} failed)`);
    const coverage = coverageLine(bucket);
    if (coverage) lines.push(`- ${coverage}`);
    for (const row of rows) {
      const mark = row.runs === 0 ? '·' : row.failed > 0 ? '✗' : '✓';
      const boundary = row.boundary ? ` [${row.boundary}]` : '';
      const repeat = row.runs > 1 ? ` (×${row.runs}${row.failed > 0 ? `, ${row.failed} failed` : ''})` : '';
      const skipped = row.skipped > 0 ? ` (${row.skipped} skipped)` : '';
      lines.push(`  - ${mark}${boundary} ${row.title}${repeat}${skipped} — \`${row.file}:${row.line}\``);
    }
    lines.push('');
  }

  lines.push('## Gaps');
  lines.push('');
  if (gate.gaps.length === 0) {
    lines.push('- none — every control has passing evidence');
  } else {
    for (const gap of gate.gaps) lines.push(`- ${gap}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderHtml(buckets: ControlBucket[]): string {
  const gate = analyse(buckets);
  const parts: string[] = [];
  parts.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  parts.push('<title>VaultChain compliance gate summary</title>');
  parts.push(
    '<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}' +
      '.red{color:#b00020}.green{color:#1a7f37}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}' +
      'td,th{border:1px solid #ccc;padding:.35rem .6rem;text-align:left;font-size:.9rem}code{background:#f4f4f4;padding:0 .2rem}</style>',
  );
  parts.push('</head><body>');
  parts.push('<h1>VaultChain compliance gate summary</h1>');
  parts.push(
    gate.gateRed
      ? `<p class="red"><strong>GATE: RED</strong> — ${gate.totalFailed} failing assertion(s) / ${gate.gaps.length} gap(s) across ${gate.totalRuns} assertion run(s).</p>`
      : `<p class="green"><strong>GATE: GREEN</strong> — all ${gate.totalRuns} assertion run(s) passed; every control evidenced; no gaps.</p>`,
  );

  for (const bucket of buckets) {
    const rows = sortedRows(bucket);
    if (bucket.id === UNMAPPED && rows.length === 0) continue;
    const runs = rows.reduce((n, r) => n + r.runs, 0);
    const failed = rows.reduce((n, r) => n + r.failed, 0);
    const status = runs === 0 ? 'NO EVIDENCE' : failed > 0 ? 'FAIL' : 'PASS';
    parts.push(`<h2>${escapeHtml(bucket.id)} — <span class="${failed > 0 || runs === 0 ? 'red' : 'green'}">${status}</span></h2>`);
    parts.push(`<p>${escapeHtml(bucket.title)}</p>`);
    const coverage = coverageLine(bucket);
    if (coverage) parts.push(`<p><strong>${escapeHtml(coverage)}</strong></p>`);
    parts.push('<table><tr><th></th><th>Boundary</th><th>Assertion</th><th>Runs</th><th>Failed</th><th>Location</th></tr>');
    for (const row of rows) {
      const mark = row.runs === 0 ? '·' : row.failed > 0 ? '✗' : '✓';
      parts.push(
        `<tr><td>${mark}</td><td>${escapeHtml(row.boundary ?? '')}</td><td>${escapeHtml(row.title)}</td>` +
          `<td>${row.runs}</td><td>${row.failed}</td><td><code>${escapeHtml(`${row.file}:${row.line}`)}</code></td></tr>`,
      );
    }
    parts.push('</table>');
  }

  parts.push('<h2>Gaps</h2><ul>');
  if (gate.gaps.length === 0) {
    parts.push('<li>none — every control has passing evidence</li>');
  } else {
    for (const gap of gate.gaps) parts.push(`<li class="red">${escapeHtml(gap)}</li>`);
  }
  parts.push('</ul></body></html>');
  return parts.join('\n');
}
