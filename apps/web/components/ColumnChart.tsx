'use client';

import { useRef, useState } from 'react';

export interface ChartDatum {
  key: string;
  // The X-axis label (short: "12.10")
  label: string;
  value: number;
  // What to show in the hint next to the value ("Week from 12.10")
  tip: string;
}

// Rounding the axis top to a "round" number: 1, 2, 5, 10, 20, 50…
function niceMax(v: number) {
  if (v <= 4) return Math.max(v, 1);
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 4, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

// A single-series bar chart: thin bars (up to 24 px), rounded at the top, a 2 px gap,
// the value label only at the tallest bar, the rest in the hint (mouse, touch, keyboard)
// and in the data table under a spoiler. The label colour is text colour, only the bars are painted with the accent.
export function ColumnChart({ data, ariaLabel, tableTitle, valueHead, labelHead, formatValue }: {
  data: ChartDatum[];
  ariaLabel: string;
  tableTitle: string;
  valueHead: string;
  labelHead: string;
  formatValue?: (n: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const top = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
  const fmt = formatValue ?? ((n: number) => n.toLocaleString());
  const ticks = [0, max / 2, max].filter((t, i, a) => a.indexOf(t) === i);
  // X-axis labels: no more often than they fit (about six on the screen)
  const step = Math.max(1, Math.ceil(data.length / 6));

  const tipLeft = (() => {
    if (active === null || !plot.current) return 0;
    const w = plot.current.clientWidth;
    const x = ((active + 0.5) / data.length) * w;
    return Math.min(Math.max(x, 70), Math.max(w - 70, 70)); // the hint does not go beyond the edge
  })();

  return (
    <figure className="chart" aria-label={ariaLabel}>
      <div className="chart-plot" ref={plot} onPointerLeave={() => setActive(null)}>
        {ticks.map((t) => (
          <div key={t} className="chart-grid" style={{ bottom: `${(t / max) * 100}%` }}>
            <span className="chart-tick">{fmt(t)}</span>
          </div>
        ))}
        <div className="chart-cols">
          {data.map((d, i) => {
            const h = (d.value / max) * 100;
            return (
              <button
                type="button"
                key={d.key}
                className={`chart-col${active === i ? ' on' : ''}`}
                aria-label={`${d.tip}: ${fmt(d.value)}`}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(i)}
              >
                <span className="chart-bar" style={{ height: `${h}%` }} />
                {i === top && d.value > 0 && (
                  <span className="chart-val" style={{ bottom: `calc(${h}% + 4px)` }}>{fmt(d.value)}</span>
                )}
              </button>
            );
          })}
        </div>
        {active !== null && (
          <div className="chart-tip" style={{ left: tipLeft }} role="status">
            <b>{fmt(data[active].value)}</b>
            <span>{data[active].tip}</span>
          </div>
        )}
      </div>
      <div className="chart-x">
        {data.map((d, i) => (
          <span key={d.key}>{i % step === 0 ? d.label : ''}</span>
        ))}
      </div>
      <details className="chart-table">
        <summary>{tableTitle}</summary>
        <table className="table">
          <thead>
            <tr><th>{labelHead}</th><th className="num">{valueHead}</th></tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.key}><td>{d.tip}</td><td className="num">{fmt(d.value)}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
