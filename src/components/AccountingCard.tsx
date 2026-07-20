import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { useLedgerActions } from '../lib/ledger';
import { useLedgerConnections, type LedgerConnection } from '../lib/queries';
import { Card, ConfirmDialog, SkeletonLines } from './ui';
import { fmtDate } from '../lib/format';

const PROVIDERS: { id: 'quickbooks' | 'xero'; name: string }[] = [
  { id: 'quickbooks', name: 'QuickBooks' },
  { id: 'xero', name: 'Xero' },
];

// Advisor-side view of the client's accounting connection: see whether the books
// are connected, connect/disconnect on the client's behalf, and a reminder that
// a connection lets financials be imported (and verified) on the intake. Drives
// the same server flow as the owner portal, so the two never diverge.
export function AccountingCard({
  companyId,
}: {
  companyId: string | undefined;
  companyName?: string;
  firmId?: string;
}) {
  const { profile } = useAuth();
  const connQ = useLedgerConnections(companyId);
  const byProvider = new Map((connQ.data ?? []).map((c) => [c.provider, c]));
  const anyConnected = (connQ.data ?? []).some((c) => c.status === 'connected');
  const { connect, disconnect } = useLedgerActions(companyId, { connectedBy: profile?.id ?? null });
  const [pending, setPending] = useState<string | null>(null);
  const [toDisconnect, setToDisconnect] = useState<LedgerConnection | null>(null);

  const handleConnect = async (id: 'quickbooks' | 'xero') => {
    setPending(id);
    try {
      await connect(id);
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
    <Card>
      <div className="verif-head">
        <span className="stat-block-label">Accounting connection</span>
        {anyConnected && <span className="verif-badge verif-tier-high">Connected</span>}
      </div>
      <p className="muted" style={{ margin: '0.25rem 0 0.9rem' }}>
        Connect the client's books so their financials can be verified against their real accounting
        system — the basis for a defensible, buyer-ready score.
      </p>
      {connQ.isLoading ? (
        <SkeletonLines lines={2} />
      ) : (
        <div className="acct-rows">
          {PROVIDERS.map((p) => {
            const conn = byProvider.get(p.id);
            const connected = conn?.status === 'connected';
            const busy = pending === p.id;
            return (
              <div className="acct-row" key={p.id}>
                <span className="acct-name">{p.name}</span>
                {connected && conn ? (
                  <>
                    <span className="acct-status acct-on">
                      ● Connected{conn.connected_at ? ` · ${fmtDate(conn.connected_at)}` : ''}
                    </span>
                    <button
                      className="btn-ghost acct-btn"
                      disabled={busy}
                      onClick={() => setToDisconnect(conn)}
                    >
                      {busy ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="acct-status muted">Not connected</span>
                    <button
                      className="btn-secondary acct-btn"
                      disabled={busy}
                      onClick={() => handleConnect(p.id)}
                    >
                      {busy ? 'Connecting…' : 'Connect'}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

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
          The client's financials will no longer be verifiable against their books until reconnected —
          the score reverts to self-reported figures.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
