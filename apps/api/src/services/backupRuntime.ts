const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const CLEANUP_TIMEOUT_MS = 5_000;

export function getBackupTimeoutMs(): number {
  const timeout = Number(process.env.BACKUP_TIMEOUT_MS);
  return Number.isSafeInteger(timeout) &&
    timeout > 0 &&
    timeout <= 2_147_483_647
    ? timeout
    : DEFAULT_TIMEOUT_MS;
}

export function asError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Operação de backup cancelada.");
}

/** Observa também a promise original quando o cancelamento vence a corrida. */
export function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/** SDKs que não concluem o abort não podem prender a vaga de execução para sempre. */
export async function waitForCleanup(tasks: Promise<unknown>[]): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const cleaned = await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), CLEANUP_TIMEOUT_MS);
      }),
    ]);
    if (!cleaned) {
      console.warn(
        "⚠️ Prazo de limpeza excedido; cancelamento solicitado às operações remanescentes.",
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
