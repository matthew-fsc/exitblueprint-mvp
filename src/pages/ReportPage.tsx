import { useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, invokeFunctionBlob, supabase } from '../lib/supabase';
import { qk, useLatestReport } from '../lib/queries';
import { useBrand } from '../lib/branding';
import { FirmMark, PageHeader, SkeletonLines, useToast } from '../components/ui';
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
  const { brand, branding } = useBrand();
  const reportQ = useLatestReport(assessmentId);
  const doc = reportQ.data ?? null;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const blob = await invokeFunctionBlob('render-owner-pdf', { assessment_id: assessmentId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'exit-readiness-report.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (reportQ.isLoading) return <SkeletonLines lines={6} />;

  const ruleBased = (doc?.model ?? '').startsWith('rule-based');

  return (
    <div className="report">
      <PageHeader
        title="Owner report"
        crumbs={[{ label: 'Portfolio', to: '/' }, { label: 'Owner report' }]}
        actions={
          <Link className="button-link" to={`/assessment/${assessmentId}/results`}>
            ← results
          </Link>
        }
      />
      {error && <p className="form-error no-print">{error}</p>}

      {!doc ? (
        <div className="no-print">
          <p className="muted">
            No report yet. The report is built server-side from this assessment’s scores and flagged
            gaps — every figure traces back to an answer, and no number is invented. If an AI writing
            service is configured it drafts the prose from those same numbers; otherwise a
            plain-language version is composed directly from the data.
          </p>
          <button onClick={generate} disabled={busy}>
            {busy ? 'Generating…' : 'Generate owner report'}
          </button>
        </div>
      ) : (
        <>
          <div className="report-meta no-print">
            <span className={`status-chip status-${doc.finalized_at ? 'good' : 'warning'}`}>
              {doc.finalized_at
                ? `Finalized ${fmtDate(doc.finalized_at)}`
                : ruleBased
                  ? 'Draft built from your assessment data — review and edit before finalizing'
                  : 'AI-drafted from your assessment data — review and edit before finalizing'}
            </span>
            <span className="muted">
              {ruleBased ? 'Composed from your scores and flagged gaps' : `Drafted by ${doc.model}`} ·
              generated {new Date(doc.created_at).toLocaleString()}
            </span>
          </div>

          {!doc.finalized_at ? (
            <>
              <textarea
                className="report-editor no-print"
                rows={24}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="report-actions no-print">
                <button className="linkish" onClick={generate} disabled={busy}>
                  Regenerate
                </button>
                <span>
                  <button className="linkish" onClick={saveDraft} disabled={busy}>
                    Save draft
                  </button>{' '}
                  <button onClick={finalize} disabled={busy}>
                    Finalize
                  </button>
                </span>
              </div>
            </>
          ) : (
            <div className="report-actions no-print">
              <button onClick={downloadPdf} disabled={busy}>
                {busy ? 'Preparing…' : 'Download branded PDF'}
              </button>
            </div>
          )}

          {/* print view (and read view once finalized) — firm-branded */}
          <article className={`report-body ${doc.finalized_at ? '' : 'print-only'}`}>
            <div className="report-brandbar">
              <FirmMark brand={brand} />
              {branding?.report_from_line && <span className="muted">{branding.report_from_line}</span>}
            </div>
            {renderMarkdown(doc.finalized_at ? doc.content_md : draft)}
            {branding?.footer_disclosure_md && (
              <p className="report-disclosure">{branding.footer_disclosure_md}</p>
            )}
            <p className="powered-by report-poweredby">Powered by Exit Blueprint</p>
          </article>
        </>
      )}
    </div>
  );
}
