'use client';

import { useState } from 'react';

export interface FunnelRow {
  key: string;
  label: string;
  value: number;
  // Hint: what this stage is and how it is calculated
  hint: string;
}

// The funnel as horizontal bars: length = the number of people, the width always starts from zero (not from the first stage), value labels
// at the end of the bar, the percent of the start and of the previous stage in the text. All bars are one colour: colour carries no meaning,
// the meaning is in the length. Each bar is reachable by keyboard and shows a hint.
export function FunnelBars({ rows, ariaLabel, ofStart, ofPrev, fmt }: {
  rows: FunnelRow[];
  ariaLabel: string;
  ofStart: string;
  ofPrev: string;
  fmt: (n: number) => string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const first = rows[0]?.value || 0;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

  return (
    <div className="funnel" role="list" aria-label={ariaLabel}>
      {rows.map((r, i) => {
        const prev = i === 0 ? null : rows[i - 1].value;
        return (
          <div
            key={r.key}
            role="listitem"
            tabIndex={0}
            className={`funnel-row${active === r.key ? ' on' : ''}`}
            onPointerEnter={() => setActive(r.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(r.key)}
            onBlur={() => setActive(null)}
          >
            <div className="funnel-name">{r.label}</div>
            <div className="funnel-track">
              <span className="funnel-bar" style={{ width: `${(r.value / max) * 100}%` }} />
              <span className="funnel-val">{fmt(r.value)}</span>
            </div>
            <div className="funnel-meta">
              {i > 0 && first > 0 && (
                <span>
                  <b>{pct(r.value, first)}</b> {ofStart}
                </span>
              )}
              {prev !== null && (
                <span>
                  <b>{pct(r.value, prev)}</b> {ofPrev}
                </span>
              )}
            </div>
            {active === r.key && <div className="funnel-tip" role="status">{r.hint}</div>}
          </div>
        );
      })}
    </div>
  );
}
