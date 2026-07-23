# Trust Services Criteria — Control Matrix

| | |
| --- | --- |
| **Date** | 2026-07-23 · **Version** 1.0 |
| **Scope** | SOC 2 — Security (Common Criteria), Availability (A1), Confidentiality (C1) |
| **Purpose** | Map each in-scope Trust Services Criterion to the Exit Blueprint control that satisfies it, the policy that governs it, and the evidence that proves it. |

This is the spine an auditor works from: for every criterion, *what control do you
have, where is it written down, and how do you prove it operates?* Status is
**✅ Implemented · 🟡 Partial · 🔴 Gap**, consistent with
`docs/compliance/00-soc2-readiness-assessment.md`. Evidence pointers resolve in
`docs/compliance/evidence/control-evidence-index.md`.

Policy references (`P00`–`P15`) are the files in `docs/compliance/policies/`.

## Common Criteria

### CC1 — Control Environment

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC1.1 | Code of conduct & integrity commitments; acceptable-use expectations | 🟡 | P00, P13, P14 | Policies 13/14; acknowledgment cadence to begin |
| CC1.2 | Security governance & oversight (Security Officer role) | 🟡 | P00 §4 | Assigned to Matthew; governance body planned |
| CC1.3 | Organizational structure & authority | ✅ | P00 §4 | Role table; RLS/allowlist enforce authority in code |
| CC1.4 | Competence & background verification | 🟡 | P14 | Background-check policy drafted; execution planned |

### CC2 — Communication & Information

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC2.1 | Security information is identified & used | ✅ | P00, P11 | Audit log, request logs, this pack |
| CC2.2 | Internal communication of responsibilities | 🟡 | P00, P13 | This pack is first formal internal comms; training planned |
| CC2.3 | External communication of commitments | ✅ | P06 | `/security` page, docs/13, docs/16, subprocessor register |

### CC3 — Risk Assessment

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC3.1 | Objectives specified for risk ID | ✅ | P07 | Risk policy §objectives |
| CC3.2 | Risks identified & analyzed | 🟡 | P07, P15 | `evidence/risk-register.csv`; first formal cycle to record |
| CC3.3 | Fraud risk considered | 🟡 | P07 | Fraud-risk section; register entries |
| CC3.4 | Change-related risk assessed | ✅ | P02, P07 | PR + CI gate; migration discipline |

### CC4 — Monitoring Activities

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC4.1 | Ongoing/separate control evaluations | 🟡 | P00, P11 | CI runs every PR (continuous); management review cadence to begin |
| CC4.2 | Deficiencies communicated & remediated | 🟡 | P04, P15 | IR + vuln policies; remediation tracking |

### CC5 — Control Activities

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC5.1 | Control activities mitigate risk | ✅ | all P | This matrix + CI |
| CC5.2 | Technology control activities | ✅ | P03, P02 | CI gate; RLS suite; scoring fixtures |
| CC5.3 | Policies & procedures deployed | ✅/🟡 | P00 | This pack adopted; consistent operation = Type II evidence |

### CC6 — Logical & Physical Access

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC6.1 | Logical access security (identity + RLS) | ✅ | P01, P08 | Clerk; RLS on `firm_id`; `scripts/rls-test.ts` |
| CC6.2 | Registration/provisioning & deprovisioning | ✅/🟡 | P01, P14 | `scripts/admin.ts` + Clerk webhook; offboarding checklist |
| CC6.3 | Role-based least privilege | ✅ | P01 | RLS role policies; `PLATFORM_SUPERADMIN_IDS` default-deny |
| CC6.4 | Physical access restricted | ✅ (inherited) | P00 | No company DCs; Supabase/Render/Vercel SOC 2 |
| CC6.5 | Logical/physical asset disposal | 🟡 | P09 | Per-tenant destruction operational; audited purge 🟡 |
| CC6.6 | Boundary protection | ✅ | P01, P03 | TLS, edge JWT verify, webhook signatures, rate limiting, provider WAF |
| CC6.7 | Restricted data transmission & movement | ✅ | P08, P01 | TLS 1.2+; AES-256-GCM at rest; signed 5-min URLs; nosniff attachment serving |
| CC6.8 | Malicious/unauthorized software prevention | 🟡 | P08, P03 | ClamAV scan optional (`EB_SCANNER=clamav`); enable in prod |

### CC7 — System Operations

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC7.1 | Vulnerability detection | 🟡 | P15, P03 | `npm audit` clean; CI scanning + pen test planned |
| CC7.2 | Security event monitoring | 🟡 | P11 | `data_access_log`; Sentry seam; alerting thresholds to configure |
| CC7.3 | Incident evaluation & response | ✅/🟡 | P04 | IR plan + severity model; first tabletop to record |
| CC7.4 | Incident containment & recovery | 🟡 | P04, P05 | IR + BCP/DR runbooks |
| CC7.5 | Recovery & post-incident improvement | 🟡 | P04 | Blameless post-mortem process; incident register |

### CC8 — Change Management

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC8.1 | Changes authorized, designed, tested, approved | ✅/🟡 | P02, P03 | PR to `main`; `.github/workflows/ci.yml` gate; review; migration discipline. Author≠approver 🟡 for small team |

### CC9 — Risk Mitigation

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| CC9.1 | Business-disruption risk mitigation | 🟡 | P05, P12 | BCP/DR + backups; DR test pending |
| CC9.2 | Vendor & business-partner risk management | 🟡 | P06 | `seed/subprocessors.csv`; vendor attestations; annual re-assessment to operationalize |

## Availability (A1)

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| A1.1 | Capacity management | 🟡 | P05 | Stateless compute + managed DB; capacity targets to set |
| A1.2 | Backup, recovery, resilience | ✅/🟡 | P12, P05 | Supabase backups + PITR (✅); restore procedure (📄); test record (🟡) |
| A1.3 | Recovery plan tested | 🔴→🟡 | P05 | DR test with recorded last-tested date planned |

## Confidentiality (C1)

| Criterion | Control | Status | Policy | Evidence |
| --- | --- | --- | --- | --- |
| C1.1 | Confidential information identified & protected | ✅ | P08 | Classification tiers; NPI encrypted/RLS-isolated/signed-URL; never sent to LLM for scoring |
| C1.2 | Confidential information disposed of | 🟡 | P09 | Retention/disposal policy; audited self-serve purge 🟡 |

## How to read the status roll-up

- **✅ across CC6, C1.1, most of CC8, A1.2 (backups):** the *technical* control
  environment. These are the controls most startups lack and Exit Blueprint has.
- **🟡 across CC1–CC4, CC7, CC9, A1.3:** the *operating-evidence* controls — they
  require recurring, dated execution (reviews, tests, cycles). Design exists; the
  Type II observation window accrues the proof. Start the cadences (readiness §4).
- **No 🔴 that isn't already on a remediation path.** Every gap has a named owner
  policy and a roadmap tier.
