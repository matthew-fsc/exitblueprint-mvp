import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  qk,
  useActiveAgreementVersions,
  useCompanies,
  useEngagements,
  type AgreementVersionRow,
} from '../lib/queries';
import { Card, ConfirmDialog, EmptyState, PageHeader, SkeletonLines, useToast } from '../components/ui';
import { track } from '../lib/analytics';

export default function ClientsPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const companiesQ = useCompanies();
  const engagementsQ = useEngagements();
  const agreementsQ = useActiveAgreementVersions();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Engagement onboarding is blocked on recording agreement acceptance: opening
  // the modal captures the signer + data-use consents, then create-engagement
  // persists the engagement and its acceptance atomically (beta Requirement 1).
  const [pending, setPending] = useState<{ companyId: string; companyName: string } | null>(null);
  const [signer, setSigner] = useState('');
  const [consentBenchmarking, setConsentBenchmarking] = useState(false);
  const [consentAggregation, setConsentAggregation] = useState(false);
  const [consentOutcome, setConsentOutcome] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const companies = companiesQ.data ?? [];
  const engagements = engagementsQ.data ?? [];
  const agreement: AgreementVersionRow | undefined = agreementsQ.data?.[0];

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

  const openAgreement = (companyId: string, companyName: string) => {
    setError(null);
    setSigner('');
    setConsentBenchmarking(false);
    setConsentAggregation(false);
    setConsentOutcome(false);
    setPending({ companyId, companyName });
  };

  const confirmEngagement = async () => {
    if (!pending || !agreement) return;
    if (!signer.trim()) {
      setError('Enter who accepted the agreement on the client’s behalf.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await invokeFunction<{ engagement_id: string }>('create-engagement', {
        company_id: pending.companyId,
        agreement_version_id: agreement.id,
        signer_name: signer.trim(),
        consent: {
          benchmarking: consentBenchmarking,
          anonymized_aggregation: consentAggregation,
          outcome_tracking: consentOutcome,
        },
      });
      track({
        type: 'onboarding',
        name: 'engagement_started',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        engagementId: created.engagement_id,
        properties: {
          consent_benchmarking: consentBenchmarking,
          consent_anonymized_aggregation: consentAggregation,
          consent_outcome_tracking: consentOutcome,
        },
      });
      setPending(null);
      qc.invalidateQueries({ queryKey: qk.engagements() });
      toast.show('Agreement recorded — engagement started', 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Clients" subtitle="Companies your firm is guiding toward exit readiness." />
      {error && !pending && <p className="form-error">{error}</p>}

      {!agreementsQ.isLoading && !agreement && (
        <Card>
          <p className="form-error m-0">
            Your firm has no active engagement agreement, so new engagements can’t be started yet.
            An admin can add one with <code>npm run admin -- create-agreement-version</code>.
          </p>
        </Card>
      )}

      {companiesQ.isLoading ? (
        <Card>
          <SkeletonLines lines={4} />
        </Card>
      ) : companies.length === 0 ? (
        <EmptyState title="No companies yet" icon="empty">
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
                  <button onClick={() => openAgreement(c.id, c.name)} disabled={!agreement}>
                    Start engagement
                  </button>
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

      <ConfirmDialog
        open={!!pending && !!agreement}
        title={`Engagement agreement — ${pending?.companyName ?? ''}`}
        confirmLabel="Record acceptance & start"
        cancelLabel="Cancel"
        busy={submitting}
        onCancel={() => (submitting ? undefined : setPending(null))}
        onConfirm={confirmEngagement}
      >
        {agreement && (
          <div className="agreement-accept">
            <p className="muted agreement-version">
              {agreement.title} · version {agreement.version_label}
            </p>
            <div className="agreement-body">{agreement.body_md}</div>

            <label className="agreement-signer">
              <span>Client signatory (who accepted)</span>
              <input
                value={signer}
                onChange={(e) => setSigner(e.target.value)}
                placeholder="e.g. Jane Owner, CEO"
              />
            </label>

            <fieldset className="agreement-consents">
              <legend>Data-use consent (as authorized by the client)</legend>
              <label>
                <input
                  type="checkbox"
                  checked={consentBenchmarking}
                  onChange={(e) => setConsentBenchmarking(e.target.checked)}
                />
                Benchmarking use
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={consentAggregation}
                  onChange={(e) => setConsentAggregation(e.target.checked)}
                />
                Anonymized aggregation
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={consentOutcome}
                  onChange={(e) => setConsentOutcome(e.target.checked)}
                />
                Outcome tracking
              </label>
            </fieldset>

            {error && <p className="form-error">{error}</p>}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
