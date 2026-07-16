// Beta Requirement 5: document bytes are encrypted at rest (AES-256-GCM). The
// key comes from EB_DOCUMENT_KEY — 64 hex chars (32 bytes) preferred, else any
// string is stretched with scrypt. Production MUST set it; the dev default is
// deliberately weak and documented as such (docs/13-security-summary.md).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const ENC_ALGO = 'aes-256-gcm';

function key(): Buffer {
  const raw = process.env.EB_DOCUMENT_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (raw) return scryptSync(raw, 'exit-blueprint-doc', 32);
  return scryptSync('dev-insecure-document-key', 'exit-blueprint-doc', 32);
}

// Self-describing envelope: iv(12) || auth tag(16) || ciphertext.
export function encryptBytes(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENC_ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(envelope: Buffer): Buffer {
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(12, 28);
  const ct = envelope.subarray(28);
  const decipher = createDecipheriv(ENC_ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
