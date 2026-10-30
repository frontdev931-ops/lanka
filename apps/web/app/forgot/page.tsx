'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Alert } from '../../components/ui';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { Brand } from '../../components/Brand';

export default function ForgotPage() {
  const t = useT();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { email } = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-lang"><LanguageSwitcher /></div>
      <form className="auth-card" onSubmit={submit}>
        <div className="brand"><Brand /></div>
        <h1>{t('auth.forgotTitle')}</h1>
        {sent ? (
          <>
            <Alert tone="success">{t('auth.forgotSent')}</Alert>
            <p className="auth-switch"><Link href="/login">{t('auth.backToLogin')}</Link></p>
          </>
        ) : (
          <>
            <p className="sub">{t('auth.forgotSub')}</p>
            <div className="field">
              <label htmlFor="email">{t('login.email')}</label>
              <input id="email" className="input" name="email" type="email" required autoComplete="email" />
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('common.wait') : t('auth.forgotSubmit')}</button>
            <p className="auth-switch"><Link href="/login">{t('auth.backToLogin')}</Link></p>
          </>
        )}
      </form>
    </div>
  );
}
