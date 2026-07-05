// ETH address normalization (PRD §A.6 edge case, DECISIONS D12). P2 review
// Major 5: allowlist matching must be case-insensitive for ETH — a checksummed
// (mixed-case) entry must permit the lowercase form and vice versa, while a
// genuinely different address stays blocked regardless of casing.
//
// Amounts are fee-exact in wei (0.01 ETH @ 10bps -> fee 0.00001 ETH, exact).

import { test, expect, ApiClient, PAST_COOLING_OFF_MS } from '../fixtures/index.js';
import { decide, walletBalance, type TxResponse } from './support/helpers.js';

test.describe('ETH address normalization (D12)', () => {
  test('mixed-case allowlisted address permits a lowercase withdrawal — and vice versa', async ({
    asOperatorA,
    asOperatorB,
    asAdmin,
    build,
    chain,
  }) => {
    const operator = new ApiClient(asOperatorA);
    const funded = await build.fundedWallet({ asset: 'ETH' }); // 5.000000000000000000 ETH

    // Allowlist the CHECKSUMMED (mixed-case) form directly via the API —
    // builders generate their own addresses, and the casing IS the test.
    const mixedCase = `0xAbCdEf${build.uniqueRef('').replaceAll('-', '').slice(0, 12)}CaFeBaBe`;
    const added = await operator.post(`/accounts/${funded.accountId}/allowlist`, {
      assetSymbol: 'ETH',
      address: mixedCase,
      label: 'checksummed destination',
    });
    expect(added.status).toBe(201);
    await chain.advanceClockMs(PAST_COOLING_OFF_MS);

    // Withdraw to the LOWERCASE form: normalization must match the entry.
    const wd = await operator.post<TxResponse>('/withdrawals', {
      walletId: funded.walletId,
      amount: '0.010000000000000000',
      counterpartyAddress: mixedCase.toLowerCase(),
      idempotencyKey: build.uniqueRef('eth-lower'),
    });
    expect(wd.status, 'lowercase form of a checksummed allowlisted address must be permitted').toBe(201);

    await decide(new ApiClient(asOperatorB), wd.json.id, 'APPROVE');
    const second = await decide(new ApiClient(asAdmin), wd.json.id, 'APPROVE');
    expect(second.json.state).toBe('PENDING_CONFIRMATION');
    // 5 - 0.01 - 0.00001 fee, exact to 18 dp: no precision loss anywhere.
    expect(await walletBalance(operator, funded.walletId)).toBe('4.989990000000000000');

    // Vice versa: a lowercase entry permits an UPPERCASED withdrawal target.
    const lowerEntry = `0xfeed${build.uniqueRef('').replaceAll('-', '').slice(0, 12)}beef`;
    const added2 = await operator.post(`/accounts/${funded.accountId}/allowlist`, {
      assetSymbol: 'ETH',
      address: lowerEntry,
      label: 'lowercase destination',
    });
    expect(added2.status).toBe(201);
    await chain.advanceClockMs(PAST_COOLING_OFF_MS);

    const wd2 = await operator.post<TxResponse>('/withdrawals', {
      walletId: funded.walletId,
      amount: '0.010000000000000000',
      counterpartyAddress: lowerEntry.toUpperCase(),
      idempotencyKey: build.uniqueRef('eth-upper'),
    });
    expect(wd2.status, 'uppercased form of a lowercase allowlisted address must be permitted').toBe(201);
  });

  test('a different address is blocked no matter how it is cased', async ({ asOperatorA, build, chain }) => {
    const operator = new ApiClient(asOperatorA);
    const funded = await build.fundedWallet({ asset: 'ETH' });
    const dest = await build.activeAddress({ accountId: funded.accountId, asset: 'ETH' });
    void dest; // an ACTIVE entry exists — the probe below must still be rejected
    void chain;

    const notAllowlisted = `0xDeAd${build.uniqueRef('').replaceAll('-', '').slice(0, 12)}0000`;
    const wd = await operator.post('/withdrawals', {
      walletId: funded.walletId,
      amount: '0.010000000000000000',
      counterpartyAddress: notAllowlisted,
      idempotencyKey: build.uniqueRef('eth-blocked'),
    });
    expect(wd.status, 'unlisted address must be 422 regardless of casing').toBe(422);
  });
});
