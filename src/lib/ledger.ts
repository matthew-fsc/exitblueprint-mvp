// Shared connect / disconnect actions for a company's accounting ledger, used
// identically by the owner portal (OwnerConnectPage) and the advisor engagement
// view (AccountingCard) so the workflow can never drift between the two.
//
// connect() calls ledger-connect-begin. With a live provider app it returns an
// authorize URL and we hand the browser off to QuickBooks/Xero (returning via
// /ledger/callback). Without one (dev), it returns a state we complete straight
// away — same code path, minus the external redirect. disconnect() revokes and
// flips the connection to 'disconnected' server-side.
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/ui';
import { invokeFunction } from './supabase';
import { qk, type LedgerConnection } from './queries';

type Provider = 'quickbooks' | 'xero';

interface BeginResult {
  mode: 'oauth' | 'dev';
  provider: Provider;
  state: string;
  authorize_url: string | null;
}

const label = (p: Provider) => (p === 'quickbooks' ? 'QuickBooks' : 'Xero');

export function useLedgerActions(
  companyId: string | undefined | null,
  opts?: { connectedBy?: string | null; returnTo?: string },
) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    if (companyId) qc.invalidateQueries({ queryKey: qk.ledgerConnections(companyId) });
  };

  const connect = async (provider: Provider) => {
    if (!companyId) return;
    try {
      const begin = await invokeFunction<BeginResult>('ledger-connect-begin', {
        company_id: companyId,
        provider,
        connected_by: opts?.connectedBy ?? null,
        return_to: opts?.returnTo ?? window.location.pathname,
      });
      if (begin.mode === 'oauth' && begin.authorize_url) {
        // Real handshake: hand off to the provider; we come back via /ledger/callback.
        window.location.href = begin.authorize_url;
        return;
      }
      // Dev simulation: complete the (already authorized) request immediately.
      await invokeFunction('ledger-connect-complete', { company_id: companyId, state: begin.state });
      refresh();
      toast.show(`${label(provider)} connected`, 'good');
    } catch (e) {
      toast.show((e as Error).message, 'error');
    }
  };

  const disconnect = async (conn: LedgerConnection) => {
    try {
      await invokeFunction('ledger-disconnect', {
        company_id: conn.company_id,
        connection_id: conn.id,
      });
      refresh();
      toast.show('Disconnected', 'good');
    } catch (e) {
      toast.show((e as Error).message, 'error');
    }
  };

  return { connect, disconnect };
}
