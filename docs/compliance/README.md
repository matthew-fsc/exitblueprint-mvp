# Compliance Pack — SOC 2 & Penetration-Test Readiness

This directory is the **audit-ready documentation set** for Exit Blueprint: the
policies, control mappings, risk register, and evidence pointers an auditor or an
enterprise/RIA security reviewer asks for, plus the scope for a first penetration test.

It complements — and does not replace — the customer-facing security docs:
`docs/13-security-summary.md` (one-pager), `docs/16-vendor-security-dd.md`
(vendor-DD questionnaire), and `docs/42-lwg-vendor-dd-response.md` (a completed real
packet). Those are the *sales-facing* view; this pack is the *auditor-facing* view.

> **Scope:** SOC 2 — **Security** (Common Criteria), **Availability**, and
> **Confidentiality**. Processing Integrity and Privacy are not in the initial report.
> **Owner/approver:** Matthew. **Version 1.0, effective 2026-07-23.**

## Start here

| Read this | For |
| --- | --- |
| [00-soc2-readiness-assessment.md](./00-soc2-readiness-assessment.md) | **The gap analysis.** Where we stand vs. the Trust Services Criteria, what's implemented vs. a gap, and the prioritized remediation roadmap to Type I → Type II. |
| [01-trust-services-criteria-matrix.md](./01-trust-services-criteria-matrix.md) | **The control matrix.** Every in-scope criterion → control → policy → evidence, with status. |
| [02-codebase-security-scan.md](./02-codebase-security-scan.md) | **The technical scan.** Source-review + automated findings (result: no high/critical, 0 dependency vulns) and hardening recommendations. |

## Policies (`policies/`)

The adopted information-security policy set. `00` is the master; the rest carry the
detail for each domain and each names the SOC 2 criteria it supports.

| # | Policy |
| --- | --- |
| 00 | [Information Security Policy (master)](./policies/00-information-security-policy.md) |
| 01 | [Access Control Policy](./policies/01-access-control-policy.md) |
| 02 | [Change Management Policy](./policies/02-change-management-policy.md) |
| 03 | [Secure Development Policy](./policies/03-secure-development-policy.md) |
| 04 | [Incident Response Plan](./policies/04-incident-response-plan.md) |
| 05 | [Business Continuity & Disaster Recovery Plan](./policies/05-business-continuity-dr-plan.md) |
| 06 | [Vendor / Sub-processor Risk Management Policy](./policies/06-vendor-risk-management-policy.md) |
| 07 | [Risk Assessment Policy](./policies/07-risk-assessment-policy.md) |
| 08 | [Data Classification & Handling Policy](./policies/08-data-classification-handling-policy.md) |
| 09 | [Data Retention & Disposal Policy](./policies/09-data-retention-disposal-policy.md) |
| 11 | [Logging & Monitoring Policy](./policies/11-logging-monitoring-policy.md) |
| 12 | [Backup Policy](./policies/12-backup-policy.md) |
| 13 | [Acceptable Use Policy](./policies/13-acceptable-use-policy.md) |
| 14 | [Human Resources Security Policy](./policies/14-human-resources-security-policy.md) |
| 15 | [Vulnerability Management Policy](./policies/15-vulnerability-management-policy.md) |

_(Policy number 10 is intentionally unused; the numbering follows the domain map in the
master policy, not a strict sequence.)_

## Evidence (`evidence/`)

| File | What it is |
| --- | --- |
| [control-evidence-index.md](./evidence/control-evidence-index.md) | The "show me" table — each control → the file/test/config/record that evidences it. |
| [risk-register.csv](./evidence/risk-register.csv) | The risk register (likelihood × impact, controls, treatment, residual, owner, review date). |

## Penetration test (`pentest/`)

| File | What it is |
| --- | --- |
| [00-pentest-scope-and-roe.md](./pentest/00-pentest-scope-and-roe.md) | Scope, targets, rules of engagement, methodology, deliverables — the doc you hand a testing firm. |
| [01-pentest-readiness-checklist.md](./pentest/01-pentest-readiness-checklist.md) | The pre-flight checklist to complete before testing begins. |

## How to use this pack

1. **For a SOC 2 auditor / readiness partner:** start with the readiness assessment
   and the TSC matrix; the evidence index resolves every "show me."
2. **For an enterprise/RIA vendor review:** the readiness assessment's executive
   summary + `docs/16` answer most questionnaires; share the pen-test attestation once
   the test is done.
3. **To drive it to done:** work the readiness assessment's §3 roadmap top-down. Tier 1
   gets to Type I; Tier 2 cadences produce the dated records Type II tests over the
   observation window.

## Honesty contract

Every document here uses **✅ Implemented · 📄 Documented · 🟡 Planned** and never
dresses a plan as a shipped control — the same discipline as `docs/16` and CLAUDE.md.
An honest 🟡 with a remediation is worth more than an over-claim that fails a walkthrough.

## Maintenance

- Review the whole pack at least **annually** and on material change (new external
  route, new sub-processor, team change, architecture change). Record reviews in
  `docs/06-decisions.md`.
- Keep the sub-processor set in sync across `seed/subprocessors.csv`, `docs/13`,
  `docs/16`, and policy 06.
- `_facts-brief.md` is an internal authoring aid (keeps every doc citing the same true
  facts), not an audit artifact.
