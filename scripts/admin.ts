// Provisioning CLI (S4.5 A4). Firm/advisor/owner provisioning stays CLI-only
// through MVP (docs/08-operations.md); S5 builds login and the advisor shell
// only. Connects with DATABASE_URL — the server-side/service connection
// string, never shipped to the client bundle.
//
// Usage:
//   npm run admin -- create-firm --name "Summit Exit Advisors"
//   npm run admin -- create-advisor --firm "Summit Exit Advisors" --email jo@summit.com [--role advisor|reviewer|admin] [--name "Jo Advisor"]
//   npm run admin -- assign-company --email owner@client.com --company "Client Co"
//   npm run admin -- create-agreement-version --firm "Summit Exit Advisors" [--label EA-1.0] [--title "..."] [--body "..."]
//
// Notes: create-advisor creates the auth.users row and profile. On hosted
// Supabase, login credentials are issued afterwards via the dashboard/auth
// invite (S5); this CLI provisions the records the app reads.
import pg from 'pg';
import {
  DEFAULT_AGREEMENT_BODY,
  DEFAULT_AGREEMENT_LABEL,
  DEFAULT_AGREEMENT_TITLE,
} from './agreement-template';

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

async function findFirm(db: pg.ClientBase, nameOrId: string): Promise<{ id: string; name: string }> {
  const res = await db.query(`select id, name from firms where name = $1 or id::text = $1`, [nameOrId]);
  if (res.rowCount === 0) throw new Error(`firm '${nameOrId}' not found`);
  return res.rows[0];
}

async function createFirm(db: pg.ClientBase, flags: Record<string, string>) {
  const name = required(flags, 'name');
  const existing = await db.query(`select id from firms where name = $1`, [name]);
  if (existing.rowCount) {
    console.log(`firm '${name}' already exists: ${existing.rows[0].id}`);
    return;
  }
  const res = await db.query(`insert into firms (name) values ($1) returning id`, [name]);
  console.log(`created firm '${name}': ${res.rows[0].id}`);
}

async function createAdvisor(db: pg.ClientBase, flags: Record<string, string>) {
  const email = required(flags, 'email');
  const role = flags.role ?? 'advisor';
  if (!['advisor', 'admin', 'owner', 'reviewer'].includes(role)) throw new Error(`unknown role '${role}'`);
  const firm = await findFirm(db, required(flags, 'firm'));

  let userId: string;
  const existingUser = await db.query(`select id from auth.users where email = $1`, [email]);
  if (existingUser.rowCount) {
    userId = existingUser.rows[0].id;
  } else {
    userId = (
      await db.query(
        `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
        [email],
      )
    ).rows[0].id;
  }

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
  if (!existingUser.rowCount) {
    console.log(`note: auth user created without credentials — issue a login via Supabase auth invite`);
  }
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
