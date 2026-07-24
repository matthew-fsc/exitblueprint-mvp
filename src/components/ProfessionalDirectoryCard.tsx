// The firm professional directory ("rolodex"): a reusable contact card rendered
// on both the Organization page (admins) and the standalone Network page (any
// advisor). Contacts are firm-scoped records — not logins — that can later be
// attached to an engagement's deal team or seeded into a collaborator invite.
//
// Two ways to get contacts in: one at a time via the form, or in bulk by pasting
// rows (CSV / one-per-line "name, org, kind, email, phone"). Writes go directly
// through the supabase client under RLS (firm staff may write their own firm's
// rows; see 20260721001300_firm_professionals_selfserve.sql).
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qk,
  useFirmProfessionals,
  type ProfessionalKind,
  type FirmProfessionalRow,
} from '../lib/queries';
import { ConfirmDialog, EmptyState, LoadingState, SectionCard, Switch, useToast } from './ui';

export const KIND_LABEL: Record<ProfessionalKind, string> = {
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  ma_advisor: 'M&A advisor',
  banker: 'Banker',
  wealth_manager: 'Wealth manager',
  insurance: 'Insurance',
  other: 'Other',
};

const EMPTY_FORM = { full_name: '', organization: '', kind: 'cpa' as ProfessionalKind, email: '', phone: '', notes: '' };

// Loose free-text → enum mapping for pasted rows, so "CPA", "accountant",
// "lawyer", "M&A", "wealth", etc. land on the right kind; unknown → 'other'.
const KIND_ALIASES: Record<string, ProfessionalKind> = {
  cpa: 'cpa', accountant: 'cpa', accounting: 'cpa',
  attorney: 'attorney', lawyer: 'attorney', legal: 'attorney', counsel: 'attorney',
  ma_advisor: 'ma_advisor', 'm&a': 'ma_advisor', 'm&a advisor': 'ma_advisor', advisor: 'ma_advisor', broker: 'ma_advisor',
  banker: 'banker', bank: 'banker', lender: 'banker',
  wealth_manager: 'wealth_manager', wealth: 'wealth_manager', 'wealth manager': 'wealth_manager', financial: 'wealth_manager',
  insurance: 'insurance',
  other: 'other',
};
function parseKind(raw: string): ProfessionalKind {
  const k = raw.trim().toLowerCase();
  return KIND_ALIASES[k] ?? 'other';
}

interface ParsedRow {
  full_name: string;
  organization: string | null;
  kind: ProfessionalKind;
  email: string | null;
  phone: string | null;
}

// Split one pasted line on comma OR tab (so spreadsheet paste works too).
function parsePasted(text: string): { rows: ParsedRow[]; skipped: number } {
  let skipped = 0;
  const rows: ParsedRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cells = trimmed.split(/[\t,]/).map((c) => c.trim());
    const name = cells[0] ?? '';
    if (!name) {
      skipped++;
      continue;
    }
    rows.push({
      full_name: name,
      organization: cells[1] || null,
      kind: cells[2] ? parseKind(cells[2]) : 'other',
      email: cells[3] || null,
      phone: cells[4] || null,
    });
  }
  return { rows, skipped };
}

export function ProfessionalDirectoryCard({
  firmId,
  meProfileId,
}: {
  firmId?: string;
  meProfileId?: string;
}) {
  const qc = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: pros, isLoading } = useFirmProfessionals(firmId, { includeArchived });

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<FirmProfessionalRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const { busy, run } = useAsyncAction();
  const toast = useToast();

  const parsedImport = useMemo(() => parsePasted(pasteText), [pasteText]);

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const invalidate = () => firmId && qc.invalidateQueries({ queryKey: qk.firmProfessionals(firmId) });

  const startEdit = (p: FirmProfessionalRow) => {
    setEditingId(p.id);
    setForm({
      full_name: p.full_name,
      organization: p.organization ?? '',
      kind: p.kind,
      email: p.email ?? '',
      phone: p.phone ?? '',
      notes: p.notes ?? '',
    });
  };

  const submit = () =>
    run(
      async () => {
        if (!firmId || !form.full_name.trim()) throw new Error('A name is required.');
        const payload = {
          firm_id: firmId,
          full_name: form.full_name.trim(),
          organization: form.organization.trim() || null,
          kind: form.kind,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          notes: form.notes.trim() || null,
        };
        if (editingId) {
          const { error } = await supabase.from('firm_professionals').update(payload).eq('id', editingId);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await supabase.from('firm_professionals').insert({ ...payload, created_by: meProfileId ?? null });
          if (error) throw new Error(error.message);
        }
        reset();
        invalidate();
      },
      { success: editingId ? 'Contact updated' : 'Contact added' },
    );

  const importRows = () =>
    run(async () => {
      if (!firmId) throw new Error('No firm.');
      const { rows, skipped } = parsedImport;
      if (rows.length === 0) throw new Error('Nothing to import. Paste at least one row with a name.');
      const payload = rows.map((r) => ({ ...r, firm_id: firmId, created_by: meProfileId ?? null }));
      const { error } = await supabase.from('firm_professionals').insert(payload);
      if (error) throw new Error(error.message);
      setPasteText('');
      setImportOpen(false);
      invalidate();
      toast.show(
        `Imported ${rows.length} ${rows.length === 1 ? 'contact' : 'contacts'}` +
          (skipped ? ` · skipped ${skipped} malformed` : ''),
        'good',
      );
    });

  const setArchived = (p: FirmProfessionalRow, archived: boolean) =>
    run(
      async () => {
        const { error } = await supabase.from('firm_professionals').update({ archived }).eq('id', p.id);
        if (error) throw new Error(error.message);
        setArchiving(null);
        invalidate();
      },
      { success: archived ? 'Contact archived' : 'Contact restored' },
    );

  return (
    <SectionCard
      title="Professional directory"
      subtitle="Your clients' outside professionals: CPAs, attorneys, M&A advisors, bankers. Curate them once here, then attach them to any engagement's deal team."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {isLoading ? (
          <LoadingState variant="inline" />
        ) : (pros ?? []).length === 0 ? (
          <EmptyState title="No professionals yet">Add the first outside professional your firm works with below, or paste your rolodex in bulk.</EmptyState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {(pros ?? []).map((p) => (
              <div key={p.id} className="eb-list-row" style={{ opacity: p.archived ? 0.55 : 1 }}>
                <div className="eb-list-row-main">
                  <div style={{ fontWeight: 600 }}>
                    {p.full_name}
                    {p.organization && <span className="muted text-sm"> · {p.organization}</span>}
                  </div>
                  <div className="muted text-sm">
                    {[p.email, p.phone].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                <span className="status-chip status-neutral eb-list-row-push">{KIND_LABEL[p.kind]}</span>
                {p.archived && <span className="status-chip status-warning">Archived</span>}
                <button className="linkish" type="button" onClick={() => startEdit(p)}>Edit</button>
                {p.archived ? (
                  <button className="linkish" type="button" onClick={() => setArchived(p, false)} disabled={busy}>Restore</button>
                ) : (
                  <button className="linkish" type="button" onClick={() => setArchiving(p)}>Archive</button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
          <div className="control-row" style={{ justifyContent: 'space-between' }}>
            <span className="stat-block-label">{editingId ? 'Edit contact' : 'Add a professional'}</span>
            {!editingId && (
              <button className="linkish" type="button" onClick={() => setImportOpen((v) => !v)}>
                {importOpen ? 'Close bulk import' : 'Paste contacts in bulk'}
              </button>
            )}
          </div>

          {importOpen && !editingId ? (
            <div className="directory-import" style={{ marginTop: 'var(--space-3)' }}>
              <p className="muted text-sm m-0">
                One contact per line: <code>name, organization, type, email, phone</code>. Only the name is
                required; commas or tabs (paste from a spreadsheet) both work. Type is matched loosely
                (CPA, attorney, banker, wealth, insurance, M&amp;A) and defaults to Other.
              </p>
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'Dana Reyes, Reyes & Co. CPAs, cpa, dana@reyescpa.com, (555) 123-4567\nSam Lee, Lee Law, attorney, sam@leelaw.com'}
                style={{ marginTop: 'var(--space-2)', width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
              />
              <div className="control-row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
                <button onClick={importRows} disabled={busy || parsedImport.rows.length === 0}>
                  {busy ? 'Importing…' : `Import ${parsedImport.rows.length || ''} ${parsedImport.rows.length === 1 ? 'contact' : 'contacts'}`.trim()}
                </button>
                <button className="button-secondary" type="button" onClick={() => { setImportOpen(false); setPasteText(''); }} disabled={busy}>
                  Cancel
                </button>
                {pasteText.trim() && (
                  <span className="muted text-sm">
                    {parsedImport.rows.length} ready{parsedImport.skipped ? ` · ${parsedImport.skipped} skipped` : ''}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }} className="settings-grid">
                <label className="field">
                  <span className="field-label">Name</span>
                  <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Dana Reyes" />
                </label>
                <label className="field">
                  <span className="field-label">Organization</span>
                  <input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} placeholder="Reyes & Co. CPAs" />
                </label>
                <label className="field">
                  <span className="field-label">Type</span>
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProfessionalKind })}>
                    {(Object.keys(KIND_LABEL) as ProfessionalKind[]).map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Email</span>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="dana@reyescpa.com" />
                </label>
                <label className="field">
                  <span className="field-label">Phone</span>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" />
                </label>
                <label className="field" style={{ gridColumn: '1 / -1' }}>
                  <span className="field-label">Notes</span>
                  <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Relationship, specialty, or how you work together." />
                </label>
              </div>
              <div className="control-row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
                <button onClick={submit} disabled={busy || !form.full_name.trim()}>
                  {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add professional'}
                </button>
                {editingId && (
                  <button className="button-secondary" type="button" onClick={reset} disabled={busy}>Cancel</button>
                )}
                <span className="control-row" style={{ marginLeft: 'auto', gap: 'var(--space-2)' }}>
                  <Switch
                    size="sm"
                    checked={includeArchived}
                    onChange={setIncludeArchived}
                    label={<span className="muted text-sm">Show archived</span>}
                  />
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!archiving}
        title="Archive this professional?"
        confirmLabel="Archive"
        cancelLabel="Cancel"
        busy={busy}
        onCancel={() => !busy && setArchiving(null)}
        onConfirm={() => archiving && setArchived(archiving, true)}
      >
        <p className="m-0">
          {archiving?.full_name} will be hidden from the directory and can't be attached to new engagements. Existing
          engagement links are kept. You can restore them later.
        </p>
      </ConfirmDialog>
    </SectionCard>
  );
}
