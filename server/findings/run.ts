// Run the finding patterns against an engagement's graph and persist the
// results: a findings row per match plus a finding_approval review item so the
// advisor signs off before a finding reaches a report. Idempotent — re-running
// rebuilds the engagement's findings rather than duplicating them. Kept separate
// from the pipeline's match_findings step (which sits downstream of the still-
// stubbed score step) so verification can surface findings today.
import type pg from 'pg';
import { PATTERN_REGISTRY } from './patterns';

export interface FindingsRunResult {
  findings: number;
}

export async function runFindings(
  db: pg.ClientBase,
  firmId: string,
  engagementId: string,
): Promise<FindingsRunResult> {
  // Rebuild the engagement's findings atomically: a matcher that throws must not
  // leave the findings half-cleared.
  await db.query('begin');
  try {
    // Clear prior findings and their pending approval items; approved/rejected
    // history on resolved review items is left alone.
    await db.query(`delete from findings where engagement_id = $1`, [engagementId]);
    await db.query(
      `delete from review_items
        where engagement_id = $1 and type = 'finding_approval' and status = 'pending'`,
      [engagementId],
    );

    let count = 0;
    for (const pattern of Object.values(PATTERN_REGISTRY)) {
      const matches = await pattern.match({ db, engagementId });
      for (const match of matches) {
        const finding = await db.query(
          `insert into findings
             (firm_id, engagement_id, pattern_key, severity, graph_evidence, status)
           values ($1, $2, $3, $4, $5, 'pending') returning id`,
          [firmId, engagementId, pattern.patternKey, match.severity, JSON.stringify(match.evidence)],
        );
        const findingId = finding.rows[0].id as string;
        await db.query(
          `insert into review_items (firm_id, engagement_id, type, payload)
           values ($1, $2, 'finding_approval', $3)`,
          [
            firmId,
            engagementId,
            JSON.stringify({
              finding_id: findingId,
              pattern_key: pattern.patternKey,
              description: pattern.description,
              severity: match.severity,
              evidence: match.evidence,
            }),
          ],
        );
        count++;
      }
    }
    await db.query('commit');
    return { findings: count };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}
