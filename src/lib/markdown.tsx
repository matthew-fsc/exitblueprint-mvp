// Minimal, dependency-free Markdown renderer for the generated deliverable
// documents (owner report, CIM). It handles exactly what the composers and
// prompts emit — headings, bold/italic inline, and bullet lists — so the
// polished on-screen document renders without pulling in a full Markdown
// library. Shared by ReportPage and CimPage so the two never drift.
import type { ReactElement } from 'react';

export function inline(text: string): (string | ReactElement)[] {
  const parts: (string | ReactElement)[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) parts.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    else parts.push(<em key={k++}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderMarkdown(md: string): ReactElement[] {
  const out: ReactElement[] = [];
  const lines = md.split('\n');
  let bullets: string[] = [];
  const flush = (key: number) => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${key}`}>
        {bullets.map((b, j) => (
          <li key={j}>{inline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  lines.forEach((line, i) => {
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
      return;
    }
    flush(i);
    if (line.startsWith('### ')) out.push(<h3 key={i}>{inline(line.slice(4))}</h3>);
    else if (line.startsWith('## ')) out.push(<h2 key={i}>{inline(line.slice(3))}</h2>);
    else if (line.startsWith('# ')) out.push(<h1 key={i}>{inline(line.slice(2))}</h1>);
    else if (line.trim() === '') out.push(<div key={i} className="report-gap" />);
    else out.push(<p key={i}>{inline(line)}</p>);
  });
  flush(lines.length);
  return out;
}
