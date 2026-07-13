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
  };
}
