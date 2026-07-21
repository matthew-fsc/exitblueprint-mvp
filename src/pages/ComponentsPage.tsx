// Dev-only gallery (/dev/components): renders every F0 component in every
// state, the way a Storybook would. Not linked from the app; a visual
// acceptance surface for the design system.
import { useState } from 'react';
import {
  Card,
  ConfirmDialog,
  DataTable,
  DeltaChip,
  DimensionBars,
  EmptyState,
  FirmMark,
  PageHeader,
  ScoreDial,
  Skeleton,
  SkeletonLines,
  StatBlock,
  StatRow,
  Switch,
  TierBadge,
  Timeline,
  TrajectoryChart,
  useToast,
  type Column,
} from '../components/ui';
import { TIER_ORDER } from '../lib/tokens';
import { fmtCurrency, fmtScore } from '../lib/format';

interface DemoRow {
  client: string;
  drs: number;
  tier: string;
  delta: number;
}
const demoRows: DemoRow[] = [
  { client: 'Meridian Managed IT', drs: 82.6, tier: 'Sale Ready', delta: 4.2 },
  { client: 'Apex Fabrication', drs: 16.1, tier: 'Not Saleable (Yet)', delta: -2.0 },
  { client: 'Harborview Staffing', drs: 52.0, tier: 'High Risk', delta: 0 },
];
const demoCols: Column<DemoRow>[] = [
  { key: 'client', header: 'Client', sortValue: (r) => r.client },
  { key: 'drs', header: 'DRS', numeric: true, sortValue: (r) => r.drs, render: (r) => fmtScore(r.drs) },
  { key: 'tier', header: 'Tier', render: (r) => <TierBadge tier={r.tier} size="sm" /> },
  { key: 'delta', header: 'Δ', numeric: true, sortValue: (r) => r.delta, render: (r) => <DeltaChip value={r.delta} /> },
];

function GallerySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="gallery-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function ComponentsPage() {
  const [confirm, setConfirm] = useState(false);
  const [notify, setNotify] = useState(true);
  const [archived, setArchived] = useState(false);
  const [terms, setTerms] = useState(true);
  const [plan, setPlan] = useState('quarterly');
  const toast = useToast();

  return (
    <div>
      <PageHeader
        title="Component gallery"
        subtitle="Dev-only — every F0 component in every state"
        crumbs={[{ label: 'Dev' }, { label: 'Components' }]}
        actions={<span className="dev-badge">dev</span>}
      />

      <GallerySection title="ScoreDial (tier-colored)">
        <div className="gallery-row">
          <ScoreDial value={82.6} label="Sale Ready" />
          <ScoreDial value={52} label="High Risk" />
          <ScoreDial value={16.1} label="Not Saleable" />
          <ScoreDial value={91} label="Institutional" />
          <ScoreDial value={60} label="ORI" size={88} />
        </div>
      </GallerySection>

      <GallerySection title="TierBadge (all five, always labeled)">
        <div className="gallery-row">
          {TIER_ORDER.map((t) => (
            <TierBadge key={t} tier={t} />
          ))}
        </div>
        <div className="gallery-row">
          <span className="gallery-label">sizes</span>
          <TierBadge tier="Sale Ready" size="sm" />
          <TierBadge tier="Sale Ready" size="md" />
          <TierBadge tier="Sale Ready" size="lg" />
        </div>
      </GallerySection>

      <GallerySection title="DeltaChip">
        <div className="gallery-row">
          <DeltaChip value={4.2} />
          <DeltaChip value={-3.1} />
          <DeltaChip value={0} />
          <span className="gallery-label">gap counts (fewer is better)</span>
          <DeltaChip value={2} goodWhenUp={false} />
          <DeltaChip value={-1} goodWhenUp={false} />
        </div>
      </GallerySection>

      <GallerySection title="TrajectoryChart (signature)">
        <Card>
          <TrajectoryChart
            points={[
              { label: '#1', score: 45, tier: 'High Risk' },
              { label: '#2', score: 52, tier: 'High Risk', superseded: true },
              { label: '#3', score: 59.9, tier: 'Needs Work' },
              { label: '#4', score: 72.3, tier: 'Sale Ready' },
            ]}
            targetScore={85}
          />
        </Card>
      </GallerySection>

      <GallerySection title="DimensionBars">
        <Card>
          <DimensionBars
            dimensions={[
              { code: 'REV', name: 'Revenue Quality', score: 86.75 },
              { code: 'FIN', name: 'Financial Integrity', score: 91 },
              { code: 'OPS', name: 'Operational Independence', score: 52 },
              { code: 'CUS', name: 'Customer Risk', score: 41 },
              { code: 'MGT', name: 'Management & Team', score: 26 },
              { code: 'GRW', name: 'Growth Drivers', score: 74.75 },
            ]}
          />
        </Card>
      </GallerySection>

      <GallerySection title="StatBlock row">
        <StatRow>
          <StatBlock label="Engagements" value="15" />
          <StatBlock label="Avg DRS" value="61.4" aside={<DeltaChip value={3.1} />} />
          <StatBlock label="Movers this quarter" value="6" hint="up ≥ 3 points" />
          <StatBlock label="Stale ≥ 90 days" value="2" hint="need a reassessment" />
        </StatRow>
      </GallerySection>

      <GallerySection title="DataTable (sortable, sticky, states)">
        <DataTable columns={demoCols} rows={demoRows} keyFor={(r) => r.client} onRowClick={() => toast.show('Row clicked')} initialSort={{ key: 'drs', dir: 'desc' }} />
        <div style={{ height: '0.75rem' }} />
        <div className="gallery-row" style={{ display: 'block' }}>
          <span className="gallery-label">loading</span>
          <DataTable columns={demoCols} rows={[]} keyFor={() => ''} loading />
        </div>
        <div className="gallery-row" style={{ display: 'block' }}>
          <span className="gallery-label">error</span>
          <DataTable columns={demoCols} rows={[]} keyFor={() => ''} error="Network request failed" />
        </div>
        <div className="gallery-row" style={{ display: 'block' }}>
          <span className="gallery-label">empty</span>
          <DataTable columns={demoCols} rows={[]} keyFor={() => ''} />
        </div>
      </GallerySection>

      <GallerySection title="Timeline">
        <Card>
          <Timeline
            items={[
              { id: '1', time: 'Mar 3, 2026', title: 'Baseline assessment completed', body: 'DRS 45 · High Risk' },
              { id: '2', time: 'Jun 12, 2026', title: 'Owner report finalized', muted: true },
              { id: '3', time: 'Sep 30, 2026', title: 'Reassessment completed', body: 'DRS 59.9 · Needs Work' },
            ]}
          />
        </Card>
      </GallerySection>

      <GallerySection title="FirmMark">
        <div className="gallery-row">
          <FirmMark fallbackName="Cascade Wealth Partners" />
          <FirmMark brand={{ displayName: 'Northmark Advisory', logoUrl: null }} />
          <FirmMark fallbackName="Cascade Wealth Partners" poweredBy />
        </div>
      </GallerySection>

      <GallerySection title="EmptyState">
        <EmptyState
          title="No engagements yet"
          action={<button>Add your first client</button>}
        >
          Start by adding a company, then open a readiness engagement for it.
        </EmptyState>
      </GallerySection>

      <GallerySection title="Skeleton">
        <Card>
          <SkeletonLines lines={3} />
          <div style={{ height: '0.75rem' }} />
          <Skeleton width="8rem" height="2rem" />
        </Card>
      </GallerySection>

      <GallerySection title="Card + currency formatter">
        <div className="gallery-row">
          <Card>Default card · {fmtCurrency(4600000)}</Card>
          <Card pad="lg">Large padding card</Card>
        </div>
      </GallerySection>

      <GallerySection title="Buttons (hierarchy + sizes)">
        <div className="gallery-row">
          <button>Primary</button>
          <button className="btn-secondary">Secondary</button>
          <button className="btn-ghost">Ghost</button>
          <button className="btn-danger">Danger</button>
          <button disabled>Disabled</button>
        </div>
        <div className="gallery-row">
          <span className="gallery-label">small</span>
          <button className="btn-sm">Primary</button>
          <button className="btn-sm btn-secondary">Secondary</button>
          <span className="gallery-label">icon</span>
          <button className="icon-btn" aria-label="Add" title="Add">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="icon-btn icon-btn-sm" aria-label="Close" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </GallerySection>

      <GallerySection title="Switch (single boolean, applies immediately)">
        <div className="gallery-row">
          <Switch checked={notify} onChange={setNotify} label="Email notifications" hint="On completed reassessments" />
          <Switch checked={archived} onChange={setArchived} label="Show archived" />
          <Switch size="sm" checked={notify} onChange={setNotify} ariaLabel="Compact toggle" />
          <Switch checked disabled onChange={() => {}} label="Locked on" />
        </div>
      </GallerySection>

      <GallerySection title="Checkbox · radio · select (on-brand native controls)">
        <div className="gallery-row" style={{ gap: '1.5rem' }}>
          <label className="control-row" style={{ gap: '0.5rem' }}>
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span className="text-sm">Benchmarking use</span>
          </label>
          <label className="control-row" style={{ gap: '0.5rem' }}>
            <input type="checkbox" checked={false} readOnly />
            <span className="text-sm">Unchecked</span>
          </label>
          <label className="control-row" style={{ gap: '0.5rem' }}>
            <input type="checkbox" checked disabled readOnly />
            <span className="text-sm muted">Disabled</span>
          </label>
        </div>
        <div className="gallery-row" style={{ gap: '1.5rem' }}>
          {['monthly', 'quarterly', 'annual'].map((p) => (
            <label key={p} className="control-row" style={{ gap: '0.5rem' }}>
              <input type="radio" name="demo-plan" checked={plan === p} onChange={() => setPlan(p)} />
              <span className="text-sm" style={{ textTransform: 'capitalize' }}>{p}</span>
            </label>
          ))}
          <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Cadence">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
      </GallerySection>

      <GallerySection title="ConfirmDialog + Toast">
        <div className="gallery-row">
          <button onClick={() => setConfirm(true)}>Open confirm dialog</button>
          <button className="btn-ghost" onClick={() => toast.show('Saved', 'good')}>
            Success toast
          </button>
          <button className="btn-ghost" onClick={() => toast.show('Something failed', 'error')}>
            Error toast
          </button>
        </div>
        <ConfirmDialog
          open={confirm}
          title="Supersede this assessment?"
          confirmLabel="Supersede"
          danger
          onConfirm={() => {
            setConfirm(false);
            toast.show('Superseded', 'good');
          }}
          onCancel={() => setConfirm(false)}
        >
          The original assessment stays immutable; a corrected new assessment will be created and
          scored.
        </ConfirmDialog>
      </GallerySection>
    </div>
  );
}
