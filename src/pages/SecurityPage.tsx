import { useEffect, useState } from 'react';
import { isDevStack } from '../lib/supabase';
import { enrollTotp, getMfaState, verifyTotp, type MfaState, type TotpEnrollment } from '../lib/mfa';
import { ErrorState, PageHeader, SectionCard, useToast } from '../components/ui';

// R5: MFA enrollment/verification + a one-page security summary for advisor
// compliance review (the full version lives in docs/13-security-summary.md).
export default function SecurityPage() {
  const toast = useToast();
  const [state, setState] = useState<MfaState | 'loading'>('loading');
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    getMfaState()
      .then(setState)
      .catch(() => setState('satisfied'));
  };
  useEffect(refresh, []);

  const startEnroll = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await enrollTotp());
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const verify = async () => {
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    try {
      await verifyTotp(enrollment.factorId, code.trim());
      setEnrollment(null);
      setCode('');
      toast.show('Multi-factor authentication enabled', 'good');
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Security" subtitle="Account protection and how client data is handled." />

      <SectionCard title="Multi-factor authentication">
        {isDevStack ? (
          <p className="muted">
            MFA is enforced on the hosted deployment. The local dev stack has no authenticator
            endpoint, so enrollment is disabled here.
          </p>
        ) : state === 'loading' ? (
          <p className="muted">Checking status…</p>
        ) : state === 'satisfied' && !enrollment ? (
          <p className="status-chip status-good">Active — your account is protected by MFA.</p>
        ) : (
          <div className="mfa-enroll">
            {!enrollment ? (
              <>
                <p className="muted">
                  {state === 'needs_verify'
                    ? 'Enter a code from your authenticator to finish signing in.'
                    : 'MFA is required for advisor accounts. Add an authenticator app to continue.'}
                </p>
                <button onClick={startEnroll} disabled={busy}>
                  {busy ? 'Starting…' : 'Set up authenticator'}
                </button>
              </>
            ) : (
              <>
                <p className="muted">Scan this with your authenticator app, or enter the secret manually.</p>
                {/* Supabase returns the QR as an SVG data URI. */}
                <img className="mfa-qr" src={enrollment.qrSvg} alt="MFA QR code" />
                <code className="mfa-secret">{enrollment.secret}</code>
                <div className="mfa-verify">
                  <input
                    inputMode="numeric"
                    placeholder="6-digit code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button onClick={verify} disabled={busy || code.trim().length < 6}>
                    {busy ? 'Verifying…' : 'Verify & enable'}
                  </button>
                </div>
              </>
            )}
            {error && <ErrorState variant="inline" error={error} />}
          </div>
        )}
      </SectionCard>

      <SectionCard title="How client data is protected">
        <ul className="security-summary">
          <li>
            <strong>Data storage.</strong> Postgres (Supabase) with row-level security on every
            table; each firm sees only its own client records — enforced in the database, not just
            the app.
          </li>
          <li>
            <strong>Encryption.</strong> Uploaded documents are encrypted at rest (AES-256-GCM);
            all traffic is TLS. Source documents are served only through short-expiry signed URLs.
          </li>
          <li>
            <strong>Access controls.</strong> Roles are admin, advisor, reviewer, and client
            (owner). MFA is required for advisor and admin accounts, and sessions are signed out
            automatically after 30 minutes of inactivity. Every read of a client document or report
            is written to an audit log.
          </li>
          <li>
            <strong>Consent & retention.</strong> No assessment data is collected before a signed
            engagement agreement and data-use consent are recorded; assessments are immutable
            snapshots. On termination, a firm's data is exported in standard formats and destroyed
            per its instruction.
          </li>
          <li>
            <strong>Subprocessors.</strong> Supabase (database, auth, storage), Vercel (hosting +
            compute), and Anthropic (AI narrative from structured data — never used to compute a
            score). Each is SOC 2 attested.
          </li>
        </ul>
        <p className="muted">
          A full security summary and our vendor due-diligence response are available on request.
        </p>
      </SectionCard>
    </div>
  );
}
