// Beta Requirement 5: audit log of access to client records. Best-effort — a
// logging failure must never break the read it records — written server-side
// (service_role) into data_access_log, which advisors read for compliance.
import type pg from 'pg';

export interface AccessEvent {
  firmId: string;
  actorUserId?: string | null;
  actorProfileId?: string | null;
  action: string; // e.g. 'document.read', 'document.download', 'report.download'
  resourceType: string; // e.g. 'document', 'owner_report'
  resourceId?: string | null;
  engagementId?: string | null;
  detail?: Record<string, unknown> | null;
}

export async function logAccess(db: pg.ClientBase, e: AccessEvent): Promise<void> {
  try {
    await db.query(
      `insert into data_access_log
         (firm_id, actor_user_id, actor_profile_id, action, resource_type, resource_id, engagement_id, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.firmId,
        e.actorUserId ?? null,
        e.actorProfileId ?? null,
        e.action,
        e.resourceType,
        e.resourceId ?? null,
        e.engagementId ?? null,
        e.detail ? JSON.stringify(e.detail) : null,
      ],
    );
  } catch {
    /* never let audit logging break the operation it records */
  }
}
