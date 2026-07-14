// Supabase access-token verification for the compute service. Supports both
// signing regimes a project can be in, chosen per token by its `alg` header:
//
//   - HS256  — legacy shared JWT secret (Project Settings → API → JWT Secret),
//              verified against FUNCTIONS_JWT_SECRET.
//   - ES256/RS256/EdDSA — asymmetric JWT signing keys (the default on newer
//              projects), verified against the project JWKS at
//              <SUPABASE_URL>/auth/v1/.well-known/jwks.json. No shared secret.
//
// Supporting both (rather than swapping) means a project mid-rotation — where
// old and new tokens coexist — keeps working. jwtVerify checks the signature
// and expiry; we additionally require a `sub` (the user id RLS keys off).
import {
  createRemoteJWKSet,
  jwtVerify,
  decodeProtectedHeader,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export interface Claims extends JWTPayload {
  sub: string;
  role?: string;
}

export interface VerifierConfig {
  // Legacy symmetric secret (HS256). Optional once JWKS is configured.
  hsSecret?: string;
  // Full JWKS URL for asymmetric verification. Optional for legacy-only projects.
  jwksUrl?: string;
  // Test seam: supply a resolved key set (e.g. jose's createLocalJWKSet) so the
  // asymmetric path can be exercised without a network fetch.
  jwks?: JWTVerifyGetKey;
}

export type VerifyToken = (token: string) => Promise<Claims | null>;

// Build a verifier from config. Requires at least one regime to be configured;
// throws otherwise so misconfiguration fails loudly at startup, not per request.
export function makeVerifyToken(config: VerifierConfig): VerifyToken {
  const hsKey = config.hsSecret ? new TextEncoder().encode(config.hsSecret) : null;
  const jwks: JWTVerifyGetKey | null =
    config.jwks ?? (config.jwksUrl ? createRemoteJWKSet(new URL(config.jwksUrl)) : null);

  if (!hsKey && !jwks) {
    throw new Error('no JWT verification configured: set FUNCTIONS_JWT_SECRET or SUPABASE_URL');
  }

  return async (token: string): Promise<Claims | null> => {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      return null; // not a well-formed JWS
    }

    try {
      let payload: JWTPayload;
      if (alg === 'HS256') {
        if (!hsKey) return null; // token wants the legacy secret, none configured
        ({ payload } = await jwtVerify(token, hsKey));
      } else {
        if (!jwks) return null; // asymmetric token, no JWKS configured
        ({ payload } = await jwtVerify(token, jwks as JWTVerifyGetKey));
      }
      if (typeof payload.sub !== 'string' || !payload.sub) return null;
      return payload as Claims;
    } catch {
      return null; // bad signature, expired, unknown kid, etc.
    }
  };
}
