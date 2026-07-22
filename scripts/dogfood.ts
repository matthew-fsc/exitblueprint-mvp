// Dogfooding seed — provisions ExitBlueprint as its OWN first tenant AND runs the
// company through its own readiness lens end to end (docs/40 §4c/§6 "eat your own
// cooking"; runbook: the "Dogfooding" section of docs/39-sales-demo-runbook.md).
// We are a lower-middle-market business that will one day raise or exit, so we hold
// ourselves to our own rigor: our own firm, our own DRS/ORI trajectory, our own
// evidence binder, our own honestly-named gaps.
//
// This builds directly on scripts/seed-internal-tenant.ts: `seedInternalTenant`
// provisions the firm + company + engagement + agreement acceptance through the
// SAME primitives admin.ts create-firm uses; this script then adds the internal
// advisor (the same gated path admin.ts create-advisor uses), two immutable scored
// assessments, the remediation Plan, an evidence binder, and a few firm-scoped
// Library items — so the internal tenant looks like a real engagement.
//
// ISOLATION GUARANTEE (CLAUDE.md rule #5; docs/40 §4c). The internal tenant is a
// *customer of the platform, not a backdoor around it.* Every write is firm_id
// scoped and looked up before insert; it runs over the same service-role
// DATABASE_URL as db:seed / seed:demo / admin; it NEVER disables RLS, loosens or
// drops a policy, grants a superadmin or special role, or reads across firms.
// Platform-operator access stays on the separate PLATFORM_SUPERADMIN_IDS gate,
// untouched here — the internal firm's advisor is an ordinary firm-scoped user.
//
// Rule #4: the self-assessment is two normal immutable assessments tied to a
// rubric_version. Rule #1: the answers are ExitBlueprint's own honest, conservative
// inputs in seed/dogfood/*.json, scored by the REAL engine and re-validated against
// the canonical reference scorer — any drift aborts without committing.
//
// Idempotent: safe to re-run (looks up before insert; assessments are skipped once
// present — a changed score would be a NEW assessment, never an edit).
//
// Usage: DATABASE_URL=... npm run dogfood
//   Optional: DOGFOOD_ADVISOR_EMAIL (default founder@exitblueprint.com)
//             DOGFOOD_ADVISOR_NAME  (default "ExitBlueprint Founder")
//             DOGFOOD_ADVISOR_ROLE  (default admin — full workspace access)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import { instantiateTasksForGaps } from '../server/roadmap';
import {
  addMembership,
  clerkEnabled,
  findOrCreateUser,
  orgRoleForAppRole,
  type AppRole,
} from '../server/clerk';
import type { Answers } from '../shared/scoring/types';
import {
  seedInternalTenant,
  INTERNAL_FIRM_NAME,
  INTERNAL_COMPANY_NAME,
  type DbLike,
} from './seed-internal-tenant';

const ADVISOR_EMAIL = process.env.DOGFOOD_ADVISOR_EMAIL ?? 'founder@exitblueprint.com';
const ADVISOR_NAME = process.env.DOGFOOD_ADVISOR_NAME ?? 'ExitBlueprint Founder';
const ADVISOR_ROLE = (process.env.DOGFOOD_ADVISOR_ROLE ?? 'admin') as AppRole;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface DogfoodSnapshot {
  profile: string;
  snapshot_date: string;
  answers: Answers;
  expected: {
    sub_scores: Record<string, number>;
    drs: number;
    tier: string;
    owner_readiness_index: number;
    gaps: string[];
  };
}

const snapshots: DogfoodSnapshot[] = [1, 2].map((n) =>
  JSON.parse(readFileSync(join(root, 'seed', 'dogfood', `dogfood-snapshot-${n}.json`), 'utf8')),
);

// Provision the internal advisor via the SAME gated path admin.ts create-advisor
// uses: Clerk user + org membership when CLERK_SECRET_KEY is set, else the dev
// auth.users row (local emulator). Returns the profile id. An ordinary firm-scoped
// user — no superadmin, no special grant.
async function ensureInternalAdvisor(db: pg.Client, firmId: string): Promise<string> {
  let userId: string;
  if (clerkEnabled()) {
    const orgId = (await db.query(`select clerk_org_id from firms where id = $1`, [firmId])).rows[0]
      ?.clerk_org_id as string | null | undefined;
    if (!orgId) {
      throw new Error(
        `internal firm ${firmId} has no Clerk organization — seedInternalTenant should have created it`,
      );
    }
    const { id, created } = await findOrCreateUser(ADVISOR_EMAIL, ADVISOR_NAME);
    await addMembership(orgId, id, orgRoleForAppRole(ADVISOR_ROLE));
    console.log(`dogfood: ${created ? 'created' : 'reused'} Clerk advisor ${id} in org ${orgId}`);
    userId = id;
  } else {
    const existing = await db.query(`select id from auth.users where email = $1`, [ADVISOR_EMAIL]);
    userId = existing.rowCount
      ? existing.rows[0].id
      : (
          await db.query(
            `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
            [ADVISOR_EMAIL],
          )
        ).rows[0].id;
  }

  const profile = await db.query(
    `insert into profiles (user_id, firm_id, role, email, full_name)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set firm_id = excluded.firm_id, role = excluded.role,
           email = excluded.email, full_name = coalesce(excluded.full_name, profiles.full_name)
     returning id`,
    [userId, firmId, ADVISOR_ROLE, ADVISOR_EMAIL, ADVISOR_NAME],
  );
  return profile.rows[0].id as string;
}

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const rubricVersion = await db.query(
      `select id from rubric_versions where status = 'active' order by created_at desc limit 1`,
    );
    if (rubricVersion.rowCount === 0) {
      throw new Error('no active rubric version — run npm run db:seed first');
    }
    const rubricVersionId = rubricVersion.rows[0].id;
    const questionIds = new Map<string, string>(
      (
        await db.query(
          `select q.id, q.code from questions q
           join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rubricVersionId],
        )
      ).rows.map((r) => [r.code, r.id]),
    );

    // 1. Firm + company + engagement + agreement acceptance — the existing
    //    internal-tenant bootstrap (same primitives as admin.ts create-firm).
    const seeded = await seedInternalTenant(db as unknown as DbLike);
    const { firmId, engagementId } = seeded;
    console.log(
      `dogfood: internal tenant ready — firm ${firmId} (${seeded.firmCreated ? 'created' : 'present'}), ` +
        `engagement ${engagementId} (${seeded.engagementCreated ? 'created' : 'present'})`,
    );

    // 2. Internal advisor — the sanctioned create-advisor path. Attach to the
    //    engagement if it has no advisor yet (idempotent).
    const advisorProfileId = await ensureInternalAdvisor(db, firmId);
    await db.query(`update engagements set advisor_id = $2 where id = $1 and advisor_id is null`, [
      engagementId,
      advisorProfileId,
    ]);
    console.log(`dogfood: internal advisor '${ADVISOR_EMAIL}' (${ADVISOR_ROLE}) → profile ${advisorProfileId}`);

    // 3. Two immutable assessments — our own baseline + reassessment. Scored by the
    //    REAL engine and re-validated against the reference scorer; any drift aborts.
    for (const [index, snapshot] of snapshots.entries()) {
      const sequence = index + 1;
      const existing = await db.query(
        `select id, status, drs_score from assessments
         where engagement_id = $1 and sequence_number = $2 and record_status = 'active'`,
        [engagementId, sequence],
      );
      if (existing.rowCount) {
        const drs = Number(existing.rows[0].drs_score);
        if (existing.rows[0].status !== 'completed' || drs !== snapshot.expected.drs) {
          throw new Error(
            `dogfood assessment ${sequence} exists but does not match expected (drs ${drs} vs ${snapshot.expected.drs})`,
          );
        }
        console.log(`dogfood: assessment ${sequence} already present (DRS ${drs}) — skipped`);
        continue;
      }

      const assessmentId = (
        await db.query(
          `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
           values ($1, $2, $3, $4) returning id`,
          [firmId, engagementId, rubricVersionId, sequence],
        )
      ).rows[0].id;
      for (const [code, value] of Object.entries(snapshot.answers)) {
        const questionId = questionIds.get(code);
        if (!questionId) continue;
        await db.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`, [
          assessmentId,
          questionId,
          JSON.stringify(value),
        ]);
      }

      const result = await scoreAssessment(db, assessmentId);
      const mismatches: string[] = [];
      if (result.drsScore !== snapshot.expected.drs) mismatches.push(`drs ${result.drsScore} != ${snapshot.expected.drs}`);
      if (result.drsTier !== snapshot.expected.tier) mismatches.push(`tier ${result.drsTier} != ${snapshot.expected.tier}`);
      if (result.oriScore !== snapshot.expected.owner_readiness_index) {
        mismatches.push(`ori ${result.oriScore} != ${snapshot.expected.owner_readiness_index}`);
      }
      if (JSON.stringify(result.gapCodes) !== JSON.stringify(snapshot.expected.gaps)) {
        mismatches.push(`gaps ${result.gapCodes} != ${snapshot.expected.gaps}`);
      }
      for (const [code, points] of Object.entries(snapshot.expected.sub_scores)) {
        const got = result.subScores.find((s) => s.code === code)?.points;
        if (got !== points) mismatches.push(`sub_score ${code} ${got} != ${points}`);
      }
      if (mismatches.length > 0) {
        throw new Error(
          `dogfood: engine output does not match reference scorer for snapshot ${sequence}:\n  ${mismatches.join('\n  ')}`,
        );
      }
      await db.query(`update assessments set completed_at = $2 where id = $1`, [assessmentId, snapshot.snapshot_date]);
      console.log(
        `dogfood: assessment ${sequence} scored DRS ${result.drsScore} (${result.drsTier}), ` +
          `ORI ${result.oriScore}, ${result.gapCodes.length} gaps — matches reference scorer`,
      );
    }

    // 4. Engagement outcome — we are honestly preparing for a future raise/exit.
    await db.query(
      `insert into engagement_outcomes (firm_id, engagement_id, process_status)
       values ($1, $2, 'preparing')
       on conflict (engagement_id) do nothing`,
      [firmId, engagementId],
    );

    // 5. The Plan — our own remediation roadmap, instantiated from the open gaps on
    //    the latest assessment (anchored to today, forward-looking). Idempotent.
    const roadmap = await instantiateTasksForGaps(db, engagementId, new Date().toISOString().slice(0, 10));
    if (roadmap.tasksCreated > 0) console.log(`dogfood: plan built — ${roadmap.tasksCreated} remediation tasks`);

    // 6. Evidence binder — our own data-room readiness, honest to our posture:
    //    statements exist, but owner-independence, management depth, and customer
    //    concentration are open gaps we don't hide. Idempotent on (engagement, item).
    const evidence: [string, string][] = [
      ['FIN-STMTS', 'ready'],
      ['FIN-QOE', 'in_progress'],
      ['OPS-SOP', 'in_progress'],
      ['OPS-OWNER', 'gap'],
      ['HR-KEY', 'gap'],
      ['CUS-CONC', 'gap'],
      ['CUS-CONTRACTS', 'in_progress'],
    ];
    for (const [itemCode, state] of evidence) {
      await db.query(
        `insert into engagement_data_room_items (firm_id, engagement_id, item_code, readiness_state)
         values ($1, $2, $3, $4)
         on conflict (engagement_id, item_code) do update set readiness_state = excluded.readiness_state`,
        [firmId, engagementId, itemCode, state],
      );
    }
    console.log(`dogfood: evidence binder seeded — ${evidence.length} data-room item states`);

    // 7. A few Library items ExitBlueprint authored for itself — advisor-sourced,
    //    FIRM-SCOPED (firm_id set), so they demonstrate tenant isolation: only the
    //    internal firm sees them. Idempotent on (firm_id, title).
    const libraryItems: [string, string, string, string, string, string][] = [
      [
        'initiative',
        'Reduce founder operating hours below 20/week',
        'Our top honest gap is owner dependence. Delegate documented processes to the first ops hire and transition founder-held customer relationships to the team.',
        'OPS',
        'OPS-HOURS',
        'critical',
      ],
      [
        'risk_flag',
        'Early-pilot customer concentration',
        'A handful of anchor advisor firms still drive a large share of revenue. Diversify the book and paper multi-year renewals before any raise or process.',
        'CUS',
        'CUS-TOP1',
        'high',
      ],
      [
        'buyer_question',
        'Can ExitBlueprint run without its founders?',
        'Describe the management bench we are building, the SOP coverage in progress, and the parallel-operation plan. Name the gap; show the trajectory.',
        'OPS',
        'OPS-DEPTH',
        'high',
      ],
    ];
    for (const [itemType, title, body, dimensionCode, subScoreCode, severity] of libraryItems) {
      await db.query(
        `insert into advisory_library_items
           (firm_id, source, item_type, title, body, dimension_code, sub_score_code, severity, created_by)
         select $1, 'advisor', $2::advisory_item_type, $3, $4, $5, $6, $7::gap_severity, $8
         where not exists (
           select 1 from advisory_library_items where firm_id = $1 and title = $3
         )`,
        [firmId, itemType, title, body, dimensionCode, subScoreCode, severity, advisorProfileId],
      );
    }
    console.log(`dogfood: library seeded — ${libraryItems.length} advisor-authored items (firm-scoped)`);

    console.log(
      `dogfood: done — firm '${INTERNAL_FIRM_NAME}', company '${INTERNAL_COMPANY_NAME}', advisor '${ADVISOR_EMAIL}' (${ADVISOR_ROLE}).`,
    );
    console.log(
      clerkEnabled()
        ? `dogfood: the advisor signs in through Clerk (email code / password reset) — no dev password.`
        : `dogfood: local dev — the advisor signs in on the dev emulator (password 'demo').`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
