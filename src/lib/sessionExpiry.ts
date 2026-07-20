// Cross-cutting session-lifecycle signals shared by the auth provider, the query
// layer, and the login screen. Kept in one tiny React-free module so the
// module-level QueryClient (src/App.tsx) can reach the AuthProvider without a
// context, and so the reason a user landed on /login survives the redirect.

// ── Global "session expired" bridge ───────────────────────────────────────────
// A query whose error humanizes to kind:'auth' (a stale/invalid JWT) can't be
// recovered by a refetch — the only fix is to re-authenticate. The QueryCache
// onError calls notifySessionExpired(); the active AuthProvider registers a
// handler that signs out, which drops the session and lets the route gates
// redirect to /login. One handler at a time; the last registration wins.
type ExpiredHandler = () => void;
let expiredHandler: ExpiredHandler | null = null;

export function registerSessionExpiredHandler(fn: ExpiredHandler | null): void {
  expiredHandler = fn;
}

let notifying = false;
export function notifySessionExpired(): void {
  // Re-entrancy guard: several in-flight queries can fail at once when a token
  // drops, and we want exactly one sign-out/redirect, not a storm of them.
  if (notifying || !expiredHandler) return;
  notifying = true;
  markSignoutReason('expired');
  try {
    expiredHandler();
  } finally {
    // Re-arm once the sign-out has propagated (the session going null unmounts
    // the failing surfaces), so a genuinely new expiry later is still handled.
    setTimeout(() => {
      notifying = false;
    }, 2000);
  }
}

// ── Post-sign-out reason (idle vs expired) ────────────────────────────────────
// Survives the client-side redirect to /login (and Clerk's own afterSignOutUrl
// navigation) via sessionStorage, so the login screen can explain *why* the user
// is there instead of dropping them on a bare form with no context.
export type SignoutReason = 'idle' | 'expired';
const REASON_KEY = 'eb-signout-reason';

export function markSignoutReason(reason: SignoutReason): void {
  try {
    sessionStorage.setItem(REASON_KEY, reason);
  } catch {
    // sessionStorage can throw in private-mode/embedded contexts — a missing
    // reason banner is cosmetic, so degrade silently.
  }
}

// Read the reason without clearing it. Pure, so it's safe to call during render
// (and under StrictMode's double-invoke) — the login screen peeks here and clears
// separately once it has shown the notice.
export function peekSignoutReason(): SignoutReason | null {
  try {
    const v = sessionStorage.getItem(REASON_KEY);
    if (v === 'idle' || v === 'expired') return v;
  } catch {
    // ignore — treated as "no reason"
  }
  return null;
}

// Clear the reason so a later refresh of /login doesn't keep showing the notice.
export function clearSignoutReason(): void {
  try {
    sessionStorage.removeItem(REASON_KEY);
  } catch {
    // ignore
  }
}

// Read and clear in one step, for non-render callers.
export function consumeSignoutReason(): SignoutReason | null {
  const v = peekSignoutReason();
  clearSignoutReason();
  return v;
}
