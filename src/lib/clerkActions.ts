import { isClerkStack } from './supabase';

// Clerk exposes its singleton on window.Clerk once ClerkProvider has mounted
// (docs/30 — Clerk is the identity provider). Always-mounted chrome (the app bar
// account menu, the onboarding checklist) reaches personal-account settings —
// profile, password, and two-factor all live in Clerk's own modal — through this
// global rather than the useClerk() hook: the hook throws outside a
// ClerkProvider, and the dev stack renders without one (main.tsx). A no-op off
// the Clerk stack keeps those surfaces safe everywhere.
export function openUserProfile(): void {
  if (!isClerkStack) return;
  const clerk = (window as unknown as { Clerk?: { openUserProfile?: () => void } }).Clerk;
  clerk?.openUserProfile?.();
}
