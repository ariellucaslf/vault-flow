/**
 * Formata bytes de forma segura para strings legíveis (B, KB, MB, GB, TB).
 * Suporta tanto BigInt quanto Number, além de null/undefined.
 */
export function formatBytes(bytes: bigint | number | null | undefined, decimals: number = 2): string {
  if (bytes === null || bytes === undefined) return "-";

  const numBytes = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (numBytes <= 0) return "0 B";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];

  const i = Math.floor(Math.log(numBytes) / Math.log(k));
  const unitIndex = Math.min(i, sizes.length - 1);

  return `${parseFloat((numBytes / Math.pow(k, unitIndex)).toFixed(dm))} ${sizes[unitIndex]}`;
}
