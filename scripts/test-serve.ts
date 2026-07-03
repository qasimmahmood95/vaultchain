// Playwright webServer command: fresh DB, migrations, deterministic seed,
// then boot the platform. KEEP_DB=1 skips the reset (fast local iteration).

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

process.env.NODE_ENV = 'test'; // silences the fastify request logger (src/app.ts)

if (!process.env.KEEP_DB) {
  rmSync('prisma/vaultchain.db', { force: true });
  rmSync('prisma/vaultchain.db-journal', { force: true });
}
execSync('npx prisma migrate deploy', { stdio: 'inherit' });
if (!process.env.KEEP_DB) {
  execSync('npx tsx scripts/seed.ts', { stdio: 'inherit' });
}

await import('../src/server.js');
