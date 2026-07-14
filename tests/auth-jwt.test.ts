// Compute-service token verification (server/auth-jwt.ts). Pure crypto, no DB.
// Proves the service accepts genuine tokens under BOTH signing regimes — the
// legacy HS256 shared secret and asymmetric ES256 signing keys (verified via a
// local JWKS) — and rejects tampered, expired, wrong-key, and malformed tokens.
import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { makeVerifyToken } from '../server/auth-jwt';

const HS_SECRET = 'test-legacy-jwt-secret-value-1234567890';
const hsKey = new TextEncoder().encode(HS_SECRET);

async function hsToken(claims: Record<string, unknown>, exp = '1h') {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(hsKey);
}

describe('compute-service JWT verification', () => {
  describe('legacy HS256 (FUNCTIONS_JWT_SECRET)', () => {
    const verify = makeVerifyToken({ hsSecret: HS_SECRET });

    it('accepts a valid token and returns its claims', async () => {
      const token = await hsToken({ sub: 'user-1', role: 'authenticated' });
      const claims = await verify(token);
      expect(claims?.sub).toBe('user-1');
      expect(claims?.role).toBe('authenticated');
    });

    it('rejects a token signed with the wrong secret', async () => {
      const token = await new SignJWT({ sub: 'user-1' })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('a-different-secret-entirely-000000'));
      expect(await verify(token)).toBeNull();
    });

    it('rejects an expired token', async () => {
      const token = await new SignJWT({ sub: 'user-1' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(0)
        .setExpirationTime(1) // epoch+1s, long past
        .sign(hsKey);
      expect(await verify(token)).toBeNull();
    });

    it('rejects a token with no sub', async () => {
      const token = await hsToken({ role: 'authenticated' });
      expect(await verify(token)).toBeNull();
    });

    it('rejects a malformed token', async () => {
      expect(await verify('not.a.jwt')).toBeNull();
      expect(await verify('garbage')).toBeNull();
    });
  });

  describe('asymmetric ES256 (JWKS)', () => {
    it('accepts a token signed by a key in the JWKS and rejects a foreign key', async () => {
      const { privateKey, publicKey } = await generateKeyPair('ES256');
      const jwk = await exportJWK(publicKey);
      jwk.kid = 'signing-key-1';
      jwk.alg = 'ES256';
      const jwks = createLocalJWKSet({ keys: [jwk] });

      // JWKS-only verifier (no HS secret): mirrors a project on signing keys.
      const verify = makeVerifyToken({ jwks });

      const good = await new SignJWT({ sub: 'user-2', role: 'authenticated' })
        .setProtectedHeader({ alg: 'ES256', kid: 'signing-key-1' })
        .setExpirationTime('1h')
        .sign(privateKey);
      const claims = await verify(good);
      expect(claims?.sub).toBe('user-2');

      // A token from a key not in the JWKS must be rejected.
      const foreign = await generateKeyPair('ES256');
      const bad = await new SignJWT({ sub: 'attacker' })
        .setProtectedHeader({ alg: 'ES256', kid: 'signing-key-1' })
        .setExpirationTime('1h')
        .sign(foreign.privateKey);
      expect(await verify(bad)).toBeNull();
    });
  });

  describe('mixed / mid-rotation (both configured)', () => {
    it('accepts HS256 and ES256 tokens, routing by the alg header', async () => {
      const { privateKey, publicKey } = await generateKeyPair('ES256');
      const jwk = await exportJWK(publicKey);
      jwk.kid = 'k1';
      const verify = makeVerifyToken({ hsSecret: HS_SECRET, jwks: createLocalJWKSet({ keys: [jwk] }) });

      const hs = await hsToken({ sub: 'legacy-user' });
      const es = await new SignJWT({ sub: 'new-user' })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setExpirationTime('1h')
        .sign(privateKey);

      expect((await verify(hs))?.sub).toBe('legacy-user');
      expect((await verify(es))?.sub).toBe('new-user');
    });
  });

  it('throws at construction if nothing is configured', () => {
    expect(() => makeVerifyToken({})).toThrow(/FUNCTIONS_JWT_SECRET or SUPABASE_URL/);
  });
});
