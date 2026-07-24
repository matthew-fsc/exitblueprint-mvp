import { useState } from 'react';
import { useOwnerContext } from '../../lib/owner';
import { useEducationModules, type EducationLibraryModule } from '../../lib/queries';
import { Card, EmptyState, ErrorState, PageHeader, SkeletonLines } from '../../components/ui';

// The nine canonical rubric dimension codes → the plain names an owner reads.
// Owners never see raw codes like "FIN" (docs/26 UI system, machine-artifact
// rule); the code stays for authoring and the advisor Library.
const DIMENSION_LABELS: Record<string, string> = {
  REV: 'Revenue Quality',
  FIN: 'Financial Integrity',
  OPS: 'Operational Independence',
  CUS: 'Customer Risk',
  MGT: 'Management and Team',
  GRW: 'Growth Drivers',
  GOL: 'Exit Goals and Timing',
  PFN: 'Personal Financial Readiness',
  VAL: 'Value Confidence',
};

function ModuleCard({ m }: { m: EducationLibraryModule }) {
  const [open, setOpen] = useState(false);
  const dimLabel = m.dimension_code
    ? (DIMENSION_LABELS[m.dimension_code] ?? null)
    : null;
  const bodyId = `learn-body-${m.code ?? m.id}`;
  return (
    <div className={`learn-item ${m.recommended ? 'learn-item-rec' : ''}`}>
      <button
        className="learn-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="learn-titles">
          <span className="learn-title">{m.title}</span>
          {dimLabel && <span className="learn-dim">{dimLabel}</span>}
        </span>
        <span className="learn-toggle" aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && <div className="learn-body" id={bodyId}>{m.body}</div>}
    </div>
  );
}

export default function OwnerLearnPage() {
  const { engagement, loading, isError, error, refetch } = useOwnerContext();
  const eduQ = useEducationModules(engagement?.id);
  const modules = eduQ.data?.modules ?? [];
  const recommended = modules.filter((m) => m.recommended);
  const rest = modules.filter((m) => !m.recommended);

  return (
    <div className="stack-lg">
      <PageHeader
        title="Learn"
        subtitle="Short guides on what buyers look for. The ones tied to your gaps are marked for you."
      />
      {loading || eduQ.isLoading ? (
        <Card><SkeletonLines lines={6} /></Card>
      ) : isError || eduQ.isError ? (
        <ErrorState variant="section" error={error ?? eduQ.error} onRetry={refetch} />
      ) : modules.length === 0 ? (
        <EmptyState title="Guides coming soon">
          Educational content will appear here as your engagement progresses.
        </EmptyState>
      ) : (
        <>
          {recommended.length > 0 && (
            <section>
              <h3 className="section-heading">Recommended for you <span className="muted">· {recommended.length}</span></h3>
              <Card><div className="learn-list">{recommended.map((m) => <ModuleCard key={m.code ?? m.id} m={m} />)}</div></Card>
            </section>
          )}
          <section>
            <h3 className="section-heading">All guides <span className="muted">· {rest.length}</span></h3>
            <Card><div className="learn-list">{rest.map((m) => <ModuleCard key={m.code ?? m.id} m={m} />)}</div></Card>
          </section>
        </>
      )}
    </div>
  );
}
