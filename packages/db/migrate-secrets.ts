import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecretEnvelope,
  verifyMasterKeyConfigured,
} from './crypto';

dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient();

async function main() {
  verifyMasterKeyConfigured();
  console.log('🔐 Iniciando migração retomável de credenciais para AES-256-GCM (vf:v1)...');

  let migratedProjects = 0;
  let migratedSources = 0;
  let migratedDestinations = 0;

  // 1. Migrar Project.dbUrl com secretVersion = 0
  const legacyProjects = await prisma.project.findMany({
    where: { secretVersion: 0 },
    select: { id: true, dbUrl: true, secretVersion: true },
  });

  for (const proj of legacyProjects) {
    if (!proj.dbUrl) {
      await prisma.project.update({
        where: { id: proj.id },
        data: { secretVersion: 1 },
      });
      migratedProjects++;
      continue;
    }

    const context = {
      resourceType: 'Project' as const,
      resourceId: proj.id,
      field: 'dbUrl' as const,
    };

    const encrypted = isEncryptedSecretEnvelope(proj.dbUrl)
      ? proj.dbUrl
      : encryptSecret(proj.dbUrl, context);

    // Verifica round-trip em memória antes de persistir
    const verifiedPlaintext = decryptSecret(encrypted, context);
    if (!isEncryptedSecretEnvelope(proj.dbUrl) && verifiedPlaintext !== proj.dbUrl) {
      throw new Error(`Falha na verificação de round-trip em memória para Project ${proj.id}`);
    }

    await prisma.project.update({
      where: { id: proj.id },
      data: {
        dbUrl: encrypted,
        secretVersion: 1,
      },
    });
    migratedProjects++;
  }

  // 2. Migrar StorageSource.credentials com secretVersion = 0
  const legacySources = await prisma.storageSource.findMany({
    where: { secretVersion: 0 },
    select: { id: true, credentials: true },
  });

  for (const src of legacySources) {
    const context = {
      resourceType: 'StorageSource' as const,
      resourceId: src.id,
      field: 'credentials' as const,
    };

    const encrypted = isEncryptedSecretEnvelope(src.credentials)
      ? src.credentials
      : encryptSecret(src.credentials, context);

    const verifiedPlaintext = decryptSecret(encrypted, context);
    if (!isEncryptedSecretEnvelope(src.credentials) && verifiedPlaintext !== src.credentials) {
      throw new Error(`Falha na verificação de round-trip em memória para StorageSource ${src.id}`);
    }

    await prisma.storageSource.update({
      where: { id: src.id },
      data: {
        credentials: encrypted,
        secretVersion: 1,
      },
    });
    migratedSources++;
  }

  // 3. Migrar Destination.credentials com secretVersion = 0
  const legacyDestinations = await prisma.destination.findMany({
    where: { secretVersion: 0 },
    select: { id: true, credentials: true },
  });

  for (const dest of legacyDestinations) {
    const context = {
      resourceType: 'Destination' as const,
      resourceId: dest.id,
      field: 'credentials' as const,
    };

    const encrypted = isEncryptedSecretEnvelope(dest.credentials)
      ? dest.credentials
      : encryptSecret(dest.credentials, context);

    const verifiedPlaintext = decryptSecret(encrypted, context);
    if (!isEncryptedSecretEnvelope(dest.credentials) && verifiedPlaintext !== dest.credentials) {
      throw new Error(`Falha na verificação de round-trip em memória para Destination ${dest.id}`);
    }

    await prisma.destination.update({
      where: { id: dest.id },
      data: {
        credentials: encrypted,
        secretVersion: 1,
      },
    });
    migratedDestinations++;
  }

  console.log(
    `✅ Migração concluída: ${migratedProjects} projeto(s), ${migratedSources} origem(ns) de storage e ${migratedDestinations} destino(s) atualizados para secretVersion=1.`
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err: unknown) => {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    console.error('❌ Falha na migração de segredos:', msg);
    await prisma.$disconnect();
    process.exit(1);
  });
