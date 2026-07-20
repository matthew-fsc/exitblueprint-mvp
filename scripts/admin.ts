// Provisioning CLI. Firm/advisor/owner provisioning is CLI-driven
// (docs/08-operations.md). Connects with DATABASE_URL — the server-side/service
// connection string, never shipped to the client bundle.
//
// Usage:
//   npm run admin -- create-firm --name "Summit Exit Advisors"
//   npm run admin -- create-advisor --firm "Summit Exit Advisors" --email jo@summit.com [--role advisor|reviewer|admin] [--name "Jo Advisor"]
//   npm run admin -- assign-company --email owner@client.com --company "Client Co"
//   npm run admin -- create-agreement-version --firm "Summit Exit Advisors" [--label EA-1.0] [--title "..."] [--body "..."]
//
// Identity provisioning is config-gated, mirroring the app (docs/30):
//   - CLERK (CLERK_SECRET_KEY set) — the production standard: create-firm creates
//     the firm's Clerk **Organization** and stores firms.clerk_org_id;
//     create-advisor creates/finds the Clerk **user**, adds the org membership,
//     and writes the profile keyed to the Clerk user id. No auth.users row —
//     identity lives in Clerk. The advisor then signs in through Clerk (email
//     code / password reset per your instance's enabled strategies).
//   - DEV (no CLERK_SECRET_KEY) — local/CI: create the auth.users row + profile,
//     as before, so the dev emulator (password 'demo') can log the user in.
import pg from 'pg';
import {
  DEFAULT_AGREEMENT_BODY,
  DEFAULT_AGREEMENT_LABEL,
  DEFAULT_AGREEMENT_TITLE,
} from './agreement-template';
import { ensureDefaultAgreementVersion } from '../server/agreements';
import {
  addMembership,
  clerkEnabled,
  createOrganization,
  findOrCreateUser,
  orgRoleForAppRole,
  type AppRole,
} from '../server/clerk';

const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) {
      throw new Error(`malformed flag near '${rest[i]}'`);
    }
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

function required(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

interface Firm {
  id: string;
  name: string;
  clerk_org_id: string | null;
}

async function findFirm(db: pg.ClientBase, nameOrId: string): Promise<Firm> {
  const res = await db.query(`select id, name, clerk_org_id from firms where name = $1 or id::text = $1`, [nameOrId]);
  if (res.rowCount === 0) throw new Error(`firm '${nameOrId}' not found`);
  return res.rows[0];
}

// Create the firm and, under Clerk, its backing Organization (firms.clerk_org_id).
// Idempotent: re-running backfills a missing org onto an existing firm and never
// creates a second one.
async function createFirm(db: pg.ClientBase, flags: Record<string, string>) {
  const name = required(flags, 'name');
  const existing = (
    await db.query(`select id, clerk_org_id from firms where name = $1`, [name])
  ).rows[0] as { id: string; clerk_org_id: string | null } | undefined;

  if (!clerkEnabled()) {
    if (existing) {
      console.log(`firm '${name}' already exists: ${existing.id}`);
      await ensureDefaultAgreementVersion(db, existing.id);
      return;
    }
    const res = await db.query(`insert into firms (name) values ($1) returning id`, [name]);
    console.log(`created firm '${name}': ${res.rows[0].id}`);
    await ensureDefaultAgreementVersion(db, res.rows[0].id);
    return;
  }

  // Clerk mode: ensure the firm exists and carries a Clerk Organization id.
  if (existing?.clerk_org_id) {
    console.log(`firm '${name}' already provisioned: ${existing.id} (Clerk org ${existing.clerk_org_id})`);
    await ensureDefaultAgreementVersion(db, existing.id);
    return;
  }
  const org = await createOrganization(name);
  let firmId: string;
  if (existing) {
    await db.query(`update firms set clerk_org_id = $2 where id = $1`, [existing.id, org.id]);
    firmId = existing.id;
    console.log(`backfilled Clerk org for firm '${name}': ${existing.id} (Clerk org ${org.id})`);
  } else {
    const res = await db.query(`insert into firms (name, clerk_org_id) values ($1, $2) returning id`, [name, org.id]);
    firmId = res.rows[0].id;
    console.log(`created firm '${name}': ${res.rows[0].id} (Clerk org ${org.id})`);
  }
  // Seed the default engagement agreement so the firm can start onboarding
  // immediately (matches the Clerk webhook's provisioning path).
  await ensureDefaultAgreementVersion(db, firmId);
}

async function createAdvisor(db: pg.ClientBase, flags: Record<string, string>) {
  const email = required(flags, 'email');
  const role = flags.role ?? 'advisor';
  if (!['advisor', 'admin', 'owner', 'reviewer'].includes(role)) throw new Error(`unknown role '${role}'`);
  const firm = await findFirm(db, required(flags, 'firm'));

  const userId = clerkEnabled()
    ? await provisionClerkAdvisor(firm, email, role as AppRole, flags.name ?? null)
    : await provisionDevAdvisor(db, email);

  const profile = await db.query(
    `insert into profiles (user_id, firm_id, role, email, full_name)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set firm_id = excluded.firm_id, role = excluded.role,
           email = excluded.email, full_name = coalesce(excluded.full_name, profiles.full_name)
     returning id, (xmax = 0) as inserted`,
    [userId, firm.id, role, email, flags.name ?? null],
  );
  console.log(
    `${profile.rows[0].inserted ? 'created' : 'updated'} ${role} '${email}' in firm '${firm.name}' (profile ${profile.rows[0].id})`,
  );
  if (clerkEnabled()) {
    console.log(`note: advisor signs in through Clerk (email code / password reset) — no dev password`);
  } else {
    console.log(`note: dev auth user created — log in with password 'demo' on the dev emulator`);
  }
}

// Clerk mode: create/find the Clerk user, add the org membership, and return the
// Clerk user id to key the profile on. The firm must already have a Clerk org.
async function provisionClerkAdvisor(
  firm: Firm,
  email: string,
  role: AppRole,
  fullName: string | null,
): Promise<string> {
  if (!firm.clerk_org_id) {
    throw new Error(`firm '${firm.name}' has no Clerk organization yet — run 'create-firm --name "${firm.name}"' first`);
  }
  const { id: userId, created } = await findOrCreateUser(email, fullName);
  await addMembership(firm.clerk_org_id, userId, orgRoleForAppRole(role));
  console.log(`${created ? 'created' : 'reused'} Clerk user ${userId}, added to org ${firm.clerk_org_id} as ${orgRoleForAppRole(role)}`);
  return userId;
}

// Dev mode: create/find the auth.users row (local emulator identity) and return
// its uuid to key the profile on.
async function provisionDevAdvisor(db: pg.ClientBase, email: string): Promise<string> {
  const existingUser = await db.query(`select id from auth.users where email = $1`, [email]);
  if (existingUser.rowCount) return existingUser.rows[0].id;
  return (
    await db.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email])
  ).rows[0].id;
}

async function assignCompany(db: pg.ClientBase, flags: Record<string, string>) {
  const email = required(flags, 'email');
  const companyName = required(flags, 'company');
  const profile = await db.query(
    `select p.id, p.firm_id, p.role from profiles p where p.email = $1`,
    [email],
  );
  if (profile.rowCount === 0) throw new Error(`no profile with email '${email}'`);
  const company = await db.query(
    `select id, firm_id, name from companies where name = $1 or id::text = $1`,
    [companyName],
  );
  if (company.rowCount === 0) throw new Error(`company '${companyName}' not found`);
  if (company.rows[0].firm_id !== profile.rows[0].firm_id) {
    throw new Error(`company '${companyName}' belongs to a different firm than '${email}'`);
  }
  await db.query(`update profiles set company_id = $2 where id = $1`, [
    profile.rows[0].id,
    company.rows[0].id,
  ]);
  console.log(`assigned '${email}' to company '${company.rows[0].name}'`);
}

// Beta Requirement 1: a firm needs at least one active engagement-agreement
// version before advisors can start engagements. Idempotent on (firm, label).
async function createAgreementVersion(db: pg.ClientBase, flags: Record<string, string>) {
  const firm = await findFirm(db, required(flags, 'firm'));
  const label = flags.label ?? DEFAULT_AGREEMENT_LABEL;
  const title = flags.title ?? DEFAULT_AGREEMENT_TITLE;
  const body = flags.body ?? DEFAULT_AGREEMENT_BODY;
  const existing = await db.query(
    `select id from agreement_versions where firm_id = $1 and version_label = $2`,
    [firm.id, label],
  );
  if (existing.rowCount) {
    console.log(`agreement version '${label}' already exists for '${firm.name}': ${existing.rows[0].id}`);
    return;
  }
  const res = await db.query(
    `insert into agreement_versions (firm_id, version_label, title, body_md, status)
     values ($1, $2, $3, $4, 'active') returning id`,
    [firm.id, label, title, body],
  );
  console.log(`created agreement version '${label}' for firm '${firm.name}': ${res.rows[0].id}`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    switch (command) {
      case 'create-firm':
        await createFirm(db, flags);
        break;
      case 'create-advisor':
        await createAdvisor(db, flags);
        break;
      case 'assign-company':
        await assignCompany(db, flags);
        break;
      case 'create-agreement-version':
        await createAgreementVersion(db, flags);
        break;
      default:
        console.error(
          'usage: admin.ts <create-firm --name X | create-advisor --firm X --email Y [--role advisor|reviewer|admin] [--name Z] | assign-company --email Y --company X | create-agreement-version --firm X [--label EA-1.0] [--title T] [--body ...]>',
        );
        process.exit(1);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
