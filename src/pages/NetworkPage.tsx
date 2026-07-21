// Network — the advisor-facing home for the firm's professional directory
// ("rolodex"). The same directory also appears on the admin Organization page;
// this route makes it reachable by any advisor so the person who actually holds
// the network can load it without routing through an admin. Adding and editing
// contacts is enforced at the database (firm staff may write their own firm's
// rows; see 20260721001300_firm_professionals_selfserve.sql).
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/ui';
import { ProfessionalDirectoryCard } from '../components/ProfessionalDirectoryCard';

export default function NetworkPage() {
  const { profile } = useAuth();
  const firmId = profile?.firm_id ?? undefined;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Network"
        subtitle="Your professional network — the attorneys, accountants, bankers, and advisors you work with. Add them once, then attach them to any engagement's deal team."
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Network' }]}
      />
      <ProfessionalDirectoryCard firmId={firmId} meProfileId={profile?.id} />
    </div>
  );
}
