// Applies supabase/migrations/*.sql in filename order against DATABASE_URL.
// On plain Postgres (no Supabase stack) it first applies db/supabase-shim.sql
// so migrations that depend on the auth schema and Supabase roles still run.
// On a real Supabase database the shim is skipped.
//
// The apply logic lives in server/migrate.ts (applyMigrations) so the compute
// service can run the same runner over its service-role connection — "Load
// methodology" applies pending migrations before seeding (server/seed-methodology.ts).
// This wrapper adds the CLI concerns: its own connection and the PostgREST reload.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../server/migrate';

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const applied = await applyMigrations(client);

    // Tell PostgREST to reload its schema cache. Migrations are applied over a
    // raw pg connection (not the Supabase CLI), so on a hosted Supabase project
    // PostgREST never learns about newly created tables/columns on its own and
    // requests fail with "Could not find the table 'public.<name>' in the schema
    // cache". Signalling a reload here keeps the REST API in sync after every
    // migrate run. Harmless (a no-op) on plain Postgres with no PostgREST.
    await client.query("notify pgrst, 'reload schema'");
    return applied;
  } finally {
    await client.end();
  }
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
