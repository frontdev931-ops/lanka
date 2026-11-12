'use client';

import { KeyboardEvent, ReactNode } from 'react';

// A tab bar with a shared bottom line (Settings, the team). Arrow keys, Home and End move between tabs; only the active tab is in the Tab order.
export function LineTabs<K extends string>({ id, label, tabs, active, onPick, render }: { id: string; label: string; tabs: readonly K[]; active: K; onPick: (k: K) => void; render: (k: K) => ReactNode }) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(active);
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onPick(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className="line-tabs" role="tablist" aria-label={label}>
      {tabs.map((k) => (
        <button key={k} id={`${id}-tab-${k}`} type="button" role="tab" aria-selected={active === k} aria-controls={`${id}-panel-${k}`} tabIndex={active === k ? 0 : -1} className={`line-tab${active === k ? ' active' : ''}`} onClick={() => onPick(k)} onKeyDown={onKey}>
          {render(k)}
        </button>
      ))}
    </div>
  );
}
