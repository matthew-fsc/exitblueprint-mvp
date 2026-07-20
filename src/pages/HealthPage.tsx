import { useEffect, useState } from 'react';
import {
  getAccessToken,
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
    { name: 'Session token', state: 'pending', detail: 'checking…' },
    { name: 'RLS role claim', state: 'pending', detail: 'checking…' },
    { name: 'Authenticated read', state: 'pending', detail: 'checking…' },
    { name: 'Profile linkage', state: 'pending', detail: 'checking…' },
  ]);

  useEffect(() => {
    let alive = true;
    (async () => {
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
      const token = await getAccessToken().catch(() => null);
      const hasToken = !!token && token !== 'dev-anon-key';
      const claims = hasToken && token ? decodeJwt(token) : null;
      const sub = claims && typeof claims.sub === 'string' ? claims.sub : undefined;
      const sessionChecks = await checkSessionToken();
      const readCheck = await checkAuthenticatedRead(hasToken);
      const linkageChecks = await checkProfileLinkage(sub);
      if (alive) setChecks([...base, api, ...sessionChecks, readCheck, ...linkageChecks]);
    })();
    return () => {
      alive = false;
    };
  }, []);

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
    </div>
  );
}
