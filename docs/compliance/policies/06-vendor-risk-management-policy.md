# Vendor Risk Management Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually and on material change · **Applies to:** all third-party providers (sub-processors) that Exit Blueprint relies on to deliver the platform.

## Purpose

Ensure every third party that stores, processes, or transmits Exit Blueprint
client data — or is otherwise critical to the service — is vetted before use,
tracked in a canonical register, and re-assessed on a defined cadence. As a
small team, Exit Blueprint relies heavily on managed providers and inherits much
of its infrastructure security from them; this policy governs how we choose and
watch them.

## Scope

All sub-processors and critical service providers in the production data plane.
The set is deliberately small and fixed at six vendors (below). Adding or
removing any provider is a controlled change under this policy.

## The sub-processor register

The **canonical register is `seed/subprocessors.csv`.** The same list is
surfaced to firms on the in-app `/security` page and mirrored in docs/13 and
docs/16. All four locations must stay in sync; the CSV is authoritative on
conflict.

| Sub-processor | Purpose | Data exposure | Region | Attestation |
| --- | --- | --- | --- | --- |
| **Supabase** | Postgres database, RLS, object storage | All client records — encrypted at rest, RLS-isolated | US | SOC 2 Type II |
| **Clerk** | Identity provider — auth, MFA, org/user management | User identity + session data (names, emails, auth tokens); no client business records | US | SOC 2 Type II |
| **Render** | Compute service hosting | Transient request/response only; no client data at rest | US | SOC 2 Type II |
| **Vercel** | Static frontend hosting | Serves the browser app; no client data at rest | US | SOC 2 Type II |
| **Stripe** | Subscription billing + payments for advisor firms | Firm billing/payment data; no client assessment records | US | PCI DSS Level 1; SOC 2 Type II |
| **Anthropic** | AI narrative drafted from already-structured data | Report inputs only; never trains on data; never computes/influences a score | US | SOC 2 Type II |

All sub-processors are US-based, keeping client data in the US region.

## Policy statements

1. No third party handles client data until it has been vetted under this policy
   and added to the register.
2. Onboarding due diligence requires the vendor's own current independent
   security attestation (SOC 2 Type II or equivalent ISO 27001).
3. Every sub-processor is re-assessed at least annually.
4. Adding or removing a sub-processor follows the controlled change process below.
5. Security and confidentiality requirements flow down to sub-processors via
   their terms/DPAs; a provider that cannot meet them is not used.

## Onboarding due diligence

Before a provider is added, Matthew reviews and records:

- The provider's current independent attestation (SOC 2 Type II / ISO 27001) or
  equivalent evidence.
- Data exposure: what class of Exit Blueprint data the provider would touch, and
  whether that is necessary (data minimization).
- Region / data residency (must keep client data in the US region).
- Encryption in transit and at rest, and the provider's own sub-processor and
  breach-notification commitments.
- A DPA or equivalent contractual terms carrying flow-down security obligations.

## Annual re-assessment

Each sub-processor is re-assessed at least annually: re-confirm the current
attestation is in force, review any published incidents or material changes,
and re-confirm data exposure is still minimal and necessary. Outcomes are
recorded with a date.

- Status: 🟡 planned as a recurring operational cadence with recorded dates
  (facts brief gap #7; docs/16 §3, §6). The vendors are vetted and hold current
  attestations today; the *recurring* re-assessment process is not yet
  operationalized.

## Change process — adding or removing a sub-processor

1. Complete onboarding due diligence (above) for an addition, or confirm data
   is migrated/purged for a removal.
2. Update the canonical register `seed/subprocessors.csv`.
3. Propagate the change to the `/security` page, docs/13, and docs/16 so all
   views match.
4. Notify affected firms of the sub-processor change, consistent with our DPA
   commitments, before or promptly upon the change taking effect.
5. Land the change through the normal PR + CI gate.

- Status: 📄 process defined here; register + `/security` propagation are ✅ the
  existing mechanism; firm-notification-on-change is 📄 (procedural).

## Anthropic-specific note (AI boundary)

Anthropic (Claude API) is a special case reflecting architecture rule 2: it
receives **report inputs only** — already-structured data — to draft narrative.
It **never trains on our data, never computes or influences a readiness score,**
and its output is always labeled draft narrative. No client identity or raw
document bytes are sent for scoring; scoring is deterministic, rule-based code
(`seed/fixtures/reference_scorer.py`). This boundary is a hard architectural
constraint, not merely a vendor term. See policy 08 (data classification) for
the data-handling side of this boundary.

## Flow-down of security requirements

Our security and confidentiality obligations to firms flow down to
sub-processors through their terms and DPAs: encryption, access control, breach
notification, and no unauthorized secondary use of data. Application-level
tenant isolation is enforced by our own RLS (`scripts/rls-test.ts`), so no human
at a provider has application-level access to a firm's records. A provider that
cannot meet these requirements is not onboarded and, if an existing provider
falls out of compliance, is offboarded via the change process.

## Roles & responsibilities

- **Matthew** — approves onboarding, maintains the register, runs the annual
  re-assessment, and owns add/remove changes and firm notification.
- **All personnel** — must not introduce a new data-handling third party outside
  this process.

## Implementation / evidence

- Canonical register: `seed/subprocessors.csv` (✅).
- Firm-facing register: in-app `/security` page; docs/13, docs/16 (✅ in sync).
- Tenant isolation limiting provider data access: `scripts/rls-test.ts`, `npm run test:rls` (✅).
- AI boundary: architecture rule 2; `seed/fixtures/reference_scorer.py` (✅ deterministic scoring, no LLM).
- Onboarding due diligence + change process (📄 defined here).
- Annual re-assessment cadence with recorded dates (🟡 planned).

## Exceptions

No exceptions to the "vetted before data access" or "register kept in sync"
requirements. Any temporary deviation must be approved and documented by
Matthew with a remediation date.

## Review & enforcement

Reviewed at least annually and whenever a sub-processor is added, removed, or
materially changes. Matthew enforces the policy; introducing an unvetted
data-handling provider is a policy violation.

## SOC 2 mapping

Supports Common Criteria CC9.2 (assess and manage risks associated with
vendors and business partners). Cross-references: policy 05 (BCP/DR — provider
resilience), policy 08 (data classification — AI boundary), docs/13, docs/16,
`seed/subprocessors.csv`.
