// Migration-file hygiene. These are pure (no DB): they read the migration
// filenames and hold the naming invariant that makes the two migration ledgers
// reconcilable (server/migrate.ts).
//
// Why this matters — and why it lives in CI. A hosted Supabase project is
// provisioned by the Supabase CLI (`supabase db push`), which keys applied
// migrations on the 14-digit VERSION (the filename's timestamp prefix), NOT on
// the full filename our own ledger uses. So two files that share a version are
// indistinguishable to `db push`: it registers the version for the first-sorting
// file and SILENTLY SKIPS the rest. That already bit us once — the pair
// 20260721000600_firm_service_tier / 20260721000600_owner_cim_visibility
// collided across parallel branches, and owner_cim_visibility was skipped on
// every db-push database, leaving the owner_cim_read policy uncreated until it
// was recreated forward under a unique version (20260722210000; see
// docs/06-decisions.md 2026-07-22). CLAUDE.md's rule — "Never hand-allocate a
// sequential number — it races across branches; use a full UTC timestamp taken
// at creation" — exists precisely to prevent this. Verify it, don't trust it:
// this test fails the moment a NEW collision lands, so the next one can't slip
// through silently and surface only as a missing object on a live Supabase host.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveMigrationsDir } from '../server/migrate';

// The one accepted historical collision. Both files are already applied on live
// databases, and renaming applied migration history is riskier than the forward
// repair that already neutralized it (owner_cim_read recreated in 20260722210000;
// firm_service_tier later dropped in 20260722000500). Documented in
// docs/06-decisions.md (2026-07-22 x2, 2026-07-23). This set grandfathers that
// single case so the guard protects against the NEXT collision without demanding
// a rewrite of applied history. Do not add to it — a new duplicate version is a
// bug to fix by renaming the not-yet-applied file, not to whitelist here.
const GRANDFATHERED_DUPLICATE_VERSIONS = new Set(['20260721000600']);

describe('migration files', () => {
  const files = readdirSync(resolveMigrationsDir())
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('there are migrations to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every migration filename starts with a 14-digit YYYYMMDDHHMMSS version', () => {
    // versionOf() in server/migrate.ts extracts exactly this prefix; a file that
    // doesn't match gets version null and is never reconcilable against the
    // Supabase CLI ledger, so it could re-run against an evolved schema.
    for (const file of files) {
      expect(file, `${file} must begin with a 14-digit timestamp`).toMatch(/^\d{14}_.+\.sql$/);
    }
  });

  it('no two migrations share a 14-digit version (except the documented historical collision)', () => {
    const byVersion = new Map<string, string[]>();
    for (const file of files) {
      const version = file.slice(0, 14);
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }

    const collisions = [...byVersion.entries()]
      .filter(([version, group]) => group.length > 1 && !GRANDFATHERED_DUPLICATE_VERSIONS.has(version))
      .map(([version, group]) => `${version}: ${group.join(', ')}`);

    expect(
      collisions,
      `Duplicate migration version(s) — 'supabase db push' keys on the 14-digit prefix and would ` +
        `silently skip all but the first-sorting file. Rename the not-yet-applied file to a unique ` +
        `full UTC timestamp (CLAUDE.md), do not hand-pick a sequential number:\n${collisions.join('\n')}`,
    ).toEqual([]);
  });
});
