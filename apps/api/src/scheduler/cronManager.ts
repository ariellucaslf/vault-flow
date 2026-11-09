import cron, { ScheduledTask } from 'node-cron';
import { prisma } from '@vault-flow/db';
import {
  BackupBusyError,
  reconcileInterruptedBackups,
  runBackupForProject,
} from '../services/backupOrchestrator';

interface RegisteredCronJob {
  task: ScheduledTask;
  cronSchedule: string;
  timezone: string;
  projectName: string;
}

const scheduledJobs = new Map<string, RegisteredCronJob>();

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function isValidCronExpression(expression: string): boolean {
  if (!expression || typeof expression !== 'string') return false;
  const trimmed = expression.trim();
  // Exige padrão cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana)
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  return cron.validate(trimmed);
}

export function resolveSafeTimeZone(candidate?: string | null): string {
  const defaultTz = process.env.CRON_TIMEZONE?.trim() || 'UTC';
  if (candidate && isValidTimeZone(candidate)) {
    return candidate.trim();
  }
  if (isValidTimeZone(defaultTz)) {
    return defaultTz;
  }
  return 'UTC';
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
export async function reconcileCronJobs(): Promise<CronReconciliationResult> {
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

  const activeProjectsById = new Map(
    projects.filter((p) => p.enabled).map((p) => [p.id, p])
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
      console.log(`🛑 Agendamento removido/pausado para o projeto: [${existing.projectName}]`);
    }
  }

  // 2. Adicionar ou atualizar projetos ativos
  for (const project of activeProjectsById.values()) {
    const schedule = project.cronSchedule.trim();
    if (!isValidCronExpression(schedule)) {
      console.error(
        `❌ Expressão cron inválida ignorada para o projeto "${project.name}": "${project.cronSchedule}"`
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

    const typeLabel = project.type === 'STORAGE' ? 'STORAGE' : 'DATABASE';
    console.log(
      `🕒 Agendando backup [${typeLabel}] para [${project.name}] com cron "${schedule}" (${timezone})`
    );

    const task = cron.schedule(
      schedule,
      async () => {
        try {
          await runBackupForProject(project.id, 'SCHEDULED');
        } catch (err: unknown) {
          if (err instanceof BackupBusyError) {
            console.warn(
              `⚠️ Execução agendada ignorada para "${project.name}" (ocupado): ${err.message}`
            );
            return;
          }
          const msg = err instanceof Error ? err.message : 'Erro desconhecido';
          console.error(`❌ Erro na execução agendada do projeto "${project.name}": ${msg}`);
        }
      },
      {
        scheduled: true,
        timezone,
      }
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

export async function initCronJobs(): Promise<void> {
  console.log('🔄 Inicializando reconciliação de execuções e agendamentos (Cron)...');

  try {
    await reconcileInterruptedBackups();
    const summary = await reconcileCronJobs();
    console.log(
      `✅ Cron reconciliado: ${summary.activeJobs} ativo(s) (+${summary.added} adicionado(s), ~${summary.updated} atualizado(s), -${summary.removed} removido(s)).`
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Erro desconhecido';
    console.error('❌ Falha ao inicializar rotinas agendadas (Cron):', msg);
  }
}
