import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

function safeCompareTokens(provided: string, expected: string): boolean {
  if (!provided || !expected || expected.length < 32) {
    return false;
  }

  const providedDigest = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();

  const digestsMatch = crypto.timingSafeEqual(providedDigest, expectedDigest);
  return digestsMatch && provided.length === expected.length;
}

/**
 * Exige o token interno de servidor (INTERNAL_API_TOKEN) em todas as rotas operacionais da API.
 */
export function requireInternalApiToken(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env.INTERNAL_API_TOKEN?.trim() || '';
  if (expectedToken.length < 32) {
    res.status(503).json({
      success: false,
      data: null,
      error: 'API interna indisponível: INTERNAL_API_TOKEN não configurado.',
    });
    return;
  }

  const headerToken = req.header('x-internal-token')?.trim() || '';
  const authHeader = req.header('authorization')?.trim() || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  const providedToken = headerToken || bearerToken;

  if (!safeCompareTokens(providedToken, expectedToken)) {
    res.status(401).json({
      success: false,
      data: null,
      error: 'Acesso não autorizado à API interna.',
    });
    return;
  }

  next();
}
