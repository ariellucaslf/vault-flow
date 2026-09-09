import { Request, Response } from "express";
import { prisma } from "@vault-flow/db";
import { runBackupForProject } from "../services/backupOrchestrator";
import { z } from "zod";

const triggerParamsSchema = z.object({
  id: z.string().min(1, "O ID do projeto é obrigatório"),
});

export const listProjects = async (req: Request, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      include: {
        destinations: true,
        storageSource: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({ success: true, data: projects, error: null });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro interno ao listar projetos.";
    res.status(500).json({ success: false, data: null, error: message });
  }
};

export const triggerBackup = async (req: Request, res: Response) => {
  const validation = triggerParamsSchema.safeParse(req.params);

  if (!validation.success) {
    res.status(400).json({
      success: false,
      data: null,
      error: validation.error.errors[0]?.message || "Parâmetros inválidos",
    });
    return;
  }

  const { id } = validation.data;

  try {
    const project = await prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      res.status(404).json({
        success: false,
        data: null,
        error: "Projeto não encontrado",
      });
      return;
    }

    // Executa assincronamente em background para nao bloquear a resposta HTTP
    runBackupForProject(id).catch((err: unknown) => {
      console.error("❌ Erro em segundo plano ao executar backup para " + id + ":", err);
    });

    res.json({
      success: true,
      data: { message: "Backup agendado para execução imediata com sucesso" },
      error: null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Erro interno ao disparar backup.";
    res.status(500).json({ success: false, data: null, error: message });
  }
};
