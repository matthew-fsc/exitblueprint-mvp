import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface Company {
  id: string;
  name: string;
  industry: string | null;
  revenue_band: string | null;
}

interface Engagement {
  id: string;
  company_id: string;
  status: string;
  started_at: string;
}

export default function ClientsPage() {
  const { profile } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data: cos, error: coErr } = await supabase
      .from('companies')
      .select('*')
      .order('name');
    const { data: engs } = await supabase.from('engagements').select('*');
    if (coErr) setError(coErr.message);
    setCompanies((cos as Company[]) ?? []);
    setEngagements((engs as Engagement[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    load();
  };

  const createEngagement = async (companyId: string) => {
    setError(null);
    const { error } = await supabase.from('engagements').insert([
      { firm_id: profile!.firm_id, company_id: companyId, advisor_id: profile!.id },
    ]);
    if (error) {
      setError(error.message);
      return;
    }
    load();
  };

  if (loading) return <p className="muted">Loading clients…</p>;

  return (
    <div>
      <div className="page-title-row">
        <h2>Clients</h2>
      </div>
      {error && <p className="form-error">{error}</p>}
      {companies.length === 0 && <p className="muted">No companies yet — add the first client below.</p>}
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
      <form className="inline-form" onSubmit={createCompany}>
        <h3>New company</h3>
        <input
          placeholder="Company name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          placeholder="Industry (optional)"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
        />
        <button type="submit">Add company</button>
      </form>
    </div>
  );
}
