import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import {
  qk,
  useAdvisoryLibrary,
  type AdvisoryItemRow,
  type AdvisoryItemType,
} from '../lib/queries';
import { Card, ConfirmDialog, EmptyState, PageHeader, SkeletonLines, useToast } from '../components/ui';

const TYPE_LABEL: Record<AdvisoryItemType, string> = {
  buyer_question: 'Buyer question',
  initiative: 'Initiative',
  risk_flag: 'Risk flag',
};
const DIMENSIONS = ['REV', 'FIN', 'OPS', 'CUS', 'MGT', 'GRW'];
const SEVERITIES = ['critical', 'high', 'med', 'low'];

function sevClass(sev: string | null): string {
  switch (sev) {
    case 'critical':
      return 'sev-critical';
    case 'high':
      return 'sev-high';
    case 'med':
      return 'sev-med';
    default:
      return 'sev-low';
  }
}

export default function LibraryPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const libraryQ = useAdvisoryLibrary();
  const items = libraryQ.data ?? [];

  const [qType, setQType] = useState<AdvisoryItemType | 'all'>('all');
  const [qDim, setQDim] = useState<string>('all');
  const [qText, setQText] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdvisoryItemRow | null>(null);

  // create form state
  const [fType, setFType] = useState<AdvisoryItemType>('buyer_question');
  const [fTitle, setFTitle] = useState('');
  const [fBody, setFBody] = useState('');
  const [fFramework, setFFramework] = useState('');
  const [fData, setFData] = useState('');
  const [fDim, setFDim] = useState('REV');
  const [fSub, setFSub] = useState('');
  const [fSev, setFSev] = useState('high');
  const [fTrigger, setFTrigger] = useState('70');
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const t = qText.trim().toLowerCase();
    return items.filter(
      (i) =>
        (qType === 'all' || i.item_type === qType) &&
        (qDim === 'all' || i.dimension_code === qDim) &&
        (t === '' ||
          i.title.toLowerCase().includes(t) ||
          i.body.toLowerCase().includes(t) ||
          (i.code ?? '').toLowerCase().includes(t)),
    );
  }, [items, qType, qDim, qText]);

  const counts = useMemo(() => {
    const c = { total: items.length, system: 0, firm: 0 };
    for (const i of items) i.source === 'system' ? c.system++ : c.firm++;
    return c;
  }, [items]);

  const resetForm = () => {
    setFTitle('');
    setFBody('');
    setFFramework('');
    setFData('');
    setFSub('');
    setFTrigger('70');
    setError(null);
  };

  const createItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!profile?.firm_id || !fTitle || !fBody) return;
    setError(null);
    const { error: err } = await supabase.from('advisory_library_items').insert([
      {
        firm_id: profile.firm_id,
        source: 'advisor',
        item_type: fType,
        title: fTitle,
        body: fBody,
        response_framework: fFramework || null,
        data_needed: fData || null,
        dimension_code: fDim,
        sub_score_code: fSub || null,
        severity: fSev,
        score_trigger: fTrigger === '' ? null : Number(fTrigger),
        created_by: profile.id,
      },
    ]);
    if (err) {
      setError(err.message);
      return;
    }
    resetForm();
    setShowForm(false);
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
    toast.show('Advisory item added', 'good');
  };

  const removeItem = async (item: AdvisoryItemRow) => {
    setConfirmDelete(null);
    const { error: err } = await supabase.from('advisory_library_items').delete().eq('id', item.id);
    if (err) {
      toast.show(err.message, 'error');
      return;
    }
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
    toast.show('Item removed', 'good');
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Advisory library"
        crumbs={[{ label: 'Portfolio', to: '/' }, { label: 'Advisory library' }]}
        subtitle="The catalog of buyer questions, value initiatives, and diligence risk flags. Each item fires on an engagement when its DRS trigger is met."
        actions={
          profile?.firm_id && (
            <button onClick={() => setShowForm((s) => !s)}>
              {showForm ? 'Cancel' : 'Add firm item'}
            </button>
          )
        }
      />

      {showForm && profile?.firm_id && (
        <Card>
          <form className="advisory-form" onSubmit={createItem}>
            <div className="advisory-form-grid">
              <label>
                Type
                <select value={fType} onChange={(e) => setFType(e.target.value as AdvisoryItemType)}>
                  {(Object.keys(TYPE_LABEL) as AdvisoryItemType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Dimension
                <select value={fDim} onChange={(e) => setFDim(e.target.value)}>
                  {DIMENSIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sub-score code (optional)
                <input value={fSub} onChange={(e) => setFSub(e.target.value)} placeholder="e.g. OPS-HOURS" />
              </label>
              <label>
                Severity
                <select value={fSev} onChange={(e) => setFSev(e.target.value)}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Fires at score ≤
                <input
                  type="number"
                  value={fTrigger}
                  onChange={(e) => setFTrigger(e.target.value)}
                  min={0}
                  max={100}
                />
              </label>
            </div>
            <label>
              Title
              <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} required />
            </label>
            <label>
              Body {fType === 'buyer_question' ? '(the question)' : fType === 'risk_flag' ? '(the flag)' : '(the action)'}
              <textarea value={fBody} onChange={(e) => setFBody(e.target.value)} rows={2} required />
            </label>
            <label>
              Preparation / framework (optional)
              <textarea value={fFramework} onChange={(e) => setFFramework(e.target.value)} rows={2} />
            </label>
            <label>
              Documentation needed (optional)
              <textarea value={fData} onChange={(e) => setFData(e.target.value)} rows={2} />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div>
              <button type="submit">Add to library</button>
            </div>
          </form>
        </Card>
      )}

      <div className="advisory-filters">
        <select value={qType} onChange={(e) => setQType(e.target.value as AdvisoryItemType | 'all')}>
          <option value="all">All types</option>
          {(Object.keys(TYPE_LABEL) as AdvisoryItemType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select value={qDim} onChange={(e) => setQDim(e.target.value)}>
          <option value="all">All dimensions</option>
          {DIMENSIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search title or body…"
          value={qText}
          onChange={(e) => setQText(e.target.value)}
        />
        <span className="muted advisory-filters-count">
          {filtered.length} of {counts.total} · {counts.system} system, {counts.firm} firm
        </span>
      </div>

      {libraryQ.isLoading && <SkeletonLines lines={6} />}
      {libraryQ.isError && <p className="form-error">{(libraryQ.error as Error).message}</p>}

      {!libraryQ.isLoading && filtered.length === 0 && (
        <EmptyState title="No matching items">Adjust the filters, or add a firm-specific item.</EmptyState>
      )}

      {filtered.length > 0 && (
        <Card>
          <div className="advisory-list">
            {filtered.map((it) => (
              <div key={it.id} className={`advisory-item ${sevClass(it.severity)}`}>
                <div className="advisory-item-head">
                  <span className={`sev-chip ${sevClass(it.severity)}`}>{it.severity ?? 'note'}</span>
                  <div className="advisory-item-titles">
                    <p className="advisory-item-title">
                      {it.title}
                      <span className="advisory-tag">{TYPE_LABEL[it.item_type]}</span>
                      {it.source === 'advisor' && <span className="advisory-tag advisory-tag-firm">Firm</span>}
                    </p>
                    <p className="advisory-item-body">{it.body}</p>
                  </div>
                  <span className="advisory-item-score muted">
                    {it.sub_score_code ?? it.dimension_code ?? '—'}
                    {it.score_trigger != null ? ` ≤ ${it.score_trigger}` : ''}
                  </span>
                </div>
                {(it.response_framework || it.data_needed) && (
                  <div className="advisory-item-detail">
                    {it.response_framework && (
                      <div>
                        <span className="advisory-detail-label">Preparation</span>
                        <p>{it.response_framework}</p>
                      </div>
                    )}
                    {it.data_needed && (
                      <div>
                        <span className="advisory-detail-label">Documentation needed</span>
                        <p>{it.data_needed}</p>
                      </div>
                    )}
                  </div>
                )}
                {it.source === 'advisor' && (
                  <div className="advisory-item-actions">
                    <button className="button-danger-link" onClick={() => setConfirmDelete(it)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove advisory item?"
        confirmLabel="Remove"
        danger
        onConfirm={() => confirmDelete && removeItem(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      >
        {confirmDelete && (
          <p>"{confirmDelete.title}" will be removed from your firm's library.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
