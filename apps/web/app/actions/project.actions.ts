"use server";

import { prisma } from "@vault-flow/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

const projectSchema = z.object({
  name: z.string().min(1, "O nome do projeto é obrigatório"),
  dbUrl: z.string().url("A URL do banco de dados deve ser válida"),
  cronSchedule: z.string().min(1, "O agendamento cron é obrigatório"),
  destinationType: z.enum(["AWS_S3", "GOOGLE_DRIVE"]),
  destinationTarget: z.string().min(1, "O alvo do destino é obrigatório (Bucket ou Folder ID)"),
  destinationCredentials: z.string().min(1, "As credenciais do destino são obrigatórias"),
});

export async function createProject(formData: FormData) {
  const data = {
    name: formData.get("name") as string,
    dbUrl: formData.get("dbUrl") as string,
    cronSchedule: formData.get("cronSchedule") as string,
    destinationType: formData.get("destinationType") as string,
    destinationTarget: formData.get("destinationTarget") as string,
    destinationCredentials: formData.get("destinationCredentials") as string,
  };

  const validation = projectSchema.safeParse(data);

  if (!validation.success) {
    return { error: "Dados inválidos. Verifique os campos." };
  }

  try {
    await prisma.project.create({
      data: {
        name: validation.data.name,
        dbUrl: validation.data.dbUrl,
        cronSchedule: validation.data.cronSchedule,
        destinations: {
          create: {
            type: validation.data.destinationType,
            targetFolder: validation.data.destinationTarget,
            credentials: validation.data.destinationCredentials,
          }
        }
      }
    });
  } catch (error) {
    console.error("Erro ao criar projeto:", error);
    return { error: "Erro interno ao salvar no banco de dados." };
  }

  revalidatePath("/");
  revalidatePath("/projects");
  redirect("/projects");
}

export async function deleteProject(projectId: string) {
  try {
    await prisma.project.delete({
      where: { id: projectId }
    });
    revalidatePath("/");
    revalidatePath("/projects");
  } catch (error) {
    console.error("Erro ao deletar projeto:", error);
    return { error: "Erro interno ao deletar o projeto." };
  }
}

export async function triggerBackupAction(projectId: string) {
  try {
    // A API do Node.js está rodando na porta 4000 localmente ou no domínio configurado
    const apiUrl = process.env.API_URL || "http://localhost:4000";
    
    const response = await fetch(`${apiUrl}/api/projects/${projectId}/trigger`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`API retornou status ${response.status}`);
    }

    revalidatePath("/logs");
    return { success: true };
  } catch (error) {
    console.error("Erro ao engatilhar backup manual:", error);
    return { error: "Falha ao se comunicar com o motor de backup." };
  }
}
