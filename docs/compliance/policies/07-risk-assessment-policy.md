# Risk Assessment Policy

| | |
| --- | --- |
| **Policy** | Risk Assessment |
| **Owner** | Matthew (matthew@fracturesystems.com) |
| **Version** | 1.0 |
| **Effective** | 2026-07-23 |
| **Review** | Annually / on material change |
| **Applies to** | All Exit Blueprint personnel and systems |

## Purpose

Establish how Exit Blueprint identifies, rates, treats, and tracks risks to the
security, availability, and confidentiality of the platform and its client data —
so that risk decisions are deliberate, recorded, and revisited on a set cadence
rather than made implicitly.

## Scope

Risks to the audited system and the business that operates it: the application
and its production data plane (per the docs/16 system boundary), the
sub-processors it depends on, and the people and processes that run it. Financial
and market risk to the underlying advisory businesses that use the product is out
of scope — Exit Blueprint is a software vendor, not a regulated financial entity.

## Policy statements

1. **Methodology.** Each risk is rated on **likelihood × impact**, each scored
   Low / Medium / High. The combination sets priority: the highest attention goes
   to High-impact risks with Medium or High likelihood.
2. **Cadence.** A full risk assessment is performed **at least annually** and
   additionally **on any material change** — new sub-processor, new data type, a
   significant architecture change, an incident, or a pen-test result.
3. **Risk register.** Identified risks are recorded in the risk register with
   their likelihood, impact, chosen treatment, owner, and status. The canonical
   register is `docs/compliance/evidence/risk-register.csv`; the starter set
   below seeds it.
4. **Treatment options.** For each risk one of four treatments is chosen and
   recorded: **accept** (tolerate, with rationale), **mitigate** (add or
   strengthen a control), **transfer** (shift via a provider/SLA/insurance), or
   **avoid** (stop doing the thing that creates the risk).
5. **Fraud risk.** Risk of fraud and abuse is considered explicitly — including
   insider misuse of access, credential compromise leading to unauthorized data
   access, and tampering with scoring outputs. Deterministic, reference-checked
   scoring and append-only audit/provenance logs are the primary anti-tampering
   controls.
6. **Vendor / sub-processor risk.** Sub-processors are vetted at onboarding
   against their own attestations (SOC 2 / ISO). An **annual re-assessment
   cadence** is defined but is not yet operationalized as a recurring, dated
   process.
7. **Ownership.** Matthew owns the risk-assessment process and holds the
   security-officer / CISO-equivalent responsibility on the current small team.

## Roles & responsibilities

- **Risk owner (Matthew):** runs the assessment on cadence, maintains the
  register, assigns treatments, and approves acceptance of any residual risk.
- **Contributors / agents:** surface new risks encountered during development or
  operations and record them for the owner's review.

## Starter risk register

Representative current risks (likelihood × impact, treatment, status). Status
markers follow the honesty contract: ✅ control in place, 🟡 planned/open.

| # | Risk | Likelihood | Impact | Treatment | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Cross-tenant data exposure (isolation failure) | Low | High | Mitigate | ✅ Postgres RLS on every domain table, verified in CI (`scripts/rls-test.ts`) |
| R2 | Advisor/admin credential compromise | Medium | High | Mitigate | ✅ Clerk MFA (TOTP) required; 30-min idle timeout (`src/lib/auth.tsx`) |
| R3 | Document / signing key exposure | Low | High | Mitigate | ✅ Secrets in provider stores; prod hard-fail on missing keys; keys never stored with data (`server/documents/crypto.ts`) |
| R4 | Sub-processor / provider outage (availability) | Medium | Medium | Transfer / Accept | ✅ Reputable providers with own SLAs; stateless redeployable compute. Residual accepted |
| R5 | Data loss or corruption | Low | High | Mitigate / Transfer | ✅ Supabase managed backups + PITR; 🟡 DR test with a recorded last-tested date not yet performed |
| R6 | Insider access abuse | Low | High | Mitigate | ✅ Least privilege + RLS + append-only `data_access_log` (`server/audit.ts`); 🟡 background-check policy planned |
| R7 | Dependency vulnerability | Medium | Medium | Mitigate | ✅ `npm audit` clean today (0 vulns); 🟡 blocking CI scan planned |
| R8 | Undiscovered application vulnerability (pen-test findings) | Medium | High | Mitigate | 🟡 Open — no external penetration test performed yet; first test scoped with SOC 2 |
| R9 | Absence of a SOC 2 report gates enterprise sales | High | Medium | Mitigate | 🟡 Open — SOC 2 Type I → II path scoped; this pack is the readiness step |
| R10 | Personnel offboarding leaves residual access | Low | Medium | Mitigate | ✅ Clerk deprovisioning via `scripts/admin.ts`; 🟡 periodic access review with recorded dates planned |
| R11 | Forged/replayed webhook triggers unintended action | Low | Medium | Mitigate | ✅ Signature + replay verification; secretless endpoints disabled by default (`server/http.ts`) |
| R12 | Scoring integrity compromised (LLM influences a score) | Low | High | Mitigate / Avoid | ✅ Deterministic versioned scoring vs `seed/fixtures/reference_scorer.py`; AI narrative-only (CLAUDE.md rules 1–2) |

## Implementation / evidence

- 📄 **This policy** defines the methodology, cadence, and treatment model.
- 🟡 **Canonical CSV register** — `docs/compliance/evidence/risk-register.csv` is
  the designated home for the register; it is being established from the starter
  set above and is not yet a populated, dated artifact.
- ✅ **Control evidence** for individual risks is cited inline in the table and
  in `docs/16-vendor-security-dd.md` /
  `docs/compliance/policies/03-secure-development-policy.md`.
- 🟡 **Annual sub-processor re-assessment** and **periodic access review with
  recorded dates** — defined here, not yet operationalized as recurring dated
  processes.
- 🟡 **Formal risk-assessment cadence / dedicated CISO role** — Matthew holds the
  role now; formalization is planned as the team grows.

## Exceptions

Acceptance of a residual risk is itself a recorded decision: the risk owner
documents the rationale in the register (and, for a material acceptance, in
`docs/06-decisions.md`). Any deviation from this policy requires the owner's
approval.

## Review & enforcement

The register and this policy are reviewed at least annually and on material
change. Enforcement is the owner's responsibility: risks marked for mitigation
are tracked to closure, and open 🟡 items here are kept consistent with the gap
lists in `docs/16-vendor-security-dd.md` and
`docs/compliance/_facts-brief.md`.

## SOC 2 mapping

Supports **CC3.1–CC3.4** (specifies objectives and identifies, assesses, and
analyzes risks, including fraud and change) and **CC9** (risk mitigation,
including vendor/business-partner risk). Cross-references:
`docs/compliance/policies/15-vulnerability-management-policy.md`,
`docs/16-vendor-security-dd.md`.
