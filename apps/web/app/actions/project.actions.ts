"use server";

import crypto from "crypto";
import path from "path";
import { encryptSecret, prisma } from "@vault-flow/db";
import { getServerSession } from "next-auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authOptions } from "../../lib/auth";

async function requireAuthenticatedAdminSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return Boolean(session?.user?.name);
}

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

const s3JsonSchema = z.object({
  accessKeyId: z.string().trim().min(1, "accessKeyId é obrigatório nas credenciais S3."),
  secretAccessKey: z.string().trim().min(1, "secretAccessKey é obrigatório nas credenciais S3."),
  region: z.string().trim().min(1).optional(),
  endpoint: z.string().trim().url("endpoint S3 deve ser uma URL válida.").optional(),
  forcePathStyle: z.boolean().optional(),
});

const googleDriveJsonSchema = z.object({
  client_email: z.string().trim().email("client_email inválido no JSON da Service Account."),
  private_key: z.string().min(1, "private_key é obrigatório no JSON da Service Account."),
});

function validateProviderCredentialsJson(
  providerType: "AWS_S3" | "S3_COMPATIBLE" | "GOOGLE_DRIVE" | "LOCAL_PATH",
  rawJsonString: string,
  contextLabel: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonString);
  } catch {
    throw new Error(`As credenciais de ${contextLabel} devem estar em formato JSON válido.`);
  }

  if (providerType === "AWS_S3" || providerType === "S3_COMPATIBLE") {
    const check = s3JsonSchema.safeParse(parsed);
    if (!check.success) {
      throw new Error(
        `Credenciais S3 inválidas em ${contextLabel}: ${check.error.errors[0]?.message || "campos obrigatórios ausentes."}`
      );
    }
    return JSON.stringify(check.data);
  }

  if (providerType === "GOOGLE_DRIVE") {
    const check = googleDriveJsonSchema.safeParse(parsed);
    if (!check.success) {
      throw new Error(
        `Credenciais Google Drive inválidas em ${contextLabel}: ${check.error.errors[0]?.message || "Service Account inválida."}`
      );
    }
    return JSON.stringify(parsed);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Para origem LOCAL_PATH, informe um objeto JSON (ex: {}).`);
  }
  return "{}";
}

function validateDatabaseUrlStructure(rawDbUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawDbUrl);
  } catch {
    throw new Error("A URL do banco de dados PostgreSQL é inválida.");
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("A URL do banco deve utilizar o protocolo postgresql:// ou postgres://.");
  }

  const dbName = parsed.pathname.replace(/^\/+/, "");
  if (!parsed.hostname || !dbName || dbName.includes("/") || dbName.includes("\0")) {
    throw new Error("A URL do PostgreSQL deve conter host e nome do banco válidos.");
  }

  return rawDbUrl;
}

function validateLocalSourceTarget(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!path.isAbsolute(trimmed) || trimmed.includes("\0") || trimmed === "/") {
    throw new Error("O caminho de origem LOCAL_PATH deve ser um caminho absoluto de volume válido (não raiz '/').");
  }

  const normalized = path.posix.normalize(trimmed);
  if (
    normalized.startsWith("/etc") ||
    normalized.startsWith("/proc") ||
    normalized.startsWith("/sys") ||
    normalized.startsWith("/dev") ||
    normalized.startsWith("/run") ||
    normalized.startsWith("/var/run")
  ) {
    throw new Error("Caminho de sistema proibido como origem de backup local.");
  }

  const rawAllowed = process.env.ALLOWED_LOCAL_BACKUP_ROOTS?.trim() || "";
  const allowedRoots = rawAllowed
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && path.isAbsolute(r) && r !== "/");

  if (allowedRoots.length > 0) {
    const insideAllowed = allowedRoots.some((root) => {
      const cleanRoot = path.posix.normalize(root).replace(/\/+$/, "");
      return normalized === cleanRoot || normalized.startsWith(`${cleanRoot}/`);
    });
    if (!insideAllowed) {
      throw new Error(
        "O caminho informado para LOCAL_PATH não pertence aos volumes permitidos em ALLOWED_LOCAL_BACKUP_ROOTS."
      );
    }
  }

  return normalized;
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
  destinationTarget: z
    .string()
    .trim()
    .min(1, "O alvo do destino é obrigatório (Bucket ou Folder ID)")
    .max(255, "Alvo do destino muito longo"),
  destinationCredentials: z.string().trim().min(2, "As credenciais do destino são obrigatórias"),
});

const databaseProjectSchema = baseProjectSchema.extend({
  type: z.literal("DATABASE"),
  dbUrl: z.string().trim().min(1, "A URL do banco é obrigatória"),
});

const storageProjectSchema = baseProjectSchema.extend({
  type: z.literal("STORAGE"),
  storageType: z.enum(["AWS_S3", "S3_COMPATIBLE", "GOOGLE_DRIVE", "LOCAL_PATH"]),
  storageTarget: z
    .string()
    .trim()
    .min(1, "O bucket, pasta ou caminho local de origem é obrigatório")
    .max(512, "Alvo de origem muito longo"),
  storageCredentials: z.string().trim().min(2, "As credenciais de origem são obrigatórias"),
  storagePrefix: z.string().trim().max(255).optional().nullable(),
});

const projectSchema = z.discriminatedUnion("type", [
  databaseProjectSchema,
  storageProjectSchema,
]);

const projectIdSchema = z.string().uuid("Identificador do projeto inválido.");

function getInternalApiHeaders(): Record<string, string> {
  const internalToken = process.env.INTERNAL_API_TOKEN?.trim() || "";
  return {
    "Content-Type": "application/json",
    ...(internalToken ? { "x-internal-token": internalToken } : {}),
  };
}

async function notifyApiCronReconciliation(): Promise<void> {
  const apiUrl = process.env.API_URL || "http://localhost:4000";
  try {
    const response = await fetch(`${apiUrl}/api/projects/reconcile`, {
      method: "POST",
      headers: getInternalApiHeaders(),
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
  if (!(await requireAuthenticatedAdminSession())) {
    return { error: "Não autorizado. Sua sessão administrativa expirou." };
  }

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
    const normalizedDestCredentials = validateProviderCredentialsJson(
      data.destinationType,
      data.destinationCredentials,
      "destino"
    );

    const projectId = crypto.randomUUID();
    const destinationId = crypto.randomUUID();

    const encryptedDestCredentials = encryptSecret(normalizedDestCredentials, {
      resourceType: "Destination",
      resourceId: destinationId,
      field: "credentials",
    });

    if (data.type === "DATABASE") {
      const validatedDbUrl = validateDatabaseUrlStructure(data.dbUrl);
      const encryptedDbUrl = encryptSecret(validatedDbUrl, {
        resourceType: "Project",
        resourceId: projectId,
        field: "dbUrl",
      });

      await prisma.project.create({
        data: {
          id: projectId,
          name: data.name,
          type: "DATABASE",
          dbUrl: encryptedDbUrl,
          secretVersion: 1,
          cronSchedule: data.cronSchedule,
          timezone: data.timezone,
          enabled: true,
          destinations: {
            create: {
              id: destinationId,
              type: data.destinationType,
              targetFolder: data.destinationTarget,
              credentials: encryptedDestCredentials,
              secretVersion: 1,
            },
          },
        },
      });
    } else {
      const normalizedSourceTarget =
        data.storageType === "LOCAL_PATH"
          ? validateLocalSourceTarget(data.storageTarget)
          : data.storageTarget;

      const normalizedSourceCredentials = validateProviderCredentialsJson(
        data.storageType,
        data.storageCredentials,
        "origem de storage"
      );

      const storageSourceId = crypto.randomUUID();
      const encryptedSourceCredentials = encryptSecret(normalizedSourceCredentials, {
        resourceType: "StorageSource",
        resourceId: storageSourceId,
        field: "credentials",
      });

      await prisma.project.create({
        data: {
          id: projectId,
          name: data.name,
          type: "STORAGE",
          dbUrl: null,
          secretVersion: 1,
          cronSchedule: data.cronSchedule,
          timezone: data.timezone,
          enabled: true,
          storageSource: {
            create: {
              id: storageSourceId,
              type: data.storageType,
              targetFolder: normalizedSourceTarget,
              credentials: encryptedSourceCredentials,
              secretVersion: 1,
              prefix: data.storagePrefix || null,
            },
          },
          destinations: {
            create: {
              id: destinationId,
              type: data.destinationType,
              targetFolder: data.destinationTarget,
              credentials: encryptedDestCredentials,
              secretVersion: 1,
            },
          },
        },
      });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro ao validar ou salvar projeto.";
    console.error("❌ Erro ao criar projeto:", msg);
    return { error: msg };
  }

  await notifyApiCronReconciliation();
  revalidatePath("/");
  revalidatePath("/projects");
  redirect("/projects");
}

export async function toggleProjectEnabled(projectId: string, enabled: boolean) {
  if (!(await requireAuthenticatedAdminSession())) {
    return { error: "Não autorizado. Faça login novamente." };
  }

  const idCheck = projectIdSchema.safeParse(projectId);
  if (!idCheck.success) {
    return { error: "ID do projeto inválido." };
  }

  try {
    await prisma.project.update({
      where: { id: idCheck.data },
      data: { enabled: Boolean(enabled) },
    });

    await notifyApiCronReconciliation();
    revalidatePath("/");
    revalidatePath("/projects");
    return { success: true, enabled: Boolean(enabled) };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("❌ Erro ao alterar estado do agendamento:", msg);
    return { error: "Não foi possível alterar o estado do agendamento." };
  }
}

export async function deleteProject(projectId: string) {
  if (!(await requireAuthenticatedAdminSession())) {
    return { error: "Não autorizado. Faça login novamente." };
  }

  const idCheck = projectIdSchema.safeParse(projectId);
  if (!idCheck.success) {
    return { error: "ID do projeto inválido." };
  }

  try {
    await prisma.project.delete({
      where: { id: idCheck.data },
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
  if (!(await requireAuthenticatedAdminSession())) {
    return {
      success: false,
      status: "FAILED",
      error: "Não autorizado. Faça login novamente.",
    };
  }

  const idCheck = projectIdSchema.safeParse(projectId);
  if (!idCheck.success) {
    return {
      success: false,
      status: "FAILED",
      error: "ID do projeto inválido.",
    };
  }

  try {
    const apiUrl = process.env.API_URL || "http://localhost:4000";

    const response = await fetch(`${apiUrl}/api/projects/${idCheck.data}/trigger`, {
      method: "POST",
      headers: getInternalApiHeaders(),
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
