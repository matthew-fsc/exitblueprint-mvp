import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageSection } from './ui';
import { getMfaState } from '../lib/mfa';
import { isDevStack } from '../lib/supabase';

// First-run activation checklist for a new advisor (docs/archive/35 "thin
// first-run onboarding"). Guides the three steps that turn an empty workspace
// into a tracked engagement — secure the account, start an engagement, run the
// baseline assessment — and self-dismisses once the firm has its first score,
// so an established book never sees it (the parent only mounts it while no
// engagement has been assessed).
//
// Deliberately not a wizard: each step links to where the work already happens
// (Settings for MFA, the add-engagement dialog, the engagement page). It reads
// the same signals the dashboard already has, adding only the MFA lookup.

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
  onAddEngagement,
}: {
  engagementCount: number;
  hasAgreement: boolean;
  firstEngagementId: string | null;
  onAddEngagement: () => void;
}) {
  const navigate = useNavigate();
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

  const hasEngagement = engagementCount > 0;

  const steps: Step[] = [
    {
      key: 'secure',
      title: 'Secure your account',
      body: 'Turn on two-factor authentication so client data stays protected.',
      done: mfaDone,
      action: (
        <Link className="button-link button-primary" to="/settings">
          Set up two-factor
        </Link>
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
        'The baseline sets the starting Deal Readiness Score (DRS) and Owner Readiness Index (ORI) and opens the engagement’s trajectory.',
      done: false, // this panel unmounts once the first assessment exists
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
  ];

  // The one step to nudge: the first that is neither done nor locked.
  const activeKey = steps.find((s) => !s.done && !s.locked)?.key;
  const doneCount = steps.filter((s) => s.done).length;

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
    </PageSection>
  );
}
