// Beta Requirement 5: MFA is required for advisor/admin accounts. Enforcement is
// via Supabase Auth's TOTP factors + authenticator assurance level (AAL). The dev
// emulator has no MFA endpoint, so enforcement is bypassed on the dev stack; on a
// real Supabase project the gate (RequireAdvisor) sends un-enrolled/unverified
// staff to /settings (which hosts MFA setup) before they can use the workspace.
import { isClerkStack, isDevStack, supabase } from './supabase';

export type MfaState = 'satisfied' | 'needs_enroll' | 'needs_verify';

export async function getMfaState(): Promise<MfaState> {
  // Under Clerk, MFA is enforced as a Clerk org/session policy (not Supabase
  // AAL), so the in-app AAL gate is satisfied by definition (docs/30, A6).
  if (isClerkStack || isDevStack) return 'satisfied';
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // Fail open on a transient API error so a hiccup can't lock every advisor out;
  // enforcement applies whenever the call succeeds.
  if (error || !data) return 'satisfied';
  if (data.currentLevel === 'aal2') return 'satisfied';
  if (data.nextLevel === 'aal2') return 'needs_verify'; // a factor exists, verify it this session
  return 'needs_enroll';
}

export interface TotpEnrollment {
  factorId: string;
  qrSvg: string; // data-URI SVG of the QR code
  secret: string; // manual-entry secret
}

export async function enrollTotp(): Promise<TotpEnrollment> {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error || !data) throw error ?? new Error('could not start MFA enrollment');
  return { factorId: data.id, qrSvg: data.totp.qr_code, secret: data.totp.secret };
}

// Verify a 6-digit code against a factor, upgrading the session to AAL2.
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const ch = await supabase.auth.mfa.challenge({ factorId });
  if (ch.error || !ch.data) throw ch.error ?? new Error('could not start MFA challenge');
  const v = await supabase.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
  if (v.error) throw v.error;
}
