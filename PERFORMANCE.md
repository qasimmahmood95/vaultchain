# PERFORMANCE.md — what these numbers mean (and what they don't)

> **FICTIONAL system-under-test.** The perf layer measures a mock custody platform on
> SQLite behind a deliberately single-connection pool. Read this page before quoting any
> number from it.

## The point is contention correctness, not throughput

VaultChain stores money movements in **SQLite through one pooled connection**
(`?connection_limit=1` — DECISIONS.md D35, and it is load-bearing). Every write
transaction is serialized at the pool. That is a **known, chosen ceiling**: this platform's
correctness story is "atomic under concurrency", and a single connection is what makes the
maker-checker races resolve as clean `403`/`409` instead of lock-upgrade deadlocks.

So this layer does **not** exist to produce big numbers — on this architecture there are
no big numbers to produce. It exists to prove that **under real concurrent pressure the
platform stays correct**, and to pin the latency/throughput envelope so a regression
(accidental N+1, a dropped index, a transaction boundary widened) fails a run instead of
hiding in prose. Three scenarios, three claims:

| Scenario (`pnpm perf -- --scenario=<name>`) | The claim it proves |
|---|---|
| `approval-contention` | N simultaneous approval attempts (2 → 512) on one shared withdrawal never produce a 5xx, never duplicate an approval, always elect **exactly two** winners (dual-approval policy), and always land the withdrawal in the designed state. The **knee point** — where added concurrency stops buying throughput and starts buying queue depth — is measured and recorded. |
| `reconciliation-under-load` | After 60 seconds of sustained mixed deposits/withdrawals from 8 concurrent workers, `Σ(ledger) == wallet.balanceMinor` holds on **every** wallet — the direct no-lost-update proof — AND the trail is **exactly-once** (one credit + one ProcessedEvent per credited deposit, one principal + one fee debit per debited withdrawal; a *consistent* double-settlement would reconcile, so the invariant alone is not enough), with zero 5xx and zero off-design statuses. |
| `read-path-baseline` | At ~20k withdrawals (+20k deposits + audit trail), cursor paging is **complete, duplicate-free, and terminating** over the full chain, and list-endpoint p95/p99 are pinned against committed baselines. |

## What the numbers do NOT mean

- **They are not capacity claims.** Localhost loopback, one process, `tsx` (no build),
  SQLite file on a developer NVMe, Windows. No network, no TLS, no container limits.
  Nothing here predicts what any real deployment would do.
- **They are not comparable across machines.** `perf/baselines.json` records the machine
  that produced it (`node`, platform, CPU count). On different hardware, re-record with
  `pnpm perf:baseline` — do not "fix" a red run by editing numbers by hand.
- **Latency percentiles include client-side scheduling.** The volley scenarios measure
  from `fetch` dispatch, so at concurrency 512 a request's latency is mostly its queue
  position — that is the phenomenon being measured, not an artefact to subtract.
- **The knee is a band, not a constant.** Back-to-back runs on the same machine put the
  saturation onset anywhere between concurrency ~128 and ~512 (throughput plateau
  ~500–630 req/s on the recording machine), depending on ambient load. The *stable*
  facts are the shape (throughput saturates, then declines while p95 grows toward the
  transaction-queue timeout) and the correctness bar holding at every level. The recorded
  `kneeConcurrency` is informational, deliberately not a threshold.

## What the numbers DO mean

- **Zero 5xx / zero duplicates / invariant HOLDS are absolute.** These hard bounds are
  machine-independent truths about the code, and a violation fails the run everywhere.
- **The regression envelope is real.** Thresholds live in `perf/perf.config.json`
  (tolerance multipliers), baselines in `perf/baselines.json` (recorded numbers) — both
  committed. `pnpm perf` exits non-zero when a metric leaves the envelope; the generous
  multipliers (×3) absorb machine noise while still catching order-of-magnitude
  regressions. A failing threshold is data, not decoration: the mechanism was
  negative-tested (tamper a baseline → the run fails with exit 1).
- **The knee measurement is honest queueing theory in miniature.** With one write
  connection, service time ~2ms/approval decision gives a ~500 req/s hard ceiling;
  the measured curve (throughput flat-to-falling past the knee while p95 grows linearly
  with concurrency) matches that model. At concurrency 512 the p95 approaches Prisma's
  default 2s transaction-acquisition timeout — the envelope deliberately stops there,
  because past it the failure mode changes from "slow" to "timeout", which is a different
  (and documented) cliff.

## Running it

```bash
pnpm perf                                  # all three scenarios vs committed baselines
pnpm perf -- --scenario=approval-contention
pnpm perf:baseline                         # re-record baselines on THIS machine
```

Each scenario boots its own fresh server (reset → migrate → seed) on port **3100** — it
will not collide with a Playwright `webServer` on :3000, but it does reset
`prisma/vaultchain.db`, so don't run it mid-suite. Total runtime ≈ 3–4 minutes, most of
it the 60-second sustained-load window.

## Why this is not a required CI job

The §B.5 CI graph gates on functional truth (contract, workflow, UI, the compliance
gate). Perf latencies are machine-relative: a shared 2-core CI runner would need its own
recorded baselines and would still be noisy across runner generations — a required check
that fails on infrastructure weather teaches people to ignore required checks. The perf
run is a local/nightly tool with an honest exit code; its **hard correctness bounds** are
already covered on every CI run by the compliance gate's concurrency probe (the volley)
and the workflow suite's invariant sweep, at small N. This layer is where the same claims
get pressure-tested at large N, on demand.
