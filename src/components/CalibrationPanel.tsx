import { useDealCalibration } from '../lib/queries';
import { SkeletonLines, StatBlock, StatRow } from './ui';
import { fmtCurrencyCompact, fmtDate } from '../lib/format';

// The firm-facing view of the outcome-calibration moat (docs/09-moats.md):
// predicted-vs-actual across the firm's recorded deals. Read-only — it reports
// how our readiness scores mapped to real prices; it never adjusts a score.
export function CalibrationPanel() {
  const q = useDealCalibration();
  const c = q.data;

  const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

  return (
    <section className="cal-panel">
      <div className="section-heading">
        <h2>Prediction calibration</h2>
        <p className="muted">
          How the readiness scores you gave mapped to the prices deals actually fetched. Every recorded
          outcome sharpens this — the firm's own book, not generic comps.
        </p>
      </div>

      {q.isLoading ? (
        <SkeletonLines lines={3} />
      ) : !c || c.deals_recorded === 0 ? (
        <p className="muted" style={{ marginTop: 0 }}>
          No deal outcomes recorded yet. Record an outcome on an engagement when a deal closes or breaks,
          and predicted-vs-actual builds here.
        </p>
      ) : (
        <>
          <StatRow>
            <StatBlock label="Deals recorded" value={c.deals_recorded} hint={`${c.closed} closed · ${c.broken} broke`} />
            <StatBlock
              label="Within predicted range"
              value={pct(c.within_range_pct)}
              hint="final EV inside our range"
            />
            <StatBlock
              label="Avg EV variance"
              value={c.avg_ev_variance_pct == null ? '—' : `${c.avg_ev_variance_pct > 0 ? '+' : ''}${c.avg_ev_variance_pct}%`}
              hint="actual vs predicted base"
            />
            <StatBlock label="Avg multiple" value={c.avg_final_multiple == null ? '—' : `${c.avg_final_multiple}×`} />
            <StatBlock label="Retrade rate" value={pct(c.retrade_rate_pct)} hint="buyer cut price post-LOI" />
          </StatRow>

          <div className="cal-table-wrap">
            <table className="cal-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Outcome</th>
                  <th className="num">Predicted EV</th>
                  <th className="num">Actual EV</th>
                  <th className="num">Multiple</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {c.deals.map((d) => (
                  <tr key={d.engagement_id}>
                    <td><strong>{d.company_name}</strong></td>
                    <td>
                      <span className={`cal-outcome cal-outcome-${d.outcome}`}>{d.outcome}</span>
                      {d.within_range === false && <span className="cal-miss"> · outside range</span>}
                    </td>
                    <td className="num">{fmtCurrencyCompact(d.predicted_ev_base)}</td>
                    <td className="num">{fmtCurrencyCompact(d.final_ev)}</td>
                    <td className="num">{d.final_multiple == null ? '—' : `${d.final_multiple}×`}</td>
                    <td className="muted">{d.close_date ? fmtDate(d.close_date) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
