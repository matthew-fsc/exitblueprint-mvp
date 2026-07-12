import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, invokeFunctionBlob, supabase } from '../lib/supabase';
import { useBrand } from '../lib/branding';
import {
  qk,
  useAssessmentsByEngagement,
  useCompany,
  useCompare,
  useEngagement,
  useLatestDocument,
} from '../lib/queries';
import {
  Card,
  DataTable,
  DeltaChip,
  FirmMark,
  PageHeader,
  SkeletonLines,
  TierBadge,
  useToast,
  type Column,
} from '../components/ui';
import { fmtDate, fmtScore } from '../lib/format';

export default function DeltaReportPage() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { brand, branding } = useBrand();

  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const assessmentsQ = useAssessmentsByEngagement(engagementId);
  const completed = (assessmentsQ.data ?? []).filter((a) => a.status === 'completed' && a.drs_score != null);

  const [currentId, setCurrentId] = useState('');
  useEffect(() => {
    if (completed.length > 0 && !currentId) setCurrentId(completed[completed.length - 1].id);
  }, [completed, currentId]);

  const current = completed.find((a) => a.id === currentId) ?? null;
  const prior = useMemo(() => {
    if (!current) return null;
    const earlier = completed.filter((a) => a.sequence_number < current.sequence_number);
    return earlier.length ? earlier[earlier.length - 1] : null;
  }, [completed, current]);

  const comparable = !!prior && prior.rubric_version_id === current?.rubric_version_id;
  const isBaseline = !prior || !comparable;

  const compareQ = useCompare(comparable ? prior!.id : undefined, comparable ? currentId : undefined);
  const docQ = useLatestDocument(currentId || undefined, 'delta_report');
  const doc = docQ.data ?? null;

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(doc?.content_md ?? ''), [doc]);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.latestDoc(currentId, 'delta_report') });

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('generate-document', { assessment_id: currentId, doc_type: 'delta_report' });
      refresh();
      toast.show('Delta report generated', 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const saveDraft = async () => {
    if (!doc) return;
    setBusy(true);
    const { error } = await supabase.from('generated_documents').update({ content_md: draft }).eq('id', doc.id);
    if (error) setError(error.message);
    else toast.show('Draft saved', 'good');
    refresh();
    setBusy(false);
  };

  const finalize = async () => {
    if (!doc) return;
    setBusy(true);
    const { error } = await supabase
      .from('generated_documents')
      .update({ content_md: draft, finalized_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (error) setError(error.message);
    else toast.show('Report finalized', 'good');
    refresh();
    setBusy(false);
  };

  const downloadPdf = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await invokeFunctionBlob('render-delta-pdf', { assessment_id: currentId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${companyName.replace(/\s+/g, '-')}-delta-report.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (engagementQ.isLoading || assessmentsQ.isLoading) return <SkeletonLines lines={6} />;
  const companyName = companyQ.data?.name ?? '';

  if (completed.length === 0) {
    return (
      <div>
        <PageHeader title="Delta report" crumbs={[{ label: 'Portfolio', to: '/' }, { label: companyName, to: `/engagement/${engagementId}` }, { label: 'Delta report' }]} />
        <p className="muted">No completed assessments yet — complete a baseline first.</p>
      </div>
    );
  }

  const cmp = compareQ.data;
  const dimCols: Column<{ code: string; name: string; prior: number; current: number; delta: number }>[] = [
    { key: 'name', header: 'Business area' },
    { key: 'prior', header: 'Prior', numeric: true, render: (r) => fmtScore(r.prior) },
    { key: 'current', header: 'Current', numeric: true, render: (r) => fmtScore(r.current) },
    { key: 'delta', header: 'Change', numeric: true, render: (r) => <DeltaChip value={r.delta} digits={2} /> },
  ];

  return (
    <div className="report">
      <PageHeader
        title="Branded delta report"
        crumbs={[{ label: 'Portfolio', to: '/' }, { label: companyName, to: `/engagement/${engagementId}` }, { label: 'Delta report' }]}
        subtitle="The quarterly artifact for your client meeting — your firm's brand, the readiness story."
      />
      {error && <p className="form-error no-print">{error}</p>}

      {/* controls */}
      <Card>
        <div className="compare-controls">
          <label className="filter-control">
            <span className="filter-label">Report as of</span>
            <select value={currentId} onChange={(e) => setCurrentId(e.target.value)}>
              {completed.map((a) => (
                <option key={a.id} value={a.id}>
                  #{a.sequence_number} · DRS {fmtScore(Number(a.drs_score))} · {a.completed_at ? fmtDate(a.completed_at) : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="filter-control">
            <span className="filter-label">Compared against</span>
            <span style={{ paddingTop: '0.4rem' }}>
              {prior ? (
                comparable ? (
                  <>#{prior.sequence_number} · {prior.completed_at ? fmtDate(prior.completed_at) : ''}</>
                ) : (
                  <span className="stale-flag">prior uses a different methodology</span>
                )
              ) : (
                <span className="muted">no prior — baseline report</span>
              )}
            </span>
          </div>
          <div style={{ marginLeft: 'auto', alignSelf: 'flex-end' }}>
            <button onClick={generate} disabled={busy}>
              {busy ? 'Working…' : doc ? 'Regenerate' : 'Generate report'}
            </button>
          </div>
        </div>
        {isBaseline && prior && !comparable && (
          <p className="compare-incomparable" style={{ marginTop: '0.9rem' }}>
            The prior assessment uses a different methodology version, so this will be generated as a{' '}
            <strong>baseline report</strong> (current levels, not changes) rather than a misleading delta.
          </p>
        )}
      </Card>

      {/* editor + branded preview */}
      {doc ? (
        <>
          <div className="report-meta no-print" style={{ marginTop: '1rem' }}>
            <span className={`status-chip status-${doc.finalized_at ? 'good' : 'warning'}`}>
              {doc.finalized_at ? `Finalized ${fmtDate(doc.finalized_at)}` : 'Draft — review and edit before finalizing'}
            </span>
            <span className="muted">
              {doc.model.startsWith('rule-based') ? 'Composed from the deterministic comparison' : `Drafted by ${doc.model}`}
            </span>
          </div>

          {!doc.finalized_at && (
            <>
              <textarea className="report-editor no-print" rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="report-actions no-print">
                <span className="muted" style={{ fontSize: '0.82rem' }}>Edit the narrative; the figures below are fixed from the scoring engine.</span>
                <span>
                  <button className="linkish" onClick={saveDraft} disabled={busy}>Save draft</button>{' '}
                  <button onClick={finalize} disabled={busy}>Finalize</button>
                </span>
              </div>
            </>
          )}

          <div className="report-actions no-print" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <button onClick={downloadPdf} disabled={busy}>Download branded PDF</button>
          </div>

          {/* WYSIWYG preview mirroring the PDF layout */}
          <article className="report-body delta-preview">
            <div className="report-brandbar">
              <FirmMark brand={brand} />
              {branding?.report_from_line && <span className="muted">{branding.report_from_line}</span>}
            </div>
            <h1 style={{ marginTop: 0 }}>
              {isBaseline ? 'Baseline readiness' : 'Progress this period'} — {companyName}
            </h1>

            {/* headline movement */}
            {!isBaseline && cmp && cmp.comparable ? (
              <div className="delta-headline">
                <span className="delta-prior tnum">{fmtScore(cmp.prior.drsScore)}</span>
                <span className="compare-arrow">→</span>
                <span className="delta-current tnum">{fmtScore(cmp.current.drsScore)}</span>
                <DeltaChip value={cmp.drsDelta} />
                <TierBadge tier={cmp.current.drsTier} />
              </div>
            ) : (
              current && (
                <div className="delta-headline">
                  <span className="delta-current tnum">{fmtScore(Number(current.drs_score))}</span>
                  {current.drs_tier && <TierBadge tier={current.drs_tier} />}
                </div>
              )
            )}

            <div className="delta-narrative">{renderProse(draft || doc.content_md)}</div>

            {!isBaseline && cmp && cmp.comparable && (
              <>
                <h2>Where the business moved</h2>
                <DataTable
                  columns={dimCols}
                  rows={cmp.dimensions.map((d) => ({ code: d.code, name: dimName(d.code), prior: d.prior, current: d.current, delta: d.delta }))}
                  keyFor={(r) => r.code}
                />
                <div className="compare-gap-summary" style={{ marginTop: '0.9rem' }}>
                  <span className="delta delta-up">▼ {cmp.gapsResolved.length} resolved</span>
                  <span className="delta delta-down">▲ {cmp.gapsOpened.length} newly opened</span>
                </div>
              </>
            )}

            {branding?.footer_disclosure_md && <p className="report-disclosure">{branding.footer_disclosure_md}</p>}
            <p className="powered-by report-poweredby">Powered by Exit Blueprint</p>
          </article>
        </>
      ) : (
        <p className="muted" style={{ marginTop: '1rem' }}>
          Generate the report to preview it, edit the narrative, and download a branded PDF. Every figure is fixed by the
          scoring engine; only the prose is editable.
        </p>
      )}
    </div>
  );
}

// Dimension code → display name (the six business dimensions).
const DIM_NAMES: Record<string, string> = {
  REV: 'Revenue Quality',
  FIN: 'Financial Integrity',
  OPS: 'Operational Independence',
  CUS: 'Customer Risk',
  MGT: 'Management and Team',
  GRW: 'Growth Drivers',
};
const dimName = (code: string) => DIM_NAMES[code] ?? code;

// Very small markdown-ish renderer for the preview prose (bold + headings +
// bullets), matching the owner-report renderer's subset.
function renderProse(md: string) {
  return md.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
    if (line.startsWith('# ')) return null; // title already shown
    if (line.startsWith('- ')) return <li key={i}>{bold(line.slice(2))}</li>;
    if (line.trim() === '') return <div key={i} className="report-gap" />;
    return <p key={i}>{bold(line)}</p>;
  });
}
function bold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}
