'use client';

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';

interface Ask {
  text: string;
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

// Confirmation in an in-app dialog instead of the browser confirm: `const { ask, dialog } = useConfirm();`,
// then `if (await ask('Text')) …` and `{dialog}` in the page markup.
export function useConfirm(): { ask: (text: string, opts?: { title?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>; dialog: ReactNode } {
  const { t } = useI18n();
  const [state, setState] = useState<Ask | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const ask = useCallback((text: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}) => new Promise<boolean>((resolve) => setState({ text, ...opts, resolve })), []);
  const close = useCallback(
    (ok: boolean) => {
      state?.resolve(ok);
      setState(null);
    },
    [state],
  );

  useEffect(() => {
    if (!state) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  const title = state?.title ?? t('confirm.title');
  const dialog = state ? (
    <div className="modal-backdrop" role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="modal modal-confirm">
        <h2>{title}</h2>
        <p style={{ margin: 0, lineHeight: 1.5 }}>{state.text}</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => close(false)}>{t('common.cancel')}</button>
          <button ref={confirmRef} className={state.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => close(true)}>
            {state.confirmLabel ?? t('confirm.yes')}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ask, dialog };
}
