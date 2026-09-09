import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { IStorageProvider, StorageFileItem } from "./storageProvider.interface";

export interface LocalProviderConfig {
  basePath: string;
}

export class LocalStorageProvider implements IStorageProvider {
  private basePath: string;

  constructor(config: LocalProviderConfig) {
    this.basePath = path.resolve(config.basePath);
  }

  async listFiles(prefix?: string): Promise<StorageFileItem[]> {
    const targetDir = prefix ? path.join(this.basePath, prefix) : this.basePath;
    const items: StorageFileItem[] = [];

    if (!fs.existsSync(targetDir)) {
      throw new Error("Diretório local não encontrado: " + targetDir);
    }

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(fullPath);
          const relativeKey = path.relative(this.basePath, fullPath).replace(/\\/g, "/");
          items.push({
            key: relativeKey,
            size: stat.size,
            lastModified: stat.mtime,
          });
        }
      }
    };

    await walk(targetDir);
    return items;
  }

  async getFileStream(item: StorageFileItem): Promise<Readable> {
    const fullPath = path.join(this.basePath, item.key);
    if (!fs.existsSync(fullPath)) {
      throw new Error("Arquivo local não encontrado: " + fullPath);
    }
    return fs.createReadStream(fullPath);
  }
}
