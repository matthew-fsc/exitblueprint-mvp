import { useQueryClient } from '@tanstack/react-query';
import { useOwnerContext } from '../../lib/owner';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { qk, useLedgerConnections, type LedgerConnection } from '../../lib/queries';
import { Card, PageHeader, SkeletonLines, useToast } from '../../components/ui';
import { fmtDate } from '../../lib/format';

const PROVIDERS: { id: 'quickbooks' | 'xero'; name: string; blurb: string }[] = [
  { id: 'quickbooks', name: 'QuickBooks', blurb: 'Online or Desktop with sync' },
  { id: 'xero', name: 'Xero', blurb: 'Cloud accounting' },
];

export default function OwnerConnectPage() {
  const { company, companyId, loading } = useOwnerContext();
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const connQ = useLedgerConnections(companyId);
  const byProvider = new Map((connQ.data ?? []).map((c) => [c.provider, c]));

  const connect = async (provider: 'quickbooks' | 'xero') => {
    if (!companyId || !company) return;
    // Real OAuth is external; this records the connection the handshake would create.
    const { error } = await supabase.from('ledger_connections').upsert(
      {
        firm_id: company.firm_id,
        company_id: companyId,
        provider,
        status: 'connected',
        external_org_name: company.name,
        connected_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        connected_by: profile?.id ?? null,
      },
      { onConflict: 'company_id,provider' },
    );
    if (error) {
      toast.show(error.message, 'error');
      return;
    }
    qc.invalidateQueries({ queryKey: qk.ledgerConnections(companyId) });
    toast.show(`${provider === 'quickbooks' ? 'QuickBooks' : 'Xero'} connected`, 'good');
  };

  const disconnect = async (conn: LedgerConnection) => {
    const { error } = await supabase.from('ledger_connections').delete().eq('id', conn.id);
    if (error) {
      toast.show(error.message, 'error');
      return;
    }
    qc.invalidateQueries({ queryKey: qk.ledgerConnections(companyId!) });
    toast.show('Disconnected', 'good');
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Connect your accounting"
        subtitle="Link your books so your financials are verified automatically — no spreadsheets, and a score buyers can trust."
      />
      <Card>
        <p className="muted" style={{ marginTop: 0 }}>
          Connecting your accounting lets your advisor pull verified figures directly, instead of
          you re-keying them. Verified financials turn a self-reported score into a defensible one —
          the difference buyers pay attention to. You stay in control and can disconnect anytime.
        </p>
        {loading || connQ.isLoading ? (
          <SkeletonLines lines={3} />
        ) : (
          <div className="connect-grid">
            {PROVIDERS.map((p) => {
              const conn = byProvider.get(p.id);
              return (
                <div key={p.id} className={`connect-card ${conn ? 'connect-card-on' : ''}`}>
                  <div className="connect-card-head">
                    <span className="connect-name">{p.name}</span>
                    {conn ? (
                      <span className="connect-status connect-status-on">● Connected</span>
                    ) : (
                      <span className="connect-status">Not connected</span>
                    )}
                  </div>
                  <p className="connect-blurb muted">{p.blurb}</p>
                  {conn ? (
                    <div className="connect-detail">
                      <p className="muted">
                        {conn.external_org_name}
                        {conn.last_sync_at && <> · synced {fmtDate(conn.last_sync_at)}</>}
                      </p>
                      <button className="btn-ghost" onClick={() => disconnect(conn)}>Disconnect</button>
                    </div>
                  ) : (
                    <button onClick={() => connect(p.id)}>Connect {p.name}</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
