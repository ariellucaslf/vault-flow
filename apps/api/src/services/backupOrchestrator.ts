import crypto from 'crypto';
import { PassThrough, Readable, Transform, TransformCallback } from 'stream';
import { decryptSecret, prisma } from '@vault-flow/db';
import { executePgDump, sanitizeDiagnosticMessage } from './backupService';
import {
  uploadToS3,
  uploadToGoogleDrive,
  validateDestinationConfig,
  ValidatedDestination,
  UploadedArtifactInfo,
} from './storageService';
import { executeStorageBackup, StorageBackupResult } from './storageBackupService';

export type BackupTriggerType = 'MANUAL' | 'SCHEDULED';

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Projeto não encontrado com o ID: ${projectId}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class BackupBusyError extends Error {
  public readonly reasonCode: 'PROJECT_ALREADY_RUNNING' | 'GLOBAL_CAPACITY_REACHED';

  constructor(reasonCode: 'PROJECT_ALREADY_RUNNING' | 'GLOBAL_CAPACITY_REACHED', message: string) {
    super(message);
    this.name = 'BackupBusyError';
    this.reasonCode = reasonCode;
  }
}

export interface AcceptedBackupExecution {
  logId: string;
  projectId: string;
  projectName: string;
  status: 'IN_PROGRESS';
  triggerType: BackupTriggerType;
  completionPromise: Promise<void>;
}

const activeProjectIds = new Set<string>();

export function getMaxConcurrentBackups(): number {
  const raw = Number(process.env.MAX_CONCURRENT_BACKUPS);
  if (Number.isInteger(raw) && raw >= 1) {
    return raw;
  }
  return 1;
}

export function getActiveBackupStatus(): {
  activeCount: number;
  maxConcurrent: number;
  activeProjectIds: string[];
} {
  return {
    activeCount: activeProjectIds.size,
    maxConcurrent: getMaxConcurrentBackups(),
    activeProjectIds: Array.from(activeProjectIds),
  };
}

function acquireConcurrencySlot(projectId: string, projectName: string): void {
  if (activeProjectIds.has(projectId)) {
    throw new BackupBusyError(
      'PROJECT_ALREADY_RUNNING',
      `Já existe um backup em andamento para o projeto "${projectName}".`
    );
  }

  const maxConcurrent = getMaxConcurrentBackups();
  if (activeProjectIds.size >= maxConcurrent) {
    throw new BackupBusyError(
      'GLOBAL_CAPACITY_REACHED',
      `Limite global de backups simultâneos atingido (${activeProjectIds.size}/${maxConcurrent}). Aguarde a conclusão da execução atual.`
    );
  }

  activeProjectIds.add(projectId);
}

function releaseConcurrencySlot(projectId: string): void {
  activeProjectIds.delete(projectId);
}

/**
 * No startup da instância única da API, marca qualquer execução que tenha ficado
 * em estado IN_PROGRESS de um processo anterior como FAILED (interrompida).
 */
export async function reconcileInterruptedBackups(): Promise<number> {
  const result = await prisma.backupLog.updateMany({
    where: { status: 'IN_PROGRESS' },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      errorMessage: 'Execução interrompida por reinicialização ou encerramento do serviço da API.',
    },
  });

  if (result.count > 0) {
    console.warn(`⚠️ ${result.count} execução(ões) anterior(es) em aberto marcada(s) como FAILED no startup.`);
  }

  return result.count;
}

interface ProjectWithRelations {
  id: string;
  name: string;
  type: string;
  dbUrl: string | null;
  secretVersion: number;
  destinations: Array<{
    id: string;
    type: string;
    credentials: string;
    secretVersion: number;
    targetFolder: string;
  }>;
  storageSource: {
    id: string;
    type: string;
    credentials: string;
    secretVersion: number;
    targetFolder: string;
    prefix: string | null;
  } | null;
}

async function executeBackupPipeline(project: ProjectWithRelations, logId: string): Promise<void> {
  console.log(`\n⏳ Iniciando rotina de backup [${logId}] para o projeto: ${project.name} (${project.type})`);

  const abortController = new AbortController();
  const destinationStreams: PassThrough[] = [];
  let sourceStream: Readable | null = null;
  let sourceAbort: ((reason?: string) => void) | null = null;

  try {
    // 1. Decifrar e validar todos os destinos ANTES de iniciar qualquer processo de origem
    if (project.destinations.length === 0) {
      throw new Error('Nenhum destino de backup configurado para este projeto.');
    }

    const validatedDestinations: ValidatedDestination[] = project.destinations.map((dest) => {
      if (dest.secretVersion !== 1) {
        throw new Error(
          `Credenciais do destino (${dest.type}) não estão cifradas (secretVersion=${dest.secretVersion}). Execute a migração de segredos.`
        );
      }

      const decryptedCredentials = decryptSecret(dest.credentials, {
        resourceType: 'Destination',
        resourceId: dest.id,
        field: 'credentials',
      });

      return validateDestinationConfig({
        id: dest.id,
        type: dest.type,
        targetFolder: dest.targetFolder,
        credentials: decryptedCredentials,
      });
    });

    const sanitizedName =
      project.name
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 64) || 'project';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const fileName =
      project.type === 'STORAGE'
        ? `backup-storage-${sanitizedName}-${timestamp}.tar.gz`
        : `backup-db-${sanitizedName}-${timestamp}.dump`;

    // 2. Preparar Transform stream que contabiliza bytes e calcula SHA-256 respeitando backpressure
    let streamedBytes = 0;
    const sha256 = crypto.createHash('sha256');

    const metricsTransform = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        streamedBytes += chunk.length;
        sha256.update(chunk);
        callback(null, chunk);
      },
    });

    // 3. Conectar todos os consumidores (destinos) ANTES de produzir/drenar a origem
    const uploadPromises: Promise<UploadedArtifactInfo>[] = [];

    for (const destination of validatedDestinations) {
      const destPassThrough = new PassThrough();
      destinationStreams.push(destPassThrough);

      metricsTransform.on('error', (err: Error) => {
        if (!destPassThrough.destroyed) {
          destPassThrough.destroy(err);
        }
      });

      metricsTransform.pipe(destPassThrough);

      if (destination.type === 'AWS_S3') {
        uploadPromises.push(
          uploadToS3(
            destPassThrough,
            destination.targetFolder,
            fileName,
            destination.s3Credentials,
            abortController.signal
          )
        );
      } else {
        uploadPromises.push(
          uploadToGoogleDrive(
            destPassThrough,
            destination.targetFolder,
            fileName,
            destination.googleCredentials,
            abortController.signal
          )
        );
      }
    }

    // 4. Iniciar a origem e encadear ao metricsTransform
    let sourceDonePromise: Promise<void>;
    let storageResult: StorageBackupResult | null = null;

    if (project.type === 'STORAGE') {
      if (!project.storageSource) {
        throw new Error('Origem de storage não configurada para este projeto.');
      }

      if (project.storageSource.secretVersion !== 1) {
        throw new Error(
          `Credenciais da origem de storage não estão cifradas (secretVersion=${project.storageSource.secretVersion}). Execute a migração de segredos.`
        );
      }

      const decryptedSourceCredentials = decryptSecret(project.storageSource.credentials, {
        resourceType: 'StorageSource',
        resourceId: project.storageSource.id,
        field: 'credentials',
      });

      storageResult = await executeStorageBackup({
        type: project.storageSource.type,
        targetFolder: project.storageSource.targetFolder,
        prefix: project.storageSource.prefix,
        credentials: decryptedSourceCredentials,
      });
      sourceStream = storageResult.stream;
      sourceDonePromise = storageResult.donePromise;
      sourceAbort = storageResult.abort;
    } else {
      if (!project.dbUrl) {
        throw new Error('URL de conexão com o banco de dados não configurada.');
      }

      if (project.secretVersion !== 1) {
        throw new Error(
          `URL de conexão do projeto não está cifrada (secretVersion=${project.secretVersion}). Execute a migração de segredos.`
        );
      }

      const decryptedDbUrl = decryptSecret(project.dbUrl, {
        resourceType: 'Project',
        resourceId: project.id,
        field: 'dbUrl',
      });

      const pgExecution = executePgDump(decryptedDbUrl);
      sourceStream = pgExecution.stream;
      sourceDonePromise = pgExecution.donePromise;
      sourceAbort = pgExecution.abort;
    }

    sourceStream.on('error', (err: Error) => {
      if (!metricsTransform.destroyed) {
        metricsTransform.destroy(err);
      }
    });

    sourceStream.pipe(metricsTransform);

    // 5. Aguardar conclusão integral da origem E de todos os destinos obrigatórios.
    // Se qualquer etapa falhar, cancela imediatamente o trabalho remanescente e aguarda limpeza.
    const allTasks: Promise<unknown>[] = [sourceDonePromise, ...uploadPromises];

    try {
      await Promise.all(allTasks);
    } catch (firstError: unknown) {
      const reason =
        firstError instanceof Error
          ? sanitizeDiagnosticMessage(firstError.message)
          : 'Falha durante execução do pipeline de backup.';

      abortController.abort();
      if (sourceAbort) {
        sourceAbort(reason);
      }
      if (sourceStream && !sourceStream.destroyed) {
        sourceStream.destroy(new Error(reason));
      }
      if (!metricsTransform.destroyed) {
        metricsTransform.destroy(new Error(reason));
      }
      for (const ds of destinationStreams) {
        if (!ds.destroyed) {
          ds.destroy(new Error(reason));
        }
      }

      await Promise.allSettled(allTasks);
      throw firstError;
    }

    const uploadedArtifacts = await Promise.all(uploadPromises);
    const finalBytes = streamedBytes > 0 ? streamedBytes : storageResult ? storageResult.getCompressedBytes() : 0;
    const finalCount = storageResult ? storageResult.fileCount : 1;

    if (finalBytes <= 0) {
      throw new Error('O backup produziu 0 bytes. Artefato inválido descartado.');
    }

    const checksumSha256 = sha256.digest('hex');
    const artifactKey = uploadedArtifacts.map((item) => item.artifactUri).join(', ');

    await prisma.backupLog.update({
      where: { id: logId },
      data: {
        status: 'SUCCESS',
        fileSize: BigInt(finalBytes),
        fileCount: finalCount,
        artifactKey,
        checksumSha256,
        completedAt: new Date(),
      },
    });

    console.log(
      `✅ Backup concluído com sucesso para "${project.name}": ${finalBytes} bytes, sha256=${checksumSha256.slice(0, 12)}..., destino=${artifactKey}`
    );
  } catch (error: unknown) {
    abortController.abort();
    if (sourceAbort) {
      sourceAbort('Backup interrompido por erro.');
    }
    for (const ds of destinationStreams) {
      if (!ds.destroyed) {
        ds.destroy();
      }
    }

    const rawMessage = error instanceof Error ? error.message : 'Erro desconhecido durante o backup';
    const errorMessage = sanitizeDiagnosticMessage(rawMessage);
    console.error(`❌ Falha no backup do projeto "${project.name}":`, errorMessage);

    await prisma.backupLog.update({
      where: { id: logId },
      data: {
        status: 'FAILED',
        errorMessage,
        completedAt: new Date(),
      },
    });

    throw new Error(errorMessage);
  }
}

/**
 * Reserva capacidade de execução, persiste o BackupLog inicial (IN_PROGRESS)
 * antes de retornar e dispara o pipeline em background controlado.
 */
export async function startBackupForProject(
  projectId: string,
  triggerType: BackupTriggerType = 'MANUAL'
): Promise<AcceptedBackupExecution> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { destinations: true, storageSource: true },
  });

  if (!project) {
    throw new ProjectNotFoundError(projectId);
  }

  try {
    acquireConcurrencySlot(project.id, project.name);
  } catch (busyError: unknown) {
    if (busyError instanceof BackupBusyError && triggerType === 'SCHEDULED') {
      await prisma.backupLog.create({
        data: {
          projectId: project.id,
          status: 'SKIPPED_BUSY',
          triggerType: 'SCHEDULED',
          completedAt: new Date(),
          errorMessage: busyError.message,
        },
      });
    }
    throw busyError;
  }

  let logId: string;
  try {
    const log = await prisma.backupLog.create({
      data: {
        status: 'IN_PROGRESS',
        triggerType,
        projectId: project.id,
      },
    });
    logId = log.id;
  } catch (dbErr: unknown) {
    releaseConcurrencySlot(project.id);
    throw dbErr;
  }

  const completionPromise = executeBackupPipeline(project, logId).finally(() => {
    releaseConcurrencySlot(project.id);
  });

  return {
    logId,
    projectId: project.id,
    projectName: project.name,
    status: 'IN_PROGRESS',
    triggerType,
    completionPromise,
  };
}

/**
 * Executa o backup completo aguardando sua conclusão final.
 */
export async function runBackupForProject(
  projectId: string,
  triggerType: BackupTriggerType = 'MANUAL'
): Promise<{ logId: string }> {
  const accepted = await startBackupForProject(projectId, triggerType);
  await accepted.completionPromise;
  return { logId: accepted.logId };
}
