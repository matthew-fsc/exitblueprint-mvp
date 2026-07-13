import { useAuth } from '../lib/auth';
import { useLedgerActions } from '../lib/ledger';
import { useLedgerConnections } from '../lib/queries';
import { Card, SkeletonLines } from './ui';
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
            return (
              <div className="acct-row" key={p.id}>
                <span className="acct-name">{p.name}</span>
                {connected && conn ? (
                  <>
                    <span className="acct-status acct-on">
                      ● Connected{conn.connected_at ? ` · ${fmtDate(conn.connected_at)}` : ''}
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
