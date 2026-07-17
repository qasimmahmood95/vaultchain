// Fresh-server lifecycle for perf scenarios (D37). Same fresh-DB semantics as
// scripts/test-serve.ts (reset -> migrate -> seed), but the server runs on a
// DEDICATED port (default 3100) as a directly-spawned node child so a stray
// Playwright webServer on :3000 can never be measured by mistake, and the
// child can be killed cleanly (killing an `npx` wrapper orphans the real
// server — a known footgun on this repo).

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

export interface PerfServer {
  baseUrl: string;
  port: number;
  stop(): Promise<void>;
}

/** Fresh DB: remove the SQLite file, re-apply migrations, run the standard seed. */
export function resetDatabase(): void {
  rmSync('prisma/vaultchain.db', { force: true });
  rmSync('prisma/vaultchain.db-journal', { force: true });
  execSync('npx prisma migrate deploy', { stdio: 'pipe' });
  execSync('npx tsx scripts/seed.ts', { stdio: 'pipe' });
}

// Children spawned by this module, reaped on interrupt/exit (P5 review
// Minor 3): a Ctrl+C'd perf run must not leave an orphan holding :3100 —
// that orphan is exactly what the pre-flight probe below exists to refuse.
const children = new Set<ChildProcess>();
let reapersInstalled = false;
function installReapers(): void {
  if (reapersInstalled) return;
  reapersInstalled = true;
  const reap = (): void => {
    for (const c of children) if (c.exitCode === null) c.kill();
  };
  process.on('exit', reap);
  process.on('SIGINT', () => {
    reap();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    reap();
    process.exit(143);
  });
}

export async function startServer(port: number): Promise<PerfServer> {
  installReapers();

  // Pre-flight: if ANYTHING already answers on this port, refuse to start —
  // the readiness poll below must never adopt a stray server whose DB state
  // is unknown (P5 review Minor 3). With the port verified silent before
  // spawn, a subsequent healthy response can only be our own child (a racing
  // third-party bind would make the child's own bind fail, which the
  // exitCode check catches).
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    throw new Error(
      `something is already listening on :${port} — refusing to adopt a stray server; kill it and re-run (perf servers are always freshly booted)`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('something is already listening')) throw err;
    // connection refused / timeout = port is free, proceed
  }

  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));

  // Keep the pipes drained (an unread pipe backpressures the child); retain a
  // tail of stderr for diagnostics if boot fails.
  const stderrTail: string[] = [];
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`perf server exited before ready (code ${child.exitCode}):\n${stderrTail.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`perf server did not become healthy within 60s:\n${stderrTail.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    baseUrl,
    port,
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill();
      });
    },
  };
}
