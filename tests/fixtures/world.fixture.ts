// Fixture composition (PRD §B.2): auth and chain-clock are independent
// extend-chains merged with mergeTests; the builders are layered on top so
// they can depend on both. Suites import { test, expect } from '../fixtures'.

import { mergeTests } from '@playwright/test';
import { authTest } from './auth.fixtures.js';
import { chainClockTest } from './chain-clock.fixture.js';
import { makeBuilders, type Build } from './builders/index.js';

export const test = mergeTests(authTest, chainClockTest).extend<{ build: Build }>({
  build: async ({ asAdmin, asOperatorA, chain }, use) => {
    await use(makeBuilders({ asAdmin, asOperatorA, chain }));
  },
});

export { expect } from '@playwright/test';
