// OAuth return target. A live QuickBooks/Xero handshake redirects here with the
// authorization code + state; we hand them to ledger-connect-complete (which
// exchanges the code for tokens server-side) and bounce the user back to wherever
// they started. In dev the connect flow never routes through here — completion is
// immediate — so this page only matters once a real provider app is configured.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { invokeFunction } from '../lib/supabase';
import { Card, PageHeader } from '../components/ui';

export default function LedgerCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ran.current) return; // complete() consumes the state; never fire it twice
    ran.current = true;
    const state = params.get('state');
    if (!state) {
      setError('Missing connection details from the provider.');
      return;
    }
    invokeFunction<{ return_to: string | null }>('ledger-connect-complete', {
      state,
      code: params.get('code'),
      realm_id: params.get('realmId'),
    })
      .then((r) => navigate(r.return_to || '/portal/connect', { replace: true }))
      .catch((e) => setError((e as Error).message));
  }, [params, navigate]);

  return (
    <main className="page">
      <div className="stack-lg">
        <PageHeader title="Finishing connection" subtitle="Linking your accounting to the engagement." />
        <Card>
          <p className="muted" style={{ marginTop: 0 }}>
            {error ? `Could not finish connecting: ${error}` : 'One moment while we complete the handshake…'}
          </p>
        </Card>
      </div>
    </main>
  );
}
