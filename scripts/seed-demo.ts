// Demo tenant seed (S4.5 A5): "Blueprint Demo Advisors" with one company and
// the two-snapshot longitudinal story (Needs Work -> Sale Ready over ~9mo).
// Demo data is NOT a correctness fixture — the three /seed/fixtures companies
// remain the only fixtures. As a validation step, this script re-checks that
// the real engine's output matches the reference scorer's expected values
// stored in seed/demo/*.json, and aborts without committing on any mismatch.
// Idempotent and firm-scoped: safe to run anywhere, never touches other firms.
// Usage: DATABASE_URL=... npm run seed:demo
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import { instantiateTasksForGaps } from '../server/roadmap';
import { runEngagementVerification } from '../server/sellside';
import type { Answers } from '../shared/scoring/types';
import {
  DEFAULT_AGREEMENT_BODY,
  DEFAULT_AGREEMENT_LABEL,
  DEFAULT_AGREEMENT_TITLE,
} from './agreement-template';

const DEMO_FIRM = 'Blueprint Demo Advisors';
const DEMO_COMPANY = 'Cascade Facility Services';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface DemoSnapshot {
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

const snapshots: DemoSnapshot[] = [1, 2].map((n) =>
  JSON.parse(readFileSync(join(root, 'seed', 'demo', `demo-snapshot-${n}.json`), 'utf8')),
);

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

    // firms.name is not unique in the schema, so look up before insert.
    let firmId = (
      await db.query(`select id from firms where name = $1 order by created_at limit 1`, [DEMO_FIRM])
    ).rows[0]?.id;
    firmId ??= (
      await db.query(`insert into firms (name) values ($1) returning id`, [DEMO_FIRM])
    ).rows[0].id;

    let companyId = (
      await db.query(`select id from companies where firm_id = $1 and name = $2`, [firmId, DEMO_COMPANY])
    ).rows[0]?.id;
    companyId ??= (
      await db.query(
        `insert into companies (firm_id, name, industry, revenue_band, state, owner_contact_name)
         values ($1, $2, 'Commercial facilities maintenance', '$5M-$10M', 'WA', 'Dana Whitfield')
         returning id`,
        [firmId, DEMO_COMPANY],
      )
    ).rows[0].id;

    let engagementId = (
      await db.query(`select id from engagements where firm_id = $1 and company_id = $2`, [firmId, companyId])
    ).rows[0]?.id;
    engagementId ??= (
      await db.query(
        `insert into engagements (firm_id, company_id, target_exit_window, started_at)
         values ($1, $2, '24-36 months', '2025-09-15') returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;

    // Beta R1: an engagement can't collect assessment data until an agreement
    // acceptance is on file. Seed the demo firm's agreement version + a fully
    // consented acceptance so the demo engagement's assessments can be created.
    let agreementVersionId = (
      await db.query(`select id from agreement_versions where firm_id = $1 and version_label = $2`, [
        firmId,
        DEFAULT_AGREEMENT_LABEL,
      ])
    ).rows[0]?.id;
    agreementVersionId ??= (
      await db.query(
        `insert into agreement_versions (firm_id, version_label, title, body_md, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [firmId, DEFAULT_AGREEMENT_LABEL, DEFAULT_AGREEMENT_TITLE, DEFAULT_AGREEMENT_BODY],
      )
    ).rows[0].id;
    await db.query(
      `insert into engagement_agreements
         (firm_id, engagement_id, agreement_version_id, accepted_signer_name,
          consent_benchmarking, consent_anonymized_aggregation, consent_outcome_tracking)
       values ($1, $2, $3, 'Dana Whitfield', true, true, true)
       on conflict (engagement_id) do nothing`,
      [firmId, engagementId, agreementVersionId],
    );

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
            `demo assessment ${sequence} exists but does not match expected (drs ${drs} vs ${snapshot.expected.drs})`,
          );
        }
        console.log(`seed-demo: assessment ${sequence} already present (DRS ${drs}) — skipped`);
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
        await db.query(
          `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`,
          [assessmentId, questionId, JSON.stringify(value)],
        );
      }

      // Score with the real engine, then validate against the reference
      // scorer's expected output. Any mismatch aborts loudly.
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
          `seed-demo: engine output does not match reference scorer for snapshot ${sequence}:\n  ${mismatches.join('\n  ')}`,
        );
      }
      // Demo storytelling: place the snapshot at its narrative date.
      await db.query(`update assessments set completed_at = $2 where id = $1`, [
        assessmentId,
        snapshot.snapshot_date,
      ]);
      console.log(
        `seed-demo: assessment ${sequence} scored DRS ${result.drsScore} (${result.drsTier}), ` +
          `${result.gapCodes.length} gaps — matches reference scorer`,
      );
    }

    await db.query(
      `insert into engagement_outcomes (firm_id, engagement_id, process_status)
       values ($1, $2, 'preparing')
       on conflict (engagement_id) do nothing`,
      [firmId, engagementId],
    );

    // Build the remediation roadmap from the open gaps so the owner's plan is
    // populated (anchored to today, forward-looking). Idempotent.
    const roadmap = await instantiateTasksForGaps(db, engagementId, new Date().toISOString().slice(0, 10));
    if (roadmap.tasksCreated > 0) console.log(`seed-demo: roadmap built — ${roadmap.tasksCreated} tasks`);

    // Sell-side verification demo: attach a fixture financial document, then run
    // the verification pipeline + findings so the Verification tab is populated
    // out of the box (reconciled values, a low-confidence review item, and the
    // customer_concentration finding awaiting approval). Uses the fixture parser;
    // idempotent because the pipeline rebuilds the engagement's derived data.
    process.env.EB_PARSER = process.env.EB_PARSER ?? 'fixture';
    const fixtureBytes = readFileSync(
      join(root, 'fixtures', 'sellside', 'customer-financials.doc.json'),
    );
    let verifyDocId = (
      await db.query(
        `select id from documents where engagement_id = $1 and original_filename = $2`,
        [engagementId, 'financials-demo.json'],
      )
    ).rows[0]?.id as string | undefined;
    verifyDocId ??= (
      await db.query(
        `insert into documents
           (firm_id, engagement_id, category, original_filename, mime_type, byte_size, status)
         values ($1, $2, 'financial_statement', 'financials-demo.json', 'application/json', $3, 'uploaded')
         returning id`,
        [firmId, engagementId, fixtureBytes.length],
      )
    ).rows[0].id;
    await db.query(
      `insert into document_blobs (document_id, firm_id, bytes) values ($1, $2, $3)
       on conflict (document_id) do update set bytes = excluded.bytes`,
      [verifyDocId, firmId, fixtureBytes],
    );
    const verify = await runEngagementVerification(db, firmId, engagementId);
    console.log(
      `seed-demo: verification run — ${verify.metrics.reconciled_total} reconciled, ${verify.findings} finding(s)`,
    );

    // Source financial files on the demo engagement, so the file-driven intake
    // ("Fill financials from a P&L") has real documents to demonstrate: a P&L
    // that fills the revenue trend + recurring share, and a revenue-by-customer
    // report that fills the top-5 concentration. Their figures match the demo
    // client's answers, so the numbers tie out. Idempotent on (engagement,
    // filename); status 'uploaded' — these are source files an advisor keeps on
    // the engagement, not run through the review pipeline.
    const demoFiles: [string, string][] = [
      ['cascade-pl-2022-2025.csv', 'financial_statement'],
      ['cascade-revenue-by-customer.csv', 'financial_statement'],
    ];
    for (const [name, category] of demoFiles) {
      const bytes = readFileSync(join(root, 'seed', 'demo', 'files', name));
      let docId = (
        await db.query(`select id from documents where engagement_id = $1 and original_filename = $2`, [
          engagementId,
          name,
        ])
      ).rows[0]?.id as string | undefined;
      docId ??= (
        await db.query(
          `insert into documents
             (firm_id, engagement_id, category, original_filename, mime_type, byte_size, status)
           values ($1, $2, $3, $4, 'text/csv', $5, 'uploaded') returning id`,
          [firmId, engagementId, category, name, bytes.length],
        )
      ).rows[0].id;
      await db.query(
        `insert into document_blobs (document_id, firm_id, bytes) values ($1, $2, $3)
         on conflict (document_id) do update set bytes = excluded.bytes`,
        [docId, firmId, bytes],
      );
    }
    console.log(`seed-demo: attached ${demoFiles.length} source financial files (P&L + revenue-by-customer)`);

    // Data Room readiness (docs/15 work stream B): populate a few states so the
    // tab renders a realistic mix out of the box. Idempotent on (engagement, item).
    const dataRoomStates: [string, string][] = [
      ['FIN-STMTS', 'ready'],
      ['FIN-QOE', 'in_progress'],
      ['FIN-TAX', 'gap'],
      ['OPS-SOP', 'in_progress'],
      ['CUS-CONC', 'gap'],
      ['CUS-CONTRACTS', 'ready'],
      ['PIP-CERT', 'not_applicable'],
      ['LEG-EMP', 'gap'],
    ];
    for (const [itemCode, state] of dataRoomStates) {
      await db.query(
        `insert into engagement_data_room_items (firm_id, engagement_id, item_code, readiness_state)
         values ($1, $2, $3, $4)
         on conflict (engagement_id, item_code) do update set readiness_state = excluded.readiness_state`,
        [firmId, engagementId, itemCode, state],
      );
    }
    console.log(`seed-demo: data room seeded — ${dataRoomStates.length} item states`);

    // Valuation + wealth target so the Three Legs of the Stool panel (docs/18)
    // shows a complete business/personal/FINANCIAL picture out of the box.
    // Idempotent: replace any prior demo recast/inputs for this engagement.
    await db.query(
      `delete from ebitda_addbacks where recast_id in (select id from ebitda_recasts where engagement_id = $1)`,
      [engagementId],
    );
    await db.query(`delete from ebitda_recasts where engagement_id = $1`, [engagementId]);
    const recastId = (
      await db.query(
        `insert into ebitda_recasts (firm_id, engagement_id, reported_ebitda) values ($1, $2, $3) returning id`,
        [firmId, engagementId, 1_800_000],
      )
    ).rows[0].id;
    for (const [label, amount, ch] of [
      ['Owner compensation above market', 260_000, 'low'],
      ['Personal auto & travel', 55_000, 'low'],
      ['One-time legal settlement', 90_000, 'medium'],
    ] as [string, number, string][]) {
      await db.query(
        `insert into ebitda_addbacks (firm_id, recast_id, label, amount, challenge_likelihood) values ($1, $2, $3, $4, $5)`,
        [firmId, recastId, label, amount, ch],
      );
    }
    await db.query(
      `insert into valuation_inputs (firm_id, engagement_id, interest_bearing_debt, owner_wealth_target, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (engagement_id) do update
         set interest_bearing_debt = excluded.interest_bearing_debt,
             owner_wealth_target = excluded.owner_wealth_target, updated_at = now()`,
      [firmId, engagementId, 400_000, 8_000_000],
    );
    console.log('seed-demo: valuation seeded — recast + $8M wealth target (financial leg sized)');

    // Engagement log (institutional memory): a couple of demo entries so the log
    // shows real advisor reasoning out of the box. Idempotent (clear then insert).
    await db.query(`delete from engagement_log where engagement_id = $1`, [engagementId]);
    // gap_code links a rationale to the recommendation it explains, so the
    // "how the plan connects" chain shows end-to-end in the demo.
    for (const [kind, daysAgo, title, detail, gapCode] of [
      ['meeting', 60, 'Kickoff — baseline review', 'Walked the owner through the baseline DRS and the top gaps. Owner aligned on a 24–36mo window.', null],
      ['rationale', 45, 'Prioritized management depth first', 'Sequenced management-depth work ahead of growth items because owner/management dependence caps the multiple more than growth upside adds.', 'MGMT_DEPTH'],
      ['decision', 20, 'Engaged a QoE-ready bookkeeper', 'Owner agreed to bring reconciliations monthly before going to market — de-risks the add-back conversation.', 'STMT_INCOMPLETE'],
    ] as [string, number, string, string, string | null][]) {
      await db.query(
        `insert into engagement_log (firm_id, engagement_id, kind, occurred_on, title, detail, gap_id)
         values ($1, $2, $3, current_date - $4::int, $5, $6,
           (select g.id from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
            where g.engagement_id = $2 and gd.code = $7 limit 1))`,
        [firmId, engagementId, kind, daysAgo, title, detail, gapCode],
      );
    }
    console.log('seed-demo: engagement log seeded — 3 entries (2 tied to recommendations)');

    // Branded demo firm (F1): the advisor's firm is the face on client-facing
    // reports. Idempotent upsert on firm_id.
    await db.query(
      `insert into firm_branding
         (firm_id, display_name, accent_color, report_from_line, footer_disclosure_md)
       values ($1, $2, $3, $4, $5)
       on conflict (firm_id) do update set
         display_name = excluded.display_name,
         accent_color = excluded.accent_color,
         report_from_line = excluded.report_from_line,
         footer_disclosure_md = excluded.footer_disclosure_md`,
      [
        firmId,
        'Cascade Wealth Partners',
        '#1f6b47',
        'Prepared by Dana Reyes, CFP®, CEPA — Cascade Wealth Partners',
        'This report is prepared for informational purposes by Cascade Wealth Partners and does not constitute investment, tax, or legal advice.',
      ],
    );
    // Firm professional directory (org controls): a few of the outside
    // professionals the demo practice works with, so the directory and the
    // engagement deal-team picker aren't empty out of the box. Idempotent on
    // (firm_id, full_name).
    for (const [full_name, organization, kind, email] of [
      ['Marcus Bell', 'Bell & Associates CPAs', 'cpa', 'marcus@bellcpas.example'],
      ['Priya Nair', 'Nair Corporate Law', 'attorney', 'priya@nairlaw.example'],
      ['Tom Okafor', 'Meridian M&A Partners', 'ma_advisor', 'tom@meridianma.example'],
    ] as [string, string, string, string][]) {
      await db.query(
        `insert into firm_professionals (firm_id, full_name, organization, kind, email)
         select $1, $2, $3, $4::professional_kind, $5
         where not exists (
           select 1 from firm_professionals where firm_id = $1 and full_name = $2
         )`,
        [firmId, full_name, organization, kind, email],
      );
    }
    console.log('seed-demo: professional directory seeded — 3 outside professionals');

    console.log(`seed-demo: done — firm '${DEMO_FIRM}', company '${DEMO_COMPANY}', branded as 'Cascade Wealth Partners'`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
