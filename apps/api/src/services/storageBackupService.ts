import { pack } from "tar-stream";
import { createGzip } from "zlib";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { asError, withAbort } from "./backupRuntime";
import { z } from "zod";
import {
  IStorageProvider,
  StorageFileItem,
} from "./providers/storageProvider.interface";
import { S3StorageProvider } from "./providers/s3Provider";
import { GoogleDriveStorageProvider } from "./providers/googleDriveProvider";
import { LocalStorageProvider } from "./providers/localProvider";

const s3SourceCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, "accessKeyId é obrigatório."),
  secretAccessKey: z.string().min(1, "secretAccessKey é obrigatório."),
  region: z.string().min(1).optional(),
  endpoint: z.string().url("endpoint S3 deve ser uma URL válida.").optional(),
  forcePathStyle: z.boolean().optional(),
});

const googleSourceCredentialsSchema = z.object({
  client_email: z
    .string()
    .email("client_email inválido nas credenciais Google Drive."),
  private_key: z
    .string()
    .min(1, "private_key obrigatório nas credenciais Google Drive."),
});

export interface StorageSourceInput {
  type: string;
  credentials: string;
  targetFolder: string;
  prefix?: string | null;
}

export interface StorageBackupResult {
  stream: Readable;
  fileCount: number;
  totalOriginalBytes: number;
  getCompressedBytes: () => bigint;
  donePromise: Promise<void>;
  abort: (reason?: string) => void;
}

/**
 * Cria o provedor correto para o storage de acordo com o tipo configurado
 */
export function createStorageProvider(
  source: StorageSourceInput,
): IStorageProvider {
  switch (source.type) {
    case "AWS_S3":
    case "S3_COMPATIBLE": {
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(source.credentials);
      } catch {
        throw new Error("Credenciais de S3 inválidas. Esperado formato JSON.");
      }

      const parsed = s3SourceCredentialsSchema.safeParse(rawJson);
      if (!parsed.success) {
        const msg =
          parsed.error.errors[0]?.message || "Credenciais S3 incompletas.";
        throw new Error("Configuração de S3 de origem inválida: " + msg);
      }

      return new S3StorageProvider({
        bucket: source.targetFolder,
        accessKeyId: parsed.data.accessKeyId,
        secretAccessKey: parsed.data.secretAccessKey,
        region: parsed.data.region,
        endpoint: parsed.data.endpoint,
        forcePathStyle: parsed.data.forcePathStyle,
      });
    }

    case "GOOGLE_DRIVE": {
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(source.credentials);
      } catch {
        throw new Error(
          "Credenciais de origem do Google Drive não estão em formato JSON válido.",
        );
      }

      const parsed = googleSourceCredentialsSchema.safeParse(rawJson);
      if (!parsed.success) {
        const msg =
          parsed.error.errors[0]?.message ||
          "Credenciais Google Drive incompletas.";
        throw new Error("Configuração de origem Google Drive inválida: " + msg);
      }

      return new GoogleDriveStorageProvider({
        folderId: source.targetFolder,
        credentialsJson: source.credentials,
      });
    }

    case "LOCAL_PATH": {
      return new LocalStorageProvider({
        basePath: source.targetFolder,
      });
    }

    default:
      throw new Error(
        "Tipo de storage de origem não suportado: " + source.type,
      );
  }
}

/**
 * Executa o backup de um storage de origem, empacotando os arquivos em tempo real
 * num fluxo comprimido .tar.gz sem gravar nada no disco local.
 */
export async function executeStorageBackup(
  source: StorageSourceInput,
  signal?: AbortSignal,
): Promise<StorageBackupResult> {
  signal?.throwIfAborted();
  const provider = createStorageProvider(source);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(asError(signal?.reason));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();

  let files: StorageFileItem[];
  try {
    files = await withAbort(
      provider.listFiles(source.prefix || undefined, controller.signal),
      controller.signal,
    );
  } catch (error: unknown) {
    signal?.removeEventListener("abort", forwardAbort);
    provider.dispose?.();
    throw error;
  }

  const archive = pack();
  const gzip = createGzip({ level: 6 });
  let compressedBytes = 0n;
  // Não colocar o stream em modo flowing antes de o upload estar conectado.
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += BigInt(chunk.length);
      callback(null, chunk);
    },
  });
  let currentFile: Readable | undefined;
  let failure: Error | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const fail = (reason: unknown): void => {
    if (failure) return;
    failure = asError(reason);
    rejectDone(failure);
    controller.abort(failure);
    currentFile?.destroy(failure);
    archive.destroy(failure);
    gzip.destroy(failure);
    output.destroy(failure);
  };
  const onAbort = (): void => fail(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  archive.on("error", fail);
  output.on("error", fail);
  const compression = pipeline(archive, gzip, output);
  void compression.catch(fail);

  const produce = async (): Promise<void> => {
    try {
      controller.signal.throwIfAborted();
      if (files.length === 0) {
        const marker = Buffer.from(
          "VaultFlow Storage Backup\nStatus: Pasta vazia\n",
        );
        archive.entry(
          {
            name: ".vaultflow-empty-snapshot.txt",
            size: marker.length,
            mode: 0o600,
          },
          marker,
        );
      }
      const names = new Set<string>();
      for (const file of files) {
        controller.signal.throwIfAborted();
        // Evita traversal e colisões depois da normalização feita por ferramentas tar.
        const key = file.key;
        if (
          !key ||
          key.includes("\0") ||
          key.includes("\\") ||
          path.posix.isAbsolute(key) ||
          key
            .split("/")
            .some((part) => part === ".." || part === "." || part === "") ||
          /^[A-Za-z]:/.test(key) ||
          names.has(key)
        ) {
          throw new Error(
            "Nome de arquivo inseguro ou duplicado na origem de storage.",
          );
        }
        if (!Number.isSafeInteger(file.size) || file.size < 0) {
          throw new Error("Tamanho de arquivo inválido na origem de storage.");
        }
        names.add(key);
        const openingFile = provider
          .getFileStream(file, controller.signal)
          .then((stream) => {
            if (controller.signal.aborted) {
              stream.destroy();
              controller.signal.throwIfAborted();
            }
            return stream;
          });
        currentFile = await withAbort(openingFile, controller.signal);
        currentFile.on("error", fail);
        // Fornecer tamanho permite escrever o tar sem acumular o arquivo em RAM.
        const entry = archive.entry({
          name: key,
          size: file.size,
          type: "file",
          mode: 0o600,
          mtime: file.lastModified ?? new Date(0),
        });
        await withAbort(
          pipeline(currentFile, entry, { signal: controller.signal }),
          controller.signal,
        );
        currentFile = undefined;
      }
      archive.finalize();
      await withAbort(compression, controller.signal);
      resolveDone();
    } catch (error: unknown) {
      fail(error);
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", onAbort);
      provider.dispose?.();
    }
  };
  // O chamador recebe o stream e instala consumidores antes de a produção começar.
  setImmediate(() => {
    void produce();
  });
  return {
    stream: output,
    fileCount: files.length,
    totalOriginalBytes: files.reduce((sum, file) => sum + file.size, 0),
    getCompressedBytes: () => compressedBytes,
    donePromise,
    abort: (reason = "Arquivamento de storage cancelado.") =>
      fail(new Error(reason)),
  };
}
