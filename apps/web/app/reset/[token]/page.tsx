'use client';

import { FormEvent, use, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { Alert } from '../../../components/ui';
import LanguageSwitcher from '../../../components/LanguageSwitcher';
import { Brand } from '../../../components/Brand';

export default function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useT();
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const { password, again } = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (password !== again) return setError(t('auth.mismatch'));
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
      setDone(true);
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
        <h1>{t('auth.resetTitle')}</h1>
        {done ? (
          <>
            <Alert tone="success">{t('auth.resetDone')}</Alert>
            <p className="auth-switch"><Link href="/login">{t('auth.backToLogin')}</Link></p>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="password">{t('auth.newPassword')}</label>
              <input id="password" className="input" name="password" type="password" required minLength={10} autoComplete="new-password" />
            </div>
            <div className="field">
              <label htmlFor="again">{t('auth.passwordAgain')}</label>
              <input id="again" className="input" name="again" type="password" required minLength={10} autoComplete="new-password" />
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('common.wait') : t('auth.resetSubmit')}</button>
          </>
        )}
      </form>
    </div>
  );
}
