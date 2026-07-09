import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { invokeFunction, supabase } from '../lib/supabase';

interface GeneratedDocument {
  id: string;
  assessment_id: string;
  engagement_id: string;
  content_md: string;
  prompt_version: string;
  model: string;
  created_at: string;
  finalized_at: string | null;
}

// Minimal inline renderer for the report markdown: bold, italics, headings,
// and bullets — no external markdown dependency.
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
  const [doc, setDoc] = useState<GeneratedDocument | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('generated_documents')
      .select('*')
      .eq('assessment_id', assessmentId!)
      .eq('doc_type', 'owner_report')
      .order('created_at', { ascending: false })
      .limit(1);
    const latest = (data?.[0] as GeneratedDocument) ?? null;
    setDoc(latest);
    setDraft(latest?.content_md ?? '');
    setLoading(false);
  }, [assessmentId]);

  useEffect(() => {
    load();
  }, [load]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('generate-document', {
        assessment_id: assessmentId,
        doc_type: 'owner_report',
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const saveDraft = async () => {
    setBusy(true);
    setError(null);
    const { error } = await supabase
      .from('generated_documents')
      .update({ content_md: draft })
      .eq('id', doc!.id);
    if (error) setError(error.message);
    await load();
    setBusy(false);
  };

  const finalize = async () => {
    setBusy(true);
    setError(null);
    const { error } = await supabase
      .from('generated_documents')
      .update({ content_md: draft, finalized_at: new Date().toISOString() })
      .eq('id', doc!.id);
    if (error) setError(error.message);
    await load();
    setBusy(false);
  };

  if (loading) return <p className="muted">Loading report…</p>;

  const ruleBased = (doc?.model ?? '').startsWith('rule-based');

  return (
    <div className="report">
      <div className="page-title-row no-print">
        <h2>Owner report</h2>
        <span className="muted">
          <Link className="button-link" to={`/assessment/${assessmentId}/results`}>
            ← results
          </Link>
        </span>
      </div>
      {error && <p className="form-error no-print">{error}</p>}

      {!doc ? (
        <div className="no-print">
          <p className="muted">
            No report yet. The report is built server-side from this assessment’s scores and flagged
            gaps — every figure traces back to an answer, and no number is invented. If an AI writing
            service is configured it drafts the prose from those same numbers; otherwise a plain-language
            version is composed directly from the data.
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
                ? `Finalized ${new Date(doc.finalized_at).toLocaleDateString()}`
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
              <button onClick={() => window.print()}>Print / save as PDF</button>
            </div>
          )}

          {/* print view (and read view once finalized) */}
          <article className={`report-body ${doc.finalized_at ? '' : 'print-only'}`}>
            {renderMarkdown(doc.finalized_at ? doc.content_md : draft)}
          </article>
        </>
      )}
    </div>
  );
}
