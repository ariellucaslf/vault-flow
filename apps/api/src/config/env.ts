import { z } from 'zod';
import { verifyMasterKeyConfigured } from '@vault-flow/db';

const apiEnvSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL é obrigatória.')
      .refine(
        (val) => val.startsWith('postgresql://') || val.startsWith('postgres://'),
        'DATABASE_URL deve iniciar com postgresql:// ou postgres://'
      ),
    INTERNAL_API_TOKEN: z
      .string()
      .min(32, 'INTERNAL_API_TOKEN deve possuir no mínimo 32 caracteres.'),
    NEXTAUTH_SECRET: z.string().optional(),
    PORT: z
      .string()
      .regex(/^\d+$/, 'PORT deve ser um número inteiro válido.')
      .optional(),
    MAX_CONCURRENT_BACKUPS: z
      .string()
      .regex(/^[1-9]\d*$/, 'MAX_CONCURRENT_BACKUPS deve ser um inteiro positivo.')
      .optional(),
    BACKUP_TIMEOUT_MS: z
      .string()
      .regex(/^[1-9]\d*$/, 'BACKUP_TIMEOUT_MS deve ser um inteiro positivo em milissegundos.')
      .optional(),
  })
  .refine(
    (env) => !env.NEXTAUTH_SECRET || env.INTERNAL_API_TOKEN !== env.NEXTAUTH_SECRET,
    {
      message: 'INTERNAL_API_TOKEN deve ser distinto de NEXTAUTH_SECRET.',
      path: ['INTERNAL_API_TOKEN'],
    }
  );

export function validateApiStartupEnv(): void {
  const parsed = apiEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Configuração de ambiente da API inválida: ${issues}`);
  }

  verifyMasterKeyConfigured();
}
