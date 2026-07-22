// Migration runner core, shared by two callers against ONE implementation:
//   - the CLI (scripts/migrate.ts) — `npm run db:migrate`, for local dev / CI, and
//   - the compute service (the superadmin `seed-methodology` function) — so a
//     hosted beta can bring its own schema current from inside the system,
//     without anyone running the CLI against a production connection string.
//     This mirrors why seed-methodology exists: a schema-changing methodology
//     update (e.g. the library_tasks table, docs/37) can't be seeded until its
//     migration is applied, so "Load methodology" applies pending migrations
//     first (server/seed-methodology.ts), then seeds.
//
// Operates on an EXISTING pg connection so the seed path can migrate + seed over
// the same service-role connection; the CLI wraps it with connect/end + a
// PostgREST schema-cache reload (scripts/migrate.ts). Each pending file runs in
// its own transaction (a failure rolls back that file and aborts the run).
//
// Reconcile two ledgers; never re-run an applied migration. A hosted Supabase
// project is provisioned out-of-band by the Supabase CLI (`supabase db push` /
// `supabase migration up`), which records applied migrations in
// supabase_migrations.schema_migrations keyed by the 14-digit VERSION (the
// filename's timestamp prefix) — NOT in our public.schema_migrations. If we read
// only our own ledger it looks empty on such a DB and we'd replay history from the
// first migration. That is unsafe two ways: the first CREATE collides with an
// existing object ("type firm_status already exists"), and — even if we swallowed
// that — an old migration re-run against a schema that LATER migrations have since
// evolved fails semantically (e.g. a policy comparing a column that a later
// migration retyped: "operator does not exist: text = uuid"). So the applied set
// must be determined WITHOUT executing: a file counts as applied if our ledger has
// its filename OR the CLI ledger has its version. Applied-but-unrecorded files are
// baselined (recorded in our ledger, never run); only genuinely-new files run.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// SQLSTATE classes Postgres raises when a CREATE/ALTER targets an object that
// already exists. Used only to make a collision on an untracked, already-provisioned
// database report an actionable "baseline it" error instead of a cryptic one.
const ALREADY_EXISTS_CODES = new Set<string>([
  '42P07', // duplicate_table (also view / index / sequence)
  '42710', // duplicate_object (type, constraint, trigger, policy, enum label, …)
  '42P06', // duplicate_schema
  '42723', // duplicate_function
  '42701', // duplicate_column
]);

const here = dirname(fileURLToPath(import.meta.url));

// The migration files ship in the compute image next to the code (server/Dockerfile
// copies supabase/migrations); in dev/CI they sit at the repo root. Both resolve to
// <root>/supabase/migrations relative to this module. MIGRATIONS_DIR overrides it,
// mirroring SEED_DIR for the seed files.
export function resolveMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(here, '..', 'supabase', 'migrations');
}

// The Supabase-role/auth-schema shim, applied only on plain Postgres (local/CI)
// where the `auth` schema and Supabase roles don't exist. On a real Supabase
// database `auth` is present, so this is skipped and the file need not be shipped.
function resolveShimPath(): string {
  return join(here, '..', 'db', 'supabase-shim.sql');
}

// A migration file's 14-digit timestamp prefix — the "version" the Supabase CLI
// records. All migrations are named YYYYMMDDHHMMSS_name.sql.
function versionOf(file: string): string | null {
  return file.match(/^(\d{14})/)?.[1] ?? null;
}

// Read the Supabase CLI's migration ledger (versions) if this DB was provisioned
// by it. Absent on plain Postgres and fresh databases → empty set.
async function cliAppliedVersions(db: pg.ClientBase): Promise<Set<string>> {
  const versions = new Set<string>();
  const ledgerExists = await db.query(
    `select 1 from information_schema.tables
       where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`,
  );
  if (ledgerExists.rowCount) {
    const rows = (await db.query('select version from supabase_migrations.schema_migrations')).rows;
    for (const r of rows) versions.add(String(r.version));
  }
  return versions;
}

// Apply every pending migration in filename order over `db`. Returns the list of
// filenames applied this run (empty when the schema is already current). Does NOT
// signal a PostgREST schema-cache reload — the caller owns that (the CLI notifies
// after the run; the seed path notifies after it seeds).
export async function applyMigrations(
  db: pg.ClientBase,
  opts: { migrationsDir?: string } = {},
): Promise<string[]> {
  const migrationsDir = opts.migrationsDir ?? resolveMigrationsDir();
  const applied: string[] = [];

  const authExists = await db.query("select 1 from pg_namespace where nspname = 'auth'");
  if (authExists.rowCount === 0) {
    const shimPath = resolveShimPath();
    if (existsSync(shimPath)) {
      await db.query(readFileSync(shimPath, 'utf8'));
      applied.push('supabase-shim (plain Postgres detected)');
    }
  }

  await db.query(`
    create table if not exists public.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);

  const doneFiles = new Set<string>(
    (await db.query('select version from public.schema_migrations')).rows.map((r) => r.version as string),
  );
  const doneVersions = await cliAppliedVersions(db);

  const baselined: string[] = [];
  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];
  for (const file of files) {
    if (doneFiles.has(file)) continue;

    // Applied out-of-band (Supabase CLI) but not yet in our ledger: record it so the
    // two ledgers converge, then skip — re-running it would collide or, against the
    // now-evolved schema, fail semantically. (A shared 14-digit prefix means both
    // files with that version are treated as applied; timestamps are meant to be
    // unique, and where they aren't the CLI itself can't distinguish them either.)
    const version = versionOf(file);
    if (version && doneVersions.has(version)) {
      await db.query(
        'insert into public.schema_migrations (version) values ($1) on conflict do nothing',
        [file],
      );
      baselined.push(file);
      continue;
    }

    await db.query('begin');
    try {
      await db.query(readFileSync(join(migrationsDir, file), 'utf8'));
      await db.query('insert into public.schema_migrations (version) values ($1)', [file]);
      await db.query('commit');
      applied.push(file);
    } catch (err) {
      await db.query('rollback').catch(() => {});
      // An "already exists" collision here means the DB was provisioned out-of-band
      // with NEITHER ledger tracking it (e.g. the dashboard SQL editor), so we can't
      // safely tell applied from pending. Re-running is unsafe; make the fix actionable
      // instead of surfacing a cryptic first-collision.
      if (ALREADY_EXISTS_CODES.has((err as { code?: string }).code ?? '')) {
        throw new Error(
          `Migration ${file} failed: ${(err as Error).message}. This database appears already ` +
            `provisioned but has no migration ledger (public.schema_migrations is empty and no ` +
            `supabase_migrations.schema_migrations was found), so applied migrations can't be told ` +
            `from pending ones. Baseline it once — record the already-applied versions in ` +
            `supabase_migrations.schema_migrations (or public.schema_migrations) — then retry.`,
        );
      }
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }

  if (baselined.length > 0) {
    // One-time convergence on a CLI-provisioned DB our ledger hadn't tracked —
    // visible in server logs.
    console.log(`migrate: baselined ${baselined.length} pre-existing migration(s) from the Supabase ledger`);
  }

  return applied;
}
