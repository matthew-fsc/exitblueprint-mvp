// Applies supabase/migrations/*.sql in filename order against DATABASE_URL.
// On plain Postgres (no Supabase stack) it first applies db/supabase-shim.sql
// so migrations that depend on the auth schema and Supabase roles still run.
// On a real Supabase database the shim is skipped.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase', 'migrations');

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    const authExists = await client.query(
      "select 1 from pg_namespace where nspname = 'auth'",
    );
    if (authExists.rowCount === 0) {
      await client.query(readFileSync(join(root, 'db', 'supabase-shim.sql'), 'utf8'));
      applied.push('supabase-shim (plain Postgres detected)');
    }

    await client.query(`
      create table if not exists public.schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )`);

    const files = existsSync(migrationsDir)
      ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
      : [];
    for (const file of files) {
      const done = await client.query(
        'select 1 from public.schema_migrations where version = $1',
        [file],
      );
      if (done.rowCount) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
        await client.query('insert into public.schema_migrations (version) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  migrate(url)
    .then((applied) => {
      if (applied.length === 0) console.log('migrate: nothing to apply');
      for (const a of applied) console.log(`migrate: applied ${a}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
