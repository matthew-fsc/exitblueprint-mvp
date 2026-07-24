import { Link } from 'react-router-dom';
import { BRAND } from '../lib/brand';

// Small site footer linking the legal / trust pages. The integrator mounts it in
// App.tsx (see the wiring note). Styled with design-system tokens — no new CSS.
// Links are plain react-router Links so it works inside the app shell or on the
// standalone public legal routes.
const LINKS: { to: string; label: string }[] = [
  { to: '/legal/terms', label: 'Terms of Service' },
  { to: '/legal/privacy', label: 'Privacy Policy' },
  { to: '/legal/dpa', label: 'Data Processing Addendum' },
  { to: '/legal/subprocessors', label: 'Sub-processors' },
];

export function LegalFooter() {
  const year = new Date().getFullYear();
  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        padding: 'var(--space-6) var(--pad-page-x)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--space-4)',
        justifyContent: 'space-between',
      }}
    >
      <nav
        aria-label="Legal"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)' }}
      >
        {LINKS.map((l) => (
          <Link key={l.to} to={l.to} className="linkish text-sm">
            {l.label}
          </Link>
        ))}
      </nav>
      <span className="muted text-sm">© {year} {BRAND.name}</span>
    </footer>
  );
}

export default LegalFooter;
