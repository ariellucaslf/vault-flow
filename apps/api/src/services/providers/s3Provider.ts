import { S3Client, ListObjectsV2Command, ListObjectsV2CommandOutput, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { IStorageProvider, StorageFileItem } from "./storageProvider.interface";

export interface S3ProviderConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export class S3StorageProvider implements IStorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3ProviderConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region || "us-east-1",
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async listFiles(prefix?: string): Promise<StorageFileItem[]> {
    const items: StorageFileItem[] = [];
    let continuationToken: string | undefined = undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix ? (prefix.startsWith("/") ? prefix.slice(1) : prefix) : undefined,
        ContinuationToken: continuationToken,
      });

      const response: ListObjectsV2CommandOutput = await this.client.send(command);

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key && !object.Key.endsWith("/")) {
            items.push({
              key: object.Key,
              size: object.Size ?? 0,
              lastModified: object.LastModified,
            });
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return items;
  }

  async getFileStream(item: StorageFileItem): Promise<Readable> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: item.key,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error("Corpo vazio recebido ao baixar o arquivo S3: " + item.key);
    }

    return response.Body as Readable;
  }
}
