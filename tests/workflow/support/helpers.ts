// Local support helpers for the WORKFLOW suite only.
//
// Fixture gaps are worked around HERE — never by editing tests/fixtures/**
// (frozen during P2b). Shared code comes through ./world.js, which mirrors
// the '../fixtures/index.js' surface (see the shim note there); nothing in
// this file touches src/ or another suite.

import { ApiClient } from '../../fixtures/index.js';
import type { AccountHandle, ApiResult, ChainApi } from '../../fixtures/index.js';

// ---------------------------------------------------------------------------
// Response shapes (re-typed locally from openapi/vaultchain.yaml — the suite
// asserts on these fields; the contract layer owns full-shape validation).
// ---------------------------------------------------------------------------

export interface TxResponse {
  id: string;
  walletId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  assetSymbol: string;
  amountMinor: string;
  amount: string;
  feeMinor: string;
  fee: string;
  state: string;
  counterpartyAddress: string | null;
  counterpartyVaspId: string | null;
  chainTxRef: string | null;
  confirmations: number;
  idempotencyKey: string | null;
}

export interface WithdrawalDetailResponse extends TxResponse {
  approvals: { approverApiKeyId: string; approverRole: string; decision: string }[];
  travelRule: { direction: 'ORIGINATOR' | 'BENEFICIARY'; payload: Record<string, unknown> }[];
}

export interface WalletResponse {
  id: string;
  accountId: string;
  assetSymbol: string;
  segregationModel: string;
  balanceMinor: string;
  balance: string;
}

export interface HoldResponse {
  id: string;
  transactionId: string;
  reason: string;
  state: 'OPEN' | 'RELEASED' | 'REJECTED';
  transaction?: { id: string; state: string; type: string };
}

export interface DeliveryResponse {
  id: string;
  event: string;
  payload: string; // raw JSON string the signature covers
  attempts: number;
  status: string;
  dueAtSimMs: string; // sim-clock ms before which delivery is withheld (delay control)
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ProblemResponse {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First wallet of an account handle, asserted present (strict-TS friendly). */
export function firstWallet(account: AccountHandle): AccountHandle['wallets'][number] {
  const wallet = account.wallets[0];
  if (!wallet) throw new Error(`account ${account.accountId} was created without a wallet`);
  return wallet;
}

/** Formatted balance of a wallet (exact decimal string, asset-scaled). */
export async function walletBalance(api: ApiClient, walletId: string): Promise<string> {
  const res = await api.get<WalletResponse>(`/wallets/${walletId}`);
  if (res.status !== 200) throw new Error(`GET /wallets/${walletId} -> HTTP ${res.status}`);
  return res.json.balance;
}

/** Register an inbound deposit (sim) — raw result so tests assert status. */
export async function registerDeposit(
  operator: ApiClient,
  walletId: string,
  amount: string,
  chainTxRef: string,
): Promise<ApiResult<TxResponse>> {
  return operator.post<TxResponse>(`/wallets/${walletId}/deposits/simulate`, { amount, chainTxRef });
}

/** Record an approval decision — raw result so tests assert status + state. */
export async function decide(
  api: ApiClient,
  withdrawalId: string,
  decision: 'APPROVE' | 'REJECT',
): Promise<ApiResult<TxResponse>> {
  return api.post<TxResponse>(`/withdrawals/${withdrawalId}/approvals`, { decision });
}

/** Audit actions recorded for one transaction (entity-scoped — never global). */
export async function auditActions(compliance: ApiClient, transactionId: string): Promise<string[]> {
  const res = await compliance.get<PageResponse<{ action: string }>>(
    `/audit?entityType=Transaction&entityId=${transactionId}&limit=100`,
  );
  if (res.status !== 200) throw new Error(`GET /audit for ${transactionId} -> HTTP ${res.status}`);
  return res.json.items.map((e) => e.action);
}

/**
 * Find THIS test's open hold by transactionId, paging past any seeded open
 * holds (those belong to the contract suite's read-only probes — never touch
 * a hold you did not create).
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

/** Find the deposit.detected delivery whose payload references OUR deposit. */
export async function findDepositDetectedDelivery(
  operator: ApiClient,
  depositTxId: string,
): Promise<DeliveryResponse> {
  const res = await operator.get<PageResponse<DeliveryResponse>>('/webhooks/deliveries?event=deposit.detected');
  if (res.status !== 200) throw new Error(`GET /webhooks/deliveries -> HTTP ${res.status}`);
  const mine = res.json.items.find((d) => {
    const payload = JSON.parse(d.payload) as { transactionId?: string };
    return payload.transactionId === depositTxId;
  });
  if (!mine) throw new Error(`no deposit.detected delivery found for transaction ${depositTxId}`);
  return mine;
}

/**
 * Settle every outstanding PENDING_CONFIRMATION transaction before a test
 * queues a screening outcome. The seed plants in-flight deposits (and earlier
 * tests may leave unconfirmed withdrawals); 12 blocks meets or exceeds every
 * asset's requiredConfirmations (BTC 3 / ETH 12 / GBPX 1), so after this
 * flush a queued FLAG can only be consumed by THIS test's own screening.
 * Screenings consumed during the flush use the platform default (CLEAN).
 */
export async function settlePendingBacklog(chain: ChainApi): Promise<void> {
  await chain.advanceBlocks(12);
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
