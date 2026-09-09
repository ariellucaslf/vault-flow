import cron from "node-cron";
import { prisma } from "@vault-flow/db";
import { runBackupForProject } from "../services/backupOrchestrator";

export async function initCronJobs() {
  console.log("🔄 Inicializando agendamentos de backup automáticos...");

  try {
    const projects = await prisma.project.findMany();

    for (const project of projects) {
      if (!cron.validate(project.cronSchedule)) {
        console.error("❌ Expressão cron inválida para o projeto " + project.name + ": " + project.cronSchedule);
        continue;
      }

      const typeLabel = project.type === "STORAGE" ? "STORAGE" : "DATABASE";
      console.log("🕒 Agendando backup [" + typeLabel + "] para [" + project.name + "] com cron: " + project.cronSchedule);

      cron.schedule(project.cronSchedule, async () => {
        try {
          await runBackupForProject(project.id);
        } catch (err: unknown) {
          // O erro já é registrado no BackupLog dentro de runBackupForProject
          const msg = err instanceof Error ? err.message : "Erro desconhecido";
          console.error("❌ Erro na execução agendada do projeto " + project.name + ": " + msg);
        }
      });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("❌ Falha ao inicializar rotinas agendadas (Cron):", msg);
  }
}
