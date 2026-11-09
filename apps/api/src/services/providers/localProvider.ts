import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { IStorageProvider, StorageFileItem } from './storageProvider.interface';

export interface LocalProviderConfig {
  basePath: string;
}

const FORBIDDEN_SYSTEM_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/private/etc',
  '/private/var/run',
];

function isPathInsideRoot(candidateRealPath: string, rootRealPath: string): boolean {
  if (candidateRealPath === rootRealPath) return true;
  const normalizedRoot = rootRealPath.endsWith(path.sep)
    ? rootRealPath
    : `${rootRealPath}${path.sep}`;
  return candidateRealPath.startsWith(normalizedRoot);
}

/**
 * Valida que um diretório local de backup pertence estritamente a uma das raízes
 * de volume permitidas em ALLOWED_LOCAL_BACKUP_ROOTS e não aponta para diretórios sensíveis.
 */
export function resolveAndValidateLocalBackupPath(rawBasePath: string): string {
  const trimmed = rawBasePath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error('O caminho de origem LOCAL_PATH deve ser absoluto.');
  }

  const rawAllowedRoots = process.env.ALLOWED_LOCAL_BACKUP_ROOTS?.trim() || '';
  const allowedRoots = rawAllowedRoots
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && path.isAbsolute(r) && r !== '/');

  if (allowedRoots.length === 0) {
    throw new Error(
      'Origem LOCAL_PATH desabilitada: configure ALLOWED_LOCAL_BACKUP_ROOTS com os diretórios de volume explicitamente permitidos.'
    );
  }

  if (!fs.existsSync(trimmed)) {
    throw new Error('Diretório local de origem não encontrado.');
  }

  const realTarget = fs.realpathSync(trimmed);
  const stat = fs.statSync(realTarget);
  if (!stat.isDirectory()) {
    throw new Error('O caminho local de origem deve ser um diretório válido.');
  }

  for (const forbidden of FORBIDDEN_SYSTEM_PREFIXES) {
    if (realTarget === forbidden || realTarget.startsWith(`${forbidden}/`)) {
      throw new Error('Acesso negado: diretório de sistema proibido como origem de backup.');
    }
  }

  const masterKeyFile = process.env.VAULTFLOW_MASTER_KEY_FILE?.trim();
  if (masterKeyFile && fs.existsSync(masterKeyFile)) {
    const realKeyFile = fs.realpathSync(masterKeyFile);
    const realKeyDir = path.dirname(realKeyFile);
    if (isPathInsideRoot(realKeyFile, realTarget) || realTarget === realKeyDir) {
      throw new Error(
        'Acesso negado: o diretório de origem não pode conter nem coincidir com o diretório da chave mestra.'
      );
    }
  }

  const realAllowedRoots: string[] = [];
  for (const root of allowedRoots) {
    if (fs.existsSync(root)) {
      realAllowedRoots.push(fs.realpathSync(root));
    }
  }

  const isAllowed = realAllowedRoots.some((allowedRoot) =>
    isPathInsideRoot(realTarget, allowedRoot)
  );

  if (!isAllowed) {
    throw new Error(
      'Acesso negado: o caminho local informado está fora dos volumes permitidos em ALLOWED_LOCAL_BACKUP_ROOTS.'
    );
  }

  return realTarget;
}

export class LocalStorageProvider implements IStorageProvider {
  private readonly realBasePath: string;

  constructor(config: LocalProviderConfig) {
    this.realBasePath = resolveAndValidateLocalBackupPath(config.basePath);
  }

  async listFiles(prefix?: string): Promise<StorageFileItem[]> {
    let targetDir = this.realBasePath;
    if (prefix && prefix.trim()) {
      const sanitizedPrefix = prefix.trim().replace(/^\/+/, '');
      const candidateDir = path.resolve(this.realBasePath, sanitizedPrefix);
      if (!fs.existsSync(candidateDir)) {
        throw new Error('Subpasta/prefixo local não encontrado.');
      }
      const realCandidateDir = await fs.promises.realpath(candidateDir);
      if (!isPathInsideRoot(realCandidateDir, this.realBasePath)) {
        throw new Error('Acesso negado: prefixo aponta para fora da raiz permitida.');
      }
      targetDir = realCandidateDir;
    }

    const items: StorageFileItem[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Ignora symlinks para impedir escape de diretório
        if (entry.isSymbolicLink()) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        const realFullPath = await fs.promises.realpath(fullPath);

        if (!isPathInsideRoot(realFullPath, this.realBasePath)) {
          throw new Error('Acesso negado: detectado caminho fora da raiz permitida.');
        }

        if (entry.isDirectory()) {
          await walk(realFullPath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(realFullPath);
          const relativeKey = path.relative(this.realBasePath, realFullPath).replace(/\\/g, '/');
          if (!relativeKey || relativeKey.startsWith('..') || path.isAbsolute(relativeKey)) {
            continue;
          }
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
    if (!item.key || item.key.includes('\0') || path.isAbsolute(item.key)) {
      throw new Error('Chave de arquivo local inválida.');
    }

    const candidatePath = path.resolve(this.realBasePath, item.key);
    const lstat = await fs.promises.lstat(candidatePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      throw new Error('Acesso negado: symlink ou arquivo inválido.');
    }

    const realFilePath = await fs.promises.realpath(candidatePath);
    if (!isPathInsideRoot(realFilePath, this.realBasePath)) {
      throw new Error('Acesso negado: o arquivo está fora da raiz permitida.');
    }

    return fs.createReadStream(realFilePath);
  }
}
