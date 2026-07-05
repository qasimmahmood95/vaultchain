// The single import surface for every suite (PRD §B.1):
//   import { test, expect } from '../fixtures';
// Suites share NOTHING else — no cross-suite imports, no src/ imports.

export { test, expect } from './world.fixture.js';
export { ApiClient, API_BASE, type ApiResult } from './api-client.js';
export type { ChainApi, ChainState } from './chain-clock.fixture.js';
export type {
  Build,
  AssetSymbol,
  ClientHandle,
  AccountHandle,
  FundedWalletHandle,
  AddressHandle,
  TxHandle,
} from './builders/index.js';
export { PAST_COOLING_OFF_MS } from './builders/index.js';
export type { Identity } from './auth.fixtures.js';
export { UI_STATE, type UiRole } from './ui-states.js';
