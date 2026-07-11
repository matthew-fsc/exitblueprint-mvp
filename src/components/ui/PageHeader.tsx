import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface Crumb {
  label: string;
  to?: string;
}

// Standard page top: breadcrumb, title, optional subtitle, right-aligned
// actions. Every primary page uses this so headers never drift.
export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="ui-pageheader">
      <div className="ui-pageheader-titles">
        {crumbs && crumbs.length > 0 && (
          <nav className="ui-breadcrumb" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="ui-breadcrumb-sep">/</span>}
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
              </Fragment>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="ui-pageheader-sub">{subtitle}</p>}
      </div>
      {actions && <div className="ui-pageheader-actions">{actions}</div>}
    </header>
  );
}
