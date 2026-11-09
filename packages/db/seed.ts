import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Carrega variáveis de ambiente de forma previsível sem sobrescrever variáveis já definidas no processo:
// 1. process.env já injetado (ex: Docker Compose / CI / linha de comando)
// 2. packages/db/.env (se existir)
// 3. .env na raiz do monorepo (se existir)
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

async function main() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const plainPassword = process.env.ADMIN_PASSWORD;
  const forceReset =
    process.argv.includes('--reset-password') || process.env.ADMIN_FORCE_RESET === 'true';

  if (!username || username.length < 3) {
    throw new Error(
      'ADMIN_USERNAME explícito é obrigatório (mínimo de 3 caracteres). Não há usuário padrão.'
    );
  }

  if (!plainPassword || plainPassword.length < 8 || plainPassword === 'password') {
    throw new Error(
      'ADMIN_PASSWORD explícito e seguro é obrigatório (mínimo de 8 caracteres, proibido "password").'
    );
  }

  const existingUser = await prisma.user.findUnique({
    where: { username },
  });

  if (existingUser && !forceReset) {
    console.log(
      `ℹ️ Usuário administrador "${existingUser.username}" já existe (senha preservada). Para redefinir a senha explicitamente, execute: npm run reset-admin -w @vault-flow/db`
    );
    return;
  }

  const hashedPassword = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

  if (existingUser && forceReset) {
    await prisma.user.update({
      where: { username },
      data: {
        password: hashedPassword,
        updatedAt: new Date(),
      },
    });
    console.log(`🔐 Senha do administrador "${username}" redefinida com sucesso.`);
    return;
  }

  const created = await prisma.user.create({
    data: {
      username,
      password: hashedPassword,
    },
  });

  console.log(`✅ Usuário administrador criado com sucesso: ${created.username}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e: unknown) => {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido no seed';
    console.error(`❌ Erro no seed administrativo: ${msg}`);
    await prisma.$disconnect();
    process.exit(1);
  });
