import { Upload } from '@aws-sdk/lib-storage';
import { S3Client } from '@aws-sdk/client-s3';
import { google } from 'googleapis';
import { Readable, PassThrough } from 'stream';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export async function uploadToS3(
  stream: Readable,
  bucketName: string,
  objectKey: string,
  credentials: S3Credentials
) {
  const s3Client = new S3Client({
    region: credentials.region || 'us-east-1',
    endpoint: credentials.endpoint || undefined,
    forcePathStyle: credentials.forcePathStyle ?? Boolean(credentials.endpoint),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });

  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: objectKey,
        Body: stream,
      },
    });

    let lastLogged = 0;
    upload.on('httpUploadProgress', (progress) => {
      // Log progress every 5MB
      if (progress.loaded && progress.loaded - lastLogged > 5 * 1024 * 1024) {
        console.log(`[S3 Upload Progress] ${Math.round(progress.loaded / 1024 / 1024)}MB uploaded...`);
        lastLogged = progress.loaded;
      }
    });

    const result = await upload.done();
    console.log(`✅ Successfully uploaded to S3: ${result.Location}`);
    return result;
  } catch (error) {
    console.error(`❌ Failed to upload to S3:`, error);
    throw error;
  }
}

export async function uploadToGoogleDrive(
  stream: Readable,
  folderId: string,
  fileName: string,
  credentialsJson: string
) {
  try {
    // 1. Parsing Service Account JSON
    const credentials = JSON.parse(credentialsJson);
    
    // 2. Authentication
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    const drive = google.drive({ version: 'v3', auth });

    // 3. Google Drive API exige stream padrão no formato PassThrough
    const passThrough = new PassThrough();
    stream.pipe(passThrough);

    console.log(`[Google Drive] Starting upload for ${fileName}...`);

    // 4. Executando o Multipart Upload
    const result = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        body: passThrough,
      },
      fields: 'id, name, webViewLink',
    });

    console.log(`✅ Successfully uploaded to Google Drive: ${result.data.webViewLink || result.data.id}`);
    return result.data;
  } catch (error) {
    console.error(`❌ Failed to upload to Google Drive:`, error);
    throw error;
  }
}
