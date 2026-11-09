"use server";

import { prisma } from "@vault-flow/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

const CRON_FIELD_REGEX = /^(\*|\d+(-\d+)?(,\d+(-\d+)?)*)(\/[1-9]\d*)?$/;

function isValidFiveFieldCron(expression: string): boolean {
  const trimmed = expression.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges: Array<[number, number]> = [
    [0, 59], // minuto
    [0, 23], // hora
    [1, 31], // dia do mês
    [1, 12], // mês
    [0, 7],  // dia da semana
  ];

  return parts.every((field, idx) => {
    if (!CRON_FIELD_REGEX.test(field)) return false;
    const range = ranges[idx];
    if (!range) return false;
    const [min, max] = range;
    const base = field.split("/")[0] || "";
    if (base === "*") return true;

    return base.split(",").every((segment) => {
      const nums = segment.split("-").map(Number);
      if (nums.some((n) => Number.isNaN(n) || n < min || n > max)) return false;
      if (nums.length === 2 && (nums[0] ?? 0) > (nums[1] ?? 0)) return false;
      return true;
    });
  });
}

const baseProjectSchema = z.object({
  name: z.string().trim().min(1, "O nome do projeto é obrigatório").max(120, "Nome muito longo"),
  type: z.enum(["DATABASE", "STORAGE"]).default("DATABASE"),
  cronSchedule: z
    .string()
    .trim()
    .min(1, "O agendamento cron é obrigatório")
    .refine(isValidFiveFieldCron, "Expressão Cron inválida. Use o formato de 5 campos (ex: 0 3 * * *)."),
  timezone: z
    .string()
    .trim()
    .default("UTC")
    .refine(isValidTimeZone, "Timezone IANA inválido (ex: America/Sao_Paulo ou UTC)."),
  destinationType: z.enum(["AWS_S3", "GOOGLE_DRIVE"]),
  destinationTarget: z.string().trim().min(1, "O alvo do destino é obrigatório (Bucket ou Folder ID)"),
  destinationCredentials: z.string().trim().min(2, "As credenciais do destino são obrigatórias"),
});

const databaseProjectSchema = baseProjectSchema.extend({
  type: z.literal("DATABASE"),
  dbUrl: z
    .string()
    .trim()
    .min(1, "A URL do banco é obrigatória")
    .url("A URL do banco de dados deve ser válida")
    .refine(
      (val) => val.startsWith("postgresql://") || val.startsWith("postgres://"),
      "A URL do banco deve usar o protocolo postgresql:// ou postgres://"
    ),
});

const storageProjectSchema = baseProjectSchema.extend({
  type: z.literal("STORAGE"),
  storageType: z.enum(["AWS_S3", "S3_COMPATIBLE", "GOOGLE_DRIVE", "LOCAL_PATH"]),
  storageTarget: z.string().trim().min(1, "O bucket, pasta ou caminho local de origem é obrigatório"),
  storageCredentials: z.string().trim().min(2, "As credenciais de origem são obrigatórias"),
  storagePrefix: z.string().trim().optional().nullable(),
});

const projectSchema = z.discriminatedUnion("type", [
  databaseProjectSchema,
  storageProjectSchema,
]);

async function notifyApiCronReconciliation(): Promise<void> {
  const apiUrl = process.env.API_URL || "http://localhost:4000";
  try {
    const response = await fetch(`${apiUrl}/api/projects/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      console.warn(`⚠️ Reconciliação de cron retornou status HTTP ${response.status}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    console.warn(`⚠️ Não foi possível notificar reconciliação imediata à API (${msg}).`);
  }
}

export async function createProject(formData: FormData) {
  const rawType = (formData.get("type") as string) || "DATABASE";
  const rawTimezone = (formData.get("timezone") as string) || "UTC";

  const rawData = {
    name: formData.get("name") as string,
    type: rawType,
    cronSchedule: formData.get("cronSchedule") as string,
    timezone: rawTimezone,
    destinationType: formData.get("destinationType") as string,
    destinationTarget: formData.get("destinationTarget") as string,
    destinationCredentials: formData.get("destinationCredentials") as string,
    ...(rawType === "DATABASE"
      ? {
          dbUrl: formData.get("dbUrl") as string,
        }
      : {
          storageType: formData.get("storageType") as string,
          storageTarget: formData.get("storageTarget") as string,
          storageCredentials: formData.get("storageCredentials") as string,
          storagePrefix: (formData.get("storagePrefix") as string) || null,
        }),
  };

  const validation = projectSchema.safeParse(rawData);

  if (!validation.success) {
    const errorMsg = validation.error.errors[0]?.message || "Dados inválidos. Verifique os campos.";
    return { error: errorMsg };
  }

  const data = validation.data;

  try {
    if (data.type === "DATABASE") {
      await prisma.project.create({
        data: {
          name: data.name,
          type: "DATABASE",
          dbUrl: data.dbUrl,
          cronSchedule: data.cronSchedule,
          timezone: data.timezone,
          enabled: true,
          destinations: {
            create: {
              type: data.destinationType,
              targetFolder: data.destinationTarget,
              credentials: data.destinationCredentials,
            },
          },
        },
      });
    } else {
      await prisma.project.create({
        data: {
          name: data.name,
          type: "STORAGE",
          dbUrl: null,
          cronSchedule: data.cronSchedule,
          timezone: data.timezone,
          enabled: true,
          storageSource: {
            create: {
              type: data.storageType,
              targetFolder: data.storageTarget,
              credentials: data.storageCredentials,
              prefix: data.storagePrefix || null,
            },
          },
          destinations: {
            create: {
              type: data.destinationType,
              targetFolder: data.destinationTarget,
              credentials: data.destinationCredentials,
            },
          },
        },
      });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido ao salvar.";
    console.error("❌ Erro ao criar projeto no banco:", msg);
    return { error: "Erro interno ao salvar no banco de dados." };
  }

  await notifyApiCronReconciliation();
  revalidatePath("/");
  revalidatePath("/projects");
  redirect("/projects");
}

export async function toggleProjectEnabled(projectId: string, enabled: boolean) {
  try {
    await prisma.project.update({
      where: { id: projectId },
      data: { enabled },
    });

    await notifyApiCronReconciliation();
    revalidatePath("/");
    revalidatePath("/projects");
    return { success: true, enabled };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("❌ Erro ao alterar estado do agendamento:", msg);
    return { error: "Não foi possível alterar o estado do agendamento." };
  }
}

export async function deleteProject(projectId: string) {
  try {
    await prisma.project.delete({
      where: { id: projectId },
    });

    await notifyApiCronReconciliation();
    revalidatePath("/");
    revalidatePath("/projects");
    revalidatePath("/logs");
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("❌ Erro ao deletar projeto:", msg);
    return { error: "Erro interno ao deletar o projeto." };
  }
}

export interface TriggerBackupActionResult {
  success: boolean;
  status: "ACCEPTED" | "BUSY" | "FAILED";
  logId?: string;
  message?: string;
  error?: string;
}

export async function triggerBackupAction(projectId: string): Promise<TriggerBackupActionResult> {
  try {
    const apiUrl = process.env.API_URL || "http://localhost:4000";

    const response = await fetch(`${apiUrl}/api/projects/${projectId}/trigger`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: { logId?: string; status?: string; message?: string };
      error?: string | null;
    } | null;

    revalidatePath("/");
    revalidatePath("/projects");
    revalidatePath("/logs");

    if (response.status === 409) {
      return {
        success: false,
        status: "BUSY",
        error: payload?.error || "O motor de backup já está ocupado com outra execução em andamento.",
      };
    }

    if (!response.ok) {
      return {
        success: false,
        status: "FAILED",
        error: payload?.error || `A API de backup retornou status ${response.status}.`,
      };
    }

    return {
      success: true,
      status: "ACCEPTED",
      logId: payload?.data?.logId,
      message: payload?.data?.message || "Backup aceito e iniciado em segundo plano.",
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro de rede";
    console.error("❌ Erro ao disparar backup manual:", msg);
    return {
      success: false,
      status: "FAILED",
      error: "Falha ao se comunicar com o motor de backup.",
    };
  }
}
