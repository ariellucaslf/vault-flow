import { Request, Response } from "express";
import { z } from "zod";
import {
  BackupBusyError,
  BackupUnavailableError,
  ProjectNotFoundError,
  startBackupForProject,
} from "../services/backupOrchestrator";
import { isSchedulerReady, reconcileCronJobs } from "../scheduler/cronManager";
import { sanitizeDiagnosticMessage } from "../services/backupService";

const triggerParamsSchema = z.object({
  id: z.string().uuid("O ID do projeto deve ser um UUID válido"),
});

export const triggerBackup = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const validation = triggerParamsSchema.safeParse(req.params);

  if (!validation.success) {
    res.status(400).json({
      success: false,
      data: null,
      error: validation.error.errors[0]?.message || "Parâmetros inválidos",
    });
    return;
  }

  if (!isSchedulerReady()) {
    res.status(503).json({
      success: false,
      data: null,
      error: "Agendador indisponível. Tente novamente em instantes.",
    });
    return;
  }

  const { id } = validation.data;

  try {
    const accepted = await startBackupForProject(id, "MANUAL");

    // Acompanha a promise em background para evitar UnhandledPromiseRejection
    accepted.completionPromise.catch((err: unknown) => {
      const msg =
        err instanceof Error
          ? sanitizeDiagnosticMessage(err.message)
          : "Erro desconhecido";
      console.error(
        `❌ Execução em background [${accepted.logId}] falhou para ${id}: ${msg}`,
      );
    });

    res.status(202).json({
      success: true,
      data: {
        logId: accepted.logId,
        projectId: accepted.projectId,
        status: accepted.status,
        message: "Backup aceito e iniciado em segundo plano.",
      },
      error: null,
    });
  } catch (error: unknown) {
    if (error instanceof BackupUnavailableError) {
      res
        .status(503)
        .json({ success: false, data: null, error: error.message });
      return;
    }
    if (error instanceof ProjectNotFoundError) {
      res.status(404).json({
        success: false,
        data: null,
        error: "Projeto não encontrado.",
      });
      return;
    }

    if (error instanceof BackupBusyError) {
      res.status(409).json({
        success: false,
        data: { reasonCode: error.reasonCode },
        error: error.message,
      });
      return;
    }

    const message =
      error instanceof Error
        ? sanitizeDiagnosticMessage(error.message)
        : "Erro interno ao disparar backup.";
    console.error("❌ Erro ao aceitar disparo de backup:", message);
    res.status(500).json({
      success: false,
      data: null,
      error: "Erro interno ao iniciar execução de backup.",
    });
  }
};

export const reconcileProjectsCron = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const summary = await reconcileCronJobs();
    res.json({
      success: true,
      data: summary,
      error: null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? sanitizeDiagnosticMessage(error.message)
        : "Erro desconhecido na reconciliação.";
    console.error("❌ Erro ao reconciliar agendamentos cron:", message);
    res.status(500).json({
      success: false,
      data: null,
      error: "Falha ao reconciliar agendamentos de backup.",
    });
  }
};
