import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  useAssessmentsByEngagement,
  useCompany,
  useEngagement,
  useVerification,
} from '../lib/queries';
import { EngagementNav, PageHeader, SubTabs, type SubTab } from '../components/ui';
import { DataRoomPanel } from './DataRoomPage';
import { DocumentsPanel } from './DocumentsPage';
import { VerificationPanel } from './VerificationPage';

// Evidence is one job — building the diligence binder — that used to read as
// three separate tools (Data room · Documents · Verification), each its own tab
// and page (docs/22 F2). This folds them into a single Evidence surface: one
// masthead with the single verification number the whole stream rolls up to, and
// a sub-tab switcher for the three views. The three panels keep their own logic
// (imported from the original files); only the chrome is consolidated.

const SECTIONS = ['data-room', 'documents', 'verification'] as const;
type Section = (typeof SECTIONS)[number];

const TABS: SubTab[] = [
  { key: 'data-room', label: 'Data room' },
  { key: 'documents', label: 'Documents' },
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

  const active: Section = SECTIONS.includes(section as Section)
    ? (section as Section)
    : 'data-room';

  const companyName = companyQ.data?.name ?? '';
  const pct = verifQ.data?.pct ?? null;

  return (
    <div className="page-shell">
      <header className="page-masthead">
        <PageHeader
          title="Evidence"
          crumbs={[
            { label: 'Portfolio', to: '/' },
            { label: companyName, to: `/engagement/${engagementId}` },
            { label: 'Evidence' },
          ]}
          subtitle={
            <>
              The diligence binder for {companyName || 'this engagement'} — the buyer's request
              list, source documents, and what's proven.
              {pct != null && (
                <>
                  {' '}
                  <strong>{pct}% of financial inputs verified.</strong>
                </>
              )}
            </>
          }
          actions={
            latest ? (
              <Link className="button-link" to={`/assessment/${latest.id}/cim`}>
                Package into CIM →
              </Link>
            ) : undefined
          }
        />
        {engagementId && <EngagementNav engagementId={engagementId} />}
      </header>

      <SubTabs
        tabs={TABS}
        activeKey={active}
        ariaLabel="Evidence sections"
        onSelect={(key) => navigate(`/engagement/${engagementId}/evidence/${key}`)}
      />

      <div className="subtabs-panel">
        {active === 'data-room' && <DataRoomPanel />}
        {active === 'documents' && <DocumentsPanel />}
        {active === 'verification' && <VerificationPanel />}
      </div>
    </div>
  );
}
