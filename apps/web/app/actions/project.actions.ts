"use server";

import { prisma } from "@vault-flow/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

const baseProjectSchema = z.object({
  name: z.string().min(1, "O nome do projeto é obrigatório"),
  type: z.enum(["DATABASE", "STORAGE"]).default("DATABASE"),
  cronSchedule: z.string().min(1, "O agendamento cron é obrigatório"),
  destinationType: z.enum(["AWS_S3", "GOOGLE_DRIVE"]),
  destinationTarget: z.string().min(1, "O alvo do destino é obrigatório (Bucket ou Folder ID)"),
  destinationCredentials: z.string().min(1, "As credenciais do destino são obrigatórias"),
});

const databaseProjectSchema = baseProjectSchema.extend({
  type: z.literal("DATABASE"),
  dbUrl: z.string().min(1, "A URL do banco é obrigatória").url("A URL do banco de dados deve ser válida"),
});

const storageProjectSchema = baseProjectSchema.extend({
  type: z.literal("STORAGE"),
  storageType: z.enum(["AWS_S3", "S3_COMPATIBLE", "GOOGLE_DRIVE", "LOCAL_PATH"]),
  storageTarget: z.string().min(1, "O bucket, pasta ou caminho local de origem é obrigatório"),
  storageCredentials: z.string().min(1, "As credenciais de origem são obrigatórias"),
  storagePrefix: z.string().optional().nullable(),
});

const projectSchema = z.discriminatedUnion("type", [
  databaseProjectSchema,
  storageProjectSchema,
]);

export async function createProject(formData: FormData) {
  const rawType = (formData.get("type") as string) || "DATABASE";

  const rawData = {
    name: formData.get("name") as string,
    type: rawType,
    cronSchedule: formData.get("cronSchedule") as string,
    destinationType: formData.get("destinationType") as string,
    destinationTarget: formData.get("destinationTarget") as string,
    destinationCredentials: formData.get("destinationCredentials") as string,
    ...(rawType === "DATABASE" ? {
      dbUrl: formData.get("dbUrl") as string,
    } : {
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

  revalidatePath("/");
  revalidatePath("/projects");
  redirect("/projects");
}

export async function deleteProject(projectId: string) {
  try {
    await prisma.project.delete({
      where: { id: projectId },
    });
    revalidatePath("/");
    revalidatePath("/projects");
    return { success: true };
  } catch (error: unknown) {
    console.error("❌ Erro ao deletar projeto:", error);
    return { error: "Erro interno ao deletar o projeto." };
  }
}

export async function triggerBackupAction(projectId: string) {
  try {
    const apiUrl = process.env.API_URL || "http://localhost:4000";

    const response = await fetch(apiUrl + "/api/projects/" + projectId + "/trigger", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error("A API retornou status " + response.status);
    }

    revalidatePath("/logs");
    return { success: true };
  } catch (error: unknown) {
    console.error("❌ Erro ao disparar backup manual:", error);
    return { error: "Falha ao se comunicar com o motor de backup." };
  }
}
