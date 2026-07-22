// R&D PROTOTYPE — NOT PRODUCTION. See dev/frontier/README.md.
//
// Standalone runner for the DRS Calibration Engine. Generates a synthetic,
// in-memory corpus of paired prediction/reality outcomes (no DB, no network,
// no secrets), then prints the three deterministic products the engine derives:
//   1. the empirical calibration table (the "FICO readout" per DRS band),
//   2. calibration diagnostics (how good the DRS is as a predictor), and
//   3. a DRAFT recalibration proposal (a new version, never applied).
//
// Run:  npx tsx dev/frontier/calibration/demo.ts
//   or: node --experimental-strip-types dev/frontier/calibration/demo.ts   (Node 22+)

import {
  calibrationTable,
  calibrationDiagnostics,
  proposeRecalibration,
} from './engine.ts';
import type { PairedOutcome, DrsBand, CurrentRubric } from './types.ts';

// Fixed DRS bands for the demo (rubric data in production).
const BANDS: DrsBand[] = [
  { key: 'not_ready', label: 'Not Ready', min: 0, max: 50 },
  { key: 'developing', label: 'Developing', min: 50, max: 70 },
  { key: 'approaching', label: 'Approaching', min: 70, max: 85 },
  { key: 'sale_ready', label: 'Sale Ready', min: 85, max: 100 },
];

// The current versioned valuation rule the prototype reads read-only.
const CURRENT_RUBRIC: CurrentRubric = {
  valuation_rules_version: 'val_2026_02',
  bands: [
    { band_key: 'not_ready', readiness_multiple: 3.0 },
    { band_key: 'developing', readiness_multiple: 4.0 },
    { band_key: 'approaching', readiness_multiple: 5.0 },
    { band_key: 'sale_ready', readiness_multiple: 6.0 },
  ],
};

// -- deterministic synthetic corpus -------------------------------------------
// Seeded PRNG (mulberry32) so the demo is reproducible without Math.random —
// same run, same numbers, which matches the engine's determinism guarantee.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCorpus(): PairedOutcome[] {
  const rnd = mulberry32(42);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2; // ~N(0,1)-ish
  const out: PairedOutcome[] = [];

  // Ground-truth "reality" multiple per band, plus a deliberate rubric bias:
  // the current rubric UNDER-predicts the top band (real market pays more for a
  // sale-ready company than val_2026_02 assumes) and is roughly right elsewhere.
  const truth: Record<string, { realMult: number; drsLo: number; drsHi: number; n: number }> = {
    not_ready: { realMult: 3.1, drsLo: 30, drsHi: 49, n: 10 },
    developing: { realMult: 4.05, drsLo: 50, drsHi: 69, n: 14 },
    approaching: { realMult: 5.1, drsLo: 70, drsHi: 84, n: 16 },
    sale_ready: { realMult: 6.9, drsLo: 85, drsHi: 98, n: 12 }, // rubric says 6.0 -> under-predicts
  };

  let i = 0;
  for (const [band, t] of Object.entries(truth)) {
    const ruleMult = CURRENT_RUBRIC.bands.find((b) => b.band_key === band)!.readiness_multiple;
    for (let k = 0; k < t.n; k++) {
      const drs = Math.round(t.drsLo + rnd() * (t.drsHi - t.drsLo));
      const ebitda = 1_000_000 + Math.round(rnd() * 4_000_000);
      const predictedBase = ebitda * ruleMult;
      const realMult = Math.max(1.5, t.realMult + gauss() * 0.4);
      const finalEv = Math.round(ebitda * realMult);
      out.push({
        engagement_id: `eng_${String(++i).padStart(3, '0')}`,
        industry: 'industrials',
        size_band: 'ebitda_1_5m',
        predicted_drs: drs,
        predicted_ev_low: Math.round(predictedBase * 0.85),
        predicted_ev_base: Math.round(predictedBase),
        predicted_ev_high: Math.round(predictedBase * 1.15),
        final_ev: finalEv,
        final_multiple: Math.round(realMult * 100) / 100,
        ebitda_at_close: ebitda,
        days_on_market: 120 + Math.round(rnd() * 180),
        retrade: rnd() < 0.18,
      });
    }
  }
  return out;
}

// -- run ----------------------------------------------------------------------

function money(n: number | null): string {
  return n == null ? '—' : `$${(n / 1_000_000).toFixed(2)}M`;
}
function pct(n: number | null): string {
  return n == null ? '—' : `${n}%`;
}
function mult(n: number | null): string {
  return n == null ? '—' : `${n}x`;
}

const corpus = makeCorpus();
const table = calibrationTable(corpus, BANDS);
const diag = calibrationDiagnostics(corpus, table);
const proposal = proposeRecalibration(table, CURRENT_RUBRIC, {
  proposedVersion: 'val_2026_03_PROPOSED',
});

console.log('='.repeat(78));
console.log('DRS CALIBRATION ENGINE — R&D prototype (synthetic corpus, deterministic)');
console.log('='.repeat(78));
console.log(`\nPaired outcomes in corpus: ${table.total_paired}\n`);

console.log('1) EMPIRICAL CALIBRATION TABLE  (the "FICO readout" per DRS band)');
console.log('-'.repeat(78));
console.log(
  ['band', 'DRS', 'n', 'conf', 'median x', 'p25–p75', 'within', 'EV var', 'retrade']
    .map((s, idx) => s.padEnd([12, 7, 4, 5, 9, 12, 7, 8, 7][idx]))
    .join(''),
);
for (const c of table.cells) {
  console.log(
    [
      c.band_label.padEnd(12),
      c.drs_range.padEnd(7),
      String(c.n).padEnd(4),
      (c.confident ? 'yes' : 'no').padEnd(5),
      mult(c.multiple_median).padEnd(9),
      `${mult(c.multiple_p25)}–${mult(c.multiple_p75)}`.padEnd(12),
      pct(c.within_range_pct).padEnd(7),
      (c.mean_ev_variance_pct == null ? '—' : `${c.mean_ev_variance_pct > 0 ? '+' : ''}${c.mean_ev_variance_pct}%`).padEnd(8),
      pct(c.retrade_rate_pct).padEnd(7),
    ].join(''),
  );
}

console.log('\n2) CALIBRATION DIAGNOSTICS  (how good the DRS is as a predictor)');
console.log('-'.repeat(78));
console.log(`  paired outcomes ............. ${diag.paired_outcomes}`);
console.log(`  confident bands (n>=8) ...... ${diag.confident_bands}`);
console.log(`  overall mean |EV variance| .. ${pct(diag.overall_mean_abs_ev_variance_pct)}`);
console.log(`  overall within-range hit .... ${pct(diag.overall_within_range_pct)}`);
for (const b of diag.band_bias) {
  console.log(`  band ${b.band_key.padEnd(12)} ${b.direction.toUpperCase().padEnd(11)} (${b.mean_ev_variance_pct > 0 ? '+' : ''}${b.mean_ev_variance_pct}%)`);
}

console.log('\n3) PROPOSED RECALIBRATION  (a NEW version — applied=false, human-gated)');
console.log('-'.repeat(78));
console.log(`  from version ..... ${proposal.from_version}`);
console.log(`  proposed version . ${proposal.proposed_version}`);
console.log(`  applied .......... ${proposal.applied}   requires_human_review: ${proposal.requires_human_review}`);
if (proposal.changes.length === 0) {
  console.log('  (no confident band showed bias beyond the dead-band — nothing to propose)');
}
for (const ch of proposal.changes) {
  console.log(
    `\n  ${ch.band_key}: ${mult(ch.current_readiness_multiple)} -> ${mult(ch.proposed_readiness_multiple)} ` +
      `(${ch.delta > 0 ? '+' : ''}${ch.delta})`,
  );
  console.log(`    basis: ${ch.basis}`);
}
console.log(`\n  unchanged bands: ${proposal.unchanged_bands.join(', ') || '(none)'}`);
console.log(`\n  ${proposal.notes}`);
console.log('\n' + '='.repeat(78));
console.log('Reminder: this object never edits a score or a rubric. Ships as a new');
console.log('valuation_rules_version only after human review (CLAUDE.md rules 1 & 4).');
console.log('='.repeat(78));
