# SOC 2 Readiness Assessment (Gap Analysis)

| | |
| --- | --- |
| **Prepared for** | Matthew (matthew@fracturesystems.com) |
| **Date** | 2026-07-23 |
| **Scope** | SOC 2 — Security (Common Criteria), Availability, Confidentiality |
| **Target** | Type I (design) → Type II (operating effectiveness) |
| **Method** | Control walkthrough of the codebase + existing security docs, mapped to the 2017 Trust Services Criteria (TSC), scored implemented / partial / gap |

This is the self-assessment an auditor's readiness review would produce: where Exit
Blueprint stands against SOC 2 today, what is genuinely in place, and the shortest
honest path to a clean Type I and then Type II. It is deliberately conservative — a
control is only "Implemented" if it can be evidenced in code, config, or an adopted
policy. Everything else is "Partial" or "Gap" with a named remediation.

## 1. Executive summary

**The technical control environment is strong and well ahead of the typical
pre-audit startup.** The platform was built security-first: database-enforced
multi-tenant isolation, encryption in transit and at rest, signed short-expiry
document delivery, audit logging, MFA, idle timeout, rate limiting, signature-verified
webhooks, and a production startup that refuses to run without its encryption keys.
An automated dependency audit currently reports **0 vulnerabilities**, and a source
review found **no high or critical code-level findings** (see
`docs/compliance/02-codebase-security-scan.md`).

**The gaps are almost entirely in process and documentation, not in the product.**
Before this pack, Exit Blueprint had excellent one-page and vendor-DD security
summaries but no adopted policy set, no control-to-criteria matrix, no risk register,
and no evidence of *recurring* control operation (access reviews, DR tests,
sub-processor re-assessments) — which is exactly what a SOC 2 **Type II** tests. It
also has not yet had an independent penetration test.

**Bottom line:**
- **Type I readiness:** achievable in the near term. This pack supplies the missing
  policies, matrix, and risk register — the design-of-controls evidence Type I needs.
  The remaining Type I blockers are small (finalize the breach-notification clause,
  adopt the pack formally, and turn on CI dependency scanning).
- **Type II readiness:** gated by *time and operating evidence*. Type II requires the
  recurring controls to actually run over an observation window (typically 3–6 months)
  with dated records. Start the cadences now (§4) so the observation window can begin.
- **Penetration test:** scope is defined in `docs/compliance/pentest/`. This is the
  other common hard gate on enterprise/RIA vendor reviews and should run in parallel.

## 2. Readiness scorecard by Trust Services Criteria

Status key: **✅ Implemented** · **🟡 Partial** (control exists but not fully
operationalized/evidenced) · **🔴 Gap** (not yet in place).

### Common Criteria — Control Environment & Governance (CC1–CC5)

| Criteria | Area | Status | Notes |
| --- | --- | --- | --- |
| CC1.1 | Integrity & ethics, code of conduct | 🟡 | Acceptable-use + HR-security policies now drafted (policies 13, 14); formal code-of-conduct acknowledgment cadence to begin. |
| CC1.2–1.3 | Board/management oversight, structure | 🟡 | Small team; Security Officer role assigned (Matthew). Formal governance body planned as team grows. |
| CC1.4 | Competence, background checks | 🔴→🟡 | Background-check policy drafted (planned before first enterprise engagement); not yet executed. |
| CC2.1–2.3 | Communication of security commitments | 🟡 | External: `/security` page, docs/13, docs/16. Internal: this pack is the first formal internal comms; training program planned. |
| CC3.1–3.4 | Risk assessment | 🟡 | Risk policy + starter register now exist (policy 07, `evidence/risk-register.csv`); first formal annual cycle to be recorded. |
| CC4.1–4.2 | Monitoring of controls | 🟡 | CI enforces technical controls continuously; management review cadence of the controls themselves to begin. |
| CC5.1–5.3 | Control activities / policies | ✅/🟡 | Policies now defined (this pack); CI is an automated control activity. Consistent operation is the Type II evidence to accrue. |

### Common Criteria — Logical & Physical Access (CC6)

| Criteria | Area | Status | Notes |
| --- | --- | --- | --- |
| CC6.1 | Logical access / identity | ✅ | Clerk identity; RLS on every domain table (`firm_id`); default-deny. Verified by `npm run test:rls`. |
| CC6.2 | Provisioning / deprovisioning | ✅/🟡 | Provisioning via `scripts/admin.ts` + Clerk webhook. Offboarding checklist documented (policy 14); recorded execution to accrue. |
| CC6.3 | Role-based access / least privilege | ✅ | Roles (admin/advisor/reviewer/owner) enforced by RLS policy, not ad-hoc grants. Superadmin gated by `PLATFORM_SUPERADMIN_IDS` allowlist, default-deny. |
| CC6.6 | Boundary protection | ✅ | TLS everywhere; edge auth (JWT verify); signature-verified webhooks; per-IP rate limiting; provider WAF (Render/Vercel). |
| CC6.7 | Data in transit / restricted access | ✅ | TLS 1.2+; AES-256-GCM at rest for documents; signed 5-min URLs; nosniff + attachment serving to defeat stored XSS. |
| CC6.8 | Malicious software prevention | 🟡 | Optional ClamAV upload scanning (`EB_SCANNER=clamav`, `server/documents/scanner.ts`); default records as skipped — recommend enabling in prod. |
| CC6.4–6.5 | Physical access / disposal | ✅(inherited)/🟡 | No company data centers; physical security inherited from Supabase/Render/Vercel (their SOC 2). Media disposal is provider-managed; tenant purge one-click is 🟡. |

### Common Criteria — System Operations (CC7)

| Criteria | Area | Status | Notes |
| --- | --- | --- | --- |
| CC7.1 | Vulnerability detection | 🟡 | `npm audit` clean today; automated CI dependency scanning + first pen test are planned (policy 15, pentest scope). |
| CC7.2 | Monitoring / anomaly detection | 🟡 | Structured request logging + Sentry seam (`server/observability.ts`); audit log (`data_access_log`). Formal alerting thresholds to be configured. |
| CC7.3 | Incident evaluation | ✅/🟡 | IR plan defined (policy 04); severity model + runbook in place; first tabletop exercise to be recorded. |
| CC7.4–7.5 | Incident response & recovery | 🟡 | IR + BCP/DR plans documented (policies 04, 05); DR test with a recorded last-tested date is planned. |

### Common Criteria — Change Management & Risk Mitigation (CC8–CC9)

| Criteria | Area | Status | Notes |
| --- | --- | --- | --- |
| CC8.1 | Change management | ✅/🟡 | All changes via PR to `main` with required green CI (migrations on fresh DB, RLS suite, scoring fixtures, build) and review. Author≠approver separation is 🟡 for a small team. |
| CC9.1 | Risk mitigation / business disruption | 🟡 | BCP/DR + backups documented; DR test pending. |
| CC9.2 | Vendor & sub-processor management | 🟡 | Register canonical (`seed/subprocessors.csv`); vendors carry their own attestations. Annual re-assessment cadence to be operationalized. |

### Availability (A1)

| Criteria | Area | Status | Notes |
| --- | --- | --- | --- |
| A1.1 | Capacity | 🟡 | Stateless compute, managed DB; formal capacity monitoring targets to be set. |
| A1.2 | Backup & recovery | ✅/🟡 | Supabase managed backups + PITR (✅); documented restore procedure (policy 12); recovery *test* record 🟡. |
| A1.3 | Recovery testing | 🔴→🟡 | DR test with recorded last-tested date planned (policy 05). This is the single most-asked Availability evidence item. |

### Confidentiality (C1)

| Criteria | Area | Status | Notes |
| --- | --- | --- | --- |
| C1.1 | Confidential data identified & protected | ✅ | Data classification policy (policy 08); NPI encrypted at rest, RLS-isolated, signed-URL delivered, never sent to the LLM for scoring. |
| C1.2 | Confidential data disposal | 🟡 | Retention/disposal policy (policy 09); per-tenant export + destruction is operational today; self-serve audited purge is 🟡. |

## 3. Prioritized remediation roadmap

Ordered by "most likely to be a hard gate on an enterprise/RIA sale" first — the same
prioritization docs/16 uses.

### Tier 1 — Type I blockers / hardest sales gates
1. **Adopt this policy pack formally** — Security Officer sign-off + record in
   `docs/06-decisions.md`. Converts the drafts here into adopted policy (evidence for
   CC5, CC1).
2. **Finalize the breach-notification contract clause** (≤30-day / 72-hour target) in
   the customer contract template. Closes the last "committed but not papered" item.
3. **Turn on CI dependency scanning** — add `npm audit --audit-level=high` (and/or
   GitHub Dependabot/dependency-review) as a CI step. Small change; converts CC7.1
   from 🟡 to a continuously-evidenced control. (Audit is clean today, so this is
   zero-remediation to switch on.)
4. **Engage a SOC 2 auditor / readiness partner** and pick the observation window.

### Tier 2 — Pen test & operating cadences (start now; Type II evidence)
5. **Commission the first independent penetration test** per
   `docs/compliance/pentest/00-pentest-scope-and-roe.md`; track findings to closure.
6. **Start the recurring cadences and record dates** — this is what Type II tests:
   - Quarterly **access review** (advisors, admins, superadmin allowlist, service creds).
   - Annual **sub-processor re-assessment** (collect each vendor's current SOC 2/ISO).
   - At least annual **DR restore test** with a recorded last-tested date.
   - Annual **risk assessment** cycle recorded against the register.
   - Periodic **log/alert review**.
7. **Enable ClamAV upload scanning in production** (`EB_SCANNER=clamav`) — moves CC6.8
   from optional to on.

### Tier 3 — Program maturation
8. **Background-check process** before the first enterprise engagement (policy 14).
9. **Security-awareness training** program with completion records (CC1.4, CC2.2).
10. **Self-serve tenant export + audited purge** admin action (turns policy 09 into
    one click; closes C1.2 fully).
11. **Formal alerting thresholds** on the observability pipeline (CC7.2).
12. **Configure `DATABASE_CA_CERT`** in production for full DB TLS verification (the
    code already warns if unset).

## 4. What "passing" looks like

- **Type I:** an auditor confirms the controls in §2 are *designed* appropriately at a
  point in time. This pack + Tier-1 items gets there. No long waiting period required.
- **Type II:** the same controls are shown to have *operated effectively* across the
  observation window, evidenced by the dated records the Tier-2 cadences produce.
  Begin those cadences immediately so the clock starts.
- **Pen test:** a reputable firm completes testing against the defined scope, and
  findings are remediated or risk-accepted with rationale. Track in the pentest folder.

## 5. Evidence pointers

Everything an auditor will ask "show me" for is indexed in
`docs/compliance/evidence/control-evidence-index.md`, which maps each control to the
file path, test, or config that evidences it. The code-level review backing the
"no high/critical findings" statement is in
`docs/compliance/02-codebase-security-scan.md`.
