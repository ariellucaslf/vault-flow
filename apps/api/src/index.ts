import path from "path";
import dotenv from "dotenv";

// Carrega variáveis de ambiente antes de inicializar Prisma ou rotas:
// 1. process.env já definido no ambiente
// 2. apps/api/.env (se existir)
// 3. .env na raiz do monorepo (se existir)
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import express, { NextFunction, Request, Response } from "express";
import { prisma } from "@vault-flow/db";
import { validateApiStartupEnv } from "./config/env";
import {
  initCronJobs,
  isSchedulerReady,
  stopCronJobs,
} from "./scheduler/cronManager";
import appRoutes from "./routes";
import { cancelActiveBackups } from "./services/backupOrchestrator";
import { sanitizeDiagnosticMessage } from "./services/backupService";

validateApiStartupEnv();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.use("/api", appRoutes);

app.get("/health", async (_req: Request, res: Response) => {
  if (!isSchedulerReady()) {
    res
      .status(503)
      .json({
        success: false,
        data: { status: "initializing" },
        error: "Agendador indisponível.",
      });
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      success: true,
      data: { status: "ok", db: "connected" },
      error: null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? sanitizeDiagnosticMessage(error.message)
        : "Database connection check failed";
    console.error("❌ Health check failed:", message);
    res.status(500).json({
      success: false,
      data: { status: "error", db: "disconnected" },
      error: "Serviço de metadados indisponível.",
    });
  }
});

// Middleware global de proteção contra vazamento de erros internos ou JSON malformado
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  const rawMessage =
    err instanceof Error ? err.message : "Erro inesperado na requisição";
  console.error(
    "❌ Erro na camada HTTP da API:",
    sanitizeDiagnosticMessage(rawMessage),
  );
  res.status(400).json({
    success: false,
    data: null,
    error: "Requisição inválida ou erro interno no processamento.",
  });
});

const PORT = Number(process.env.PORT) || 4000;

const server = app.listen(PORT, () => {
  console.log(`🚀 API Server ready at: http://localhost:${PORT}`);
  void initCronJobs();
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await Promise.all([stopCronJobs(), cancelActiveBackups()]);
  await prisma.$disconnect();
}
for (const event of ["SIGTERM", "SIGINT"] as const) {
  process.once(event, () => {
    void shutdown().catch((error: unknown) => {
      const message =
        error instanceof Error
          ? sanitizeDiagnosticMessage(error.message)
          : "Erro desconhecido";
      console.error("❌ Falha ao encerrar a API:", message);
      process.exitCode = 1;
    });
  });
}
