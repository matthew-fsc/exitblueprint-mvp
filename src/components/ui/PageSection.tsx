import type { ReactNode } from 'react';

// A major region of a page. Introduces itself with a quiet eyebrow title and a
// hairline rule, and sits on the page's section rhythm — this is what turns a
// flat stack of equal-weight cards into a composed page with a reading path.
// See docs/26 "Page composition". Wrap a page's body in `page-shell`, lead with
// a `page-masthead`, then group the content into PageSections.
export function PageSection({
  title,
  note,
  children,
}: {
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page-section">
      <div className="page-section-head">
        <span className="page-section-title">{title}</span>
        {note && <span className="page-section-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}
