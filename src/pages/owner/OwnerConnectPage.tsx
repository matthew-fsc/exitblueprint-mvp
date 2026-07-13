import { useOwnerContext } from '../../lib/owner';
import { useAuth } from '../../lib/auth';
import { useLedgerActions } from '../../lib/ledger';
import { useLedgerConnections } from '../../lib/queries';
import { Card, PageHeader, SkeletonLines } from '../../components/ui';
import { fmtDate } from '../../lib/format';

const PROVIDERS: { id: 'quickbooks' | 'xero'; name: string; blurb: string }[] = [
  { id: 'quickbooks', name: 'QuickBooks', blurb: 'Online or Desktop with sync' },
  { id: 'xero', name: 'Xero', blurb: 'Cloud accounting' },
];

export default function OwnerConnectPage() {
  const { companyId, loading } = useOwnerContext();
  const { profile } = useAuth();
  const connQ = useLedgerConnections(companyId);
  const byProvider = new Map((connQ.data ?? []).map((c) => [c.provider, c]));
  const { connect, disconnect } = useLedgerActions(companyId, {
    connectedBy: profile?.id ?? null,
    returnTo: '/portal/connect',
  });

  return (
    <div className="stack-lg">
      <PageHeader
        title="Connect your accounting"
        subtitle="Link your books so your advisor can verify your financials — the difference between a self-reported score and one buyers trust."
      />
      <Card>
        <p className="muted" style={{ marginTop: 0 }}>
          Connecting your accounting lets your advisor verify your figures against your real books,
          instead of relying on self-reported numbers. Verified financials turn a self-reported score
          into a defensible one — the difference buyers pay attention to. You stay in control and can
          disconnect anytime.
        </p>
        {loading || connQ.isLoading ? (
          <SkeletonLines lines={3} />
        ) : (
          <div className="connect-grid">
            {PROVIDERS.map((p) => {
              const conn = byProvider.get(p.id);
              const connected = conn?.status === 'connected';
              return (
                <div key={p.id} className={`connect-card ${connected ? 'connect-card-on' : ''}`}>
                  <div className="connect-card-head">
                    <span className="connect-name">{p.name}</span>
                    {connected ? (
                      <span className="connect-status connect-status-on">● Connected</span>
                    ) : (
                      <span className="connect-status">Not connected</span>
                    )}
                  </div>
                  <p className="connect-blurb muted">{p.blurb}</p>
                  {connected && conn ? (
                    <div className="connect-detail">
                      <p className="muted">
                        {conn.external_org_name}
                        {conn.connected_at && <> · connected {fmtDate(conn.connected_at)}</>}
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
