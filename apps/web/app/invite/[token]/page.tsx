'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { Alert, Loading } from '../../../components/ui';
import LanguageSwitcher from '../../../components/LanguageSwitcher';
import { Brand } from '../../../components/Brand';

interface Info {
  clinicName: string;
  role: string;
  email: string;
  existingUser: boolean;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { t, label } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [fatal, setFatal] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Info>(`/invites/${token}`)
      .then(setInfo)
      .catch((e) => setFatal((e as Error).message));
  }, [token]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api(`/invites/${token}/accept`, { method: 'POST', body: JSON.stringify(f) });
      router.push('/dashboard'); // сервер уже вошёл в систему: сессионная cookie поставлена
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const brand = (
    <div className="brand">
      <Brand />
    </div>
  );

  return (
    <div className="auth-wrap">
      <div className="auth-lang"><LanguageSwitcher /></div>
      <div className="auth-card">
        {brand}
        <h1>{t('invite.title')}</h1>
        {fatal ? (
          <>
            <Alert tone="error">{fatal}</Alert>
            <p className="auth-switch"><Link href="/login">{t('invite.toLogin')}</Link></p>
          </>
        ) : !info ? (
          <Loading />
        ) : (
          <form onSubmit={submit}>
            <p className="sub">{t('invite.intro', { clinic: info.clinicName, role: label('role', info.role) })}</p>
            <p className="muted" style={{ marginTop: 0 }}>{info.existingUser ? t('invite.existingHint') : t('invite.newHint')}</p>
            <div className="field">
              <label htmlFor="email">{t('login.email')}</label>
              <input id="email" className="input" value={info.email} readOnly disabled />
            </div>
            {!info.existingUser && (
              <div className="field">
                <label htmlFor="name">{t('login.yourName')}</label>
                <input id="name" className="input" name="name" required minLength={2} autoComplete="name" />
              </div>
            )}
            <div className="field">
              <label htmlFor="password">{info.existingUser ? t('login.password') : t('login.passwordMin')}</label>
              <input id="password" className="input" name="password" type="password" required minLength={info.existingUser ? 1 : 10} autoComplete={info.existingUser ? 'current-password' : 'new-password'} />
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('common.wait') : t('invite.submit')}</button>
          </form>
        )}
      </div>
    </div>
  );
}
