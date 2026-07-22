// Canonical default engagement-agreement template. Lives in shared/ because it
// is imported by BOTH the server (firm provisioning seeds it — see
// server/agreements.ts / server/clerk-webhook.ts) and the dev/CLI tooling
// (scripts/admin.ts, the seeds). The Docker image ships server/ and shared/ but
// not scripts/, so server code must source this here, never from scripts/.
//
// Real firms replace this with their own vetted text via
// `npm run admin -- create-agreement-version`. Kept deliberately plain — the
// point of beta Requirement 1 is that SOME immutable, versioned text is on file
// and referenced by every acceptance, not that this wording is authoritative.
export const DEFAULT_AGREEMENT_LABEL = 'EA-1.0';
export const DEFAULT_AGREEMENT_TITLE = 'Exit Blueprint Engagement Agreement';

export const DEFAULT_AGREEMENT_BODY = `Exit Blueprint Engagement Agreement

This engagement authorizes the advisor to conduct an exit-readiness assessment of
the client's business using the Exit Blueprint platform. By accepting, the client
acknowledges:

1. Purpose. The advisor will collect business and owner information, score exit
   readiness, and prepare readiness reports and a remediation roadmap.

2. Data handling. Information the client provides — and documents uploaded on the
   client's behalf — is stored securely and used to produce the client's own
   readiness assessment. Access is restricted to the client's advisory firm.

3. Consent (recorded separately at acceptance). The client may separately permit
   the use of de-identified data for benchmarking, anonymized aggregation, and
   outcome tracking. These permissions are optional and independent of this
   engagement.

4. No guarantee of outcome. The Diligence Readiness Score is an assessment tool, not a
   valuation, offer, or assurance of any transaction result.

Acceptance of this agreement is required before any assessment data is collected.`;
