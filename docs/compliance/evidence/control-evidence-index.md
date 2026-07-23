# Control Evidence Index

| | |
| --- | --- |
| **Version** 1.0 · 2026-07-23 · Owner: Matthew |
| **Purpose** | The "show me" table. For each control an auditor tests, this maps to the exact file, test, config, or record that evidences it — so a walkthrough is a lookup, not a scavenger hunt. |

Status: **✅ Implemented · 🟡 Partial/planned**. Paths are repo-relative. "Live
evidence" items (dated records the recurring cadences produce) accrue during the
Type II observation window and are noted where not yet present.

## Access control & identity (CC6.1–6.3)

| Control | Status | Evidence |
| --- | --- | --- |
| Multi-tenant RLS isolation | ✅ | `supabase/migrations/*` (RLS policies), `scripts/rls-test.ts`, CI job "RLS firm-isolation test" in `.github/workflows/ci.yml`; test run output |
| Identity provider (Clerk) | ✅ | `server/auth-jwt.ts`, `server/clerk.ts`, `server/clerk-webhook.ts`, `docs/30-clerk-cutover-runbook.md` |
| JWT verification at the edge | ✅ | `server/auth-jwt.ts`, `server/http.ts` (`bearer`), `tests/auth-jwt.test.ts` |
| MFA (TOTP) for advisor/admin | ✅ | Clerk MFA policy (dashboard); `docs/13-security-summary.md` §Access controls |
| Idle session timeout (30 min) | ✅ | `src/lib/auth.tsx` (`IDLE_TIMEOUT_MS`), `tests/sessionExpiry.test.ts` |
| Role-based least privilege | ✅ | RLS role policies in migrations; `server/functions.ts` scope authorization |
| Superadmin cross-tenant gate (default-deny) | ✅ | `server/platform-admin.ts` (`isPlatformSuperadmin`), `server/http.ts` `/internal/metrics`, `PLATFORM_SUPERADMIN_IDS` |
| Provisioning / deprovisioning | ✅/🟡 | `scripts/admin.ts`, Clerk webhook; offboarding checklist policy 14; dated execution records 🟡 |
| Periodic access review (dated) | 🟡 | Cadence defined (policy 01); recorded review artifacts accrue in Type II window |

## Encryption & data protection (CC6.6–6.7, C1.1)

| Control | Status | Evidence |
| --- | --- | --- |
| TLS in transit | ✅ | Provider TLS (Render/Vercel); `server/db-ssl.ts` for DB TLS |
| DB TLS full verification | 🟡 | `server/db-ssl.ts`; enable by setting `DATABASE_CA_CERT` (prod warns if unset) |
| AES-256-GCM at rest (documents) | ✅ | `server/documents/crypto.ts`, `tests/security.test.ts` (round-trip + tamper) |
| Signed short-expiry document URLs | ✅ | `server/documents/signed-url.ts`, `tests/security.test.ts` |
| Stored-XSS-safe serving | ✅ | `server/http.ts` `/documents/download` (nosniff, attachment, safe MIME) |
| Malware scanning on upload | 🟡 | `server/documents/scanner.ts` (`EB_SCANNER=clamav`); enable in prod |
| Data classification | ✅ | Policy 08 |

## Logging, monitoring & audit (CC7.2–7.3)

| Control | Status | Evidence |
| --- | --- | --- |
| Data-access audit log (append-only) | ✅ | `server/audit.ts` (`data_access_log`), `tests/security.test.ts` |
| Immutable answer-provenance log | ✅ | `server/audit.ts` (`answer_provenance_events`), `tests/provenance-evidence.test.ts` |
| Structured request logging | ✅ | `server/observability.ts` (`logRequest`), `server/http.ts` |
| Error monitoring (Sentry seam) | ✅/🟡 | `server/observability.ts`; live once `SENTRY_DSN` set; `tests/observability.test.ts` |
| Alerting thresholds | 🟡 | Policy 11; to configure |

## Operations, change & vuln management (CC7.1, CC8.1)

| Control | Status | Evidence |
| --- | --- | --- |
| Change management (PR + CI gate + review) | ✅ | `.github/workflows/ci.yml`, GitHub PR history, `docs/06-decisions.md` |
| Definition-of-done gate | ✅ | `CLAUDE.md` §Definition of done; CI jobs |
| Migration discipline (timestamped, no manual edits) | ✅ | `supabase/migrations/*`, `scripts/migrate.ts`, `CLAUDE.md` |
| Dependency vulnerability posture | ✅/🟡 | `npm audit` = 0 vulns (manual today); CI scanning step 🟡 (policy 15) |
| Rate limiting | ✅ | `server/ratelimit.ts`, `tests/ratelimit.test.ts`, `server/http.ts` |
| Webhook signature/replay defense | ✅ | `server/clerk-webhook.ts`, `server/stripe.ts`, `server/scheduled.ts`, `tests/clerk-webhook.test.ts`, `tests/stripe.test.ts` |
| Secure-by-default prod startup | ✅ | `server/http.ts` (hard-fail without `EB_DOCUMENT_KEY`/`EB_SIGNING_KEY`) |
| Secrets management | ✅ | `.gitignore` (`.env*`), `.env.example`, host secret stores; `docs/14-environment-keys.md` |
| Internal code security scan | ✅ | `docs/compliance/02-codebase-security-scan.md` |
| Penetration test | 🟡 | `docs/compliance/pentest/`; not yet performed |

## Availability & continuity (A1.1–A1.3, CC9.1)

| Control | Status | Evidence |
| --- | --- | --- |
| Managed backups + PITR | ✅ | Supabase managed backups (provider console); policy 12 |
| Stateless redeployable compute | ✅ | `server/Dockerfile`, `render.yaml`, git history |
| Health/readiness endpoints | ✅ | `server/http.ts` `/health`, `/ready` |
| Documented restore procedure | ✅ | Policy 05, policy 12 |
| DR restore test (dated) | 🟡 | Policy 05; last-tested date to record |

## Risk, vendor & governance (CC1–CC4, CC9.2)

| Control | Status | Evidence |
| --- | --- | --- |
| Information security policy pack | ✅ | `docs/compliance/policies/*` (this pack) |
| Risk assessment + register | ✅/🟡 | Policy 07, `docs/compliance/evidence/risk-register.csv`; first dated annual cycle 🟡 |
| Sub-processor register | ✅ | `seed/subprocessors.csv`, `docs/13`, `docs/16`, in-app `/security` page |
| Vendor re-assessment (annual, dated) | 🟡 | Policy 06; cadence to operationalize |
| Incident response plan | ✅ | Policy 04; incident register + first tabletop 🟡 |
| Breach-notification commitment | 📄/🟡 | Policy 04; contract clause being finalized |
| Vendor security summaries (external) | ✅ | `docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`, `docs/42-lwg-vendor-dd-response.md` |

## HR & personnel security (CC1.1, CC1.4, CC6.2)

| Control | Status | Evidence |
| --- | --- | --- |
| Acceptable use policy | ✅ | Policy 13 |
| HR security policy (onboarding/offboarding) | ✅/🟡 | Policy 14; executed records 🟡 |
| Background checks | 🟡 | Policy 14; planned before first enterprise engagement |
| Security-awareness training | 🟡 | Policy 14; program + completion records planned |

---

**Note on "live evidence."** Items marked 🟡 for a *dated record* are not design gaps —
the control is designed and, where technical, implemented. What accrues over the SOC 2
Type II observation window is the *proof it ran on schedule* (a completed access
review, a DR-test log, a vendor re-assessment). Start the cadences (readiness §4) to
begin producing these.
