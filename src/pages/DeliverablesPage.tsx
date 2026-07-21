import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useAssessmentsByEngagement, useCompany, useEngagement } from '../lib/queries';
import {
  Card,
  EmptyState,
  EngagementNav,
  PageHeader,
  SkeletonLines,
  SubTabs,
  subTabId,
  subTabPanelId,
  type SubTab,
} from '../components/ui';
import { fmtDate, fmtScore } from '../lib/format';
import { engagementCrumbs } from '../lib/nav';
import { CLIENT_DOCUMENT_TYPES, documentTypeForSection } from '../../shared/documents/catalog';
import { OwnerReportPanel } from './ReportPage';
import { DeltaReportPanel } from './DeltaReportPage';
import { CimPanel } from './CimPage';

// The Deliverables studio — the one place an advisor curates every client
// document (docs/17 §5). It consolidates what used to be three scattered pages
// (owner report, delta report, CIM) into a single tabbed surface, exactly as the
// Evidence work stream folded its three tools into one (docs/archive/22 F2): one
// masthead, one assessment selector, and a sub-tab per deliverable. Each panel
// reads the same selected assessment, so an advisor picks a point in time once
// and every document reflects it. The documents themselves are built from
// deterministic scoring output plus an AI (or rule-composed) narrator — the
// catalog of types lives in shared/documents/catalog.ts, the single source of
// truth this page and the server-side renderer both read.
const TABS: SubTab[] = CLIENT_DOCUMENT_TYPES.map((d) => ({ key: d.section, label: d.title }));

export default function DeliverablesPage() {
  const { engagementId, section } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const companyName = companyQ.data?.name ?? '';
  const assessmentsQ = useAssessmentsByEngagement(engagementId);
  const completed = (assessmentsQ.data ?? []).filter((a) => a.status === 'completed' && a.drs_score != null);

  // The active deliverable (owner | delta | cim), from the :section route segment.
  const activeType = documentTypeForSection(section ?? '') ?? CLIENT_DOCUMENT_TYPES[0];
  const active = activeType.section;

  // The selected assessment drives every panel. Deep-linked via ?assessment=<id>
  // so a bookmark or a redirect from an old per-assessment route lands on the
  // right one; defaults to the latest completed assessment.
  const requested = searchParams.get('assessment');
  const selectedId =
    completed.find((a) => a.id === requested)?.id ?? completed[completed.length - 1]?.id ?? '';

  const selectAssessment = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('assessment', id);
    setSearchParams(next, { replace: true });
  };

  const goSection = (nextSection: string) => {
    const qs = searchParams.toString();
    navigate(`/engagement/${engagementId}/deliverables/${nextSection}${qs ? `?${qs}` : ''}`);
  };

  if (engagementQ.isLoading || assessmentsQ.isLoading) return <SkeletonLines lines={6} />;

  return (
    <div className="page-shell report">
      <header className="page-masthead no-print">
        <PageHeader
          title="Deliverables"
          crumbs={engagementCrumbs(engagementId, companyName, 'Deliverables')}
          subtitle="Curate the client documents — the score becomes the story, drafted by an AI narrator from the deterministic results, then finalized and branded."
        />
        {engagementId && <EngagementNav engagementId={engagementId} />}
      </header>

      {completed.length === 0 ? (
        <EmptyState title="No completed assessments yet">
          Complete a baseline assessment first — the deliverables are drafted from its scores and flagged
          gaps.
        </EmptyState>
      ) : (
        <>
          <Card>
            <div className="compare-controls">
              <label className="filter-control">
                <span className="filter-label">Assessment</span>
                <select value={selectedId} onChange={(e) => selectAssessment(e.target.value)}>
                  {completed.map((a) => (
                    <option key={a.id} value={a.id}>
                      #{a.sequence_number} · DRS {fmtScore(Number(a.drs_score))} ·{' '}
                      {a.completed_at ? fmtDate(a.completed_at) : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted delta-compared-against">
                {activeType.blurb}
              </p>
            </div>
          </Card>

          <SubTabs
            tabs={TABS}
            activeKey={active}
            ariaLabel="Client documents"
            onSelect={goSection}
          />

          <div
            className="subtabs-panel"
            role="tabpanel"
            id={subTabPanelId(active)}
            aria-labelledby={subTabId(active)}
            tabIndex={0}
          >
            {active === 'owner' && <OwnerReportPanel assessmentId={selectedId} />}
            {active === 'delta' && <DeltaReportPanel assessmentId={selectedId} engagementId={engagementId} />}
            {active === 'cim' && <CimPanel assessmentId={selectedId} engagementId={engagementId} />}
          </div>
        </>
      )}
    </div>
  );
}
