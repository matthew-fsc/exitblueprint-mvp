import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ConfirmDialog,
  DataTable,
  DeltaChip,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSection,
  Sparkline,
  StatBlock,
  StatRow,
  TierBadge,
  useToast,
  type Column,
} from '../components/ui';
import {
  qk,
  useActiveAgreementVersions,
  useCompanies,
  useEngagements,
  useFirmAttention,
  usePortfolio,
  type AgreementVersionRow,
  type AttentionShape,
  type CompanyRow,
  type EngagementRow,
  type PortfolioRow,
} from '../lib/queries';
import { useAuth } from '../lib/auth';
import { GettingStarted } from '../components/GettingStarted';
import { invokeFunction, supabase } from '../lib/supabase';
import { track } from '../lib/analytics';
import { TIER_ORDER } from '../lib/tokens';
import { daysSince, fmtScore } from '../lib/format';

const STALE_DAYS = 90;

type TierFilter = 'all' | (typeof TIER_ORDER)[number];
type MoveFilter = 'all' | 'up' | 'down' | 'stale';

const ATTENTION_PREVIEW = 4; // rows shown per group before "+N more"

// In-app "Needs attention" worklist (docs/archive/35 Phase 9). Surfaces the same signals
// the n8n continuous-eval webhooks compute — reassessment due, stalled tasks,
// stale engagements — so an advisor sees what needs doing without an external
// nudge. Hidden entirely when nothing is due (the stat band already shows the
// all-clear); read-only, links straight to the engagement.
function AttentionGroup<T extends { engagementId: string; companyName: string | null }>({
  title,
  items,
  emphasis,
  render,
  onOpen,
}: {
  title: string;
  items: T[];
  emphasis?: boolean;
  render: (it: T) => string;
  onOpen: (engagementId: string) => void;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, ATTENTION_PREVIEW);
  const more = items.length - shown.length;
  return (
    <div className="attn-group">
      <div className="attn-group-head">
        <span className={`attn-count ${emphasis ? 'attn-count-warn' : ''}`}>{items.length}</span>
        <span className="attn-group-title">{title}</span>
      </div>
      <ul className="attn-list">
        {shown.map((it, i) => (
          <li key={i}>
            <button className="attn-item" onClick={() => onOpen(it.engagementId)}>
              <span className="attn-company">{it.companyName ?? 'Untitled engagement'}</span>
              <span className="attn-reason">{render(it)}</span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="attn-more muted text-sm">+{more} more</p>}
    </div>
  );
}

function AttentionPanel({ data }: { data: AttentionShape }) {
  const navigate = useNavigate();
  const open = (id: string) => navigate(`/engagement/${id}`);
  return (
    <PageSection title="Needs attention" note={`${data.counts.total} item${data.counts.total === 1 ? '' : 's'}`}>
      <div className="attn-grid">
        <AttentionGroup
          title="Reassessment due"
          items={data.reassessmentDue}
          onOpen={open}
          render={(it) => `last assessed ${it.daysSinceLastAssessment} days ago`}
        />
        <AttentionGroup
          title="Stalled tasks"
          items={data.stalledTasks}
          emphasis
          onOpen={open}
          render={(t) => (t.pastDue ? `${t.title} — ${t.daysOverdue}d overdue` : `${t.title} — untouched ${t.daysStalled}d`)}
        />
        <AttentionGroup
          title="Gone quiet"
          items={data.staleEngagements}
          onOpen={open}
          render={(it) => `no activity in ${it.daysStale} days`}
        />
      </div>
    </PageSection>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const portfolioQ = usePortfolio();
  const rows = portfolioQ.data ?? [];
  const companiesQ = useCompanies();
  const engagementsQ = useEngagements();
  const attentionQ = useFirmAttention();
  const agreementsQ = useActiveAgreementVersions();
  const agreement: AgreementVersionRow | undefined = agreementsQ.data?.[0];
  const [tier, setTier] = useState<TierFilter>('all');
  const [move, setMove] = useState<MoveFilter>('all');
  const [adding, setAdding] = useState(false);

  const assessed = rows.filter((r) => r.latestDrs != null);
  const avgDrs = assessed.length
    ? Math.round((assessed.reduce((a, r) => a + (r.latestDrs ?? 0), 0) / assessed.length) * 10) / 10
    : null;
  const movers = rows.filter((r) => (r.delta ?? 0) >= 3).length;
  const staleCount = rows.filter((r) => {
    const d = daysSince(r.latestAt);
    return r.latestAt != null && d != null && d >= STALE_DAYS;
  }).length;

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tier !== 'all' && r.latestTier !== tier) return false;
      const d = daysSince(r.latestAt);
      if (move === 'up' && !((r.delta ?? 0) > 0)) return false;
      if (move === 'down' && !((r.delta ?? 0) < 0)) return false;
      if (move === 'stale' && !(r.latestAt != null && d != null && d >= STALE_DAYS)) return false;
      return true;
    });
  }, [rows, tier, move]);

  const columns: Column<PortfolioRow>[] = [
    {
      key: 'company',
      header: 'Client',
      sortValue: (r) => r.companyName.toLowerCase(),
      render: (r) => (
        <span>
          <strong>{r.companyName}</strong>
          {r.industry && <span className="muted text-sm" style={{ display: 'block' }}>{r.industry}</span>}
        </span>
      ),
    },
    {
      key: 'drs',
      header: 'DRS',
      numeric: true,
      sortValue: (r) => r.latestDrs ?? -1,
      render: (r) => (r.latestDrs != null ? <strong>{fmtScore(r.latestDrs)}</strong> : <span className="muted">—</span>),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortValue: (r) => (r.latestTier ? TIER_ORDER.indexOf(r.latestTier as (typeof TIER_ORDER)[number]) : -1),
      render: (r) => (r.latestTier ? <TierBadge tier={r.latestTier} size="sm" /> : <span className="muted">no assessment</span>),
    },
    {
      key: 'delta',
      header: 'Δ since prior',
      numeric: true,
      sortValue: (r) => r.delta ?? 0,
      render: (r) =>
        r.deltaState === 'value' ? (
          <DeltaChip value={r.delta} />
        ) : r.deltaState === 'incomparable' ? (
          <span className="muted" title="Prior assessment used a different rubric version — scores are not comparable" style={{ whiteSpace: 'nowrap' }}>
            new rubric
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'trend',
      header: 'Trend',
      render: (r) => <Sparkline points={r.points} />,
    },
    {
      key: 'gaps',
      header: 'Open gaps',
      numeric: true,
      sortValue: (r) => r.openGaps,
      render: (r) => (r.openGaps > 0 ? <span className="count-pill">{r.openGaps}</span> : <span className="muted">0</span>),
    },
    {
      key: 'stale',
      header: 'Last assessed',
      numeric: true,
      sortValue: (r) => daysSince(r.latestAt) ?? 99999,
      render: (r) => {
        const d = daysSince(r.latestAt);
        if (r.latestAt == null || d == null) return <span className="muted">never</span>;
        const stale = d >= STALE_DAYS;
        return (
          <span className={stale ? 'stale-flag' : 'muted'} style={{ whiteSpace: 'nowrap' }}>
            {d}d ago{stale ? ' · stale' : ''}
          </span>
        );
      },
    },
  ];

  const isLoading = portfolioQ.isLoading;
  const engagements = engagementsQ.data ?? [];
  // First-run activation checklist: shown until the firm records its first
  // assessment, then it self-dismisses so an established book never sees it.
  const showGettingStarted =
    !isLoading && !engagementsQ.isLoading && assessed.length === 0;
  const filtersActive = tier !== 'all' || move !== 'all';
  // Two distinct empty states: a genuinely empty book vs. filters that excluded
  // everything — telling a user with a full book to "add your first client"
  // would be a misleading dead end.
  const emptyNode = filtersActive ? (
    <EmptyState
      icon="search"
      title="No engagements match these filters"
      action={
        <button
          className="btn-secondary"
          onClick={() => {
            setTier('all');
            setMove('all');
          }}
        >
          Clear filters
        </button>
      }
    >
      No engagement in your book matches the current tier and movement filters.
    </EmptyState>
  ) : (
    <EmptyState
      title="No engagements yet"
      action={
        <button onClick={() => setAdding(true)} disabled={!agreement}>
          Add engagement
        </button>
      }
    >
      Start a readiness engagement for a client to begin tracking it here. Each
      engagement measures a Deal Readiness Score (DRS) and Owner Readiness Index
      (ORI), then tracks them over time.
    </EmptyState>
  );

  return (
    <div className="page-shell">
      <header className="page-masthead">
        <PageHeader
          title="Engagements"
          subtitle="Exit-readiness engagements across your book, ordered by attention needed."
          actions={
            <button
              onClick={() => setAdding(true)}
              disabled={!agreement}
              title={agreement ? undefined : 'Your firm has no active engagement agreement yet'}
            >
              Add engagement
            </button>
          }
        />
      </header>

      {showGettingStarted && (
        <GettingStarted
          engagementCount={engagements.length}
          hasAgreement={!!agreement}
          firstEngagementId={engagements[0]?.id ?? null}
          onAddEngagement={() => setAdding(true)}
        />
      )}

      {!agreementsQ.isLoading && !agreement && (
        <ErrorState
          variant="section"
          title="No engagement agreement"
          message="Your firm has no active engagement agreement, so new engagements can’t be started yet. New firms are set up with a default agreement automatically — if you’re seeing this, contact your Exit Blueprint administrator to add one."
        />
      )}

      <PageSection title="Book at a glance" note="Where the engagement stands today">
        <StatRow>
          <StatBlock label="Engagements" value={isLoading ? '—' : rows.length} hint="active in your book" />
          <StatBlock label="Average DRS" value={isLoading ? '—' : avgDrs ?? '—'} hint="across the book" />
          <StatBlock label="Movers this quarter" value={isLoading ? '—' : movers} hint="up ≥ 3 points vs prior" />
          <StatBlock
            label="Stale ≥ 90 days"
            value={isLoading ? '—' : staleCount}
            hint={isLoading ? 'across the book' : staleCount > 0 ? 'need a reassessment' : 'all current'}
          />
        </StatRow>
      </PageSection>

      {attentionQ.data && attentionQ.data.counts.total > 0 && <AttentionPanel data={attentionQ.data} />}

      <PageSection
        title="Engagements"
        note={!isLoading && rows.length > 0 ? `${filtered.length} of ${rows.length} shown` : undefined}
      >
        <div className="filter-row">
          <label className="filter-control">
            <span className="filter-label">Tier</span>
            <select value={tier} onChange={(e) => setTier(e.target.value as TierFilter)}>
              <option value="all">All tiers</option>
              {TIER_ORDER.slice().reverse().map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-control">
            <span className="filter-label">Show</span>
            <select value={move} onChange={(e) => setMove(e.target.value as MoveFilter)}>
              <option value="all">Everything</option>
              <option value="up">Improving</option>
              <option value="down">Declining</option>
              <option value="stale">Stale (≥ 90 days)</option>
            </select>
          </label>
        </div>

        <DataTable
          columns={columns}
          rows={filtered}
          keyFor={(r) => r.engagementId}
          onRowClick={(r) => navigate(`/engagement/${r.engagementId}`)}
          loading={isLoading}
          error={portfolioQ.error?.message ?? null}
          initialSort={{ key: 'stale', dir: 'desc' }}
          empty={emptyNode}
        />
      </PageSection>

      {/* Add-engagement flow (merged from the former Clients tab): pick an
          existing client without an engagement or add a new company, record the
          agreement acceptance, and land inside the new engagement. Mounted only
          while open so its form state is fresh each time. */}
      {adding && (
        <AddEngagementDialog
          agreement={agreement}
          companies={companiesQ.data ?? []}
          engagements={engagementsQ.data ?? []}
          onClose={() => setAdding(false)}
          onCreated={(engagementId) => {
            setAdding(false);
            navigate(`/engagement/${engagementId}`);
          }}
        />
      )}
    </div>
  );
}

const NEW_COMPANY = '__new__';

function AddEngagementDialog({
  agreement,
  companies,
  engagements,
  onClose,
  onCreated,
}: {
  agreement: AgreementVersionRow | undefined;
  companies: CompanyRow[];
  engagements: EngagementRow[];
  onClose: () => void;
  onCreated: (engagementId: string) => void;
}) {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  // A company can hold one engagement, so only clients without one are eligible;
  // everything else is created fresh.
  const eligible = companies.filter((c) => !engagements.some((e) => e.company_id === c.id));

  const [companyId, setCompanyId] = useState<string>(NEW_COMPANY);
  const [newName, setNewName] = useState('');
  const [newIndustry, setNewIndustry] = useState('');
  const [signer, setSigner] = useState('');
  const [consentBenchmarking, setConsentBenchmarking] = useState(false);
  const [consentAggregation, setConsentAggregation] = useState(false);
  const [consentOutcome, setConsentOutcome] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNew = companyId === NEW_COMPANY;

  const confirm = async () => {
    if (!agreement) return;
    setError(null);
    if (isNew && !newName.trim()) {
      setError('Enter a company name.');
      return;
    }
    if (!signer.trim()) {
      setError('Enter who accepted the agreement on the client’s behalf.');
      return;
    }
    setSubmitting(true);
    try {
      let cid = companyId;
      if (isNew) {
        const { data: created, error: cErr } = await supabase
          .from('companies')
          .insert([{ firm_id: profile!.firm_id, name: newName.trim(), industry: newIndustry.trim() || null }])
          .select('id')
          .single();
        if (cErr) throw new Error(cErr.message);
        cid = created.id;
        qc.invalidateQueries({ queryKey: qk.companies() });
      }
      const createdEng = await invokeFunction<{ engagement_id: string }>('create-engagement', {
        company_id: cid,
        agreement_version_id: agreement.id,
        signer_name: signer.trim(),
        consent: {
          benchmarking: consentBenchmarking,
          anonymized_aggregation: consentAggregation,
          outcome_tracking: consentOutcome,
        },
      });
      track({
        type: 'onboarding',
        name: 'engagement_started',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        engagementId: createdEng.engagement_id,
        properties: {
          consent_benchmarking: consentBenchmarking,
          consent_anonymized_aggregation: consentAggregation,
          consent_outcome_tracking: consentOutcome,
        },
      });
      qc.invalidateQueries({ queryKey: qk.engagements() });
      qc.invalidateQueries({ queryKey: qk.portfolio() });
      toast.show('Agreement recorded — engagement started', 'good');
      onCreated(createdEng.engagement_id);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title="New engagement"
      confirmLabel="Record acceptance & start"
      cancelLabel="Cancel"
      busy={submitting}
      onCancel={() => (submitting ? undefined : onClose())}
      onConfirm={confirm}
    >
      {!agreement ? (
        <ErrorState
          variant="inline"
          title="No engagement agreement"
          message="Your firm has no active engagement agreement, so new engagements can’t be started yet."
        />
      ) : (
        <div className="agreement-accept">
          <label className="agreement-signer">
            <span>Client</span>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value={NEW_COMPANY}>＋ Add a new company…</option>
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.industry ? ` · ${c.industry}` : ''}
                </option>
              ))}
            </select>
          </label>

          {isNew && (
            <div className="add-eng-newco">
              <input
                placeholder="Company name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                placeholder="Industry (optional)"
                value={newIndustry}
                onChange={(e) => setNewIndustry(e.target.value)}
              />
            </div>
          )}

          <p className="muted agreement-version">
            {agreement.title} · version {agreement.version_label}
          </p>
          <div className="agreement-body">{agreement.body_md}</div>

          <label className="agreement-signer">
            <span>Client signatory (who accepted)</span>
            <input
              value={signer}
              onChange={(e) => setSigner(e.target.value)}
              placeholder="e.g. Jane Owner, CEO"
            />
          </label>

          <fieldset className="agreement-consents">
            <legend>Data-use consent (as authorized by the client)</legend>
            <label>
              <input
                type="checkbox"
                checked={consentBenchmarking}
                onChange={(e) => setConsentBenchmarking(e.target.checked)}
              />
              Benchmarking use
            </label>
            <label>
              <input
                type="checkbox"
                checked={consentAggregation}
                onChange={(e) => setConsentAggregation(e.target.checked)}
              />
              Anonymized aggregation
            </label>
            <label>
              <input
                type="checkbox"
                checked={consentOutcome}
                onChange={(e) => setConsentOutcome(e.target.checked)}
              />
              Outcome tracking
            </label>
          </fieldset>

          {error && <ErrorState variant="inline" error={error} />}
        </div>
      )}
    </ConfirmDialog>
  );
}
