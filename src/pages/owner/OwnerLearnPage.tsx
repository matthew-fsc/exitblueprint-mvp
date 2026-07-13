import { useState } from 'react';
import { useOwnerContext } from '../../lib/owner';
import { useEducation, type EducationModule } from '../../lib/queries';
import { Card, EmptyState, PageHeader, SkeletonLines } from '../../components/ui';

function ModuleCard({ m }: { m: EducationModule }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`learn-item ${m.recommended ? 'learn-item-rec' : ''}`}>
      <button className="learn-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="learn-titles">
          <span className="learn-title">{m.title}</span>
          {m.dimension_code && <span className="learn-dim">{m.dimension_code}</span>}
        </span>
        <span className="learn-toggle">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="learn-body">{m.body_md}</div>}
    </div>
  );
}

export default function OwnerLearnPage() {
  const { engagement, latest, loading } = useOwnerContext();
  const eduQ = useEducation(engagement?.id, latest?.rubric_version_id);
  const modules = eduQ.data ?? [];
  const recommended = modules.filter((m) => m.recommended);
  const rest = modules.filter((m) => !m.recommended);

  return (
    <div className="stack-lg">
      <PageHeader
        title="Learn"
        subtitle="Short guides on what buyers look for — the ones tied to your gaps are marked for you."
      />
      {loading || eduQ.isLoading ? (
        <Card><SkeletonLines lines={6} /></Card>
      ) : modules.length === 0 ? (
        <EmptyState title="Guides are on the way">
          Educational content will appear here as your engagement progresses.
        </EmptyState>
      ) : (
        <>
          {recommended.length > 0 && (
            <section>
              <h3 className="section-heading">Recommended for you <span className="muted">· {recommended.length}</span></h3>
              <Card><div className="learn-list">{recommended.map((m) => <ModuleCard key={m.code} m={m} />)}</div></Card>
            </section>
          )}
          <section>
            <h3 className="section-heading">All guides <span className="muted">· {rest.length}</span></h3>
            <Card><div className="learn-list">{rest.map((m) => <ModuleCard key={m.code} m={m} />)}</div></Card>
          </section>
        </>
      )}
    </div>
  );
}
