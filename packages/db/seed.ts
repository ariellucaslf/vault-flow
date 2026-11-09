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

async function main() {
  // Puxa as credenciais do .env ou usa valores padrão genéricos para quem clonar o projeto (open-source)
  const username = process.env.ADMIN_USERNAME || 'admin';
  const plainPassword = process.env.ADMIN_PASSWORD || 'password';
  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  const user = await prisma.user.upsert({
    where: { username },
    update: {},
    create: {
      username,
      password: hashedPassword,
    },
  });

  console.log(`✅ Usuário administrador criado/atualizado: ${user.username}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
