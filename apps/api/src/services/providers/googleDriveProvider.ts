import { drive_v3, google } from "googleapis";
import { Readable } from "stream";
import { IStorageProvider, StorageFileItem } from "./storageProvider.interface";

export interface GoogleDriveProviderConfig {
  folderId: string;
  credentialsJson: string;
}

export class GoogleDriveStorageProvider implements IStorageProvider {
  private folderId: string;
  private credentialsJson: string;

  constructor(config: GoogleDriveProviderConfig) {
    if (!/^[A-Za-z0-9_-]+$/.test(config.folderId.trim())) {
      throw new Error("ID de pasta Google Drive inválido.");
    }
    this.folderId = config.folderId.trim();
    this.credentialsJson = config.credentialsJson;
  }

  private getDriveClient(): drive_v3.Drive {
    let credentials: unknown;
    try {
      credentials = JSON.parse(this.credentialsJson);
    } catch {
      throw new Error("Falha ao processar credenciais JSON do Google Drive");
    }

    const auth = new google.auth.GoogleAuth({
      credentials: credentials as Record<string, unknown>,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    return google.drive({ version: "v3", auth });
  }

  async listFiles(
    prefix?: string,
    signal?: AbortSignal,
  ): Promise<StorageFileItem[]> {
    const drive = this.getDriveClient();
    const items: StorageFileItem[] = [];

    // Funcao recursiva para listar pastas e arquivos mantendo a hierarquia relativa
    const listFolderRecursive = async (
      currentFolderId: string,
      currentPath: string,
    ): Promise<void> => {
      let pageToken: string | undefined = undefined;

      do {
        const res: { data: drive_v3.Schema$FileList } = await drive.files.list(
          {
            q: "'" + currentFolderId + "' in parents and trashed = false",
            fields:
              "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
            pageToken: pageToken,
            pageSize: 100,
          },
          signal ? { signal } : undefined,
        );

        const files = res.data.files || [];
        for (const file of files) {
          if (!file.id || !file.name) continue;

          if (file.mimeType === "application/vnd.google-apps.folder") {
            const nextPath = currentPath
              ? currentPath + "/" + file.name
              : file.name;
            await listFolderRecursive(file.id, nextPath);
          } else {
            if (file.mimeType?.startsWith("application/vnd.google-apps.")) {
              throw new Error(
                "Arquivos nativos/atalhos do Google Drive exigem exportação ainda não suportada.",
              );
            }
            const relativePath = currentPath
              ? currentPath + "/" + file.name
              : file.name;
            items.push({
              key: relativePath,
              size: file.size ? Number(file.size) : 0,
              lastModified: file.modifiedTime
                ? new Date(file.modifiedTime)
                : undefined,
              id: file.id,
            });
          }
        }

        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);
    };

    if (prefix?.trim()) {
      throw new Error(
        "Prefixo de origem Google Drive ainda não suportado. Use uma pasta de origem específica.",
      );
    }
    await listFolderRecursive(this.folderId, "");
    return items;
  }

  async getFileStream(
    item: StorageFileItem,
    signal?: AbortSignal,
  ): Promise<Readable> {
    if (!item.id) {
      throw new Error(
        "ID do Google Drive não encontrado para o arquivo: " + item.key,
      );
    }

    const drive = this.getDriveClient();
    const response = await drive.files.get(
      { fileId: item.id, alt: "media" },
      { responseType: "stream", signal },
    );

    const stream = response.data as Readable;
    const onAbort = (): void => {
      stream.destroy();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.once("close", () => signal?.removeEventListener("abort", onAbort));
    if (signal?.aborted) {
      stream.destroy();
      signal.throwIfAborted();
    }
    return stream;
  }
}
