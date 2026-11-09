import crypto from "crypto";
import { PassThrough, Readable, Transform, TransformCallback } from "stream";
import { finished } from "stream/promises";
import { decryptSecret, prisma } from "@vault-flow/db";
import { executePgDump, sanitizeDiagnosticMessage } from "./backupService";
import {
  uploadToS3,
  uploadToGoogleDrive,
  validateDestinationConfig,
  ValidatedDestination,
  UploadedArtifactInfo,
} from "./storageService";
import {
  executeStorageBackup,
  StorageBackupResult,
} from "./storageBackupService";
import {
  asError,
  getBackupTimeoutMs,
  waitForCleanup,
  withAbort,
} from "./backupRuntime";

export type BackupTriggerType = "MANUAL" | "SCHEDULED";

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Projeto não encontrado com o ID: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class BackupBusyError extends Error {
  public readonly reasonCode:
    "PROJECT_ALREADY_RUNNING" | "GLOBAL_CAPACITY_REACHED";

  constructor(
    reasonCode: "PROJECT_ALREADY_RUNNING" | "GLOBAL_CAPACITY_REACHED",
    message: string,
  ) {
    super(message);
    this.name = "BackupBusyError";
    this.reasonCode = reasonCode;
  }
}

export class BackupUnavailableError extends Error {
  constructor() {
    super(
      "Serviço de backup em encerramento. Tente novamente após a reinicialização.",
    );
    this.name = "BackupUnavailableError";
  }
}

export interface AcceptedBackupExecution {
  logId: string;
  projectId: string;
  projectName: string;
  status: "IN_PROGRESS";
  triggerType: BackupTriggerType;
  completionPromise: Promise<void>;
}

const activeProjectIds = new Set<string>();
const activeControllers = new Map<string, AbortController>();
const activeExecutions = new Set<Promise<void>>();
let shuttingDown = false;

export async function cancelActiveBackups(): Promise<void> {
  shuttingDown = true;
  for (const controller of activeControllers.values()) {
    controller.abort(
      new Error("Backup interrompido por encerramento do serviço."),
    );
  }
  await waitForCleanup([...activeExecutions]);
}

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
      "PROJECT_ALREADY_RUNNING",
      `Já existe um backup em andamento para o projeto "${projectName}".`,
    );
  }

  const maxConcurrent = getMaxConcurrentBackups();
  if (activeProjectIds.size >= maxConcurrent) {
    throw new BackupBusyError(
      "GLOBAL_CAPACITY_REACHED",
      `Limite global de backups simultâneos atingido (${activeProjectIds.size}/${maxConcurrent}). Aguarde a conclusão da execução atual.`,
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
    where: { status: "IN_PROGRESS" },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      errorMessage:
        "Execução interrompida por reinicialização ou encerramento do serviço da API.",
    },
  });

  if (result.count > 0) {
    console.warn(
      `⚠️ ${result.count} execução(ões) anterior(es) em aberto marcada(s) como FAILED no startup.`,
    );
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

async function executeBackupPipeline(
  project: ProjectWithRelations,
  logId: string,
): Promise<void> {
  console.log(
    `\n⏳ Iniciando rotina de backup [${logId}] para o projeto: ${project.name} (${project.type})`,
  );

  const controller = new AbortController();
  activeControllers.set(logId, controller);
  const { signal } = controller;
  const destinationStreams: PassThrough[] = [];
  const tasks: Promise<unknown>[] = [];
  let sourceStream: Readable | null = null;
  let sourceAbort: ((reason?: string) => void) | null = null;
  let streamedBytes = 0n;
  const sha256 = crypto.createHash("sha256");
  const metrics = new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      streamedBytes += BigInt(chunk.length);
      sha256.update(chunk);
      callback(null, chunk);
    },
  });

  const fail = (reason: unknown): void => {
    if (!signal.aborted) controller.abort(asError(reason));
  };
  const cancelResources = (): void => {
    const error = asError(signal.reason);
    sourceAbort?.(sanitizeDiagnosticMessage(error.message));
    sourceStream?.destroy(error);
    metrics.destroy(error);
    for (const stream of destinationStreams) stream.destroy(error);
  };
  signal.addEventListener("abort", cancelResources, { once: true });
  metrics.on("error", fail);

  // Toda tarefa é observada imediatamente, inclusive antes de preparar a origem.
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.push(task);
    void task.catch(fail);
    return task;
  };
  const timeoutMs = getBackupTimeoutMs();
  const deadline = setTimeout(() => {
    fail(
      new Error(
        `Tempo limite total de ${timeoutMs}ms excedido durante o backup.`,
      ),
    );
  }, timeoutMs);

  try {
    if (project.destinations.length === 0) {
      throw new Error(
        "Nenhum destino de backup configurado para este projeto.",
      );
    }
    const destinations: ValidatedDestination[] = project.destinations.map(
      (destination) => {
        if (destination.secretVersion !== 1) {
          throw new Error(
            "Credenciais do destino não estão cifradas. Execute a migração de segredos.",
          );
        }
        return validateDestinationConfig({
          ...destination,
          credentials: decryptSecret(destination.credentials, {
            resourceType: "Destination",
            resourceId: destination.id,
            field: "credentials",
          }),
        });
      },
    );

    const sanitizedName =
      project.name
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 64) || "project";
    // O ID da execução evita colisões entre tentativas e projetos com nomes iguais.
    const fileName =
      project.type === "STORAGE"
        ? `backup-storage-${sanitizedName}-${logId}.tar.gz`
        : `backup-db-${sanitizedName}-${logId}.dump`;
    const metricsDone = track(finished(metrics, { cleanup: true }));
    const uploadPromises: Promise<UploadedArtifactInfo>[] = [];
    for (const destination of destinations) {
      const stream = new PassThrough();
      stream.on("error", fail);
      destinationStreams.push(stream);
      metrics.pipe(stream);
      uploadPromises.push(
        track(
          destination.type === "AWS_S3"
            ? uploadToS3(
                stream,
                destination.targetFolder,
                fileName,
                destination.s3Credentials,
                signal,
              )
            : uploadToGoogleDrive(
                stream,
                destination.targetFolder,
                fileName,
                destination.googleCredentials,
                signal,
              ),
        ),
      );
    }

    let sourceDone: Promise<void>;
    let storageResult: StorageBackupResult | null = null;
    if (project.type === "STORAGE") {
      const source = project.storageSource;
      if (!source || source.secretVersion !== 1) {
        throw new Error(
          "Origem de storage ausente ou não cifrada. Execute a migração de segredos.",
        );
      }
      const preparingSource = track(
        executeStorageBackup(
          {
            type: source.type,
            targetFolder: source.targetFolder,
            prefix: source.prefix,
            credentials: decryptSecret(source.credentials, {
              resourceType: "StorageSource",
              resourceId: source.id,
              field: "credentials",
            }),
          },
          signal,
        ).then((result) => {
          // Mesmo uma resposta tardia de um SDK é observada e cancelada.
          track(result.donePromise);
          if (signal.aborted) result.abort(asError(signal.reason).message);
          return result;
        }),
      );
      storageResult = await withAbort(preparingSource, signal);
      sourceStream = storageResult.stream;
      sourceDone = storageResult.donePromise;
      sourceAbort = storageResult.abort;
    } else {
      if (!project.dbUrl || project.secretVersion !== 1) {
        throw new Error(
          "URL de conexão do banco ausente ou não cifrada. Execute a migração de segredos.",
        );
      }
      const execution = executePgDump(
        decryptSecret(project.dbUrl, {
          resourceType: "Project",
          resourceId: project.id,
          field: "dbUrl",
        }),
      );
      sourceStream = execution.stream;
      sourceDone = track(execution.donePromise);
      sourceAbort = execution.abort;
    }
    sourceStream.on("error", fail);
    signal.throwIfAborted();
    sourceStream.pipe(metrics);

    const [, , ...artifacts] = await withAbort(
      Promise.all([sourceDone, metricsDone, ...uploadPromises] as const),
      signal,
    );
    signal.throwIfAborted();
    clearTimeout(deadline);
    if (streamedBytes === 0n)
      throw new Error("O backup produziu 0 bytes. Artefato inválido.");
    const checksumSha256 = sha256.digest("hex");
    const artifactKey = artifacts
      .map((artifact) => artifact.artifactUri)
      .join(", ");
    await prisma.backupLog.update({
      where: { id: logId },
      data: {
        status: "SUCCESS",
        fileSize: streamedBytes,
        fileCount: storageResult ? storageResult.fileCount : 1,
        artifactKey,
        checksumSha256,
        completedAt: new Date(),
      },
    });
    console.log(
      `✅ Backup concluído para "${project.name}": ${streamedBytes} bytes, sha256=${checksumSha256.slice(0, 12)}...`,
    );
  } catch (error: unknown) {
    fail(error);
    await waitForCleanup(tasks);
    const errorMessage = sanitizeDiagnosticMessage(
      asError(signal.reason ?? error).message,
    );
    console.error(
      `❌ Falha no backup do projeto "${project.name}":`,
      errorMessage,
    );
    await prisma.backupLog.update({
      where: { id: logId },
      data: { status: "FAILED", errorMessage, completedAt: new Date() },
    });
    throw new Error(errorMessage);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancelResources);
    activeControllers.delete(logId);
  }
}

/**
 * Reserva capacidade de execução, persiste o BackupLog inicial (IN_PROGRESS)
 * antes de retornar e dispara o pipeline em background controlado.
 */
export async function startBackupForProject(
  projectId: string,
  triggerType: BackupTriggerType = "MANUAL",
): Promise<AcceptedBackupExecution> {
  if (shuttingDown) throw new BackupUnavailableError();
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { destinations: true, storageSource: true },
  });

  if (shuttingDown) throw new BackupUnavailableError();

  if (!project) {
    throw new ProjectNotFoundError(projectId);
  }
  if (triggerType === "SCHEDULED" && !project.enabled) {
    throw new Error("Agendamento pausado para este projeto.");
  }

  try {
    acquireConcurrencySlot(project.id, project.name);
  } catch (busyError: unknown) {
    if (busyError instanceof BackupBusyError && triggerType === "SCHEDULED") {
      await prisma.backupLog.create({
        data: {
          projectId: project.id,
          status: "SKIPPED_BUSY",
          triggerType: "SCHEDULED",
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
        status: "IN_PROGRESS",
        triggerType,
        projectId: project.id,
      },
    });
    logId = log.id;
    if (shuttingDown) {
      await prisma.backupLog.update({
        where: { id: logId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage:
            "Execução interrompida antes do início por encerramento do serviço.",
        },
      });
      throw new BackupUnavailableError();
    }
  } catch (dbErr: unknown) {
    releaseConcurrencySlot(project.id);
    throw dbErr;
  }

  const completionPromise = executeBackupPipeline(project, logId).finally(
    () => {
      releaseConcurrencySlot(project.id);
      activeExecutions.delete(completionPromise);
    },
  );
  activeExecutions.add(completionPromise);

  return {
    logId,
    projectId: project.id,
    projectName: project.name,
    status: "IN_PROGRESS",
    triggerType,
    completionPromise,
  };
}

/**
 * Executa o backup completo aguardando sua conclusão final.
 */
export async function runBackupForProject(
  projectId: string,
  triggerType: BackupTriggerType = "MANUAL",
): Promise<{ logId: string }> {
  const accepted = await startBackupForProject(projectId, triggerType);
  await accepted.completionPromise;
  return { logId: accepted.logId };
}
