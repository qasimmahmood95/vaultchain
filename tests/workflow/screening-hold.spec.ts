// Screening holds (PRD §A.3.1): a FLAG queued on the simulator sends the next
// screened deposit to HELD with an OPEN compliance hold; release credits it,
// reject terminates it uncredited. Serialized project -> queueScreening is
// race-free, and settlePendingBacklog first flushes every other pending
// transaction so the FLAG can only hit THIS test's screening.
//
// These tests only touch holds THEY created (matched by transactionId) —
// seeded open holds belong to the contract suite's read-only probes.
// Audit entries for hold resolution are deliberately NOT asserted here
// (P4 compliance-gate territory).

import { test, expect, ApiClient } from './support/world.js';
import {
  findOpenHold,
  firstWallet,
  registerDeposit,
  settlePendingBacklog,
  walletBalance,
  type HoldResponse,
} from './support/helpers.js';

test.describe('screening holds', () => {
  test('flagged deposit is HELD, not credited; compliance release credits it exactly', async ({
    asOperatorA,
    asCompliance,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);
    const account = await build.account({ assets: ['GBPX'] });
    const wallet = firstWallet(account);

    // Flush other pending transactions FIRST so the queued FLAG is ours.
    await settlePendingBacklog(chain);
    await chain.queueScreening('FLAG');

    const dep = await registerDeposit(operator, wallet.id, '2000.00', build.uniqueRef('dep-flag'));
    expect(dep.status).toBe(201);

    await chain.advanceBlocks(1); // GBPX: 1 confirmation -> screening consumes the FLAG

    // HELD: nothing credited, and an OPEN hold references our transaction.
    expect(await walletBalance(operator, wallet.id)).toBe('0.00');
    const hold = await findOpenHold(compliance, dep.json.id);
    const heldDetail = await compliance.get<HoldResponse>(`/holds/${hold.id}`);
    expect(heldDetail.status).toBe(200);
    expect(heldDetail.json.transaction?.state).toBe('HELD');

    // Compliance release -> the deposit resumes and credits EXACTLY once.
    const release = await compliance.post<HoldResponse>(`/holds/${hold.id}/release`);
    expect(release.status).toBe(200);
    expect(release.json.state).toBe('RELEASED');

    const releasedDetail = await compliance.get<HoldResponse>(`/holds/${hold.id}`);
    expect(releasedDetail.json.transaction?.state).toBe('CREDITED');
    expect(await walletBalance(operator, wallet.id)).toBe('2000.00');
  });

  test('flagged deposit rejected by compliance: hold REJECTED, transaction REJECTED, nothing credited', async ({
    asOperatorA,
    asCompliance,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const compliance = new ApiClient(asCompliance);
    const account = await build.account({ assets: ['GBPX'] });
    const wallet = firstWallet(account);

    await settlePendingBacklog(chain);
    await chain.queueScreening('FLAG');

    const dep = await registerDeposit(operator, wallet.id, '750.00', build.uniqueRef('dep-flag'));
    expect(dep.status).toBe(201);

    await chain.advanceBlocks(1);
    expect(await walletBalance(operator, wallet.id)).toBe('0.00');

    const hold = await findOpenHold(compliance, dep.json.id);
    const rejection = await compliance.post<HoldResponse>(`/holds/${hold.id}/reject`);
    expect(rejection.status).toBe(200);
    expect(rejection.json.state).toBe('REJECTED');

    const rejectedDetail = await compliance.get<HoldResponse>(`/holds/${hold.id}`);
    expect(rejectedDetail.json.transaction?.state).toBe('REJECTED');

    // The rejected deposit is NEVER credited.
    expect(await walletBalance(operator, wallet.id)).toBe('0.00');
  });
});
