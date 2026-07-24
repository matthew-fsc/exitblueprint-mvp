import { useAuth } from './auth';
import {
  useAssessmentsByEngagement,
  useCompany,
  useEngagement,
  useOwnerEngagement,
  type AssessmentRow,
  type CompanyRow,
  type EngagementRow,
} from './queries';

export interface OwnerContext {
  companyId: string | undefined;
  company: CompanyRow | null;
  engagement: EngagementRow | null;
  completed: AssessmentRow[];
  latest: AssessmentRow | null;
  // The one in-progress assessment the advisor has shared to this portal for the
  // client to fill out (null when none is shared). Owner RLS already narrows the
  // assessment list to completed rows + this shared draft.
  sharedAssessment: AssessmentRow | null;
  loading: boolean;
  // A failed load must never be silently indistinguishable from "no data yet" —
  // every owner page branches on this before falling through to an empty state.
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

// Resolves the signed-in portal user's engagement and its assessments. Every
// owner/collaborator page starts here; RLS guarantees they only ever see what
// they're scoped to. An owner resolves their company's engagement; a view-only
// collaborator is pinned to a single engagement_id (their profile carries it),
// so they see exactly the one engagement they were invited to — never a sibling
// engagement of the same company.
export function useOwnerContext(): OwnerContext {
  const { profile } = useAuth();
  const companyId = profile?.company_id ?? undefined;
  const scopedEngagementId = profile?.engagement_id ?? undefined;
  const companyQ = useCompany(companyId);
  // Collaborators resolve their one engagement by id; owners resolve the most
  // recent engagement for their company. Both hooks always run (disabled when
  // their id is undefined) so hook order is stable.
  const directEngagementQ = useEngagement(scopedEngagementId);
  const ownerEngagementQ = useOwnerEngagement(scopedEngagementId ? undefined : companyId);
  const engagementQ = scopedEngagementId ? directEngagementQ : ownerEngagementQ;
  const engagement = engagementQ.data ?? null;
  const assessmentsQ = useAssessmentsByEngagement(engagement?.id);
  const completed = (assessmentsQ.data ?? []).filter((a) => a.status === 'completed');
  // RLS only ever exposes a single in-progress assessment to the owner (the shared
  // one), so the first in-progress row is it.
  const sharedAssessment = (assessmentsQ.data ?? []).find((a) => a.status === 'in_progress') ?? null;
  return {
    companyId,
    company: companyQ.data ?? null,
    engagement,
    completed,
    latest: completed[completed.length - 1] ?? null,
    sharedAssessment,
    loading: engagementQ.isLoading || (!!engagement && assessmentsQ.isLoading),
    isError: companyQ.isError || engagementQ.isError || assessmentsQ.isError,
    error: engagementQ.error ?? assessmentsQ.error ?? companyQ.error,
    refetch: () => {
      companyQ.refetch();
      engagementQ.refetch();
      assessmentsQ.refetch();
    },
  };
}
