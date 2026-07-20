import { useAuth } from './auth';
import {
  useAssessmentsByEngagement,
  useCompany,
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
  loading: boolean;
  // A failed load must never be silently indistinguishable from "no data yet" —
  // every owner page branches on this before falling through to an empty state.
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

// Resolves the signed-in owner's single engagement and its assessments. Every
// owner page starts here; RLS guarantees they only ever see their own company.
export function useOwnerContext(): OwnerContext {
  const { profile } = useAuth();
  const companyId = profile?.company_id ?? undefined;
  const companyQ = useCompany(companyId);
  const engagementQ = useOwnerEngagement(companyId);
  const engagement = engagementQ.data ?? null;
  const assessmentsQ = useAssessmentsByEngagement(engagement?.id);
  const completed = (assessmentsQ.data ?? []).filter((a) => a.status === 'completed');
  return {
    companyId,
    company: companyQ.data ?? null,
    engagement,
    completed,
    latest: completed[completed.length - 1] ?? null,
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
