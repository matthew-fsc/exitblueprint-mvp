// Internal-tenant bootstrap — provisions "ExitBlueprint" as its own first tenant
// (docs/40 §4c "Dogfooding — ExitBlueprint as its own first tenant").
//
// The dogfooding discipline: we are a lower-middle-market business that will one
// day raise or exit, so we hold ourselves to our own readiness rigor by running
// our own company through the platform — our own DRS trajectory, our own evidence
// binder, our own named gaps. This script stands up that internal tenant and a
// starter engagement scaffold representing the company running itself through the
// readiness lens.
//
// ISOLATION GUARANTEE (CLAUDE.md §5, docs/40 §4c & §7.2): the internal tenant is a
// *customer of the platform, not a backdoor around it.* It is provisioned by
// exactly the same primitives as any firm — server/clerk.createOrganization + a
// firms insert + server/agreements.ensureDefaultAgreementVersion, i.e. the same
// code paths `scripts/admin.ts create-firm` uses — every domain row it writes
// carries the internal firm_id, and it lives under normal firm RLS. It NEVER
// loosens a tenant policy, disables RLS, drops/alters a policy, or reads across
// firms. Operator access to the platform stays on the separate, orthogonal
// PLATFORM_SUPERADMIN_IDS gate (server/platform-admin.ts); this script grants no
// superadmin and no special role — the internal firm's advisors are ordinary
// firm-scoped users like any other tenant's.
//
// Idempotent: safe to run repeatedly. The firm, company, and engagement are each
// looked up before insert, so re-running never creates a duplicate. If Clerk is
// not configured (local/CI, no CLERK_SECRET_KEY) it degrades to the dev path
// exactly like admin.ts create-firm does.
//
// Usage: DATABASE_URL=... npm run seed:internal
import pg from 'pg';
import { DEFAULT_AGREEMENT_LABEL } from '../shared/agreement-template';
import {
  clerkEnabled as realClerkEnabled,
  createOrganization as realCreateOrganization,
} from '../server/clerk';
import { ensureDefaultAgreementVersion as realEnsureDefaultAgreementVersion } from '../server/agreements';
import { platformSuperadminIds } from '../server/platform-admin';

// The internal tenant's identity. Kept as constants (not flags) because there is
// exactly one internal tenant; re-running looks these up rather than duplicating.
export const INTERNAL_FIRM_NAME = 'ExitBlueprint';
export const INTERNAL_COMPANY_NAME = 'ExitBlueprint';
export const INTERNAL_SIGNER_NAME = 'ExitBlueprint (self)';

// Minimal structural DB surface so the bootstrap logic is DB-free testable. A real
// pg.Client / pg.PoolClient satisfies this. No connection or RLS concept leaks in
// here — the caller owns the (service-role, same-as-admin.ts) connection.
export interface DbLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

// The provisioning primitives, injected so the unit test can substitute fakes and
// so this file NEVER reinvents firm provisioning — it calls the same exported
// functions admin.ts create-firm uses. Defaults wire the real implementations.
export interface SeedDeps {
  clerkEnabled: () => boolean;
  createOrganization: (name: string) => Promise<{ id: string }>;
  ensureDefaultAgreementVersion: (db: DbLike, firmId: string) => Promise<void>;
}

export function defaultDeps(): SeedDeps {
  return {
    clerkEnabled: realClerkEnabled,
    createOrganization: (name) => realCreateOrganization(name),
    ensureDefaultAgreementVersion: (db, firmId) =>
      realEnsureDefaultAgreementVersion(db as unknown as pg.ClientBase, firmId),
  };
}

export interface SeedResult {
  firmId: string;
  companyId: string;
  engagementId: string;
  firmCreated: boolean;
  orgCreated: boolean;
  companyCreated: boolean;
  engagementCreated: boolean;
  agreementAcceptanceCreated: boolean;
}

// Ensure the internal firm exists and (under Clerk) carries a Clerk Organization
// id. This mirrors admin.ts createFirm exactly: dev path inserts firms(name);
// Clerk path creates the Organization and stores clerk_org_id, backfilling a
// pre-existing firm rather than ever creating a second one.
async function ensureInternalFirm(
  db: DbLike,
  deps: SeedDeps,
): Promise<{ firmId: string; firmCreated: boolean; orgCreated: boolean }> {
  const existing = (
    await db.query(
      `select id, clerk_org_id from firms where name = $1 order by created_at limit 1`,
      [INTERNAL_FIRM_NAME],
    )
  ).rows[0] as { id: string; clerk_org_id: string | null } | undefined;

  if (!deps.clerkEnabled()) {
    if (existing) return { firmId: existing.id, firmCreated: false, orgCreated: false };
    const firmId = (
      await db.query(`insert into firms (name) values ($1) returning id`, [INTERNAL_FIRM_NAME])
    ).rows[0].id as string;
    return { firmId, firmCreated: true, orgCreated: false };
  }

  // Clerk mode: firm must carry a Clerk org. Already provisioned → no-op.
  if (existing?.clerk_org_id) {
    return { firmId: existing.id, firmCreated: false, orgCreated: false };
  }
  const org = await deps.createOrganization(INTERNAL_FIRM_NAME);
  if (existing) {
    await db.query(`update firms set clerk_org_id = $2 where id = $1`, [existing.id, org.id]);
    return { firmId: existing.id, firmCreated: false, orgCreated: true };
  }
  const firmId = (
    await db.query(`insert into firms (name, clerk_org_id) values ($1, $2) returning id`, [
      INTERNAL_FIRM_NAME,
      org.id,
    ])
  ).rows[0].id as string;
  return { firmId, firmCreated: true, orgCreated: true };
}

// Provision the internal tenant. Every write below is firm_id-scoped and looked
// up before insert (idempotent), so this is safe to run repeatedly and never
// touches another firm's rows. See the isolation guarantee in the header comment.
export async function seedInternalTenant(
  db: DbLike,
  deps: SeedDeps = defaultDeps(),
): Promise<SeedResult> {
  // 1. Firm — same provisioning path as any firm (admin.ts create-firm).
  const { firmId, firmCreated, orgCreated } = await ensureInternalFirm(db, deps);

  // 2. Default engagement agreement — the same primitive create-firm seeds, so the
  //    internal firm is never born in an unreachable state.
  await deps.ensureDefaultAgreementVersion(db, firmId);

  // 3. Company — ExitBlueprint running itself through the readiness lens. firm_id
  //    scoped; looked up before insert. (firms.name is not unique, companies are
  //    firm-scoped, so we always qualify by firm_id — never a cross-firm read.)
  let companyId = (
    await db.query(`select id from companies where firm_id = $1 and name = $2`, [
      firmId,
      INTERNAL_COMPANY_NAME,
    ])
  ).rows[0]?.id as string | undefined;
  const companyCreated = companyId === undefined;
  companyId ??= (
    await db.query(
      `insert into companies (firm_id, name, industry, revenue_band, state, owner_contact_name)
       values ($1, $2, 'Exit-readiness SaaS for M&A advisors', '$1M-$5M', 'DE', $3)
       returning id`,
      [firmId, INTERNAL_COMPANY_NAME, INTERNAL_SIGNER_NAME],
    )
  ).rows[0].id as string;

  // 4. Engagement scaffold — the internal company's own readiness engagement.
  //    firm_id + company_id scoped; looked up before insert.
  let engagementId = (
    await db.query(`select id from engagements where firm_id = $1 and company_id = $2`, [
      firmId,
      companyId,
    ])
  ).rows[0]?.id as string | undefined;
  const engagementCreated = engagementId === undefined;
  engagementId ??= (
    await db.query(
      `insert into engagements (firm_id, company_id, target_exit_window)
       values ($1, $2, '24-36 months') returning id`,
      [firmId, companyId],
    )
  ).rows[0].id as string;

  // 5. Engagement-agreement acceptance (Beta R1) so the scaffold can hold
  //    assessments. References the firm's own active agreement version; firm_id
  //    scoped; on conflict (engagement_id) do nothing keeps it idempotent. We
  //    self-consent to the same data-rights terms every client engagement records.
  const agreementVersionId = (
    await db.query(`select id from agreement_versions where firm_id = $1 and version_label = $2`, [
      firmId,
      DEFAULT_AGREEMENT_LABEL,
    ])
  ).rows[0]?.id as string | undefined;
  if (!agreementVersionId) {
    throw new Error(
      `internal firm ${firmId} is missing agreement version '${DEFAULT_AGREEMENT_LABEL}' — ensureDefaultAgreementVersion should have seeded it`,
    );
  }
  const acceptance = await db.query(
    `insert into engagement_agreements
       (firm_id, engagement_id, agreement_version_id, accepted_signer_name,
        consent_benchmarking, consent_anonymized_aggregation, consent_outcome_tracking)
     values ($1, $2, $3, $4, true, true, true)
     on conflict (engagement_id) do nothing
     returning id`,
    [firmId, engagementId, agreementVersionId, INTERNAL_SIGNER_NAME],
  );
  const agreementAcceptanceCreated = (acceptance.rowCount ?? 0) > 0;

  return {
    firmId,
    companyId,
    engagementId,
    firmCreated,
    orgCreated,
    companyCreated,
    engagementCreated,
    agreementAcceptanceCreated,
  };
}

async function main() {
  const url =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    // The internal tenant is a normal firm; platform-operator access is a
    // SEPARATE gate. Surface (never grant) it so the operator wires it correctly.
    const superadmins = platformSuperadminIds();
    console.log(
      superadmins.size > 0
        ? `seed-internal: PLATFORM_SUPERADMIN_IDS configured (${superadmins.size}) — operator gate is separate from this firm`
        : `seed-internal: note — PLATFORM_SUPERADMIN_IDS is unset; the internal tenant is still just a firm (operator access is gated separately, never by this firm's roles)`,
    );

    const result = await seedInternalTenant(db as unknown as DbLike);
    console.log(
      `seed-internal: firm '${INTERNAL_FIRM_NAME}' ${result.firmCreated ? 'created' : 'present'}${
        result.orgCreated ? ' (Clerk org created)' : ''
      }: ${result.firmId}`,
    );
    console.log(
      `seed-internal: company '${INTERNAL_COMPANY_NAME}' ${
        result.companyCreated ? 'created' : 'present'
      } (${result.companyId}); engagement ${
        result.engagementCreated ? 'created' : 'present'
      } (${result.engagementId}); acceptance ${
        result.agreementAcceptanceCreated ? 'recorded' : 'present'
      }`,
    );
    console.log(
      `seed-internal: done — provision an advisor for it the normal way: ` +
        `npm run admin -- create-advisor --firm "${INTERNAL_FIRM_NAME}" --email you@exitblueprint.com --role admin`,
    );
  } finally {
    await db.end();
  }
}

// Run as a CLI only when invoked directly (tsx scripts/seed-internal-tenant.ts),
// never on import — the unit test imports seedInternalTenant without a DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
