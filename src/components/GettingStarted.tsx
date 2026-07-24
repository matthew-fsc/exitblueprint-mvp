import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageSection } from './ui';
import { getMfaState } from '../lib/mfa';
import { openUserProfile } from '../lib/clerkActions';
import { isDevStack } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useAdvisoryLibrary, useFirmProfessionals } from '../lib/queries';

// First-run activation checklist for a new advisor (docs/archive/35 "thin
// first-run onboarding"). Guides the steps that turn an empty workspace into a
// sticky one: secure the account, start an engagement, run the baseline — then
// the two behaviors that actually create switching cost, embedding firm
// knowledge (the Advisory Library) and loading the professional network. It no
// longer disappears the instant the first score exists; it stays until every
// step is done or the user dismisses it (persisted per firm), so activation is
// measured at the high-stickiness milestone rather than the low one.
//
// Deliberately not a wizard: each step links to where the work already happens
// (the Clerk account modal for MFA, the add-engagement dialog, the engagement
// page, Library, Organization). It reads the same signals the dashboard has, adding
// the MFA lookup plus the firm library and professional-directory counts.

// Per-firm dismissal, so an advisor who has intentionally skipped the remaining
// steps isn't nagged on every dashboard load.
const dismissKey = (firmId: string | null) => `eb.gettingStarted.dismissed.${firmId ?? 'anon'}`;
function readDismissed(firmId: string | null): boolean {
  try {
    return localStorage.getItem(dismissKey(firmId)) === '1';
  } catch {
    return false;
  }
}

interface Step {
  key: string;
  title: string;
  body: string;
  done: boolean;
  // The call-to-action for the first not-yet-done step. Omitted on a locked step
  // (a later step whose prerequisite isn't met yet).
  action?: React.ReactNode;
  locked?: boolean;
}

export function GettingStarted({
  engagementCount,
  hasAgreement,
  firstEngagementId,
  assessedCount,
  onAddEngagement,
}: {
  engagementCount: number;
  hasAgreement: boolean;
  firstEngagementId: string | null;
  assessedCount: number;
  onAddEngagement: () => void;
}) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const firmId = profile?.firm_id ?? null;

  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(firmId));
  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(firmId), '1');
    } catch {
      /* ignore storage failures — the panel just reappears next load */
    }
    setDismissed(true);
  };

  // MFA is force-gated before the dashboard for real advisors, so this is
  // normally already satisfied — showing it checked gives a sense of progress.
  // On the dev stack MFA is bypassed; treat it as done rather than nag.
  const [mfaDone, setMfaDone] = useState<boolean>(isDevStack);
  useEffect(() => {
    if (isDevStack) return;
    let alive = true;
    getMfaState()
      .then((s) => alive && setMfaDone(s === 'satisfied'))
      .catch(() => alive && setMfaDone(true));
    return () => {
      alive = false;
    };
  }, []);

  // Stickiness signals: has the firm authored any of its own library items, and
  // has it started loading its professional network?
  const { data: libraryItems } = useAdvisoryLibrary();
  const firmLibraryCount = (libraryItems ?? []).filter((i) => i.source === 'advisor').length;
  const { data: professionals } = useFirmProfessionals(firmId);
  const professionalCount = (professionals ?? []).length;

  const hasEngagement = engagementCount > 0;
  const hasAssessment = assessedCount > 0;

  const steps: Step[] = [
    {
      key: 'secure',
      title: 'Secure your account',
      body: 'Turn on two-factor authentication so client data stays protected.',
      done: mfaDone,
      action: (
        <button className="button-primary" onClick={openUserProfile}>
          Set up two-factor
        </button>
      ),
    },
    {
      key: 'engagement',
      title: 'Start your first engagement',
      body: 'Record the engagement agreement for a client to begin tracking their exit readiness.',
      done: hasEngagement,
      action: (
        <button onClick={onAddEngagement} disabled={!hasAgreement}>
          Add engagement
        </button>
      ),
    },
    {
      key: 'assessment',
      title: 'Run the baseline assessment',
      body:
        'The baseline sets the starting Diligence Readiness Score (DRS) and Owner Readiness Index (ORI) and opens the engagement’s trajectory.',
      done: hasAssessment,
      locked: !hasEngagement,
      action: hasEngagement ? (
        <button
          onClick={() => firstEngagementId && navigate(`/engagement/${firstEngagementId}`)}
          disabled={!firstEngagementId}
        >
          Go to engagement
        </button>
      ) : undefined,
    },
    {
      key: 'library',
      title: 'Add your first insight to the Library',
      body:
        firmLibraryCount > 0
          ? `Your firm has authored ${firmLibraryCount} advisory ${firmLibraryCount === 1 ? 'item' : 'items'}.`
          : 'Put your own buyer questions, value initiatives, or diligence risk flags into the Advisory Library. They fire automatically on the engagements that need them. This is how your expertise becomes part of the workspace.',
      done: firmLibraryCount > 0,
      action: (
        <Link className="button-link button-primary" to="/library">
          Open the Library
        </Link>
      ),
    },
    {
      key: 'network',
      title: 'Add people from your network',
      body:
        professionalCount > 0
          ? `You have ${professionalCount} ${professionalCount === 1 ? 'contact' : 'contacts'} in your professional directory.`
          : 'Load the attorneys, accountants, bankers, and advisors you work with so you can attach them to engagements and collaborate.',
      done: professionalCount > 0,
      action: (
        <Link className="button-link button-primary" to="/organization">
          Add professionals
        </Link>
      ),
    },
  ];

  // The one step to nudge: the first that is neither done nor locked.
  const activeKey = steps.find((s) => !s.done && !s.locked)?.key;
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  // Nothing left to guide, or the advisor has waved it off: don't take up space.
  if (dismissed || allDone) return null;

  return (
    <PageSection title="Getting started" note={`${doneCount} of ${steps.length} done`}>
      <ol className="gs-list">
        {steps.map((step, i) => {
          const active = step.key === activeKey;
          return (
            <li
              key={step.key}
              className={`gs-step${step.done ? ' gs-step-done' : ''}${active ? ' gs-step-active' : ''}${
                step.locked ? ' gs-step-locked' : ''
              }`}
            >
              <span className="gs-marker" aria-hidden>
                {step.done ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4 4 10-11" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <div className="gs-body">
                <span className="gs-step-title">{step.title}</span>
                <p className="gs-step-desc">{step.body}</p>
              </div>
              {active && step.action && <div className="gs-action">{step.action}</div>}
            </li>
          );
        })}
      </ol>
      <div className="gs-footer">
        <button type="button" className="linkish gs-dismiss" onClick={dismiss}>
          Dismiss for now
        </button>
      </div>
    </PageSection>
  );
}
