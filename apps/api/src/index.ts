import express from 'express';
import cors from 'cors';
import { prisma } from '@vault-flow/db';
import { initCronJobs } from './scheduler/cronManager';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

import appRoutes from './routes';
app.use('/api', appRoutes);

app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 API Server ready at: http://localhost:${PORT}`);
  initCronJobs();
});
