'use client';

import { ReactNode, useId } from 'react';

// An on/off switch for a setting that takes effect at once: a real button with role="switch", reachable and toggled by the keyboard, with its own label and hint
export function Switch({ checked, onChange, disabled, label, hint }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="switch-row">
      <button type="button" role="switch" id={id} aria-checked={checked} aria-describedby={hint ? `${id}-hint` : undefined} className={`switch${checked ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!checked)}>
        <span className="switch-knob" aria-hidden="true" />
      </button>
      <span>
        <label htmlFor={id} className="switch-label">{label}</label>
        {hint && <span id={`${id}-hint`} className="muted switch-hint">{hint}</span>}
      </span>
    </div>
  );
}
