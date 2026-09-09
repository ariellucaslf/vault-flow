import cron from 'node-cron';
import { prisma } from '@vault-flow/db';
import { runBackupForProject } from '../services/backupOrchestrator';

export async function initCronJobs() {
  console.log('🔄 Initializing backup schedules...');
  
  try {
    const projects = await prisma.project.findMany();

    for (const project of projects) {
      if (!cron.validate(project.cronSchedule)) {
        console.error(`❌ Invalid cron schedule for project ${project.name}: ${project.cronSchedule}`);
        continue;
      }

      console.log(`🕒 Scheduling backup for [${project.name}] with cron: ${project.cronSchedule}`);
      
      cron.schedule(project.cronSchedule, async () => {
        try {
          await runBackupForProject(project.id);
        } catch (e) {
          // Error is already logged in runBackupForProject
        }
      });
    }
  } catch (error) {
    console.error('❌ Failed to initialize cron jobs', error);
  }
}
