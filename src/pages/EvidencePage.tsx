import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  useAssessmentsByEngagement,
  useCompany,
  useEngagement,
  useEvidenceCoverage,
  useVerification,
} from '../lib/queries';
import { EngagementNav, PageHeader, SubTabs, subTabId, subTabPanelId, type SubTab } from '../components/ui';
import { DataRoomPanel } from './DataRoomPage';
import { DocumentsPanel } from './DocumentsPage';
import { VerificationPanel } from './VerificationPage';
import { ReviewPanel } from './ReviewQueuePage';

// The binder never explains itself: an advisor lands on a big checklist and a
// verification % with no sense of how the two connect or how to move the number.
// This strip lays out the 0→100 path once, at the top, and names the review
// queue as the step that turns an uploaded file into a verified fact — the
// hand-off that was previously invisible.
function EvidenceGuide({ active }: { active: Section }) {
  const steps: { key: Section | 'cim'; n: number; title: string; body: string; to?: string }[] = [
    {
      key: 'data-room',
      n: 1,
      title: 'Assemble the request list',
      body: "Work the buyer's diligence list. Set each item's readiness and attach its source file. Tracked as Data-room readiness.",
    },
    {
      key: 'documents',
      n: 2,
      title: 'Upload & review',
      body: 'Uploads run scan → extraction → review, where a reviewer confirms the figures. Attach files to a list item so they stay tracked.',
      to: '/review',
    },
    {
      key: 'verification',
      n: 3,
      title: 'Verify the figures',
      body: 'Self-reported answers reconcile against the documents; confirmed values become the proof behind the score and the % above.',
    },
    {
      key: 'cim',
      n: 4,
      title: 'Package into CIM',
      body: 'Once the binder is ready, assemble the buyer-facing book from what you have proven.',
    },
  ];
  return (
    <ol className="evidence-guide" aria-label="How the diligence binder reaches 100%">
      {steps.map((s) => {
        const isActive = s.key === active;
        const inner = (
          <>
            <span className="evidence-guide-n" aria-hidden>{s.n}</span>
            <span className="evidence-guide-text">
              <span className="evidence-guide-title">
                {s.title}
                {s.to && <span className="evidence-guide-link" aria-hidden> →</span>}
              </span>
              <span className="evidence-guide-body">{s.body}</span>
            </span>
          </>
        );
        return (
          <li key={s.key} className={`evidence-guide-step ${isActive ? 'is-active' : ''}`}>
            {s.to ? (
              <Link className="evidence-guide-hit" to={s.to}>
                {inner}
              </Link>
            ) : (
              <span className="evidence-guide-hit">{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// Evidence is one job — building the diligence binder — that used to read as
// three separate tools (Data room · Documents · Verification), each its own tab
// and page (docs/archive/22 F2). This folds them into a single Evidence surface: one
// masthead with the single verification number the whole stream rolls up to, and
// a sub-tab switcher for the three views. The three panels keep their own logic
// (imported from the original files); only the chrome is consolidated.

const SECTIONS = ['data-room', 'documents', 'review', 'verification'] as const;
type Section = (typeof SECTIONS)[number];

const TABS: SubTab[] = [
  { key: 'data-room', label: 'Data room' },
  { key: 'documents', label: 'Documents' },
  { key: 'review', label: 'Review' },
  { key: 'verification', label: 'Verification' },
];

export default function EvidencePage() {
  const { engagementId, section } = useParams();
  const navigate = useNavigate();

  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const assessmentsQ = useAssessmentsByEngagement(engagementId);
  const completed = (assessmentsQ.data ?? []).filter(
    (a) => a.status === 'completed' && a.drs_score != null,
  );
  const latest = completed[completed.length - 1] ?? null;
  const verifQ = useVerification(latest?.id);
  const coverageQ = useEvidenceCoverage(engagementId);

  const active: Section = SECTIONS.includes(section as Section)
    ? (section as Section)
    : 'data-room';

  const companyName = companyQ.data?.name ?? '';
  const v = verifQ.data ?? null;
  const cov = coverageQ.data ?? null;

  return (
    <div className="page-shell">
      <header className="page-masthead">
        <PageHeader
          title="Evidence"
          crumbs={[
            { label: 'Engagements', to: '/' },
            { label: companyName, to: `/engagement/${engagementId}` },
            { label: 'Evidence' },
          ]}
          subtitle={
            <>
              One binder, built in three stages: assemble the buyer's request list, upload
              and review source files, then verify the figures behind the score. The tabs
              below are stages of this one job, each with its own progress figure.
              {cov != null && (
                <>
                  {' '}
                  <strong>
                    Diligence binder: {cov.verified} of {cov.total} items proven ({cov.pct}%)
                  </strong>, request-list items marked Ready and backed by a verified document.
                  {v != null && (
                    <>
                      {' '}
                      Separately, {v.verified_inputs} of {v.total_inputs} scored financial
                      inputs are verified ({v.pct}%), the proof behind the score.
                    </>
                  )}
                </>
              )}
            </>
          }
          actions={
            latest ? (
              <Link
                className="button-link"
                to={`/engagement/${engagementId}/deliverables/cim?assessment=${latest.id}`}
              >
                Package into CIM →
              </Link>
            ) : undefined
          }
        />
        {engagementId && <EngagementNav engagementId={engagementId} />}
      </header>

      <EvidenceGuide active={active} />

      <SubTabs
        tabs={TABS}
        activeKey={active}
        ariaLabel="Evidence sections"
        onSelect={(key) => navigate(`/engagement/${engagementId}/evidence/${key}`)}
      />

      <div
        className="subtabs-panel"
        role="tabpanel"
        id={subTabPanelId(active)}
        aria-labelledby={subTabId(active)}
        tabIndex={0}
      >
        {active === 'data-room' && <DataRoomPanel />}
        {active === 'documents' && <DocumentsPanel />}
        {active === 'review' && <ReviewPanel engagementId={engagementId} />}
        {active === 'verification' && <VerificationPanel />}
      </div>
    </div>
  );
}
