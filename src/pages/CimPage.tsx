import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, invokeFunctionBlob, supabase } from '../lib/supabase';
import {
  qk,
  useLatestDoc,
  useCimCoverage,
  useActiveAssessment,
  useEngagement,
  useCompany,
} from '../lib/queries';
import { useBrand } from '../lib/branding';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { Collapsible, EngagementNav, FirmMark, PageHeader, SkeletonLines, useToast } from '../components/ui';
import { fmtDate } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

// The CIM (Confidential Information Memorandum) deliverable: the market-facing
// document that packages the engagement's collected evidence for a buyer. It
// mirrors the owner report's generate → edit → finalize → branded-PDF flow, and
// leads with a CIM Readiness panel that shows which sections are backed by
// Ready/verified evidence and routes the advisor back to Evidence to collect the
// rest — the surface that postures evidence collection toward the CIM.
export default function CimPage() {
  const { assessmentId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const { brand, branding } = useBrand();
  const docQ = useLatestDoc(assessmentId, 'cim');
  const doc = docQ.data ?? null;
  const assessmentQ = useActiveAssessment(assessmentId);
  const engagementId = assessmentQ.data?.engagement_id;
  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const companyName = companyQ.data?.name ?? '';
  const coverageQ = useCimCoverage(engagementId);
  const coverage = coverageQ.data ?? null;

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(doc?.content_md ?? '');
  }, [doc]);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.latestDoc(assessmentId ?? '', 'cim') });

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('generate-document', { assessment_id: assessmentId, doc_type: 'cim' });
      refresh();
      toast.show('CIM generated', 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      toast.show('Markdown copied', 'good');
    } catch {
      setError('Could not copy to clipboard.');
    }
  };

  const saveDraft = async () => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.from('generated_documents').update({ content_md: draft }).eq('id', doc.id);
    if (error) setError(error.message);
    else toast.show('Draft saved', 'good');
    refresh();
    setBusy(false);
  };

  const finalize = async () => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase
      .from('generated_documents')
      .update({ content_md: draft, finalized_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (error) setError(error.message);
    else toast.show('CIM finalized', 'good');
    refresh();
    setBusy(false);
  };

  const downloadPdf = async () => {
    setBusy(true);
    setError(null);
    try {
      if (doc && !doc.finalized_at && draft !== doc.content_md) {
        await supabase.from('generated_documents').update({ content_md: draft }).eq('id', doc.id);
        refresh();
      }
      const blob = await invokeFunctionBlob('render-cim-pdf', { assessment_id: assessmentId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'confidential-information-memorandum.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      track({
        type: 'report',
        name: 'report_downloaded',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        properties: { assessment_id: assessmentId, doc_type: 'cim' },
      });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (docQ.isLoading) return <SkeletonLines lines={6} />;

  const ruleBased = (doc?.model ?? '').startsWith('rule-based');
  const finalized = !!doc?.finalized_at;
  const evidenceHref = engagementId ? `/engagement/${engagementId}/evidence` : '#';

  return (
    <div className="report">
      <header className="page-masthead no-print">
        <PageHeader
          title="Confidential Information Memorandum"
          crumbs={[
            { label: 'Portfolio', to: '/' },
            ...(engagementId
              ? [{ label: companyName || 'Engagement', to: `/engagement/${engagementId}` }]
              : []),
            { label: 'CIM' },
          ]}
          actions={
            <Link className="button-link" to={`/assessment/${assessmentId}/results`}>
              ← results
            </Link>
          }
        />
        {engagementId && <EngagementNav engagementId={engagementId} />}
      </header>
      {error && <p className="form-error no-print">{error}</p>}

      {/* CIM Readiness — postures evidence collection toward the memorandum. */}
      {coverage && (
        <section className="cim-readiness no-print">
          <div className="cim-readiness-head">
            <div>
              <span className="cim-readiness-eyebrow">CIM readiness</span>
              <p className="cim-readiness-sub muted">
                How much of the memorandum is backed by evidence already assembled in the data room.
                Collect the rest in <Link to={evidenceHref}>Evidence</Link>.
              </p>
            </div>
            <div className="cim-readiness-figure">
              <span className="cim-readiness-pct">{coverage.summary.pct}%</span>
              <span className="muted">
                {coverage.summary.itemsReady} of {coverage.summary.itemsTotal} items ready
              </span>
            </div>
          </div>
          <div className="cim-section-grid">
            {coverage.sections.map((s) => (
              <div key={s.code} className={`cim-section-row ${s.narrative ? 'cim-section-narrative' : ''}`}>
                <span className="cim-section-name">{s.name}</span>
                {s.narrative ? (
                  <span className="cim-section-tag muted">Narrative</span>
                ) : (
                  <>
                    <span className="cim-section-track" title={`${s.itemsReady} of ${s.itemsTotal} ready`}>
                      <span
                        className={`cim-section-fill ${s.pct >= 100 ? 'is-full' : s.pct > 0 ? 'is-partial' : 'is-empty'}`}
                        style={{ width: `${s.pct}%` }}
                      />
                    </span>
                    <span className="cim-section-count">
                      {s.itemsReady}/{s.itemsTotal}
                      {s.itemsVerified > 0 && <span className="cim-verified"> · {s.itemsVerified} verified</span>}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
          {coverage.sections.some((s) => s.missing.length > 0) && (
            <Collapsible title="What's still needed" hint="Evidence items to collect before the CIM is fully backed">
              <ul className="cim-missing-list">
                {coverage.sections
                  .filter((s) => s.missing.length > 0)
                  .flatMap((s) =>
                    s.missing.map((m) => (
                      <li key={`${s.code}-${m.item_code}`}>
                        <span className="cim-missing-section">{s.name}</span>
                        <span className="cim-missing-label">{m.label}</span>
                        <Link className="button-link" to={evidenceHref}>
                          Collect →
                        </Link>
                      </li>
                    )),
                  )}
              </ul>
            </Collapsible>
          )}
        </section>
      )}

      {!doc ? (
        <div className="report-generating no-print">
          {busy ? (
            <>
              <div className="report-spinner" aria-hidden />
              <p className="muted">Assembling the memorandum from the company profile, strengths, and verified evidence…</p>
            </>
          ) : (
            <>
              <p className="muted">
                The CIM is drafted server-side from the company profile, the assessment's strengths, and
                the evidence already collected. It is a buyer-facing marketing draft — review and edit it
                before sharing. No number is invented; no weakness is surfaced.
              </p>
              <button onClick={generate}>Generate CIM draft</button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="report-toolbar no-print">
            <div className="report-toolbar-status">
              <span className={`status-chip status-${finalized ? 'good' : 'warning'}`}>
                {finalized ? `Finalized ${fmtDate(doc.finalized_at)}` : ruleBased ? 'Draft' : 'AI draft'}
              </span>
              <span className="muted report-toolbar-meta">
                {ruleBased ? 'Composed from the company profile, strengths, and verified evidence' : `Drafted by ${doc.model}`} ·
                generated {new Date(doc.created_at).toLocaleString()}
              </span>
            </div>
            <div className="report-toolbar-actions">
              <button className="button-secondary" onClick={generate} disabled={busy}>
                {busy ? 'Working…' : 'Regenerate'}
              </button>
              {!finalized && (
                <button className="button-secondary" onClick={finalize} disabled={busy}>
                  Finalize
                </button>
              )}
              <button onClick={downloadPdf} disabled={busy}>
                {busy ? 'Preparing…' : 'Download branded PDF'}
              </button>
            </div>
          </div>

          {!finalized && (
            <Collapsible title="Edit source" hint="Raw Markdown — edit the wording or copy it out">
              <textarea
                className="report-editor"
                rows={18}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="report-source-actions">
                <button className="linkish" onClick={copySource}>
                  Copy Markdown
                </button>
                <button className="button-secondary" onClick={saveDraft} disabled={busy}>
                  Save changes
                </button>
              </div>
            </Collapsible>
          )}

          <div className="report-sheet-wrap">
            <article className="report-body">
              <div className="report-brandbar">
                <FirmMark brand={brand} />
                {branding?.report_from_line && <span className="muted">{branding.report_from_line}</span>}
              </div>
              {renderMarkdown(finalized ? doc.content_md : draft)}
              {branding?.footer_disclosure_md && (
                <p className="report-disclosure">{branding.footer_disclosure_md}</p>
              )}
              <p className="powered-by report-poweredby">Powered by Exit Blueprint</p>
            </article>
          </div>
        </>
      )}
    </div>
  );
}
