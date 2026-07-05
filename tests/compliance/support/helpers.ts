// Local support helpers for the COMPLIANCE suite only. Shared code comes from
// '../../fixtures/index.js' (the single cross-suite surface); nothing in this
// file touches src/ or another suite. Small idioms are deliberately duplicated
// from the workflow suite's local helpers rather than imported (PRD §B.0 rule 4).

import { ApiClient } from '../../fixtures/index.js';
import type { ApiResult, Build, ChainApi } from '../../fixtures/index.js';

// ---------------------------------------------------------------------------
// Response shapes (re-typed locally from openapi/vaultchain.yaml — this suite
// asserts on these fields; the contract layer owns full-shape validation).
// ---------------------------------------------------------------------------

export interface TxResponse {
  id: string;
  walletId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  assetSymbol: string;
  amount: string;
  fee: string;
  state: string;
  counterpartyVaspId: string | null;
  confirmations: number;
}

export interface WithdrawalDetailResponse extends TxResponse {
  approvals: { approverApiKeyId: string; approverRole: string; decision: string }[];
  travelRule: { direction: 'ORIGINATOR' | 'BENEFICIARY'; payload: Record<string, unknown> }[];
}

export interface HoldResponse {
  id: string;
  transactionId: string;
  reason: string;
  state: 'OPEN' | 'RELEASED' | 'REJECTED';
  transaction?: { id: string; state: string; type: string };
}

/** An /audit row with before/after already JSON-parsed by the platform. */
export interface AuditEntry {
  action: string;
  actorApiKeyId: string | null;
  actorRole: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The caller's ApiKey id, resolved via /me AT RUNTIME — deliberately not the
 * setup project's .auth/identity.json: DB ids are cuids minted per seed, so a
 * `--no-deps` invocation after a reseed (the defect-branch evidence protocol)
 * would compare against stale ids. Raw keys are deterministic; ids are not.
 */
export async function apiKeyIdOf(api: ApiClient): Promise<string> {
  const res = await api.get<{ apiKeyId: string }>('/me');
  if (res.status !== 200) throw new Error(`GET /me -> HTTP ${res.status}`);
  return res.json.apiKeyId;
}

/** Record an approval decision — raw result so tests assert status + state. */
export async function decide(
  api: ApiClient,
  withdrawalId: string,
  decision: 'APPROVE' | 'REJECT',
): Promise<ApiResult<TxResponse>> {
  return api.post<TxResponse>(`/withdrawals/${withdrawalId}/approvals`, { decision });
}

/** Full withdrawal detail (approvals + travelRule arrays), asserted 200. */
export async function withdrawalDetail(api: ApiClient, withdrawalId: string): Promise<WithdrawalDetailResponse> {
  const res = await api.get<WithdrawalDetailResponse>(`/withdrawals/${withdrawalId}`);
  if (res.status !== 200) throw new Error(`GET /withdrawals/${withdrawalId} -> HTTP ${res.status}`);
  return res.json;
}

/** Formatted balance of a wallet (exact decimal string, asset-scaled). */
export async function walletBalance(api: ApiClient, walletId: string): Promise<string> {
  const res = await api.get<{ balance: string }>(`/wallets/${walletId}`);
  if (res.status !== 200) throw new Error(`GET /wallets/${walletId} -> HTTP ${res.status}`);
  return res.json.balance;
}

/** Audit entries for one entity, in append order (entity-scoped — never global). */
export async function auditEntries(
  compliance: ApiClient,
  entityType: 'Transaction' | 'ComplianceHold',
  entityId: string,
): Promise<AuditEntry[]> {
  const res = await compliance.get<PageResponse<AuditEntry>>(
    `/audit?entityType=${entityType}&entityId=${entityId}&limit=100`,
  );
  if (res.status !== 200) throw new Error(`GET /audit for ${entityType}/${entityId} -> HTTP ${res.status}`);
  return res.json.items;
}

/** Just the action names, in append order. */
export async function auditActions(
  compliance: ApiClient,
  entityType: 'Transaction' | 'ComplianceHold',
  entityId: string,
): Promise<string[]> {
  return (await auditEntries(compliance, entityType, entityId)).map((e) => e.action);
}

/**
 * Find THIS test's open hold by transactionId, paging past any seeded open
 * holds (never touch a hold you did not create).
 */
export async function findOpenHold(compliance: ApiClient, transactionId: string): Promise<HoldResponse> {
  let cursor: string | null = null;
  do {
    const query: string = `/holds?state=OPEN&limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await compliance.get<PageResponse<HoldResponse>>(query);
    if (res.status !== 200) throw new Error(`GET /holds -> HTTP ${res.status}`);
    const found = res.json.items.find((h) => h.transactionId === transactionId);
    if (found) return found;
    cursor = res.json.nextCursor;
  } while (cursor);
  throw new Error(`no OPEN hold found for transaction ${transactionId}`);
}

/**
 * Stage a deposit that lands in HELD with an OPEN screening hold.
 * Serialized-project pattern: flush the settlement backlog FIRST (12 blocks
 * covers every asset's requiredConfirmations) so the queued FLAG can only be
 * consumed by THIS deposit's screening.
 */
export async function flaggedDepositHold(deps: {
  operator: ApiClient;
  compliance: ApiClient;
  build: Build;
  chain: ChainApi;
  amount?: string;
}): Promise<{ depositId: string; walletId: string; hold: HoldResponse }> {
  const account = await deps.build.account({ assets: ['GBPX'] });
  const wallet = account.wallets[0];
  if (!wallet) throw new Error('flaggedDepositHold: account created without a wallet');
  await deps.chain.advanceBlocks(12); // settle backlog before queueing the FLAG
  await deps.chain.queueScreening('FLAG');
  const dep = await deps.operator.expectOk(
    deps.operator.post<TxResponse>(`/wallets/${wallet.id}/deposits/simulate`, {
      amount: deps.amount ?? '2500.00',
      chainTxRef: deps.build.uniqueRef('flag'),
    }),
    'flaggedDepositHold deposit',
  );
  await deps.chain.advanceBlocks(1); // GBPX needs 1 confirmation -> SCREENING -> FLAG -> HELD
  const hold = await findOpenHold(deps.compliance, dep.id);
  return { depositId: dep.id, walletId: wallet.id, hold };
}

/** Canonical valid Travel Rule payload (originator needs a physical address). */
export function travelRulePayload(): {
  originator: { name: string; accountRef: string; physicalAddress: string };
  beneficiary: { name: string; accountRef: string };
} {
  return {
    originator: {
      name: 'Aldgate Digital Partners LLP (fictional)',
      accountRef: 'acct-originator-ref',
      physicalAddress: '1 Mock Lane, London, EC3N 1AB, GB (fictional)',
    },
    beneficiary: {
      name: 'Foxwhelp Custody GmbH (fictional)',
      accountRef: 'acct-beneficiary-ref',
    },
  };
}
