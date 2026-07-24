import { useState } from 'react';
import { useOwnerContext } from '../../lib/owner';
import { useAuth } from '../../lib/auth';
import { useLedgerActions } from '../../lib/ledger';
import { useLedgerConnections, type LedgerConnection } from '../../lib/queries';
import { Card, ConfirmDialog, ErrorState, PageHeader, SkeletonLines } from '../../components/ui';
import { fmtDate } from '../../lib/format';

const PROVIDERS: { id: 'quickbooks' | 'xero'; name: string; blurb: string }[] = [
  { id: 'quickbooks', name: 'QuickBooks', blurb: 'Online or Desktop with sync' },
  { id: 'xero', name: 'Xero', blurb: 'Cloud accounting' },
];

export default function OwnerConnectPage() {
  const { companyId, loading, isError, error, refetch } = useOwnerContext();
  const { profile } = useAuth();
  const connQ = useLedgerConnections(companyId);
  const byProvider = new Map((connQ.data ?? []).map((c) => [c.provider, c]));
  const { connect, disconnect } = useLedgerActions(companyId, {
    connectedBy: profile?.id ?? null,
    returnTo: '/portal/connect',
  });
  // in-flight provider (connect) and the connection queued for disconnect confirm
  const [pending, setPending] = useState<string | null>(null);
  const [toDisconnect, setToDisconnect] = useState<LedgerConnection | null>(null);

  const handleConnect = async (id: string) => {
    setPending(id);
    try {
      await connect(id as 'quickbooks' | 'xero');
    } finally {
      setPending(null);
    }
  };
  const confirmDisconnect = async () => {
    if (!toDisconnect) return;
    setPending(toDisconnect.provider);
    try {
      await disconnect(toDisconnect);
    } finally {
      setPending(null);
      setToDisconnect(null);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Connect your accounting"
        subtitle="Link your books so your advisor can verify your financials: the difference between a self-reported score and one buyers trust."
      />
      <Card>
        <p className="muted mt-0">
          Connecting your accounting lets your advisor verify your figures against your real books,
          instead of relying on self-reported numbers. Verified financials turn a self-reported score
          into a defensible one, the difference buyers pay attention to. You stay in control and can
          disconnect anytime.
        </p>
        {loading || connQ.isLoading ? (
          <SkeletonLines lines={3} />
        ) : isError ? (
          <ErrorState variant="section" error={error} onRetry={refetch} />
        ) : (
          <div className="connect-grid">
            {PROVIDERS.map((p) => {
              const conn = byProvider.get(p.id);
              const connected = conn?.status === 'connected';
              const busy = pending === p.id;
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
                      <button className="btn-ghost" onClick={() => setToDisconnect(conn)} disabled={busy}>
                        {busy ? 'Disconnecting…' : 'Disconnect'}
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => handleConnect(p.id)} disabled={busy}>
                      {busy ? 'Connecting…' : `Connect ${p.name}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={toDisconnect != null}
        title="Disconnect accounting?"
        danger
        busy={pending != null && toDisconnect != null}
        confirmLabel="Disconnect"
        onConfirm={confirmDisconnect}
        onCancel={() => setToDisconnect(null)}
      >
        <p className="m-0">
          Your advisor will no longer be able to verify your financials until you reconnect. Your
          readiness score reverts to self-reported figures in the meantime.
        </p>
      </ConfirmDialog>
    </div>
  );
}
