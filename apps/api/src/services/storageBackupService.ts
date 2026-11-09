import { TarArchive } from "archiver";
import { Readable, PassThrough } from "stream";
import { IStorageProvider } from "./providers/storageProvider.interface";
import { S3StorageProvider } from "./providers/s3Provider";
import { GoogleDriveStorageProvider } from "./providers/googleDriveProvider";
import { LocalStorageProvider } from "./providers/localProvider";

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
}

/**
 * Cria o provedor correto para o storage de acordo com o tipo configurado
 */
export function createStorageProvider(source: StorageSourceInput): IStorageProvider {
  switch (source.type) {
    case "AWS_S3":
    case "S3_COMPATIBLE": {
      let creds: {
        accessKeyId: string;
        secretAccessKey: string;
        region?: string;
        endpoint?: string;
        forcePathStyle?: boolean;
      };

      try {
        creds = JSON.parse(source.credentials);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : "JSON malformado";
        throw new Error("Credenciais de S3 inválidas. Esperado formato JSON (" + reason + ").");
      }

      return new S3StorageProvider({
        bucket: source.targetFolder,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        region: creds.region,
        endpoint: creds.endpoint,
        forcePathStyle: creds.forcePathStyle,
      });
    }

    case "GOOGLE_DRIVE": {
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

  // Executa o empacotamento assincronamente mantendo o stream ativo
  const donePromise = new Promise<void>((resolve, reject) => {
    archive.on("error", (err: Error) => {
      console.error("❌ Erro no arquivamento de storage:", err);
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
        console.error("❌ Falha durante a iteração de arquivos de storage:", err);
        archive.destroy();
        reject(err);
      }
    })();
  });

  return {
    stream: passThrough,
    fileCount: files.length,
    totalOriginalBytes,
    getCompressedBytes: () => (compressedBytes > 0 ? compressedBytes : archive.pointer()),
    donePromise,
  };
}
