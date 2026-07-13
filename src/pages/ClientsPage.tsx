import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { qk, useCompanies, useEngagements } from '../lib/queries';
import { Card, EmptyState, PageHeader, SkeletonLines, useToast } from '../components/ui';

export default function ClientsPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const companiesQ = useCompanies();
  const engagementsQ = useEngagements();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string | null>(null);

  const companies = companiesQ.data ?? [];
  const engagements = engagementsQ.data ?? [];

  const createCompany = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const { error } = await supabase
      .from('companies')
      .insert([{ firm_id: profile!.firm_id, name, industry: industry || null }]);
    if (error) {
      setError(error.message);
      return;
    }
    setName('');
    setIndustry('');
    qc.invalidateQueries({ queryKey: qk.companies() });
    toast.show('Company added', 'good');
  };

  const createEngagement = async (companyId: string) => {
    setError(null);
    const { error } = await supabase
      .from('engagements')
      .insert([{ firm_id: profile!.firm_id, company_id: companyId, advisor_id: profile!.id }]);
    if (error) {
      setError(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: qk.engagements() });
    toast.show('Engagement started', 'good');
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Clients" subtitle="Companies your firm is guiding toward exit readiness." />
      {error && <p className="form-error">{error}</p>}

      {companiesQ.isLoading ? (
        <Card>
          <SkeletonLines lines={4} />
        </Card>
      ) : companies.length === 0 ? (
        <EmptyState title="No companies yet" icon="◇">
          Add your first client below, then open a readiness engagement for it.
        </EmptyState>
      ) : (
        <ul className="client-list">
          {companies.map((c) => {
            const engagement = engagements.find((e) => e.company_id === c.id);
            return (
              <li key={c.id} className="client-card">
                <div>
                  <span className="client-name">{c.name}</span>
                  <span className="client-meta">
                    {[c.industry, c.revenue_band].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
                {engagement ? (
                  <Link className="button-link" to={`/engagement/${engagement.id}`}>
                    Engagement ({engagement.status}) →
                  </Link>
                ) : (
                  <button onClick={() => createEngagement(c.id)}>Start engagement</button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form className="inline-form" onSubmit={createCompany}>
        <h3>New company</h3>
        <input placeholder="Company name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="Industry (optional)" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        <button type="submit">Add company</button>
      </form>
    </div>
  );
}
