import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import {
  qk,
  useVerification,
  type ProvenanceSource,
  type VerificationTier,
} from '../lib/queries';
import { Card, SkeletonLines, useToast } from './ui';

const TIER_LABEL: Record<VerificationTier, string> = {
  self_reported: 'Self-reported',
  partly_verified: 'Partly verified',
  document_verified: 'Document-verified',
};
const TIER_CLASS: Record<VerificationTier, string> = {
  self_reported: 'verif-tier-low',
  partly_verified: 'verif-tier-mid',
  document_verified: 'verif-tier-high',
};
const SOURCE_LABEL: Record<ProvenanceSource, string> = {
  self_reported: 'Self-reported',
  document: 'Document',
  connected_ledger: 'Ledger (QB/Xero)',
};

// Phase 1: financial verification. Shows the share of financial inputs that are
// document- or ledger-backed, and lets the advisor set each input's source. The
// ledger option is the manual stand-in until the QuickBooks/Xero connect lands.
export function VerificationCard({
  assessmentId,
  firmId,
}: {
  assessmentId: string;
  firmId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const verifQ = useVerification(assessmentId);
  const summary = verifQ.data;

  const setSource = async (questionId: string, source: ProvenanceSource) => {
    const { error } = await supabase.from('answer_provenance').upsert(
      {
        firm_id: firmId,
        assessment_id: assessmentId,
        question_id: questionId,
        source,
        verified_by: profile?.id ?? null,
        verified_at: source === 'self_reported' ? null : new Date().toISOString(),
      },
      { onConflict: 'assessment_id,question_id' },
    );
    if (error) {
      toast.show(error.message, 'error');
      return;
    }
    qc.invalidateQueries({ queryKey: qk.verification(assessmentId) });
  };

  return (
    <Card>
      <div className="verif-head">
        <span className="stat-block-label">Financial verification</span>
        {summary && (
          <span className={`verif-badge ${TIER_CLASS[summary.tier]}`}>
            {summary.pct}% · {TIER_LABEL[summary.tier]}
          </span>
        )}
      </div>
      <p className="muted" style={{ margin: 'var(--space-1) 0 var(--space-4)' }}>
        How much of the financial picture is backed by documents or a connected ledger, rather than
        self-reported. Verified inputs turn a claimed score into a defensible one.
      </p>

      {verifQ.isLoading || !summary ? (
        <SkeletonLines lines={4} />
      ) : (
        <>
          <div className="verif-bar" title={`${summary.verified_inputs} of ${summary.total_inputs} inputs verified`}>
            <div className={`verif-fill ${TIER_CLASS[summary.tier]}`} style={{ width: `${summary.pct}%` }} />
          </div>
          <ul className="verif-list">
            {summary.inputs.map((inp) => (
              <li key={inp.question_id} className="verif-row">
                <span className="verif-code">{inp.question_code}</span>
                <span className="verif-prompt" title={inp.prompt}>{inp.prompt}</span>
                <select
                  className={`verif-select verif-src-${inp.source}`}
                  value={inp.source}
                  onChange={(e) => setSource(inp.question_id, e.target.value as ProvenanceSource)}
                  aria-label={`Source for ${inp.question_code}`}
                >
                  {(Object.keys(SOURCE_LABEL) as ProvenanceSource[]).map((s) => (
                    <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
