// Beta Requirement 6: usage instrumentation. A single fire-and-forget helper that
// writes advisor-journey events to the usage_events table (RLS-scoped to the
// caller's firm). No third-party analytics. Instrumentation must never break the
// UI, so every failure is swallowed.
import { supabase } from './supabase';

// A per-tab session id so one working session's events group together — enough
// to reconstruct where an advisor stalled (acceptance criterion 5).
function sessionId(): string {
  const KEY = 'eb-usage-session';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'no-session';
  }
}

export interface TrackEvent {
  type: string; // coarse bucket: 'onboarding' | 'assessment' | 'document' | 'report' | 'review'
  name: string; // specific action
  firmId?: string | null;
  profileId?: string | null;
  engagementId?: string | null;
  properties?: Record<string, unknown>;
}

export async function track(event: TrackEvent): Promise<void> {
  try {
    if (!event.firmId) return; // event must be firm-scoped to satisfy RLS insert
    const { data } = await supabase.auth.getSession();
    await supabase.from('usage_events').insert({
      firm_id: event.firmId,
      actor_user_id: data.session?.user?.id ?? null,
      actor_profile_id: event.profileId ?? null,
      engagement_id: event.engagementId ?? null,
      event_type: event.type,
      event_name: event.name,
      properties: event.properties ?? {},
      session_id: sessionId(),
      occurred_at: new Date().toISOString(),
    });
  } catch {
    /* analytics must never break the app */
  }
}
