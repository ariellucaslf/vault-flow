import crypto from 'crypto';
import fs from 'fs';

if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
  throw new Error('O módulo criptográfico do VaultFlow é exclusivo do servidor.');
}

const ENVELOPE_PREFIX = 'vf:v1';
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;
const MAX_SECRET_BYTES = 64 * 1024; // 64 KiB

export type SecretResourceType = 'Project' | 'StorageSource' | 'Destination';
export type SecretFieldName = 'dbUrl' | 'credentials';

export interface SecretAADContext {
  resourceType: SecretResourceType;
  resourceId: string;
  field: SecretFieldName;
}

function decodeRawKeyMaterial(rawContent: string, sourceLabel: string): Buffer {
  const trimmed = rawContent.trim();
  if (!trimmed) {
    throw new Error(`Chave mestra vazia em ${sourceLabel}.`);
  }

  // Formato hexadecimal de 64 caracteres (32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Formato base64 ou base64url codificando 32 bytes
  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    if (buf.length === KEY_BYTE_LENGTH) {
      return buf;
    }
  } catch {
    // Continua para erro padronizado abaixo
  }

  throw new Error(
    `Chave mestra inválida em ${sourceLabel}: forneça exatamente 32 bytes codificados em hex (64 caracteres) ou base64 (44 caracteres).`
  );
}

/**
 * Carrega a chave simétrica de 32 bytes da instalação a partir de arquivo montado
 * (VAULTFLOW_MASTER_KEY_FILE) ou variável explícita (VAULTFLOW_MASTER_KEY).
 * Nunca gera chave aleatória substituta se ausente.
 */
export function loadMasterKey(): Buffer {
  const keyFilePath = process.env.VAULTFLOW_MASTER_KEY_FILE?.trim();
  if (keyFilePath) {
    let rawFile: string;
    try {
      rawFile = fs.readFileSync(keyFilePath, 'utf8');
    } catch {
      throw new Error(
        `Não foi possível ler o arquivo de chave mestra em VAULTFLOW_MASTER_KEY_FILE (${keyFilePath}).`
      );
    }
    return decodeRawKeyMaterial(rawFile, 'VAULTFLOW_MASTER_KEY_FILE');
  }

  const inlineKey = process.env.VAULTFLOW_MASTER_KEY?.trim();
  if (inlineKey) {
    return decodeRawKeyMaterial(inlineKey, 'VAULTFLOW_MASTER_KEY');
  }

  throw new Error(
    'Chave mestra da instalação não configurada. Defina VAULTFLOW_MASTER_KEY_FILE apontando para um arquivo protegido com 32 bytes (hex ou base64).'
  );
}

export function verifyMasterKeyConfigured(): void {
  const key = loadMasterKey();
  key.fill(0);
}

function buildAADBuffer(context: SecretAADContext): Buffer {
  if (!context.resourceType || !context.resourceId?.trim() || !context.field) {
    throw new Error('Contexto AAD incompleto para operação criptográfica.');
  }
  return Buffer.from(
    `${ENVELOPE_PREFIX}|${context.resourceType}|${context.resourceId.trim()}|${context.field}`,
    'utf8'
  );
}

export function isEncryptedSecretEnvelope(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 5 && parts[0] === 'vf' && parts[1] === 'v1';
}

/**
 * Cifra um segredo usando AES-256-GCM com IV aleatório de 12 bytes, tag de 16 bytes
 * e AAD vinculando versão, tipo de recurso, ID e nome do campo.
 * Formato de saída: vf:v1:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 */
export function encryptSecret(plaintext: string, context: SecretAADContext): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('O segredo a ser cifrado não pode ser vazio.');
  }

  const plaintextBuf = Buffer.from(plaintext, 'utf8');
  if (plaintextBuf.byteLength > MAX_SECRET_BYTES) {
    throw new Error('O tamanho do segredo excede o limite máximo permitido (64 KiB).');
  }

  const key = loadMasterKey();
  try {
    const iv = crypto.randomBytes(IV_BYTE_LENGTH);
    const aad = buildAADBuffer(context);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      ENVELOPE_PREFIX,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  } finally {
    key.fill(0);
  }
}

/**
 * Decifra e autentica um envelope vf:v1 usando AES-256-GCM e AAD estrito.
 * Qualquer adulteração de IV, tag, ciphertext ou contexto AAD lança erro imediato.
 * Não possui fallback para plaintext.
 */
export function decryptSecret(envelope: string, context: SecretAADContext): string {
  if (typeof envelope !== 'string' || !envelope.startsWith(`${ENVELOPE_PREFIX}:`)) {
    throw new Error('Segredo armazenado em formato inválido ou não cifrado (esperado envelope vf:v1).');
  }

  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== 'vf' || parts[1] !== 'v1') {
    throw new Error('Envelope de segredo cifrado malformado.');
  }

  const [, , ivB64, tagB64, cipherB64] = parts;
  if (!ivB64 || !tagB64 || !cipherB64) {
    throw new Error('Componentes do envelope criptográfico ausentes.');
  }

  const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
  if (
    !BASE64URL_REGEX.test(ivB64) ||
    !BASE64URL_REGEX.test(tagB64) ||
    !BASE64URL_REGEX.test(cipherB64)
  ) {
    throw new Error('Codificação base64url inválida no envelope criptográfico.');
  }

  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(cipherB64, 'base64url');

  if (iv.length !== IV_BYTE_LENGTH) {
    throw new Error('Tamanho de IV inválido no envelope criptográfico.');
  }
  if (authTag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new Error('Tamanho de tag de autenticação inválido no envelope criptográfico.');
  }
  if (ciphertext.length === 0 || ciphertext.length > MAX_SECRET_BYTES) {
    throw new Error('Tamanho de payload cifrado inválido no envelope criptográfico.');
  }

  const key = loadMasterKey();
  try {
    const aad = buildAADBuffer(context);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_BYTE_LENGTH,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      'Falha na autenticação criptográfica do segredo: chave mestra incorreta, contexto divergente ou dados adulterados.'
    );
  } finally {
    key.fill(0);
  }
}
