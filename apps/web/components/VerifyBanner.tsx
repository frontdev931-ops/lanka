'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert } from './ui';

// Until the email is confirmed, the clinic's data cannot be connected: we remind and let the user send the letter again
export function VerifyBanner() {
  const t = useT();
  const [state, setState] = useState<'idle' | 'sent' | string>('idle');

  async function resend() {
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      setState('sent');
    } catch (e) {
      setState((e as Error).message);
    }
  }

  return (
    <Alert tone="warn">
      {t('auth.verifyBanner')}{' '}
      {state === 'sent' ? <b>{t('auth.verifySent')}</b> : <button className="link-btn" onClick={resend}>{t('auth.verifyResend')}</button>}
      {state !== 'idle' && state !== 'sent' && <span> {state}</span>}
    </Alert>
  );
}
