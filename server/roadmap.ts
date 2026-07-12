// Roadmap task instantiation (F5). Turns an engagement's open gaps into a
// concrete task set: for each open gap — critical severity first — the mapped
// remediation playbook's task templates are copied into `tasks`, with due dates
// derived from the engagement start plus each template's offset. Deduped by
// playbook (a playbook that several gaps trigger is instantiated once, linked to
// the most-critical of those gaps) and idempotent across runs.
import type pg from 'pg';

export interface RoadmapResult {
  tasksCreated: number;
}

// Critical first, then high, med, low. (The severity enum's storage order is not
// guaranteed to be severity order, so rank explicitly.)
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };

export async function instantiateTasksForGaps(
  db: pg.ClientBase,
  engagementId: string,
): Promise<RoadmapResult> {
  const eng = (
    await db.query(`select id, firm_id, started_at from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error(`engagement ${engagementId} not found`);

  const gaps = (
    await db.query(
      `select g.id as gap_id, gd.severity, gd.id as gap_def_id
       from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')`,
      [engagementId],
    )
  ).rows;
  gaps.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));

  // Idempotency: existing gap-derived tasks keyed by playbook + sequence.
  const existing = new Set<string>(
    (
      await db.query(
        `select playbook_id, sequence from tasks
         where engagement_id = $1 and playbook_id is not null`,
        [engagementId],
      )
    ).rows.map((r) => `${r.playbook_id}:${r.sequence}`),
  );

  const donePlaybooks = new Set<string>();
  let created = 0;

  for (const gap of gaps) {
    const maps = (
      await db.query(
        `select playbook_id from gap_playbook_map where gap_definition_id = $1 order by priority`,
        [gap.gap_def_id],
      )
    ).rows;
    for (const m of maps) {
      if (donePlaybooks.has(m.playbook_id)) continue; // one playbook, once, most-critical gap wins
      donePlaybooks.add(m.playbook_id);
      const templates = (
        await db.query(
          `select title, description, default_owner_role, sequence, target_offset_days
           from playbook_task_templates where playbook_id = $1 order by sequence`,
          [m.playbook_id],
        )
      ).rows;
      for (const t of templates) {
        const key = `${m.playbook_id}:${t.sequence}`;
        if (existing.has(key)) continue;
        await db.query(
          `insert into tasks
             (firm_id, engagement_id, gap_id, playbook_id, title, description, owner_role, status, due_date, sequence)
           values ($1, $2, $3, $4, $5, $6, $7, 'todo',
                   ($8::date + (($9)::text || ' days')::interval)::date, $10)`,
          [
            eng.firm_id,
            engagementId,
            gap.gap_id,
            m.playbook_id,
            t.title,
            t.description,
            t.default_owner_role,
            eng.started_at,
            t.target_offset_days ?? 0,
            t.sequence,
          ],
        );
        existing.add(key);
        created++;
      }
    }
  }

  return { tasksCreated: created };
}
