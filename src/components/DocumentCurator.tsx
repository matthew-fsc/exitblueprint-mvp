import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, invokeFunctionBlob, supabase } from '../lib/supabase';
import { qk, useLatestDoc, type GeneratedDocumentRow } from '../lib/queries';
import { useBrand } from '../lib/branding';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { Collapsible, ErrorState, FirmMark, useToast } from './ui';
import { fmtDate } from '../lib/format';
import { documentType } from '../../shared/documents/catalog';

// The one curation surface every client deliverable shares: generate the
// narrative (AI when a key is set, otherwise the deterministic composer), edit
// the prose, finalize it, and download the branded PDF — all through the single
// render-document-pdf endpoint. Each document type differs only in its branded
// preview body (passed as children) and any type-specific chrome (passed as
// `aside`, e.g. the CIM readiness panel), so the generate → edit → finalize →
// download machinery lives here once instead of being copy-pasted per page.

// The firm-branded document sheet: the same brand bar, disclosure, and footer
// wrap every deliverable's preview so the on-screen document matches the PDF.
export function BrandedSheet({
  children,
  articleClassName = '',
  wrap = true,
}: {
  children: ReactNode;
  articleClassName?: string;
  wrap?: boolean;
}) {
  const { brand, branding } = useBrand();
  const article = (
    <article className={`report-body ${articleClassName}`.trim()}>
      <div className="report-brandbar">
        <FirmMark brand={brand} />
        {branding?.report_from_line && <span className="muted">{branding.report_from_line}</span>}
      </div>
      {children}
      {branding?.footer_disclosure_md && <p className="report-disclosure">{branding.footer_disclosure_md}</p>}
      <p className="powered-by report-poweredby">Powered by Exit Blueprint</p>
    </article>
  );
  return wrap ? <div className="report-sheet-wrap">{article}</div> : article;
}

export interface DocumentCuratorProps {
  assessmentId: string | undefined;
  docType: string;
  // The branded preview body for this document type, given the markdown that
  // should be shown (the live draft while editing, the saved copy once finalized).
  children: (activeMarkdown: string, doc: GeneratedDocumentRow) => ReactNode;
  // Type-specific chrome rendered above the toolbar (e.g. CIM readiness).
  aside?: ReactNode;
  // Copy for the pre-generation states.
  emptyHint: ReactNode;
  generatingHint: ReactNode;
  // Auto-generate on first visit so the advisor lands on a finished document,
  // not an empty page with a button. Defaults on.
  autoGenerate?: boolean;
}

export function DocumentCurator({
  assessmentId,
  docType,
  aside,
  emptyHint,
  generatingHint,
  autoGenerate = true,
  children,
}: DocumentCuratorProps) {
  const meta = documentType(docType);
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const docQ = useLatestDoc(assessmentId, docType);
  const doc = docQ.data ?? null;

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  useEffect(() => setDraft(doc?.content_md ?? ''), [doc]);
  // Switching to a different assessment re-arms the one-shot auto-generate so a
  // freshly-selected assessment with no document composes one too.
  useEffect(() => {
    autoTried.current = false;
  }, [assessmentId]);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.latestDoc(assessmentId ?? '', docType) });

  const generate = async () => {
    if (!assessmentId) return;
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('generate-document', { assessment_id: assessmentId, doc_type: docType });
      refresh();
      toast.show(`${meta?.title ?? 'Document'} generated`, 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  // Fires once per assessment, only when no document exists yet.
  useEffect(() => {
    if (!autoGenerate) return;
    if (docQ.isLoading || doc || !assessmentId || autoTried.current || busy) return;
    autoTried.current = true; // synchronous guard — no double-fire under StrictMode
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docQ.isLoading, doc, assessmentId, autoGenerate]);

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
    const { error: e } = await supabase.from('generated_documents').update({ content_md: draft }).eq('id', doc.id);
    if (e) setError(e.message);
    else toast.show('Draft saved', 'good');
    refresh();
    setBusy(false);
  };

  const finalize = async () => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase
      .from('generated_documents')
      .update({ content_md: draft, finalized_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (e) setError(e.message);
    else toast.show(`${meta?.title ?? 'Document'} finalized`, 'good');
    refresh();
    setBusy(false);
  };

  const downloadPdf = async () => {
    if (!assessmentId) return;
    setBusy(true);
    setError(null);
    try {
      // The PDF renders from the saved content, so flush any unsaved edits first
      // — the download always matches the polished document on screen.
      if (doc && !doc.finalized_at && draft !== doc.content_md) {
        await supabase.from('generated_documents').update({ content_md: draft }).eq('id', doc.id);
        refresh();
      }
      const blob = await invokeFunctionBlob('render-document-pdf', {
        assessment_id: assessmentId,
        doc_type: docType,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta?.filename ?? 'document.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      track({
        type: 'report',
        name: 'report_downloaded',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        properties: { assessment_id: assessmentId, doc_type: docType },
      });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (docQ.isLoading && !doc) {
    return (
      <>
        {aside}
        <div className="report-generating no-print">
          <div className="report-spinner" aria-hidden />
        </div>
      </>
    );
  }

  const ruleBased = (doc?.model ?? '').startsWith('rule-based');
  const finalized = !!doc?.finalized_at;
  const activeMarkdown = finalized ? doc!.content_md : draft;

  return (
    <>
      {aside}
      {error && <ErrorState variant="inline" error={error} className="no-print" />}

      {!doc ? (
        <div className="report-generating no-print">
          {busy ? (
            <>
              <div className="report-spinner" aria-hidden />
              {generatingHint}
            </>
          ) : (
            <>
              {emptyHint}
              <button onClick={generate} disabled={!assessmentId || busy}>
                Generate {meta?.title.toLowerCase() ?? 'document'}
              </button>
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
                {ruleBased ? meta?.narratorNote : `Drafted by ${doc.model}`} · generated{' '}
                {new Date(doc.created_at).toLocaleString()}
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
              document so it never competes with it — open it to tweak or copy. The
              figures below stay fixed by the scoring engine; only the prose edits. */}
          {!finalized && (
            <Collapsible title="Edit narrative" hint="Raw Markdown — the figures stay fixed by the scoring engine">
              <textarea
                className="report-editor"
                rows={16}
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

          {children(activeMarkdown, doc)}
        </>
      )}
    </>
  );
}
