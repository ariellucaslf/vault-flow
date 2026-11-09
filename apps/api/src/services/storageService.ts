import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import { google } from "googleapis";
import { Readable } from "stream";
import { withAbort, asError } from "./backupRuntime";
import { z } from "zod";
import { sanitizeDiagnosticMessage } from "./backupService";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface UploadedArtifactInfo {
  destinationType: "AWS_S3" | "GOOGLE_DRIVE";
  targetFolder: string;
  objectKey: string;
  artifactUri: string;
}

const s3CredentialsSchema = z.object({
  accessKeyId: z
    .string()
    .min(1, "accessKeyId é obrigatório nas credenciais S3."),
  secretAccessKey: z
    .string()
    .min(1, "secretAccessKey é obrigatório nas credenciais S3."),
  region: z.string().min(1).optional(),
  endpoint: z.string().url("endpoint S3 deve ser uma URL válida.").optional(),
  forcePathStyle: z.boolean().optional(),
});

const googleServiceAccountSchema = z.object({
  client_email: z
    .string()
    .email("client_email inválido nas credenciais Google Drive."),
  private_key: z
    .string()
    .min(1, "private_key obrigatório nas credenciais Google Drive."),
});

export type ValidatedDestination =
  | {
      id: string;
      type: "AWS_S3";
      targetFolder: string;
      s3Credentials: S3Credentials;
    }
  | {
      id: string;
      type: "GOOGLE_DRIVE";
      targetFolder: string;
      googleCredentials: Record<string, unknown>;
    };

/**
 * Valida estruturalmente um destino configurado antes de iniciar a leitura da origem.
 * Nunca ignora erro de credencial ou destino inválido.
 */
export function validateDestinationConfig(destination: {
  id: string;
  type: string;
  targetFolder: string;
  credentials: string;
}): ValidatedDestination {
  const targetFolder = destination.targetFolder.trim();
  if (!targetFolder) {
    throw new Error(
      `Destino ${destination.id} (${destination.type}) está sem targetFolder configurado.`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(destination.credentials);
  } catch {
    throw new Error(
      `Credenciais do destino (${destination.type}) não estão em formato JSON válido.`,
    );
  }

  if (destination.type === "AWS_S3" || destination.type === "S3_COMPATIBLE") {
    const parsed = s3CredentialsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const msg =
        parsed.error.errors[0]?.message || "Credenciais S3 incompletas.";
      throw new Error(
        `Configuração S3 inválida para o bucket "${targetFolder}": ${msg}`,
      );
    }

    return {
      id: destination.id,
      type: "AWS_S3",
      targetFolder,
      s3Credentials: {
        accessKeyId: parsed.data.accessKeyId,
        secretAccessKey: parsed.data.secretAccessKey,
        region: parsed.data.region || "us-east-1",
        endpoint: parsed.data.endpoint,
        forcePathStyle: parsed.data.forcePathStyle,
      },
    };
  }

  if (destination.type === "GOOGLE_DRIVE") {
    const parsed = googleServiceAccountSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const msg =
        parsed.error.errors[0]?.message ||
        "Credenciais Google Service Account incompletas.";
      throw new Error(
        `Configuração Google Drive inválida para a pasta "${targetFolder}": ${msg}`,
      );
    }

    return {
      id: destination.id,
      type: "GOOGLE_DRIVE",
      targetFolder,
      googleCredentials: parsedJson as Record<string, unknown>,
    };
  }

  throw new Error(
    `Tipo de destino não suportado para upload: ${destination.type}`,
  );
}

export async function uploadToS3(
  stream: Readable,
  bucketName: string,
  objectKey: string,
  credentials: S3Credentials,
  signal?: AbortSignal,
): Promise<UploadedArtifactInfo> {
  signal?.throwIfAborted();
  const s3Client = new S3Client({
    region: credentials.region || "us-east-1",
    endpoint: credentials.endpoint || undefined,
    forcePathStyle: credentials.forcePathStyle ?? Boolean(credentials.endpoint),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucketName,
      Key: objectKey,
      Body: stream,
    },
  });

  const onAbort = (): void => {
    void upload.abort().catch((error: unknown) => {
      console.warn(
        "⚠️ Falha ao cancelar upload S3:",
        sanitizeDiagnosticMessage(asError(error).message),
      );
    });
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    let lastLogged = 0;
    upload.on("httpUploadProgress", (progress) => {
      if (progress.loaded && progress.loaded - lastLogged > 5 * 1024 * 1024) {
        console.log(
          `[S3 Upload Progress] ${Math.round(progress.loaded / 1024 / 1024)}MB enviados...`,
        );
        lastLogged = progress.loaded;
      }
    });

    await upload.done();
    const artifactUri = `s3://${bucketName}/${objectKey}`;
    console.log(`✅ Upload S3 concluído: ${artifactUri}`);

    return {
      destinationType: "AWS_S3",
      targetFolder: bucketName,
      objectKey,
      artifactUri,
    };
  } catch (error: unknown) {
    const rawMsg =
      error instanceof Error ? error.message : "Erro desconhecido no upload S3";
    const cleanMsg = sanitizeDiagnosticMessage(rawMsg);
    console.error(
      `❌ Falha no upload S3 (${bucketName}/${objectKey}): ${cleanMsg}`,
    );
    throw new Error(`Falha no upload para S3 (${bucketName}): ${cleanMsg}`);
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    s3Client.destroy();
  }
}

export async function uploadToGoogleDrive(
  stream: Readable,
  folderId: string,
  fileName: string,
  credentials: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<UploadedArtifactInfo> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(asError(signal?.reason));
  const onSourceError = (error: Error): void => controller.abort(error);
  stream.on("error", onSourceError);
  stream.once("close", () => stream.off("error", onSourceError));
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    if (signal?.aborted) forwardAbort();
    controller.signal.throwIfAborted();
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    const drive = google.drive({ version: "v3", auth });
    const result = await withAbort(
      drive.files.create(
        {
          requestBody: { name: fileName, parents: [folderId] },
          media: { body: stream },
          fields: "id, name, webViewLink",
        },
        { signal: controller.signal },
      ),
      controller.signal,
    );

    if (!result.data.id)
      throw new Error("Google Drive não retornou identificação do arquivo.");
    return {
      destinationType: "GOOGLE_DRIVE",
      targetFolder: folderId,
      objectKey: fileName,
      artifactUri: `gdrive://${folderId}/${result.data.id} (${fileName})`,
    };
  } catch (error: unknown) {
    const cleanMsg = sanitizeDiagnosticMessage(asError(error).message);
    console.error(`❌ Falha no upload Google Drive (${fileName}): ${cleanMsg}`);
    throw new Error(
      `Falha no upload para Google Drive (${folderId}): ${cleanMsg}`,
    );
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}
