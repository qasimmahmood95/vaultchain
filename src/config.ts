// Platform constants. PRD references: fee/rounding §A.2, Travel Rule §A.3.3,
// cooling-off DECISIONS.md D9, fees D6, block time D18.

/** Flat withdrawal fee in basis points (0.1%), all assets. Deposits are fee-free. */
export const WITHDRAWAL_FEE_BPS = 10n;

/** Allowlist cooling-off window, in sim-clock milliseconds (24h). */
export const COOLING_OFF_MS = 86_400_000n;

/** Sim-clock milliseconds advanced per mock block. */
export const BLOCK_MS = 60_000n;

/**
 * Travel Rule threshold in GBPX minor units (2 dp): 1000.00 fiat-equivalent.
 * PRD §A.3.3: the requirement applies AT or ABOVE this value (>=).
 */
export const TRAVEL_RULE_THRESHOLD_FIAT_MINOR = 100_000n;

/**
 * Fixed mock fiat rates, in whole GBPX per whole unit of asset (PRD §A.3.3 —
 * deliberately a constant, not simulator-controllable; GBPX is 1:1 by definition).
 */
export const MOCK_FIAT_RATES: Readonly<Record<string, bigint>> = {
  BTC: 60_000n,
  ETH: 3_000n,
  GBPX: 1n,
};

export const PORT = Number(process.env.PORT ?? 3000);

export type Role = 'CLIENT' | 'OPERATOR' | 'COMPLIANCE_OFFICER' | 'ADMIN';

export interface Actor {
  apiKeyId: string;
  role: Role;
  clientId: string | null;
}
