import { prisma } from "@vault-flow/db";
import { executePgDump } from "./backupService";
import { uploadToS3, uploadToGoogleDrive, S3Credentials } from "./storageService";
import { executeStorageBackup, StorageBackupResult } from "./storageBackupService";
import { PassThrough, Readable } from "stream";

export async function runBackupForProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { destinations: true, storageSource: true }
  });

  if (!project) throw new Error("Projeto não encontrado com o ID: " + projectId);

  console.log("\n⏳ Iniciando rotina de backup para o projeto: " + project.name + " (" + project.type + ")");

  const log = await prisma.backupLog.create({
    data: {
      status: "IN_PROGRESS",
      projectId: project.id,
    }
  });

  try {
    let sourceStream: Readable;
    let storageResult: StorageBackupResult | null = null;
    let dbBytes = 0;
    const sanitizedName = project.name.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");

    let fileName: string;

    if (project.type === "STORAGE") {
      if (!project.storageSource) {
        throw new Error("Origem de storage não configurada para este projeto.");
      }

      fileName = "backup-storage-" + sanitizedName + "-" + Date.now() + ".tar.gz";
      storageResult = await executeStorageBackup(project.storageSource);
      sourceStream = storageResult.stream;
    } else {
      if (!project.dbUrl) {
        throw new Error("URL de conexão com o banco de dados não configurada.");
      }

      fileName = "backup-" + sanitizedName + "-" + Date.now() + ".dump";
      const dumpStream = executePgDump(project.dbUrl);

      const counterStream = new PassThrough();
      counterStream.on("data", (chunk: Buffer) => {
        dbBytes += chunk.length;
      });

      dumpStream.pipe(counterStream);
      sourceStream = counterStream;
    }

    const uploadPromises: Promise<unknown>[] = [];

    for (const destination of project.destinations) {
      const passThroughStream = new PassThrough();
      sourceStream.pipe(passThroughStream);

      if (destination.type === "AWS_S3") {
        try {
          const creds: S3Credentials = JSON.parse(destination.credentials);
          uploadPromises.push(
            uploadToS3(passThroughStream, destination.targetFolder, fileName, {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              region: creds.region || "us-east-1",
              endpoint: creds.endpoint,
              forcePathStyle: creds.forcePathStyle,
            })
          );
        } catch (err) {
          console.error("❌ Falha ao processar credenciais S3 para o projeto " + project.name, err);
        }
      } else if (destination.type === "GOOGLE_DRIVE") {
        uploadPromises.push(
          uploadToGoogleDrive(passThroughStream, destination.targetFolder, fileName, destination.credentials)
        );
      }
    }

    if (uploadPromises.length === 0) {
      console.log("⚠️ Nenhum destino válido configurado para o projeto " + project.name + ". Backup abortado.");
      await prisma.backupLog.update({
        where: { id: log.id },
        data: { status: "FAILED", errorMessage: "Nenhum destino de backup válido configurado." }
      });
      return;
    }

    // Aguarda todos os uploads e, se for storage, o empacotamento completo
    if (storageResult) {
      await Promise.all([...uploadPromises, storageResult.donePromise]);
    } else {
      await Promise.all(uploadPromises);
    }

    const finalBytes = storageResult ? storageResult.getCompressedBytes() : dbBytes;
    const finalCount = storageResult ? storageResult.fileCount : 1;

    await prisma.backupLog.update({
      where: { id: log.id },
      data: {
        status: "SUCCESS",
        fileSize: BigInt(finalBytes),
        fileCount: finalCount,
      }
    });

    console.log("✅ Backup concluído com sucesso para o projeto: " + project.name + " (" + finalBytes + " bytes, " + finalCount + " arquivos)");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Erro desconhecido durante o backup";
    console.error("❌ Falha no backup do projeto " + project.name + ":", errorMessage);
    await prisma.backupLog.update({
      where: { id: log.id },
      data: {
        status: "FAILED",
        errorMessage,
      }
    });
    throw error;
  }
}
