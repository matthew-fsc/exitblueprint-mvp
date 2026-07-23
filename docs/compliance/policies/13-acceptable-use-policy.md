# Acceptable Use Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually / on material change · **Applies to:** all Exit Blueprint personnel and systems.

## Purpose

Set the rules for how Exit Blueprint personnel use company systems, accounts, and
the devices they work on — so that individual behavior does not undermine the
technical controls that protect client data. Right-sized for a small, fully
remote, cloud-native team with no offices, corporate LAN, or on-prem servers.

## Scope

All Exit Blueprint personnel (employees and contractors) and every system,
account, and device used to access company resources or client data — including
personal or managed workstations used for company work (BYOD). Managed-provider
infrastructure is out of scope for personal-conduct rules and is governed by the
provider and by other policies in this pack.

## Policy statements

1. **Use accounts only for their purpose.** Company systems and accounts are used
   for company work. Access is limited to what your role requires (see the Access
   Control Policy); do not use access to view client data you have no business
   reason to see.
2. **Workstation security.** Any device used for company work must have
   **full-disk encryption** enabled, an **automatic screen lock** with password/
   biometric unlock, and a **current, patched operating system**. Keep the OS and
   browser up to date.
3. **MFA on all business accounts.** Multi-factor authentication must be enabled
   on every business account that supports it — Clerk, GitHub, the managed
   provider consoles (Supabase, Render, Vercel, Stripe), email, and the password
   manager.
4. **Use a password manager; use strong unique credentials.** Passwords are
   generated and stored in an approved password manager. No password reuse across
   business accounts. Do not share credentials.
5. **No secrets in code or chat.** API keys, tokens, `DATABASE_URL`, signing/
   document keys, and other secrets are never committed to source, pasted into
   chat or tickets, or stored outside the managed secret stores. `.env` files stay
   git-ignored.
6. **Protect client data.** Do not copy client data onto local disks, personal
   cloud storage, or unmanaged tools beyond what the application and approved
   sub-processors require. Client data stays in the platform.
7. **Prohibited activities.** No sharing of credentials; no disabling of security
   controls (disk encryption, screen lock, MFA); no installing unvetted software
   that touches company data; no using company access for personal gain or to
   circumvent tenant isolation; no unlawful use.
8. **BYOD stance.** A small remote team may use personal or self-managed devices
   for work provided they meet the workstation-security bar in #2 and the account
   rules above. There is no corporate device fleet or MDM to inherit these from;
   compliance is the individual's responsibility until formal device management is
   introduced.
9. **Report concerns.** Report a lost/stolen device, a suspected credential
   compromise, a leaked secret, or any suspected security issue to the security
   officer without delay.

## Roles & responsibilities

- **Security officer (Matthew):** owns this policy, sets the workstation-security
  bar, receives and acts on reports, approves any exception.
- **All personnel:** keep their devices and accounts compliant, follow the rules
  above, and report concerns promptly.

## Implementation / evidence

- ✅ **MFA available and enforced for privileged app access** — Clerk TOTP MFA
  required for advisor/admin accounts (see
  `docs/compliance/policies/01-access-control-policy.md`).
- ✅ **Secrets kept out of source; hard-fail without them** — secrets via managed
  stores, `.env` git-ignored; production hard-fails at startup if
  `EB_DOCUMENT_KEY`/`EB_SIGNING_KEY` are missing (`server/http.ts`).
- ✅ **No secrets/PII in logs** — scrubbed at the logging seam
  (`server/observability.ts`); see the Logging & Monitoring Policy.
- 📄 **Workstation security, password-manager, BYOD, and reporting requirements**
  — established by this policy; followed by personnel as a procedure (there is no
  MDM enforcing them today).
- 🟡 **Formal security-awareness training program** — planned (facts-brief gap
  #10). 🟡 **Background-check policy** for personnel — planned before first
  enterprise engagement (facts-brief gap #4).

## Exceptions

Any exception (for example, a temporary device that cannot meet a requirement)
requires written security-officer approval, is time-boxed, and is recorded.
Repeated non-compliance is not an exception.

## Review & enforcement

Reviewed at least annually and on material change to the team, device model, or
tooling. Violations are addressed by the security officer and may result in
revoked access. Because most controls here are behavioral rather than technically
enforced on personal devices, honest self-compliance and prompt reporting are the
core of enforcement until formal device management is introduced.

## SOC 2 mapping

Supports Common Criteria **CC1.1** (integrity and ethical values / conduct
expectations for personnel) and **CC6.7** (restricting the transmission,
movement, and protection of information on endpoints). Cross-references:
`docs/compliance/policies/01-access-control-policy.md`,
`docs/compliance/policies/11-logging-monitoring-policy.md`,
`docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`.
