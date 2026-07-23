# Human Resources Security Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually and on material change · **Applies to:** all Exit Blueprint personnel — employees and contractors.

## Purpose

Define the personnel-security controls that apply across the lifecycle of anyone
who works on Exit Blueprint: before access is granted, during their engagement,
and at offboarding. Right-sized for a small, fully remote team — there are no
physical offices, badges, or on-prem systems to govern.

## Scope

All individuals with access to Exit Blueprint systems, code, or client data:
Matthew (currently the sole principal), plus any future employees or
contractors. Sub-processor personnel are governed by those providers' own HR
controls (inherited; see policy 06).

## Policy statements

1. Access is granted on the principle of least privilege and only after the
   person has acknowledged the security policies.
2. Personnel are subject to confidentiality/NDA obligations covering client
   data and NPI.
3. Onboarding provisions access deliberately; offboarding revokes it promptly
   and completely.
4. Personnel receive security-awareness guidance appropriate to their access.
5. Contractors are held to the same data-handling obligations as employees.

## Background checks

Background screening (identity and, where lawful and relevant, criminal/financial
history) will be performed for personnel with access to client data.

- Status: 🟡 planned before the first enterprise engagement — **not yet in
  place** (facts brief gap #4; docs/16 §4). Stated honestly: at current
  single-principal scale no third-party background check has been run. This is a
  named prerequisite, not an implemented control.

## Onboarding

When someone joins:

- **Access provisioning (least privilege).** Firm/advisor identities are
  provisioned through Clerk via `scripts/admin.ts` (Clerk Organization + user +
  membership + profile) and the Clerk provisioning webhook. Each person receives
  only the roles they need (admin, advisor, reviewer, owner); role reach is
  bounded by RLS policy, not ad-hoc grants. ✅
- **Policy acknowledgment.** The new person reviews and acknowledges this policy
  pack and the acceptable-use expectations (below) before receiving access.
- **Credential hygiene.** MFA (TOTP) is required for advisor and admin accounts,
  enforced by Clerk (✅). Secrets are issued through the provider/CI secret
  stores, never shared in plaintext channels.

## Security-awareness training

Personnel receive guidance on phishing, credential hygiene, safe handling of NPI
(policy 08), and incident reporting (policy 04).

- Status: 🟡 a formal, recurring security-awareness training program is planned
  (facts brief gap #10; docs/16 open items). Today, awareness is covered by
  acknowledgment of this pack and direct guidance; a structured program with
  recorded completion is not yet in place.

## Acceptable use

All personnel must use Exit Blueprint systems and data only for legitimate
business purposes, protect credentials, avoid placing NPI in unauthorized
locations (logs, chat, tickets — see policy 08), and use company-managed access
paths. The acceptable-use expectations align with the security controls
summarized in docs/13 and the vendor-DD posture in docs/16; personnel
acknowledge them at onboarding.

- Status: 📄 acknowledged as part of this pack; cross-references docs/13.

## Confidentiality / NDA obligations

Every person with access to client data is bound by confidentiality obligations:
client business financials and owner personal-financial-readiness inputs are
Restricted/NPI (policy 08) and must not be disclosed or used outside the
engagement. These obligations survive the end of employment/engagement.

- Status: 📄 required by this policy; 🟡 executed NDA/confidentiality agreements
  are to be filed as personnel join beyond the current principal.

## Offboarding checklist

When someone leaves, complete promptly (target: same business day):

1. **Revoke Clerk access** — deactivate the user and remove organization
   memberships (reverse of `scripts/admin.ts` provisioning).
2. **Rotate shared secrets** the person could have known — `EB_DOCUMENT_KEY`,
   `EB_SIGNING_KEY`, provider/API keys in the Render/Vercel/CI secret stores.
3. **Remove repository and cloud access** — GitHub, Supabase, Render, Vercel,
   Stripe, Anthropic, and any admin consoles.
4. **Confirm no lingering credentials** — check for personal access tokens, SSH
   keys, or service credentials tied to the individual and revoke them.
5. **Confirm data return/deletion** — any local copies of client data are
   deleted; confidentiality obligations are reaffirmed.
6. **Record** the offboarding completion (who, date, items) for evidence.

- Status: 📄 checklist defined here; the mechanisms it relies on (Clerk
  deprovisioning, env secret rotation) are ✅. 🟡 offboarding has not yet been
  exercised (no departures at current scale).

## Contractor handling

Contractors with system or data access are subject to the same onboarding,
least-privilege provisioning, confidentiality obligations, acceptable-use rules,
and offboarding checklist as employees, scoped to the minimum access their work
requires and time-boxed to the engagement.

## Code of conduct

Personnel are expected to act with integrity, protect client data and NPI,
report suspected incidents promptly and without fear (policy 04 is blameless),
follow the platform's architecture invariants (CLAUDE.md — e.g. no LLM in
scoring), and comply with this policy pack. Violations are handled under
"Review & enforcement."

## Roles & responsibilities

- **Matthew** — owns this policy; runs provisioning/deprovisioning, secret
  rotation, and (as the team grows) background checks, training, and NDA
  execution. Holds the security-officer role today; 🟡 formalization planned as
  the team grows (facts brief gap #9).
- **All personnel** — acknowledge the policies, protect credentials and data,
  and report incidents.

## Implementation / evidence

- Access provisioning/deprovisioning: `scripts/admin.ts`, Clerk provisioning webhook (✅).
- Role model bounded by RLS: `scripts/rls-test.ts` (✅).
- MFA: enforced by Clerk (✅).
- Secret stores + rotation: Render/Vercel/CI env stores; hard-fail on missing keys `server/http.ts` (✅).
- Background checks (🟡 planned, not yet in place).
- Formal security-awareness training program (🟡 planned).
- Executed NDAs / offboarding records (🟡 to be filed as the team grows; no personnel changes to date).
- Acceptable use: docs/13 (📄 acknowledged in this pack).

## Exceptions

Any deviation (e.g. granting elevated access, delaying offboarding) must be
approved and documented by Matthew with a remediation date. There is no
exception to revoking access on departure.

## Review & enforcement

Reviewed at least annually and whenever the team composition or access model
materially changes. Matthew enforces the policy; violations may result in access
revocation and, for serious breaches, termination of employment or contract.

## SOC 2 mapping

Supports Common Criteria CC1.1 (integrity and ethical values / code of conduct),
CC1.4 (competence — training and personnel controls), and CC6.2 (registering and
authorizing users before granting access; timely removal on termination).
Cross-references: policy 04 (incident response), policy 08 (data classification),
policy 06 (vendor risk), docs/13, docs/16.
