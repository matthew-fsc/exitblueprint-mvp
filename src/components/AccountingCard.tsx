import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { qk, useLedgerConnections, type LedgerConnection } from '../lib/queries';
import { Card, SkeletonLines, useToast } from './ui';
import { fmtDate } from '../lib/format';

const PROVIDERS: { id: 'quickbooks' | 'xero'; name: string }[] = [
  { id: 'quickbooks', name: 'QuickBooks' },
  { id: 'xero', name: 'Xero' },
];

// Advisor-side view of the client's accounting connection: see whether the books
// are connected, connect/disconnect on the client's behalf, and a reminder that
// a connection lets financials be imported (and verified) on the intake.
export function AccountingCard({
  companyId,
  companyName,
  firmId,
}: {
  companyId: string | undefined;
  companyName: string;
  firmId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const connQ = useLedgerConnections(companyId);
  const byProvider = new Map((connQ.data ?? []).map((c) => [c.provider, c]));
  const anyConnected = (connQ.data ?? []).some((c) => c.status === 'connected');

  const connect = async (provider: 'quickbooks' | 'xero') => {
    if (!companyId) return;
    const { error } = await supabase.from('ledger_connections').upsert(
      {
        firm_id: firmId,
        company_id: companyId,
        provider,
        status: 'connected',
        external_org_name: companyName,
        connected_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        connected_by: profile?.id ?? null,
      },
      { onConflict: 'company_id,provider' },
    );
    if (error) return toast.show(error.message, 'error');
    qc.invalidateQueries({ queryKey: qk.ledgerConnections(companyId) });
    toast.show(`${provider === 'quickbooks' ? 'QuickBooks' : 'Xero'} connected`, 'good');
  };

  const disconnect = async (conn: LedgerConnection) => {
    const { error } = await supabase.from('ledger_connections').delete().eq('id', conn.id);
    if (error) return toast.show(error.message, 'error');
    qc.invalidateQueries({ queryKey: qk.ledgerConnections(companyId!) });
    toast.show('Disconnected', 'good');
  };

  return (
    <Card>
      <div className="verif-head">
        <span className="stat-block-label">Accounting connection</span>
        {anyConnected && <span className="verif-badge verif-tier-high">Connected</span>}
      </div>
      <p className="muted" style={{ margin: '0.25rem 0 0.9rem' }}>
        Connect the client's books to import the financial figures on the assessment intake — less
        re-keying, and those inputs count as verified.
      </p>
      {connQ.isLoading ? (
        <SkeletonLines lines={2} />
      ) : (
        <div className="acct-rows">
          {PROVIDERS.map((p) => {
            const conn = byProvider.get(p.id);
            return (
              <div className="acct-row" key={p.id}>
                <span className="acct-name">{p.name}</span>
                {conn ? (
                  <>
                    <span className="acct-status acct-on">
                      ● Connected{conn.last_sync_at ? ` · synced ${fmtDate(conn.last_sync_at)}` : ''}
                    </span>
                    <button className="btn-ghost acct-btn" onClick={() => disconnect(conn)}>Disconnect</button>
                  </>
                ) : (
                  <>
                    <span className="acct-status muted">Not connected</span>
                    <button className="btn-secondary acct-btn" onClick={() => connect(p.id)}>Connect</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
