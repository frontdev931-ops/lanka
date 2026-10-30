'use client';

import { useState } from 'react';

export interface FunnelRow {
  key: string;
  label: string;
  value: number;
  // Подсказка: что это за этап и как считается
  hint: string;
}

// Воронка горизонтальными столбцами: длина = число людей, ширина всегда от нуля (не от первого этапа), подписи значений
// на конце столбца, процент от начала и от предыдущего этапа в тексте. Все столбцы одного цвета: цвет не несёт смысла,
// смысл в длине. Каждый столбец доступен с клавиатуры и показывает подсказку.
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
