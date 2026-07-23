# Codebase Security Scan

| | |
| --- | --- |
| **Date** | 2026-07-23 |
| **Scope** | Application source (`server/`, `src/`, `shared/`, `scripts/`), CI config, dependency tree |
| **Method** | Manual source review of the security-relevant paths + automated pattern sweeps (injection, XSS, command exec, secrets) + `npm audit` |
| **Result** | **No high or critical findings.** 0 dependency vulnerabilities. A short list of low-severity hardening recommendations. |

This is the internal security review that backs the readiness assessment's "no
high/critical code findings" statement and gives the penetration-testing team a head
start. It is a point-in-time snapshot; re-run on material change.

## 1. Summary

The application is built security-first and the review reflects that. The classes of
bug that dominate web-app pen tests — injection, broken access control, insecure
direct object references, stored XSS, secret leakage — are each addressed by a
deliberate, evidenced control. Findings below are **low-severity hardening
opportunities**, not exploitable defects.

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low / hardening | 5 |
| Informational (verified strengths) | 9 |

## 2. Automated checks

| Check | Command / method | Result |
| --- | --- | --- |
| Dependency vulnerabilities | `npm audit` (full + `--omit=dev`) | **0 vulnerabilities** |
| SQL string interpolation | grep for `query(\`...${...}\`)` / `+` concatenation | Only `${table}`/`${cols}` from **hardcoded literals** or `information_schema` — never user input; each documented in-code. No user-controlled interpolation. |
| Command execution | grep `child_process`, `exec(`, `execSync`, `eval(` | No use in application server paths. |
| DOM XSS sinks | grep `dangerouslySetInnerHTML`, `innerHTML` | None. The Markdown renderer (`src/lib/markdown.tsx`) builds React elements — auto-escaped by construction. |
| Hardcoded secrets | grep for keys/tokens; `.gitignore` review | No real secrets in source. Dev-only defaults are clearly labeled and production hard-fails without real keys. `.env*` git-ignored. |

## 3. Verified strengths (informational)

These are the controls the review confirmed are correctly implemented. They are the
evidence for the corresponding SOC 2 criteria and reduce pen-test attack surface.

1. **Tenant isolation is database-enforced, not app-enforced.** Every domain table
   carries `firm_id` and RLS restricts a firm to its own rows; the compute service
   runs authenticated queries as `role authenticated` with the caller's JWT claims
   (`asUser` in `server/http.ts`). An IDOR/BOLA attempt that guesses another firm's id
   is stopped in the database. Continuously verified by `npm run test:rls` in CI.
2. **Service-role (RLS-bypass) access is confined.** The service-role pool is used
   only for trusted-system operations (webhooks, provisioning, cross-tenant platform
   metrics). Cross-tenant reads are additionally gated by the `PLATFORM_SUPERADMIN_IDS`
   allowlist with default-deny (`isPlatformSuperadmin`, `server/http.ts` `/internal/metrics`).
3. **Encryption at rest with authenticated encryption.** Documents are AES-256-GCM
   encrypted before storage; the GCM auth tag makes tampering detectable (a flipped
   ciphertext bit throws on decrypt — covered by `tests/security.test.ts`).
   `server/documents/crypto.ts`.
4. **Signed URLs are stateless HMAC with timing-safe verification and short expiry.**
   `server/documents/signed-url.ts` uses `crypto.timingSafeEqual`, checks expiry, and
   the token binds to a single document id — no forgeability without the signing key,
   no cross-document reuse.
5. **Stored-XSS defense on document download.** The download route never trusts the
   stored MIME type: it recomputes a safe content-type from a sanitized extension,
   serves everything but PDF/PNG/JPEG as an `attachment` octet-stream, and sets
   `X-Content-Type-Options: nosniff` — stored HTML/SVG/JS cannot execute in-origin
   (`server/http.ts`).
6. **Webhook authenticity.** Clerk (Svix) and Stripe webhooks are signature-verified
   on the **raw** body before any parsing, with a replay/timestamp tolerance window;
   the n8n scheduled webhooks require a shared secret compared timing-safely. Unset
   secret → `503` (disabled by default), so an unconfigured endpoint is closed, not open.
7. **JWT verification is strict.** `server/auth-jwt.ts` selects the verification path
   by the token's `alg`, verifies signature + expiry against JWKS (Clerk/Supabase) or
   a legacy HS256 secret, and requires a non-empty `sub`. Misconfiguration fails loudly
   at startup, not silently per-request.
8. **Secure-by-default production startup.** The service refuses to boot in production
   without `EB_DOCUMENT_KEY` and `EB_SIGNING_KEY`, and warns when DB TLS is
   unverified (`server/http.ts`, `server/db-ssl.ts`). Dev defaults can never protect
   real client data.
9. **Rate limiting in front of auth.** The per-IP limiter runs before token
   verification on the function surface, bounding the CPU a flood of bad/expensive
   tokens can burn (`server/ratelimit.ts`, `server/http.ts`).

## 4. Low-severity findings & hardening recommendations

None of these is exploitable on its own; each raises the floor.

| ID | Finding | Recommendation | Owner control |
| --- | --- | --- | --- |
| L-1 | **No automated dependency scanning in CI.** `npm audit` is clean today but is run manually. | Add `npm audit --audit-level=high` and/or GitHub dependency-review to `.github/workflows/ci.yml`. | Policy 15 / readiness Tier 1 |
| L-2 | **Malware scanning off by default.** `EB_SCANNER=clamav` is optional; the default records uploads as "scan skipped". | Enable ClamAV in production so every upload is scanned before it persists. | Policy 08 / CC6.8 |
| L-3 | **No standard security response headers on the compute service.** Responses set CORS + `nosniff` on downloads but not a global `Strict-Transport-Security` / `X-Frame-Options` / `Content-Security-Policy` from the app layer. | Confirm HSTS/frame/CSP are set at the Vercel/Render edge; add app-level defaults where the edge doesn't cover the API responses. | Policy 03 |
| L-4 | **DB certificate verification is opt-in.** Production warns but still runs if `DATABASE_CA_CERT` is unset (encrypted-but-unverified TLS). | Set `DATABASE_CA_CERT` in production for full verification (mitigates an in-path MITM on the DB connection). | Policy 01 / CC6.7 |
| L-5 | **X-Forwarded-For trust for rate-limit keying.** The webhook rate-limit key trusts the first `X-Forwarded-For` hop. This is documented as acceptable (not an auth boundary; webhooks are signature-gated), but a direct client could spoof it to evade the volume cap. | Pin the trusted-proxy hop count to the actual edge (Render) rather than always taking the first hop. | Policy 03 |

## 5. Notes for the penetration-testing team

- **Start from the authenticated function surface** (`/functions/v1/*`) and try to
  break tenant isolation (BOLA/IDOR across `firm_id`) — this is the highest-value
  target and the control most worth an independent test of RLS in a live environment.
- **Signed-URL and webhook signature paths** are good targets for expiry/replay and
  signature-bypass testing.
- **The `/internal/metrics` superadmin route** is the cross-tenant boundary; verify the
  allowlist default-deny holds.
- Full target inventory, rules of engagement, and the credentialed-testing setup are in
  `docs/compliance/pentest/00-pentest-scope-and-roe.md`.

## 6. Re-scan triggers

Re-run this review on: a new external-facing route, a new sub-processor, a change to
the auth/RLS/crypto/signed-URL paths, a dependency major-version bump, or before each
penetration test.
