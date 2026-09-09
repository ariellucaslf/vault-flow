import { prisma } from '@vault-flow/db';
import { executePgDump } from './backupService';
import { uploadToS3, uploadToGoogleDrive } from './storageService';
import { PassThrough } from 'stream';

export async function runBackupForProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { destinations: true }
  });

  if (!project) throw new Error("Project not found");

  console.log(`\n⏳ Starting backup for project: ${project.name}`);
  
  const log = await prisma.backupLog.create({
    data: {
      status: 'IN_PROGRESS',
      projectId: project.id,
    }
  });

  try {
    const dumpStream = executePgDump(project.dbUrl);
    const uploadPromises = [];
    const fileName = `backup-${project.name.replace(/\s+/g, '-')}-${Date.now()}.dump`;

    for (const destination of project.destinations) {
      const passThroughStream = new PassThrough();
      dumpStream.pipe(passThroughStream);

      if (destination.type === 'AWS_S3') {
        try {
          const creds = JSON.parse(destination.credentials);
          uploadPromises.push(
            uploadToS3(passThroughStream, destination.targetFolder, fileName, {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              region: creds.region || 'us-east-1'
            })
          );
        } catch (err) {
          console.error(`❌ Failed to parse S3 credentials for project ${project.name}`);
        }
      } else if (destination.type === 'GOOGLE_DRIVE') {
        uploadPromises.push(
          uploadToGoogleDrive(passThroughStream, destination.targetFolder, fileName, destination.credentials)
        );
      }
    }
    
    if (uploadPromises.length === 0) {
      console.log(`⚠️ No valid destinations found for project ${project.name}. Backup skipped.`);
      await prisma.backupLog.update({
        where: { id: log.id },
        data: { status: 'FAILED', errorMessage: 'No valid destinations configured' }
      });
      return;
    }

    await Promise.all(uploadPromises);
    
    await prisma.backupLog.update({
      where: { id: log.id },
      data: { status: 'SUCCESS' }
    });
    
    console.log(`✅ Backup completed successfully for project: ${project.name}`);
  } catch (error: any) {
    console.error(`❌ Backup failed for project: ${project.name}`, error);
    await prisma.backupLog.update({
       where: { id: log.id },
       data: {
         status: 'FAILED',
         errorMessage: error?.message || 'Unknown error occurred'
       }
    });
    throw error;
  }
}
