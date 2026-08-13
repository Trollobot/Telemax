import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export function isValidApiKey(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/** Requires a matching `x-api-key` header. Applied to every /api/* route except /api/health (ТЗ.md §3.4). */
export function requireApiKey(expected: string): RequestHandler {
  return (req, res, next) => {
    if (!isValidApiKey(expected, req.header('x-api-key'))) {
      res.status(401).json({ error: 'missing or invalid x-api-key' });
      return;
    }
    next();
  };
}
