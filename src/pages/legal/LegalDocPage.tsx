import type { ReactNode } from 'react';
import { PageHeader, PageSection, SectionCard } from '../../components/ui';
import { DRAFT_BANNER, type LegalDoc } from './content';

// The unmissable draft banner every legal page leads with. Built from existing
// design-system primitives (a warning status chip + card surface) — no new CSS.
// This scaffold is deliberately NOT final legal text; the banner says so.
export function DraftBanner() {
  return (
    <SectionCard
      title="Draft — not final"
      subtitle="This is a template scaffold, not the published agreement."
    >
      <p className="m-0">
        <span className="status-chip status-warning" style={{ marginRight: 'var(--space-2)' }}>
          Draft
        </span>
        {DRAFT_BANNER}
      </p>
    </SectionCard>
  );
}

// Shared shell for the four legal documents. Self-contained (renders its own
// `main.page` wrapper) so it works as a standalone public route with no auth and
// no app chrome — the integrator only needs to mount the route. `children`
// renders after the prose sections (e.g. the sub-processor table).
export function LegalDocPage({ doc, children }: { doc: LegalDoc; children?: ReactNode }) {
  return (
    <main className="page">
      <div className="page-shell">
        <header className="page-masthead">
          <PageHeader
            title={doc.title}
            subtitle={doc.subtitle}
            crumbs={[{ label: 'Exit Blueprint' }, { label: doc.title }]}
          />
        </header>

        <DraftBanner />

        <PageSection title="Document" note={`Last updated ${doc.lastUpdated}`}>
          <div className="stack-lg">
            {doc.sections.map((section) => (
              <SectionCard key={section.heading} title={section.heading}>
                {section.body.map((para, i) => (
                  <p key={i} className={i === 0 ? 'm-0' : undefined} style={i > 0 ? { marginBottom: 0 } : undefined}>
                    {para}
                  </p>
                ))}
              </SectionCard>
            ))}
            {children}
          </div>
        </PageSection>
      </div>
    </main>
  );
}
