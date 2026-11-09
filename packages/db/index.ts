import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';
export {
  encryptSecret,
  decryptSecret,
  isEncryptedSecretEnvelope,
  loadMasterKey,
  verifyMasterKeyConfigured,
  type SecretAADContext,
  type SecretResourceType,
  type SecretFieldName,
} from './crypto';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
