// Platform superadmin — the authorization tier ABOVE firm admin. Firm `admin`
// (profiles.role) is firm-staff: RLS scopes it to its own firm (docs/31, #65).
// But methodology (rubric_versions, dimensions, valuation rules, …) is GLOBAL —
// it has no firm_id and is shared by every tenant — so publishing it must never
// be reachable through a firm-scoped role, or one firm could change scoring for
// all of them. That governance sits outside the tenant RLS model entirely.
//
// For a small, fixed set of platform operators, an env allowlist of Clerk user
// ids is the least-invasive, most auditable gate: no schema, no new role in the
// tenant model, default-deny, and reversible by editing one env var. The
// compute service checks the authenticated caller's `sub` against it (the
// `platform-admin` auth scope in server/functions.ts). Set it on the compute
// service (server/http.ts), NOT in the browser — it is never exposed client-side.
//
//   PLATFORM_SUPERADMIN_IDS=user_3Gm9…,user_abc…   (comma-separated Clerk ids)
//
// Unset → nobody is a superadmin (the methodology endpoints reply 403 with a
// message telling the operator to set it).
export function platformSuperadminIds(): Set<string> {
  return new Set(
    (process.env.PLATFORM_SUPERADMIN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isPlatformSuperadmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return platformSuperadminIds().has(userId);
}
