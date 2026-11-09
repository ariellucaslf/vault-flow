import cron, { ScheduledTask } from "node-cron";
import { prisma } from "@vault-flow/db";
import {
  BackupBusyError,
  reconcileInterruptedBackups,
  runBackupForProject,
} from "../services/backupOrchestrator";
import { sanitizeDiagnosticMessage } from "../services/backupService";

interface RegisteredCronJob {
  task: ScheduledTask;
  cronSchedule: string;
  timezone: string;
  projectName: string;
}

const scheduledJobs = new Map<string, RegisteredCronJob>();
let inFlight: Promise<CronReconciliationResult> | undefined;
let recoveryComplete = false;
let ready = false;
let stopping = false;
let refreshTimer: NodeJS.Timeout | undefined;

export function isSchedulerReady(): boolean {
  return ready && !stopping;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function isValidCronExpression(expression: string): boolean {
  if (!expression || typeof expression !== "string") return false;
  const trimmed = expression.trim();
  // Exige padrão cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana)
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return cron.validate(trimmed);
}

export function resolveSafeTimeZone(candidate?: string | null): string {
  const defaultTz = process.env.CRON_TIMEZONE?.trim() || "UTC";
  if (candidate && isValidTimeZone(candidate)) {
    return candidate.trim();
  }
  if (isValidTimeZone(defaultTz)) {
    return defaultTz;
  }
  return "UTC";
}

export interface CronReconciliationResult {
  activeJobs: number;
  added: number;
  updated: number;
  removed: number;
}

/**
 * Reconcilia em memória os agendamentos ativos com o estado atual do banco de dados,
 * sem necessidade de reiniciar o servidor da API.
 */
export function reconcileCronJobs(): Promise<CronReconciliationResult> {
  if (stopping) return Promise.reject(new Error("Agendador em encerramento."));
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // Uma única vez e antes de permitir novos disparos, mesmo após falha inicial.
    if (!recoveryComplete) {
      await reconcileInterruptedBackups();
      recoveryComplete = true;
    }
    const summary = await reconcileRegisteredJobs();
    if (!stopping) ready = true;
    return summary;
  })()
    .catch((error: unknown) => {
      ready = false;
      throw error;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

async function reconcileRegisteredJobs(): Promise<CronReconciliationResult> {
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      name: true,
      type: true,
      cronSchedule: true,
      timezone: true,
      enabled: true,
    },
  });

  if (stopping) return { activeJobs: 0, added: 0, updated: 0, removed: 0 };
  const activeProjectsById = new Map(
    projects.filter((p) => p.enabled).map((p) => [p.id, p]),
  );

  let added = 0;
  let updated = 0;
  let removed = 0;

  // 1. Remover jobs de projetos excluídos ou desativados
  for (const [projectId, existing] of scheduledJobs.entries()) {
    if (!activeProjectsById.has(projectId)) {
      existing.task.stop();
      scheduledJobs.delete(projectId);
      removed++;
      console.log(
        `🛑 Agendamento removido/pausado para o projeto: [${existing.projectName}]`,
      );
    }
  }

  // 2. Adicionar ou atualizar projetos ativos
  for (const project of activeProjectsById.values()) {
    const schedule = project.cronSchedule.trim();
    if (!isValidCronExpression(schedule)) {
      console.error(
        `❌ Expressão cron inválida ignorada para o projeto "${project.name}": "${project.cronSchedule}"`,
      );
      const prev = scheduledJobs.get(project.id);
      if (prev) {
        prev.task.stop();
        scheduledJobs.delete(project.id);
        removed++;
      }
      continue;
    }

    const timezone = resolveSafeTimeZone(project.timezone);
    const existing = scheduledJobs.get(project.id);

    if (
      existing &&
      existing.cronSchedule === schedule &&
      existing.timezone === timezone &&
      existing.projectName === project.name
    ) {
      continue;
    }

    if (existing) {
      existing.task.stop();
      scheduledJobs.delete(project.id);
      updated++;
    } else {
      added++;
    }

    const typeLabel = project.type === "STORAGE" ? "STORAGE" : "DATABASE";
    console.log(
      `🕒 Agendando backup [${typeLabel}] para [${project.name}] com cron "${schedule}" (${timezone})`,
    );

    const task = cron.schedule(
      schedule,
      async () => {
        try {
          await runBackupForProject(project.id, "SCHEDULED");
        } catch (err: unknown) {
          if (err instanceof BackupBusyError) {
            console.warn(
              `⚠️ Execução agendada ignorada para "${project.name}" (ocupado): ${err.message}`,
            );
            return;
          }
          const msg = err instanceof Error ? err.message : "Erro desconhecido";
          console.error(
            `❌ Erro na execução agendada do projeto "${project.name}": ${msg}`,
          );
        }
      },
      {
        scheduled: true,
        timezone,
      },
    );

    scheduledJobs.set(project.id, {
      task,
      cronSchedule: schedule,
      timezone,
      projectName: project.name,
    });
  }

  return {
    activeJobs: scheduledJobs.size,
    added,
    updated,
    removed,
  };
}

export function getScheduledJobsSnapshot(): Array<{
  projectId: string;
  projectName: string;
  cronSchedule: string;
  timezone: string;
}> {
  return Array.from(scheduledJobs.entries()).map(([projectId, info]) => ({
    projectId,
    projectName: info.projectName,
    cronSchedule: info.cronSchedule,
    timezone: info.timezone,
  }));
}

export async function initCronJobs(options?: {
  intervalMs?: number;
}): Promise<void> {
  stopping = false;
  const intervalMs =
    options?.intervalMs ??
    Number(process.env.CRON_RECONCILE_INTERVAL_MS || 60_000);
  const refresh = async (): Promise<void> => {
    try {
      await reconcileCronJobs();
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? sanitizeDiagnosticMessage(error.message)
          : "Erro desconhecido";
      console.error(
        "❌ Falha na reconciliação do cron; nova tentativa automática:",
        message,
      );
    }
  };
  // Instala o retry antes da primeira tentativa, que pode falhar por indisponibilidade do banco.
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refresh();
    }, intervalMs);
    refreshTimer.unref();
  }
  await refresh();
}

export async function stopCronJobs(): Promise<void> {
  stopping = true;
  ready = false;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  if (inFlight) {
    try {
      await inFlight;
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? sanitizeDiagnosticMessage(error.message)
          : "Erro desconhecido";
      console.warn("⚠️ Reconciliação encerrada com falha:", message);
    }
  }
  for (const job of scheduledJobs.values()) job.task.stop();
  scheduledJobs.clear();
}
