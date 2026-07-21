// DB-free unit test for the internal-tenant bootstrap (scripts/seed-internal-tenant.ts,
// docs/40 §4c dogfooding). No network, no CLERK_SECRET_KEY, no Postgres — runs in
// CI like tests/clerk-provision.test.ts. It locks two contracts:
//   1. Idempotency — re-running never duplicates the firm/company/engagement or
//      creates a second Clerk organization.
//   2. "Provisions like any firm; no RLS bypass" — every domain write is scoped to
//      the internal firm_id, the firm is created through the SAME shared
//      createOrganization primitive admin.ts create-firm uses, and the script
//      emits no RLS-loosening / policy-mutating SQL. It is a customer of the
//      platform, not a backdoor around tenancy (CLAUDE.md §5, docs/40 §7.2).
import { describe, expect, it } from 'vitest';
import {
  seedInternalTenant,
  INTERNAL_FIRM_NAME,
  INTERNAL_COMPANY_NAME,
  type DbLike,
  type SeedDeps,
} from '../scripts/seed-internal-tenant';
import { DEFAULT_AGREEMENT_LABEL } from '../shared/agreement-template';

// A tiny in-memory fake of the four tables the bootstrap touches. It interprets
// only the exact statements the script issues; anything else throws so a drifted
// query can't silently pass. Every statement is recorded for the isolation asserts.
class FakeDb implements DbLike {
  firms: Array<{ id: string; name: string; clerk_org_id: string | null }> = [];
  companies: Array<{ id: string; firm_id: string; name: string }> = [];
  engagements: Array<{ id: string; firm_id: string; company_id: string }> = [];
  agreementVersions: Array<{ id: string; firm_id: string; version_label: string }> = [];
  engagementAgreements: Array<{ id: string; firm_id: string; engagement_id: string }> = [];
  log: Array<{ sql: string; params: unknown[] }> = [];
  private seq = 0;
  private id(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    this.log.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    if (s.startsWith('select id, clerk_org_id from firms')) {
      const rows = this.firms
        .filter((f) => f.name === params[0])
        .map((f) => ({ id: f.id, clerk_org_id: f.clerk_org_id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('insert into firms (name) values')) {
      const f = { id: this.id('firm'), name: params[0] as string, clerk_org_id: null };
      this.firms.push(f);
      return { rows: [{ id: f.id }], rowCount: 1 };
    }
    if (s.startsWith('insert into firms (name, clerk_org_id)')) {
      const f = { id: this.id('firm'), name: params[0] as string, clerk_org_id: params[1] as string };
      this.firms.push(f);
      return { rows: [{ id: f.id }], rowCount: 1 };
    }
    if (s.startsWith('update firms set clerk_org_id')) {
      const f = this.firms.find((x) => x.id === params[0]);
      if (f) f.clerk_org_id = params[1] as string;
      return { rows: [], rowCount: f ? 1 : 0 };
    }
    if (s.startsWith('select id from companies')) {
      const rows = this.companies
        .filter((c) => c.firm_id === params[0] && c.name === params[1])
        .map((c) => ({ id: c.id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('insert into companies')) {
      const c = { id: this.id('company'), firm_id: params[0] as string, name: params[1] as string };
      this.companies.push(c);
      return { rows: [{ id: c.id }], rowCount: 1 };
    }
    if (s.startsWith('select id from engagements')) {
      const rows = this.engagements
        .filter((e) => e.firm_id === params[0] && e.company_id === params[1])
        .map((e) => ({ id: e.id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('insert into engagements')) {
      const e = { id: this.id('engagement'), firm_id: params[0] as string, company_id: params[1] as string };
      this.engagements.push(e);
      return { rows: [{ id: e.id }], rowCount: 1 };
    }
    if (s.startsWith('select id from agreement_versions')) {
      const rows = this.agreementVersions
        .filter((a) => a.firm_id === params[0] && a.version_label === params[1])
        .map((a) => ({ id: a.id }));
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('insert into engagement_agreements')) {
      // Mirrors "on conflict (engagement_id) do nothing".
      if (this.engagementAgreements.some((a) => a.engagement_id === params[1])) {
        return { rows: [], rowCount: 0 };
      }
      const a = { id: this.id('ea'), firm_id: params[0] as string, engagement_id: params[1] as string };
      this.engagementAgreements.push(a);
      return { rows: [{ id: a.id }], rowCount: 1 };
    }
    throw new Error(`FakeDb: unexpected SQL: ${s}`);
  }
}

// A stand-in for the injected provisioning primitives. createOrganization is
// counted so we can prove it fires at most once. ensureDefaultAgreementVersion
// seeds the fake's agreement_versions idempotently, exactly like the real one.
function makeDeps(opts: { clerk: boolean }): SeedDeps & { orgCalls: () => number } {
  let orgCalls = 0;
  return {
    orgCalls: () => orgCalls,
    clerkEnabled: () => opts.clerk,
    createOrganization: async (name: string) => {
      orgCalls += 1;
      return { id: `org_for_${name}_${orgCalls}` };
    },
    ensureDefaultAgreementVersion: async (db: DbLike, firmId: string) => {
      const f = db as unknown as FakeDb;
      if (!f.agreementVersions.some((a) => a.firm_id === firmId && a.version_label === DEFAULT_AGREEMENT_LABEL)) {
        f.agreementVersions.push({ id: `av_${firmId}`, firm_id: firmId, version_label: DEFAULT_AGREEMENT_LABEL });
      }
    },
  };
}

describe('seedInternalTenant — idempotency', () => {
  it('creates the full internal-tenant scaffold on the first run (Clerk mode)', async () => {
    const db = new FakeDb();
    const deps = makeDeps({ clerk: true });
    const r = await seedInternalTenant(db, deps);

    expect(r.firmCreated).toBe(true);
    expect(r.orgCreated).toBe(true);
    expect(r.companyCreated).toBe(true);
    expect(r.engagementCreated).toBe(true);
    expect(r.agreementAcceptanceCreated).toBe(true);
    expect(db.firms).toHaveLength(1);
    expect(db.firms[0].name).toBe(INTERNAL_FIRM_NAME);
    expect(db.firms[0].clerk_org_id).toBeTruthy();
    expect(db.companies).toHaveLength(1);
    expect(db.companies[0].name).toBe(INTERNAL_COMPANY_NAME);
    expect(db.engagements).toHaveLength(1);
    expect(db.engagementAgreements).toHaveLength(1);
  });

  it('is a safe no-op on re-run — no duplicate firm, company, engagement, or Clerk org', async () => {
    const db = new FakeDb();
    const deps = makeDeps({ clerk: true });

    const first = await seedInternalTenant(db, deps);
    const second = await seedInternalTenant(db, deps);

    // Second run reports everything already present.
    expect(second.firmCreated).toBe(false);
    expect(second.orgCreated).toBe(false);
    expect(second.companyCreated).toBe(false);
    expect(second.engagementCreated).toBe(false);
    expect(second.agreementAcceptanceCreated).toBe(false);

    // And the store is unchanged — exactly one of each.
    expect(db.firms).toHaveLength(1);
    expect(db.companies).toHaveLength(1);
    expect(db.engagements).toHaveLength(1);
    expect(db.engagementAgreements).toHaveLength(1);
    expect(second.firmId).toBe(first.firmId);
    expect(second.companyId).toBe(first.companyId);
    expect(second.engagementId).toBe(first.engagementId);

    // The Clerk organization is created once, never on the idempotent re-run.
    expect(deps.orgCalls()).toBe(1);
  });

  it('degrades to the dev provisioning path when Clerk is not configured', async () => {
    const db = new FakeDb();
    const deps = makeDeps({ clerk: false });

    const r = await seedInternalTenant(db, deps);
    expect(r.firmCreated).toBe(true);
    expect(r.orgCreated).toBe(false);
    expect(deps.orgCalls()).toBe(0); // no Clerk org in dev mode
    expect(db.firms[0].clerk_org_id).toBeNull();

    // Firm was inserted via the dev-path statement (firms(name)), like admin.ts.
    expect(db.log.some((e) => /insert into firms \(name\) values/i.test(e.sql))).toBe(true);
  });
});

describe('seedInternalTenant — isolation contract (customer, not backdoor)', () => {
  it('scopes every domain write to the internal firm_id (provisions like any firm)', async () => {
    const db = new FakeDb();
    const r = await seedInternalTenant(db, makeDeps({ clerk: true }));

    // Every company / engagement / engagement_agreement row belongs to the
    // internal firm — no orphaned or cross-firm rows.
    for (const c of db.companies) expect(c.firm_id).toBe(r.firmId);
    for (const e of db.engagements) expect(e.firm_id).toBe(r.firmId);
    for (const a of db.engagementAgreements) expect(a.firm_id).toBe(r.firmId);

    // And the writes carry firm_id as their leading bound parameter (firm-scoped
    // inserts, never a firm-blind write).
    const domainInserts = db.log.filter((e) =>
      /^\s*insert into (companies|engagements|engagement_agreements)/i.test(e.sql),
    );
    expect(domainInserts.length).toBeGreaterThan(0);
    for (const e of domainInserts) expect(e.params[0]).toBe(r.firmId);
  });

  it('creates the firm through the shared createOrganization primitive (same path as create-firm)', async () => {
    const db = new FakeDb();
    const deps = makeDeps({ clerk: true });
    await seedInternalTenant(db, deps);

    // Clerk-org creation is delegated to the injected primitive (server/clerk),
    // not reinvented, and the firm row stores the returned org id.
    expect(deps.orgCalls()).toBe(1);
    expect(db.firms[0].clerk_org_id).toBe(`org_for_${INTERNAL_FIRM_NAME}_1`);
  });

  it('never loosens a tenant policy — emits no RLS-bypass or policy-mutating SQL', async () => {
    const db = new FakeDb();
    await seedInternalTenant(db, makeDeps({ clerk: true }));
    await seedInternalTenant(db, makeDeps({ clerk: false }));

    const banned =
      /(disable row level security|enable row level security|drop policy|alter policy|create policy|bypassrls|set row_security|set role|reset role|security definer|to service_role|force row level security)/i;
    for (const entry of db.log) {
      expect(entry.sql).not.toMatch(banned);
    }
  });

  it('touches only the firm-scoped provisioning tables (no schema or global-methodology writes)', async () => {
    const db = new FakeDb();
    await seedInternalTenant(db, makeDeps({ clerk: true }));

    const verb = /^\s*(select|insert into|update)\b/i;
    const allowedTable = /\b(firms|companies|engagements|agreement_versions|engagement_agreements)\b/i;
    const foreignTable =
      /\b(rubric_versions|dimensions|questions|sub_scores|assessments|profiles|auth\.users|firm_branding|deal_outcomes)\b/i;
    for (const entry of db.log) {
      expect(entry.sql).toMatch(verb); // only reads/writes, never DDL verbs
      expect(entry.sql).toMatch(allowedTable); // targets a firm-scoped provisioning table
      expect(entry.sql).not.toMatch(foreignTable); // never global methodology / another firm's data
    }
    // No DDL — the script must not alter schema.
    for (const entry of db.log) {
      expect(entry.sql).not.toMatch(/^\s*(create|alter|drop) (table|schema|type|extension)/i);
    }
  });
});
