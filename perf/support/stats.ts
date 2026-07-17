// Sample statistics + knee-point detection for the perf scenarios.

export interface LatencySummary {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** Nearest-rank percentile over a COPY of the samples (input order preserved). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? 0;
}

export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    minMs: round2(Math.min(...samples)),
    maxMs: round2(Math.max(...samples)),
    meanMs: round2(sum / samples.length),
    p50Ms: round2(percentile(samples, 50)),
    p95Ms: round2(percentile(samples, 95)),
    p99Ms: round2(percentile(samples, 99)),
  };
}

export function median(samples: readonly number[]): number {
  return percentile(samples, 50);
}

export interface LevelPoint {
  concurrency: number;
  throughputRps: number;
}

/**
 * Knee point: the SMALLEST concurrency whose throughput reaches >= 90% of the
 * maximum observed throughput. With writes serialized behind one SQLite
 * connection (D35), throughput saturates at ~1/service-time while latency
 * keeps growing linearly with queue depth — the saturation onset is the knee.
 */
export function findKnee(points: readonly LevelPoint[]): number {
  const max = Math.max(...points.map((p) => p.throughputRps));
  for (const p of points) {
    if (p.throughputRps >= 0.9 * max) return p.concurrency;
  }
  return points[points.length - 1]?.concurrency ?? 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
