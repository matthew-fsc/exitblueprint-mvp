import { useCallback, useEffect, useState } from 'react';
import {
  functionsBaseUrl,
  functionsUrlConfigured,
  getAccessToken,
  invokeFunction,
  isClerkStack,
  isDevStack,
  requiresClerkConfig,
  supabase,
} from '../lib/supabase';

type CheckState = 'pending' | 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

// One row of the `seed-methodology` report (server/seed-methodology.ts).
interface SeedTableReport {
  table: string;
  inserted: number;
  updated: number;
  total: number;
  expected: number;
  ok: boolean;
}
interface SeedResult {
  rows: SeedTableReport[];
  ok: boolean;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Decode a JWT payload without verifying it — this is a client-side diagnostic,
// not an auth boundary. We only read claims to show what the token carries.
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function checkSupabaseApi(): Promise<Check> {
  if (!supabaseUrl) {
    return {
      name: 'Supabase API',
      state: 'warn',
      detail: 'VITE_SUPABASE_URL not set — copy .env.example to .env and run `supabase start`',
    };
  }
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/health`, {
      headers: anonKey ? { apikey: anonKey } : {},
    });
    return res.ok
      ? { name: 'Supabase API', state: 'ok', detail: `${supabaseUrl} reachable` }
      : { name: 'Supabase API', state: 'fail', detail: `HTTP ${res.status} from ${supabaseUrl}` };
  } catch {
    return { name: 'Supabase API', state: 'fail', detail: `Cannot reach ${supabaseUrl}` };
  }
}

// The compute service that serves every /functions/v1/* call (valuation,
// reports, review queue, comparables, …). The classic hosted misconfiguration —
// and the usual cause of a pervasive "we couldn't reach the server" on
// function-backed views — is leaving VITE_FUNCTIONS_URL UNSET: function calls
// then fall back to the Supabase URL, which does not serve them, so the browser
// blocks each one at the CORS preflight. Name that explicitly, then prove the
// resolved endpoint is actually reachable.
async function checkFunctionsService(): Promise<Check> {
  if (isDevStack) {
    return { name: 'Functions service', state: 'ok', detail: 'Same-origin dev emulator.' };
  }
  if (!functionsUrlConfigured) {
    return {
      name: 'Functions service',
      state: 'fail',
      detail:
        `VITE_FUNCTIONS_URL is not set, so /functions/v1/* calls go to ${functionsBaseUrl} (the ` +
        'Supabase URL), which does not serve this app’s functions — every function-backed view fails ' +
        'its CORS preflight ("we couldn’t reach the server"). Set VITE_FUNCTIONS_URL to the compute ' +
        'service (e.g. https://api.exitblueprint.net) in Vercel and redeploy (docs/29 §3).',
    };
  }
  try {
    const res = await fetch(`${functionsBaseUrl}/health`);
    return res.ok
      ? { name: 'Functions service', state: 'ok', detail: `${functionsBaseUrl} reachable` }
      : { name: 'Functions service', state: 'fail', detail: `HTTP ${res.status} from ${functionsBaseUrl}/health` };
  } catch {
    return {
      name: 'Functions service',
      state: 'fail',
      detail: `Cannot reach ${functionsBaseUrl}/health — is the compute service up and is VITE_FUNCTIONS_URL correct?`,
    };
  }
}

// The core production check: decode the session token and confirm it carries the
// claims Supabase RLS needs. A signed-in Clerk token that is MISSING
// `role: authenticated` is the classic cutover misconfig — every `to
// authenticated` policy denies, so the app "loads" but every read comes back
// empty or errors. Enable the Supabase integration in Clerk (docs/30 §2).
async function checkSessionToken(): Promise<Check[]> {
  let token: string | null = null;
  try {
    token = await getAccessToken();
  } catch {
    token = null;
  }

  if (!token || token === 'dev-anon-key') {
    return [
      {
        name: 'Session token',
        state: 'warn',
        detail: 'No active session — sign in first, then reload this page to check auth claims.',
      },
    ];
  }

  const claims = decodeJwt(token);
  if (!claims) {
    return [{ name: 'Session token', state: 'fail', detail: 'Token present but could not be decoded.' }];
  }

  const checks: Check[] = [];
  const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
  const iss = typeof claims.iss === 'string' ? claims.iss : undefined;
  checks.push({
    name: 'Session token',
    state: sub ? 'ok' : 'fail',
    detail: sub
      ? `Signed in as ${sub}${iss ? ` · issuer ${iss}` : ''}`
      : 'Token has no `sub` claim — RLS cannot identify the caller.',
  });

  // The decisive claim. PostgREST assumes the Postgres role named here; every
  // policy in this app targets `authenticated`.
  const role = claims.role;
  if (role === 'authenticated') {
    checks.push({ name: 'RLS role claim', state: 'ok', detail: '`role: authenticated` present — RLS policies will apply.' });
  } else {
    checks.push({
      name: 'RLS role claim',
      state: 'fail',
      detail:
        `Token is missing \`role: authenticated\` (got ${role === undefined ? 'no role claim' : `\`${String(role)}\``}). ` +
        'PostgREST will run every query as `anon`, so all firm-scoped reads are denied — this is the usual cause of ' +
        'pervasive "database errors". Enable the Supabase integration in Clerk so it adds the claim (docs/30 §2).',
    });
  }

  // Expiry sanity — a stale token reads as "not signed in" to Supabase.
  const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
  if (exp !== undefined) {
    const secondsLeft = exp - Math.floor(Date.now() / 1000);
    checks.push({
      name: 'Token expiry',
      state: secondsLeft > 0 ? 'ok' : 'fail',
      detail: secondsLeft > 0 ? `Valid for ~${Math.round(secondsLeft / 60)} more minutes.` : 'Token is expired — sign in again.',
    });
  }

  return checks;
}

// End-to-end proof: attempt an authenticated read every signed-in user is allowed
// (rubric_versions has a `to authenticated using (true)` policy). Success confirms
// the whole chain (token → Supabase → RLS). A permission error or a thrown error
// points straight back at the role-claim / third-party-auth wiring above.
async function checkAuthenticatedRead(hasToken: boolean): Promise<Check> {
  if (!hasToken) {
    return { name: 'Authenticated read', state: 'warn', detail: 'Skipped — no active session.' };
  }
  const { error } = await supabase.from('rubric_versions').select('id', { count: 'exact', head: true });
  if (error) {
    return {
      name: 'Authenticated read',
      state: 'fail',
      detail: `Read of rubric_versions failed: ${error.message}. If the role claim above is missing, fix that first.`,
    };
  }
  return { name: 'Authenticated read', state: 'ok', detail: 'Read the methodology tables as an authenticated user.' };
}

// Is the methodology actually loaded? The check above proves rubric_versions is
// READABLE; this proves an ACTIVE rubric row exists. A fresh hosted DB has the
// schema and tenant data but no methodology (a Vercel deploy never seeds), so
// starting an assessment fails with "no active rubric version" even with every
// auth check green. When this fails, a platform superadmin can load it in-place
// with the button below (the `seed-methodology` function).
async function checkMethodology(hasToken: boolean): Promise<Check> {
  if (!hasToken) return { name: 'Methodology', state: 'warn', detail: 'Skipped — no active session.' };
  const { data, error } = await supabase
    .from('rubric_versions')
    .select('version_label')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return { name: 'Methodology', state: 'fail', detail: `Could not read rubric_versions: ${error.message}` };
  if (!data?.length) {
    return {
      name: 'Methodology',
      state: 'fail',
      detail:
        'No active rubric version — this database was never seeded. Assessments cannot start until the ' +
        'methodology is loaded. A platform superadmin can load it below.',
    };
  }
  return { name: 'Methodology', state: 'ok', detail: `Active rubric ${data[0].version_label} loaded.` };
}

// The check that catches the case the methodology read above cannot: RLS resolves
// role/firm/company by joining the Clerk `sub` to `public.profiles.user_id`. A
// valid token with `role: authenticated` still reads NOTHING firm-scoped if no
// profiles row is keyed to that exact `sub` (e.g. the row was seeded/dev-created
// with a UUID, or provisioning never ran). We read our own profile by `sub` — the
// own_profile_read policy is itself `user_id = sub`, so a 0-row result IS the
// mismatch — then attempt a real firm-scoped read to prove end-to-end access.
async function checkProfileLinkage(sub: string | undefined): Promise<Check[]> {
  if (!sub) return [{ name: 'Profile linkage', state: 'warn', detail: 'Skipped — no active session.' }];

  const { data, error } = await supabase
    .from('profiles')
    .select('role, firm_id, company_id')
    .eq('user_id', sub)
    .maybeSingle();

  if (error) {
    return [{ name: 'Profile linkage', state: 'fail', detail: `Reading your profile failed: ${error.message}` }];
  }
  if (!data) {
    return [
      {
        name: 'Profile linkage',
        state: 'fail',
        detail:
          `No public.profiles row is keyed to your Clerk id \`${sub}\`. RLS resolves role/firm from ` +
          'profiles.user_id, which must equal the Clerk `sub` — a profile seeded or dev-created with a ' +
          'UUID will not match, so every firm-scoped read is denied. Provision via ' +
          '`scripts/admin.ts create-advisor` (Clerk mode) or the webhook, or re-key the row (docs/31).',
      },
    ];
  }

  const checks: Check[] = [];
  const firmOk = data.role === 'owner' ? data.company_id != null : data.firm_id != null;
  checks.push({
    name: 'Profile linkage',
    state: firmOk ? 'ok' : 'warn',
    detail: firmOk
      ? `Profile found — role ${data.role}, firm ${data.firm_id ?? '—'}${data.company_id ? `, company ${data.company_id}` : ''}.`
      : `Profile found (role ${data.role}) but ${data.role === 'owner' ? 'company_id' : 'firm_id'} is null — nothing will scope to it.`,
  });

  // Prove a real firm-scoped read resolves. This never errors on a missing row
  // (RLS just filters), so a count is informative, not a failure signal — the
  // linkage check above is the decisive one.
  const { count, error: readErr } = await supabase.from('companies').select('id', { count: 'exact', head: true });
  checks.push({
    name: 'Firm-scoped read',
    state: readErr ? 'fail' : 'ok',
    detail: readErr
      ? `Read of companies failed: ${readErr.message}`
      : `Read ${count ?? 0} company row(s) under your firm scope.`,
  });
  return checks;
}

function identityCheck(): Check {
  if (requiresClerkConfig) {
    return {
      name: 'Identity provider',
      state: 'fail',
      detail: 'Hosted deployment without Clerk — set VITE_CLERK_PUBLISHABLE_KEY + CLERK_JWKS_URL (docs/30 §3).',
    };
  }
  if (isClerkStack) return { name: 'Identity provider', state: 'ok', detail: 'Clerk (production standard).' };
  if (isDevStack) return { name: 'Identity provider', state: 'ok', detail: 'Local dev emulator.' };
  return { name: 'Identity provider', state: 'warn', detail: 'Unrecognized configuration.' };
}

export default function HealthPage() {
  const [checks, setChecks] = useState<Check[]>([
    { name: 'App', state: 'ok', detail: 'React app booted' },
    identityCheck(),
    {
      name: 'Environment',
      state: supabaseUrl ? 'ok' : 'warn',
      detail: supabaseUrl ? 'VITE_SUPABASE_URL configured' : 'VITE_SUPABASE_URL missing',
    },
    { name: 'Supabase API', state: 'pending', detail: 'checking…' },
    { name: 'Functions service', state: 'pending', detail: 'checking…' },
    { name: 'Session token', state: 'pending', detail: 'checking…' },
    { name: 'RLS role claim', state: 'pending', detail: 'checking…' },
    { name: 'Authenticated read', state: 'pending', detail: 'checking…' },
    { name: 'Methodology', state: 'pending', detail: 'checking…' },
    { name: 'Profile linkage', state: 'pending', detail: 'checking…' },
  ]);
  const [methodologyMissing, setMethodologyMissing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  const runChecks = useCallback(async (): Promise<void> => {
    const base: Check[] = [
      { name: 'App', state: 'ok', detail: 'React app booted' },
      identityCheck(),
      {
        name: 'Environment',
        state: supabaseUrl ? 'ok' : 'warn',
        detail: supabaseUrl ? 'VITE_SUPABASE_URL configured' : 'VITE_SUPABASE_URL missing',
      },
    ];
    const api = await checkSupabaseApi();
    const functions = await checkFunctionsService();
    const token = await getAccessToken().catch(() => null);
    const hasToken = !!token && token !== 'dev-anon-key';
    const claims = hasToken && token ? decodeJwt(token) : null;
    const sub = claims && typeof claims.sub === 'string' ? claims.sub : undefined;
    const sessionChecks = await checkSessionToken();
    const readCheck = await checkAuthenticatedRead(hasToken);
    const methodology = await checkMethodology(hasToken);
    const linkageChecks = await checkProfileLinkage(sub);
    setMethodologyMissing(methodology.state === 'fail');
    setChecks([...base, api, functions, ...sessionChecks, readCheck, methodology, ...linkageChecks]);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await runChecks();
    })();
    return () => {
      alive = false;
    };
  }, [runChecks]);

  const loadMethodology = async () => {
    setSeeding(true);
    setSeedError(null);
    setSeedResult(null);
    try {
      const result = await invokeFunction<SeedResult>('seed-methodology', {});
      setSeedResult(result);
      await runChecks();
    } catch (e) {
      setSeedError((e as Error).message);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="stack-lg">
      <ul className="check-list">
        {checks.map((c) => (
          <li key={c.name} className={`check check-${c.state}`}>
            <span className="check-state">{c.state}</span>
            <span className="check-name">{c.name}</span>
            <span className="check-detail">{c.detail}</span>
          </li>
        ))}
      </ul>

      {/* Methodology bootstrap — shown only when no active rubric exists. The
          action is superadmin-gated server-side; a non-superadmin gets a clear
          403 ("platform superadmin required") surfaced below. */}
      {methodologyMissing && (
        <div className="stack-sm">
          <button type="button" onClick={loadMethodology} disabled={seeding}>
            {seeding ? 'Loading methodology…' : 'Load methodology'}
          </button>
          {seedError && (
            <p className="check check-fail" role="alert">
              Seeding failed: {seedError}
            </p>
          )}
          {seedResult && (
            <div className={`check check-${seedResult.ok ? 'ok' : 'fail'}`}>
              <span className="check-detail">
                {seedResult.ok
                  ? 'Methodology loaded — reload the app and start an assessment.'
                  : 'Loaded, but some row counts did not match the seed files (see below).'}
              </span>
              <ul className="check-list">
                {seedResult.rows.map((r) => (
                  <li key={r.table} className={`check check-${r.ok ? 'ok' : 'fail'}`}>
                    <span className="check-name">{r.table}</span>
                    <span className="check-detail">
                      +{r.inserted} / ~{r.updated} · {r.total} of {r.expected}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
