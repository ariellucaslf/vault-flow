import { Request, Response } from 'express';
import { prisma } from '@vault-flow/db';
import { runBackupForProject } from '../services/backupOrchestrator';

export const listProjects = async (req: Request, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      include: { destinations: true }
    });
    res.json({ success: true, data: projects, error: null });
  } catch (error: any) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};

export const triggerBackup = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    // Execute asynchronously to not block the response
    runBackupForProject(id as string).catch(console.error);
    res.json({ success: true, data: { message: "Backup queued successfully" }, error: null });
  } catch (error: any) {
    res.status(500).json({ success: false, data: null, error: error.message });
  }
};
