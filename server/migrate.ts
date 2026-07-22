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
// PostgREST schema-cache reload (scripts/migrate.ts). Idempotent: every file is
// tracked in public.schema_migrations and applied at most once, so re-running is
// a no-op. Each file runs in its own transaction (a failure rolls back that file
// and aborts the run).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

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

  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];
  for (const file of files) {
    const done = await db.query('select 1 from public.schema_migrations where version = $1', [file]);
    if (done.rowCount) continue;
    await db.query('begin');
    try {
      await db.query(readFileSync(join(migrationsDir, file), 'utf8'));
      await db.query('insert into public.schema_migrations (version) values ($1)', [file]);
      await db.query('commit');
      applied.push(file);
    } catch (err) {
      await db.query('rollback').catch(() => {});
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }

  return applied;
}
