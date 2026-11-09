import { TarArchive } from "archiver";
import { Readable, PassThrough } from "stream";
import { z } from "zod";
import { IStorageProvider } from "./providers/storageProvider.interface";
import { S3StorageProvider } from "./providers/s3Provider";
import { GoogleDriveStorageProvider } from "./providers/googleDriveProvider";
import { LocalStorageProvider } from "./providers/localProvider";
import { sanitizeDiagnosticMessage } from "./backupService";

const s3SourceCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, "accessKeyId é obrigatório."),
  secretAccessKey: z.string().min(1, "secretAccessKey é obrigatório."),
  region: z.string().min(1).optional(),
  endpoint: z.string().url("endpoint S3 deve ser uma URL válida.").optional(),
  forcePathStyle: z.boolean().optional(),
});

const googleSourceCredentialsSchema = z.object({
  client_email: z.string().email("client_email inválido nas credenciais Google Drive."),
  private_key: z.string().min(1, "private_key obrigatório nas credenciais Google Drive."),
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
  getCompressedBytes: () => number;
  donePromise: Promise<void>;
  abort: (reason?: string) => void;
}

/**
 * Cria o provedor correto para o storage de acordo com o tipo configurado
 */
export function createStorageProvider(source: StorageSourceInput): IStorageProvider {
  switch (source.type) {
    case "AWS_S3":
    case "S3_COMPATIBLE": {
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(source.credentials);
      } catch (err: unknown) {
        const reason = err instanceof Error ? sanitizeDiagnosticMessage(err.message) : "JSON malformado";
        throw new Error("Credenciais de S3 inválidas. Esperado formato JSON (" + reason + ").");
      }

      const parsed = s3SourceCredentialsSchema.safeParse(rawJson);
      if (!parsed.success) {
        const msg = parsed.error.errors[0]?.message || "Credenciais S3 incompletas.";
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
        throw new Error("Credenciais de origem do Google Drive não estão em formato JSON válido.");
      }

      const parsed = googleSourceCredentialsSchema.safeParse(rawJson);
      if (!parsed.success) {
        const msg = parsed.error.errors[0]?.message || "Credenciais Google Drive incompletas.";
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
      throw new Error("Tipo de storage de origem não suportado: " + source.type);
  }
}

/**
 * Executa o backup de um storage de origem, empacotando os arquivos em tempo real
 * num fluxo comprimido .tar.gz sem gravar nada no disco local.
 */
export async function executeStorageBackup(source: StorageSourceInput): Promise<StorageBackupResult> {
  const provider = createStorageProvider(source);

  console.log("🔍 Listando arquivos no storage de origem (" + source.type + " / " + source.targetFolder + ")...");
  const files = await provider.listFiles(source.prefix || undefined);
  console.log("📦 Encontrados " + files.length + " arquivos para backup.");

  const archive = new TarArchive({
    gzip: true,
    gzipOptions: { level: 6 },
  });

  const passThrough = new PassThrough();
  let compressedBytes = 0;

  // Monitora a passagem de bytes compactados
  passThrough.on("data", (chunk: Buffer) => {
    compressedBytes += chunk.length;
  });

  archive.pipe(passThrough);

  const totalOriginalBytes = files.reduce((acc, f) => acc + f.size, 0);
  let aborted = false;

  const abort = (reason = "Arquivamento de storage cancelado."): void => {
    if (aborted) return;
    aborted = true;
    archive.abort();
    archive.destroy(new Error(reason));
    if (!passThrough.destroyed) {
      passThrough.destroy(new Error(reason));
    }
  };

  // Executa o empacotamento assincronamente mantendo o stream ativo
  const donePromise = new Promise<void>((resolve, reject) => {
    archive.on("error", (err: Error) => {
      console.error("❌ Erro no arquivamento de storage:", err.message);
      reject(err);
    });

    void (async () => {
      try {
        if (files.length === 0) {
          // Se a pasta estiver vazia, cria um arquivo indicador para manter integridade do tar.gz
          archive.append(
            "VaultFlow Storage Backup\nOrigem: " + source.targetFolder + "\nData: " + new Date().toISOString() + "\nStatus: Pasta vazia\n",
            { name: ".vaultflow-empty-snapshot.txt" }
          );
        } else {
          for (let i = 0; i < files.length; i++) {
            if (aborted) {
              throw new Error("Arquivamento interrompido por cancelamento.");
            }
            const file = files[i];
            if (!file) continue;
            console.log("  [" + (i + 1) + "/" + files.length + "] Compactando: " + file.key + " (" + Math.round(file.size / 1024) + " KB)");
            const fileStream = await provider.getFileStream(file);
            archive.append(fileStream, { name: file.key });
          }
        }

        await archive.finalize();
        console.log("✅ Arquivamento streaming do storage finalizado com sucesso.");
        resolve();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Erro desconhecido";
        console.error("❌ Falha durante a iteração de arquivos de storage:", msg);
        archive.destroy();
        reject(err instanceof Error ? err : new Error(msg));
      }
    })();
  });

  return {
    stream: passThrough,
    fileCount: files.length,
    totalOriginalBytes,
    getCompressedBytes: () => (compressedBytes > 0 ? compressedBytes : archive.pointer()),
    donePromise,
    abort,
  };
}
