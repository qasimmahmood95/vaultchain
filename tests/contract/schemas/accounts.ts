// Account / Wallet / AllowlistedAddress schemas (openapi/vaultchain.yaml).

import { z } from 'zod';
import { decimalString, minorUnits } from './common.js';

export const AssetSymbolSchema = z.enum(['BTC', 'ETH', 'GBPX']);
export const SegregationModelSchema = z.enum(['SEGREGATED', 'OMNIBUS']);

/** components/schemas/Account */
export const AccountSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  label: z.string(),
  segregationModel: SegregationModelSchema,
  status: z.string(),
});

/** components/schemas/WalletRaw — wallet as persisted (no formatted balance). */
export const WalletRawSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  assetSymbol: AssetSymbolSchema,
  segregationModel: SegregationModelSchema,
  depositAddress: z.string(),
  balanceMinor: minorUnits,
});

/** components/schemas/Wallet — WalletRaw + formatted `balance`. */
export const WalletSchema = WalletRawSchema.extend({
  balance: decimalString,
});

/** components/schemas/AccountWithWallets — POST /accounts 201 (wallets embedded). */
export const AccountWithWalletsSchema = AccountSchema.extend({
  wallets: z.array(WalletRawSchema),
});

/** components/schemas/AllowlistedAddress */
export const AllowlistedAddressSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  assetSymbol: z.string(),
  address: z.string(),
  addressNorm: z.string().optional(),
  label: z.string(),
  addedByApiKeyId: z.string().optional(),
  activatesAt: z.string(), // sim-clock ms at which the entry becomes usable
  status: z.enum(['PENDING', 'ACTIVE', 'REMOVED']),
  effectiveStatus: z.enum(['PENDING', 'ACTIVE']).optional(),
});
