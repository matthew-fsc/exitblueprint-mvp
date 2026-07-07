import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

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
    const { error } = await supabase.functions.invoke('generate-document', {
      body: { assessment_id: assessmentId, doc_type: 'owner_report' },
    });
    if (error) setError(error.message);
    await load();
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
            No report yet. Generation runs server-side from the assessment's structured scores and
            gaps; the model writes narrative only and never computes a number.
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
                : 'AI-generated draft — review and edit before finalizing'}
            </span>
            <span className="muted">
              {doc.prompt_version} · {doc.model} · generated{' '}
              {new Date(doc.created_at).toLocaleString()}
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
            {(doc.finalized_at ? doc.content_md : draft).split('\n').map((line, i) => {
              if (line.startsWith('# ')) return <h1 key={i}>{line.slice(2)}</h1>;
              if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
              if (line.startsWith('### ')) return <h3 key={i}>{line.slice(4)}</h3>;
              if (line.trim() === '') return <br key={i} />;
              return <p key={i}>{line}</p>;
            })}
          </article>
        </>
      )}
    </div>
  );
}
