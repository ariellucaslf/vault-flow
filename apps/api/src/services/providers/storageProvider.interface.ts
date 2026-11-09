import { Readable } from "stream";

export interface StorageFileItem {
  key: string;
  size: number;
  lastModified?: Date;
  id?: string; // Usado para referências como Google Drive file ID
}

export interface IStorageProvider {
  /**
   * Lista todos os arquivos do storage de origem sob um prefixo/pasta opcional
   */
  listFiles(prefix?: string, signal?: AbortSignal): Promise<StorageFileItem[]>;

  /**
   * Retorna um Readable stream para download do arquivo especificado
   */
  getFileStream(item: StorageFileItem, signal?: AbortSignal): Promise<Readable>;

  dispose?(): void;
}
