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

// An append-only history entry for a single answer-provenance mutation — who set
// a financial answer's source to what, against which stored document, and when.
// Written into answer_provenance_events (immutable: no UPDATE/DELETE grant). Like
// logAccess, best-effort — recording the trail must never break the write it
// records.
export interface ProvenanceEvent {
  firmId: string;
  assessmentId: string;
  questionId?: string | null;
  source: 'self_reported' | 'document' | 'connected_ledger';
  evidenceDocumentId?: string | null;
  event: string; // e.g. 'manual_entry', 'ledger_sync', 'downgraded_no_evidence'
  actorProfileId?: string | null;
  note?: string | null;
}

export async function logProvenanceEvent(db: pg.ClientBase, e: ProvenanceEvent): Promise<void> {
  try {
    await db.query(
      `insert into answer_provenance_events
         (firm_id, assessment_id, question_id, source, evidence_document_id, event, actor_profile_id, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        e.firmId,
        e.assessmentId,
        e.questionId ?? null,
        e.source,
        e.evidenceDocumentId ?? null,
        e.event,
        e.actorProfileId ?? null,
        e.note ?? null,
      ],
    );
  } catch {
    /* never let audit logging break the operation it records */
  }
}
