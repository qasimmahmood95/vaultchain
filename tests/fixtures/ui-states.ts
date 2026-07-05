// Browser storageState per role (PRD §B.2, completing D20): the setup project
// logs each role in ONCE through the real /ui/login form and saves the
// resulting cookie jar. UI specs opt in per file:
//   test.use({ storageState: UI_STATE.operatorB });
// Roles: operatorA is the MAKER; use operatorB/admin as checkers; compliance
// resolves holds. Files live under .auth/ (gitignored).

import path from 'node:path';
import { AUTH_DIR } from './auth.fixtures.js';

export const UI_STATE = {
  operatorA: path.join(AUTH_DIR, 'ui-operatorA.json'),
  operatorB: path.join(AUTH_DIR, 'ui-operatorB.json'),
  admin: path.join(AUTH_DIR, 'ui-admin.json'),
  compliance: path.join(AUTH_DIR, 'ui-compliance.json'),
} as const;

export type UiRole = keyof typeof UI_STATE;
