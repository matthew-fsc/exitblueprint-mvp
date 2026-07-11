import type { ReactNode } from 'react';

export interface TimelineItem {
  id: string;
  time?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  muted?: boolean;
}

// Vertical event timeline — used by the roadmap (F5) and the engagement
// activity log (F6).
export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="ui-timeline">
      {items.map((it) => (
        <li key={it.id} className={`ui-timeline-item ${it.muted ? 'muted-dot' : ''}`.trim()}>
          {it.time && <div className="ui-timeline-time">{it.time}</div>}
          <div className="ui-timeline-title">{it.title}</div>
          {it.body && <div className="ui-timeline-body">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}
