import { tierColor, tierForScore } from '../../lib/tokens';
import { useTheme } from '../../lib/theme';

export interface ContributionDatum {
  code: string;
  name: string;
  score: number; // dimension score 0–100
  drsWeight: number; // share of the DRS (0–1)
  contributionToDrs: number; // score × weight, the points this dimension puts on the board
}

// "Where the DRS comes from — and what's leaving points on the table." Each
// dimension's bar is scaled to its weight (Revenue's track is widest because it
// counts most), filled to what it currently contributes, with the ghost showing
// the headroom to a perfect score. Sorted biggest-shortfall first, so the drag
// on the score reads top-down. Answers the CFP's "what do we fix to move it?".
export function ContributionBars({ dimensions }: { dimensions: ContributionDatum[] }) {
  const { theme } = useTheme();
  const mode = theme === 'dark' ? 'dark' : 'light';
  const maxCap = Math.max(...dimensions.map((d) => d.drsWeight * 100), 1);
  const rows = [...dimensions]
    .map((d) => {
      const cap = d.drsWeight * 100;
      return { ...d, cap, headroom: Math.max(0, cap - d.contributionToDrs) };
    })
    .sort((a, b) => b.headroom - a.headroom);

  return (
    <div className="contrib">
      {rows.map((d) => {
        const color = tierColor(tierForScore(d.score), mode);
        const trackPct = (d.cap / maxCap) * 100;
        const fillPct = d.cap > 0 ? (d.contributionToDrs / d.cap) * 100 : 0;
        return (
          <div className="contrib-row" key={d.code}>
            <div className="contrib-label">
              <span className="contrib-name">{d.name}</span>
              <span className="contrib-score" style={{ color }}>{Math.round(d.score)}</span>
            </div>
            <div className="contrib-track-wrap">
              <div className="contrib-track" style={{ width: `${trackPct}%` }}>
                <div className="contrib-fill" style={{ width: `${fillPct}%`, background: color }} />
              </div>
              <span className="contrib-headroom" title="Points this dimension could still add to the DRS">
                {d.headroom >= 0.05 ? `+${d.headroom.toFixed(1)}` : '—'}
              </span>
            </div>
          </div>
        );
      })}
      <div className="contrib-legend">
        <span><span className="contrib-swatch" /> contributed to DRS</span>
        <span><span className="contrib-swatch ghost" /> headroom · bar width = weight</span>
      </div>
    </div>
  );
}
