// The engagement's deal-team professionals, drawn from the firm's directory.
// Staff attach a directory contact (the client's CPA, attorney, M&A advisor, …)
// to this engagement and note their role on the deal. This is the RELATIONSHIP
// roster — distinct from EngagementTeamCard, which grants a view-only PORTAL
// login. Directory entries are curated by admins in the Organization area; here
// any staff member picks from them. Writes go direct under RLS (staff CRUD).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qk,
  useEngagementProfessionals,
  useFirmProfessionals,
  type ProfessionalKind,
} from '../lib/queries';
import { EmptyState, SectionCard, SkeletonLines } from './ui';

const KIND_LABEL: Record<ProfessionalKind, string> = {
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  ma_advisor: 'M&A advisor',
  banker: 'Banker',
  wealth_manager: 'Wealth manager',
  insurance: 'Insurance',
  other: 'Other',
};

export function EngagementProfessionalsCard({
  engagementId,
  firmId,
}: {
  engagementId: string;
  firmId: string;
}) {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const linkedQ = useEngagementProfessionals(engagementId);
  const directoryQ = useFirmProfessionals(firmId);
  const { busy, run } = useAsyncAction();

  const [professionalId, setProfessionalId] = useState('');
  const [role, setRole] = useState('');

  const linked = linkedQ.data ?? [];
  const linkedIds = new Set(linked.map((l) => l.professional_id));
  const available = (directoryQ.data ?? []).filter((p) => !linkedIds.has(p.id));

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.engagementProfessionals(engagementId) });

  const attach = () =>
    run(
      async () => {
        if (!professionalId) throw new Error('Pick a professional from the directory.');
        const { error } = await supabase.from('engagement_professionals').insert({
          firm_id: firmId,
          engagement_id: engagementId,
          professional_id: professionalId,
          engagement_role: role.trim() || null,
          added_by: profile?.id ?? null,
        });
        if (error) throw new Error(error.message);
        setProfessionalId('');
        setRole('');
        invalidate();
      },
      { success: 'Added to the deal team' },
    );

  const remove = (id: string) =>
    run(
      async () => {
        const { error } = await supabase.from('engagement_professionals').delete().eq('id', id);
        if (error) throw new Error(error.message);
        invalidate();
      },
      { success: 'Removed from the deal team' },
    );

  return (
    <SectionCard
      title="Deal-team professionals"
      subtitle="The client's outside professionals on this engagement — pulled from your firm's directory. Attaching one here records who's on the deal; it does not grant portal access."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {linkedQ.isLoading ? (
          <SkeletonLines lines={2} />
        ) : linked.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {linked.map((l) => (
              <li
                key={l.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {l.professional?.full_name ?? 'Professional'}
                    {l.professional?.organization && <span className="muted text-sm"> · {l.professional.organization}</span>}
                  </div>
                  <div className="muted text-sm">
                    {l.professional ? KIND_LABEL[l.professional.kind] : ''}
                    {l.engagement_role ? ` · ${l.engagement_role}` : ''}
                  </div>
                </div>
                <button className="linkish" type="button" onClick={() => remove(l.id)} disabled={busy} style={{ marginLeft: 'auto' }}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No professionals on this deal yet">
            Attach the client's CPA, attorney, or M&A advisor from your firm's directory.
          </EmptyState>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) auto', gap: 'var(--space-2)', alignItems: 'end' }} className="team-invite-row">
          <label className="field">
            <span className="field-label">From directory</span>
            <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} disabled={available.length === 0}>
              <option value="">{available.length === 0 ? 'No more in directory' : 'Choose a professional…'}</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name}
                  {p.organization ? ` — ${p.organization}` : ''} ({KIND_LABEL[p.kind]})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Role on this deal (optional)</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Deal counsel, QoE, …" />
          </label>
          <button onClick={attach} disabled={busy || !professionalId}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
        {available.length === 0 && (directoryQ.data ?? []).length === 0 && (
          <p className="muted text-sm">
            Your firm directory is empty. An admin can add professionals under Organization → Professional directory.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
