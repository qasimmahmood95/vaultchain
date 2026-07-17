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

export async function startServer(port: number): Promise<PerfServer> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
