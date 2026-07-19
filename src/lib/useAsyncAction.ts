import { useCallback, useState } from 'react';
import { useToast } from '../components/ui';

// Canonical page-action pattern. ~10 pages had copied the same
//   setBusy(true); try { …; toast.show(ok,'good') } catch(e){ setError(e.message) } finally { setBusy(false) }
// block for every generate/save/finalize button. This consolidates it:
//
//   const { busy, run } = useAsyncAction();
//   <button disabled={busy} onClick={() => run(() => saveThing(), { success: 'Saved' })}>Save</button>
//
// On failure it shows an error toast by default; pass `onError` to route the
// message into a page's own error state instead. Returns the awaited value (or
// undefined on error) so callers can chain.
export interface RunOptions {
  success?: string; // toast on success
  onError?: (message: string) => void; // handle the error yourself (else it toasts)
}

export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = useCallback(
    async <T>(fn: () => Promise<T>, opts: RunOptions = {}): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await fn();
        if (opts.success) toast.show(opts.success, 'good');
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (opts.onError) opts.onError(message);
        else toast.show(message, 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  return { busy, run };
}
