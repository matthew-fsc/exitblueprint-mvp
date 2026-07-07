import { useEffect, useState } from 'react';

type CheckState = 'pending' | 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

async function checkSupabase(): Promise<Check> {
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

export default function HealthPage() {
  const [supabaseCheck, setSupabaseCheck] = useState<Check>({
    name: 'Supabase API',
    state: 'pending',
    detail: 'checking…',
  });

  useEffect(() => {
    checkSupabase().then(setSupabaseCheck);
  }, []);

  const checks: Check[] = [
    { name: 'App', state: 'ok', detail: 'React app booted' },
    {
      name: 'Environment',
      state: supabaseUrl ? 'ok' : 'warn',
      detail: supabaseUrl ? 'VITE_SUPABASE_URL configured' : 'VITE_SUPABASE_URL missing',
    },
    supabaseCheck,
  ];

  return (
    <ul className="check-list">
      {checks.map((c) => (
        <li key={c.name} className={`check check-${c.state}`}>
          <span className="check-state">{c.state}</span>
          <span className="check-name">{c.name}</span>
          <span className="check-detail">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}
