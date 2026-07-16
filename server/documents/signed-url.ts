// Beta Requirement 5: source documents are served only through short-expiry
// signed URLs, never a durable public link. A token is a stateless HMAC over
// (documentId, expiry) — no DB row — so it cannot be forged without the signing
// key and stops working after it expires. The GET /documents/download route
// (server/http.ts, dev/supabase-dev-server.ts) verifies it before serving bytes.
import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

function signingKey(): string {
  return process.env.EB_SIGNING_KEY || process.env.FUNCTIONS_JWT_SECRET || 'dev-insecure-signing-key';
}

export function signDocumentToken(
  documentId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): { token: string; expires_at: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac('sha256', signingKey()).update(`${documentId}.${exp}`).digest('base64url');
  return { token: `${exp}.${sig}`, expires_at: new Date(exp * 1000).toISOString() };
}

export function verifyDocumentToken(documentId: string, token: string): boolean {
  const [expStr, sig] = (token ?? '').split('.');
  const exp = Number(expStr);
  if (!expStr || !sig || !Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false; // expired
  const expected = createHmac('sha256', signingKey()).update(`${documentId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
