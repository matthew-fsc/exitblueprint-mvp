import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, invokeFunctionBlob, supabase } from '../lib/supabase';
import { qk, useLatestReport, useActiveAssessment, useEngagement, useCompany } from '../lib/queries';
import { useBrand } from '../lib/branding';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { Collapsible, EngagementNav, FirmMark, PageHeader, SkeletonLines, useToast } from '../components/ui';
import { fmtDate } from '../lib/format';

// Minimal inline renderer for the report markdown.
function inline(text: string): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) parts.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    else parts.push(<em key={k++}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderMarkdown(md: string): ReactElement[] {
  const out: ReactElement[] = [];
  const lines = md.split('\n');
  let bullets: string[] = [];
  const flush = (key: number) => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${key}`}>
        {bullets.map((b, j) => (
          <li key={j}>{inline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  lines.forEach((line, i) => {
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
      return;
    }
    flush(i);
    if (line.startsWith('### ')) out.push(<h3 key={i}>{inline(line.slice(4))}</h3>);
    else if (line.startsWith('## ')) out.push(<h2 key={i}>{inline(line.slice(3))}</h2>);
    else if (line.startsWith('# ')) out.push(<h1 key={i}>{inline(line.slice(2))}</h1>);
    else if (line.trim() === '') out.push(<div key={i} className="report-gap" />);
    else out.push(<p key={i}>{inline(line)}</p>);
  });
  flush(lines.length);
  return out;
}

export default function ReportPage() {
  const { assessmentId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const { brand, branding } = useBrand();
  const reportQ = useLatestReport(assessmentId);
  const doc = reportQ.data ?? null;
  // Keep the engagement frame around the report (docs/22 F3): load the chain to
  // the owning engagement so the masthead breadcrumbs and tab bar stay present.
  const assessmentQ = useActiveAssessment(assessmentId);
  const engagementId = assessmentQ.data?.engagement_id;
  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const companyName = companyQ.data?.name ?? '';
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  useEffect(() => {
    setDraft(doc?.content_md ?? '');
  }, [doc]);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.latestReport(assessmentId ?? '') });

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('generate-document', { assessment_id: assessmentId, doc_type: 'owner_report' });
      refresh();
      toast.show('Report generated', 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  // Auto-generate on first visit so the advisor lands on a finished document, not
  // an empty page with a button. Fires once, only when no report exists yet.
  useEffect(() => {
    if (reportQ.isLoading || doc || !assessmentId || autoTried.current || busy) return;
    autoTried.current = true; // synchronous guard — no double-fire under StrictMode
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportQ.isLoading, doc, assessmentId]);

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
    else toast.show('Report finalized', 'good');
    refresh();
    setBusy(false);
  };

  const downloadPdf = async () => {
    setBusy(true);
    setError(null);
    try {
      // The PDF renders from the saved content, so flush any unsaved edits first
      // — the download always matches the polished doc on screen.
      if (doc && !doc.finalized_at && draft !== doc.content_md) {
        await supabase.from('generated_documents').update({ content_md: draft }).eq('id', doc.id);
        refresh();
      }
      const blob = await invokeFunctionBlob('render-owner-pdf', { assessment_id: assessmentId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'exit-readiness-report.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      track({
        type: 'report',
        name: 'report_downloaded',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        properties: { assessment_id: assessmentId, doc_type: 'owner_report' },
      });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (reportQ.isLoading) return <SkeletonLines lines={6} />;

  const ruleBased = (doc?.model ?? '').startsWith('rule-based');
  const finalized = !!doc?.finalized_at;

  return (
    <div className="report">
      <header className="page-masthead no-print">
      <PageHeader
        title="Owner report"
        crumbs={[
          { label: 'Portfolio', to: '/' },
          ...(engagementId
            ? [{ label: companyName || 'Engagement', to: `/engagement/${engagementId}` }]
            : []),
          { label: 'Owner report' },
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

      {!doc ? (
        <div className="report-generating no-print">
          {busy ? (
            <>
              <div className="report-spinner" aria-hidden />
              <p className="muted">Composing the report from this assessment’s scores and flagged gaps…</p>
            </>
          ) : (
            <>
              <p className="muted">
                The report is built server-side from this assessment’s scores and flagged gaps — every
                figure traces back to an answer, and no number is invented.
              </p>
              <button onClick={generate}>Generate owner report</button>
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
                {ruleBased ? 'Composed from your scores and flagged gaps' : `Drafted by ${doc.model}`} ·
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

          {/* The raw Markdown source, tucked into an expand bar above the polished
              document so it never competes with it — open it to tweak or copy. */}
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

          {/* The polished document — the primary view, always visible, firm-branded.
              Live-previews the draft while editing; the saved copy once finalized. */}
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
