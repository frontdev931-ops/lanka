'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { Alert } from '../../../components/ui';
import LanguageSwitcher from '../../../components/LanguageSwitcher';
import { Brand } from '../../../components/Brand';

export default function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [state, setState] = useState<'wait' | 'ok' | string>('wait');

  useEffect(() => {
    api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setState('ok'))
      .catch((e) => setState((e as Error).message));
  }, [token]);

  return (
    <div className="auth-wrap">
      <div className="auth-lang"><LanguageSwitcher /></div>
      <div className="auth-card">
        <div className="brand"><Brand /></div>
        <h1>{t('auth.verifyTitle')}</h1>
        {state === 'wait' ? <p className="sub">{t('common.wait')}</p> : state === 'ok' ? <Alert tone="success">{t('auth.verifyDone')}</Alert> : <Alert tone="error">{state}</Alert>}
        <p className="auth-switch"><Link href="/dashboard">{t('auth.toApp')}</Link></p>
      </div>
    </div>
  );
}
