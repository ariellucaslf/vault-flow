import path from 'path';
import dotenv from 'dotenv';

// Carrega variáveis de ambiente antes de inicializar Prisma ou rotas:
// 1. process.env já definido no ambiente
// 2. apps/api/.env (se existir)
// 3. .env na raiz do monorepo (se existir)
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import express from 'express';
import cors from 'cors';
import { prisma } from '@vault-flow/db';
import { initCronJobs } from './scheduler/cronManager';

const app = express();
app.use(cors());
app.use(express.json());

import appRoutes from './routes';
app.use('/api', appRoutes);

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Database connection check failed';
    console.error('❌ Health check failed:', message);
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 API Server ready at: http://localhost:${PORT}`);
  initCronJobs();
});
