'use client';

import { fmtNumber } from '../lib/ui';

// Horizontal bars for a grouped result: one label column and one number column. Bars start at zero; the value is printed at the end.
export function MiniBars({ rows, labelKey, valueKey, limit = 20 }: { rows: Record<string, string | number | null>[]; labelKey: string; valueKey: string; limit?: number }) {
  const data = rows.slice(0, limit).map((r) => ({ label: String(r[labelKey] ?? '—'), value: Number(r[valueKey] ?? 0) }));
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="mini-bars" role="img" aria-label={data.map((d) => `${d.label}: ${d.value}`).join('; ')}>
      {data.map((d, i) => (
        <div key={i} className="mini-bar-row">
          <span className="mini-bar-label" title={d.label}>{d.label}</span>
          <span className="q-bar-track"><span className="q-bar" style={{ width: `${(Math.max(0, d.value) / max) * 100}%` }} /></span>
          <span className="mini-bar-val">{fmtNumber(d.value)}</span>
        </div>
      ))}
    </div>
  );
}
