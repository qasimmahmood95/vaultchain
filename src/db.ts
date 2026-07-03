import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

/** A Prisma client usable both top-level and inside $transaction callbacks. */
export type Db = PrismaClient | Prisma.TransactionClient;
