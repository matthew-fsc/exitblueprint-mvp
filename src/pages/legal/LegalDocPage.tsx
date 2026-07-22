import type { ReactNode } from 'react';
import { PageHeader, PageSection, SectionCard } from '../../components/ui';
import { BETA_NOTICE, type LegalDoc } from './content';

// The plain-language beta summary every legal page leads with. Built from
// existing design-system primitives (a status chip + card surface) — no new CSS.
// It frames these as the current beta terms and surfaces the disclaimers that
// matter most, without overstating that they are final or counsel-approved.
export function BetaSummary() {
  return (
    <SectionCard title={BETA_NOTICE.title} subtitle="What these terms mean, in plain language.">
      <p className="m-0">
        <span className="status-chip status-neutral" style={{ marginRight: 'var(--space-2)' }}>
          Beta
        </span>
        {BETA_NOTICE.points[0]}
      </p>
      {BETA_NOTICE.points.slice(1).map((point, i) => (
        <p key={i} style={{ marginBottom: 0 }}>
          {point}
        </p>
      ))}
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

        <BetaSummary />

        <PageSection title="Document" note={`Effective ${doc.lastUpdated}`}>
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
