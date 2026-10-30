'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { Alert } from './ui';

// Пока почта не подтверждена, нельзя подключать данные клиники: напоминаем и даём отправить письмо ещё раз
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
