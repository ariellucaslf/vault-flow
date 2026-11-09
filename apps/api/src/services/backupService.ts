import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

const MAX_STDERR_BYTES = 4096;
const DEFAULT_PG_DUMP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos
const PRISMA_ONLY_QUERY_PARAMS = [
  'schema',
  'pgbouncer',
  'connection_limit',
  'pool_timeout',
  'statement_cache_size',
  'socket_timeout',
  'connect_timeout',
];

export interface PgDumpOptions {
  timeoutMs?: number;
}

export interface PgDumpExecution {
  stream: Readable;
  donePromise: Promise<void>;
  abort: (reason?: string) => void;
}

/**
 * Remove credenciais, URLs completas de conexão e segredos de mensagens de erro/stderr.
 */
export function sanitizeDiagnosticMessage(input: string): string {
  return input
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, 'postgresql://[REDACTED]')
    .replace(/(password|passwd|pwd|secret|token|accessKeyId|secretAccessKey)\s*[:=]\s*[^\s,;'"&]+/gi, '$1=[REDACTED]')
    .trim();
}

function escapePgPassField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

interface PreparedPgConnection {
  sanitizedUri: string;
  schemaArg: string | null;
  tempDir: string;
  pgpassFile: string | null;
}

function preparePgConnection(rawDbUrl: string): PreparedPgConnection {
  let parsed: URL;
  try {
    parsed = new URL(rawDbUrl);
  } catch {
    throw new Error('URL do banco de dados PostgreSQL inválida.');
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Protocolo de banco de dados inválido. Use postgresql:// ou postgres://.');
  }

  const dbName = parsed.pathname.replace(/^\/+/, '');
  if (!parsed.hostname || !dbName) {
    throw new Error('URL do PostgreSQL incompleta: host e nome do banco são obrigatórios.');
  }

  let password = '';
  try {
    password = parsed.password ? decodeURIComponent(parsed.password) : '';
  } catch {
    password = parsed.password;
  }

  // Nunca manter a senha na URI passada por argumento de linha de comando
  parsed.password = '';

  let schemaArg: string | null = null;
  const rawSchema = parsed.searchParams.get('schema');
  if (rawSchema && rawSchema !== 'public') {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawSchema)) {
      throw new Error('Parâmetro schema inválido na URL do banco de dados.');
    }
    schemaArg = rawSchema;
  }

  for (const param of PRISMA_ONLY_QUERY_PARAMS) {
    parsed.searchParams.delete(param);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-pg-'));
  fs.chmodSync(tempDir, 0o700);

  let pgpassFile: string | null = null;
  if (password) {
    pgpassFile = path.join(tempDir, '.pgpass');
    const pgpassLine = `*:*:*:*:${escapePgPassField(password)}\n`;
    fs.writeFileSync(pgpassFile, pgpassLine, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(pgpassFile, 0o600);
  }

  return {
    sanitizedUri: parsed.toString(),
    schemaArg,
    tempDir,
    pgpassFile,
  };
}

function cleanupPreparedConnection(prepared: PreparedPgConnection): void {
  try {
    if (prepared.pgpassFile && fs.existsSync(prepared.pgpassFile)) {
      fs.unlinkSync(prepared.pgpassFile);
    }
    if (fs.existsSync(prepared.tempDir)) {
      fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    console.warn('⚠️ Falha ao limpar diretório temporário do pg_dump:', sanitizeDiagnosticMessage(msg));
  }
}

/**
 * Executa o processo pg_dump sem shell, utilizando arquivo .pgpass restrito (0600)
 * e ambiente mínimo. Retorna o stream de saída, uma Promise de conclusão verificada
 * e uma função de cancelamento explícito.
 */
export function executePgDump(dbUrl: string, options?: PgDumpOptions): PgDumpExecution {
  const prepared = preparePgConnection(dbUrl);
  const timeoutMs =
    options?.timeoutMs ??
    (Number(process.env.BACKUP_TIMEOUT_MS) > 0
      ? Number(process.env.BACKUP_TIMEOUT_MS)
      : DEFAULT_PG_DUMP_TIMEOUT_MS);

  const args = ['-d', prepared.sanitizedUri, '-F', 'c', '--no-password'];
  if (prepared.schemaArg) {
    args.push('-n', prepared.schemaArg);
  }

  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: prepared.tempDir,
    TMPDIR: prepared.tempDir,
    PGCONNECT_TIMEOUT: '15',
    ...(prepared.pgpassFile ? { PGPASSFILE: prepared.pgpassFile } : {}),
  };

  console.log('🔄 Iniciando processo pg_dump...');

  let pgDump: ReturnType<typeof spawn>;
  try {
    pgDump = spawn('pg_dump', args, {
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    cleanupPreparedConnection(prepared);
    const msg = err instanceof Error ? sanitizeDiagnosticMessage(err.message) : 'Erro ao invocar pg_dump';
    throw new Error(`Falha ao iniciar pg_dump: ${msg}`);
  }

  const stdout = pgDump.stdout;
  const stderr = pgDump.stderr;

  if (!stdout || !stderr) {
    cleanupPreparedConnection(prepared);
    pgDump.kill('SIGKILL');
    throw new Error('Falha ao inicializar pipes de comunicação do pg_dump.');
  }

  let stderrCollected = '';
  let stderrTruncated = false;
  let settled = false;
  let abortReason: string | null = null;
  let killEscalationTimer: NodeJS.Timeout | null = null;

  stderr.on('data', (chunk: Buffer) => {
    const piece = sanitizeDiagnosticMessage(chunk.toString('utf8'));
    if (!piece) return;

    if (stderrCollected.length < MAX_STDERR_BYTES) {
      const remaining = MAX_STDERR_BYTES - stderrCollected.length;
      stderrCollected += (stderrCollected ? ' | ' : '') + piece.slice(0, remaining);
      if (piece.length > remaining) {
        stderrTruncated = true;
      }
    } else {
      stderrTruncated = true;
    }
  });

  const formatStderrDetail = (): string => {
    if (!stderrCollected) return 'Sem saída adicional em stderr.';
    return stderrTruncated ? `${stderrCollected}... [truncado]` : stderrCollected;
  };

  const abort = (reason = 'Execução do pg_dump cancelada.'): void => {
    if (settled) return;
    if (!abortReason) {
      abortReason = sanitizeDiagnosticMessage(reason);
    }

    if (pgDump.exitCode === null && pgDump.signalCode === null) {
      pgDump.kill('SIGTERM');
      if (!killEscalationTimer) {
        killEscalationTimer = setTimeout(() => {
          if (pgDump.exitCode === null && pgDump.signalCode === null) {
            pgDump.kill('SIGKILL');
          }
        }, 3000);
        killEscalationTimer.unref();
      }
    }
  };

  const timeoutHandle = setTimeout(() => {
    abort(`Tempo limite de ${Math.round(timeoutMs / 1000)}s excedido durante execução do pg_dump.`);
  }, timeoutMs);
  timeoutHandle.unref();

  const cleanupAll = (): void => {
    clearTimeout(timeoutHandle);
    if (killEscalationTimer) {
      clearTimeout(killEscalationTimer);
      killEscalationTimer = null;
    }
    cleanupPreparedConnection(prepared);
  };

  const donePromise = new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanupAll();
      if (!stdout.destroyed) {
        stdout.destroy(error);
      }
      reject(error);
    };

    pgDump.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      const hint =
        code === 'ENOENT'
          ? 'Binário pg_dump não encontrado no sistema (instale postgresql-client).'
          : sanitizeDiagnosticMessage(err.message);
      fail(new Error(`Falha ao executar pg_dump: ${hint}`));
    });

    pgDump.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;

      if (abortReason) {
        fail(new Error(`${abortReason} (${formatStderrDetail()})`));
        return;
      }

      if (signal) {
        fail(new Error(`Processo pg_dump encerrado pelo sinal ${signal}. ${formatStderrDetail()}`));
        return;
      }

      if (code !== 0) {
        fail(new Error(`Processo pg_dump falhou com código ${code ?? 'desconhecido'}. ${formatStderrDetail()}`));
        return;
      }

      settled = true;
      cleanupAll();
      console.log('✅ Processo pg_dump concluído com código 0.');
      resolve();
    });
  });

  return {
    stream: stdout,
    donePromise,
    abort,
  };
}
