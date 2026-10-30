'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Alert } from '../../components/ui';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { Brand } from '../../components/Brand';

// One extra click on purpose: a page address opened by a crawler or a link preview must not create a demo copy
export default function DemoPage() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setBusy(true);
    setError('');
    try {
      await api('/demo/start', { method: 'POST' });
      router.push('/dashboard');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand"><Brand /></div>
        <h1>{t('demo.title')}</h1>
        <p className="sub">{t('demo.text')}</p>
        <ul className="terms-list">
          <li>{t('demo.p1')}</li>
          <li>{t('demo.p2')}</li>
          <li>{t('demo.p3')}</li>
        </ul>
        {error && <Alert tone="error">{error}</Alert>}
        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy} onClick={start}>
          {busy ? t('demo.preparing') : t('demo.start')}
        </button>
        <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
          <Link href="/">{t('demo.back')}</Link> · <Link href="/login?register=1">{t('demo.connect')}</Link>
        </p>
        <div style={{ marginTop: 10 }}><LanguageSwitcher /></div>
      </div>
    </div>
  );
}
