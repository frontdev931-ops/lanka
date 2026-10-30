'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Alert, Icon } from '../../components/ui';
import LanguageSwitcher from '../../components/LanguageSwitcher';
import { Brand } from '../../components/Brand';
import { TermsViewer } from '../../components/Terms';

interface LoginResult {
  accessToken?: string;
  clinics?: { id: string; name: string }[];
  twoFactorRequired?: boolean;
}

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [register, setRegister] = useState(false);
  // A link from the site ("Connect your clinic") opens the registration form
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('register') === '1') setRegister(true);
  }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  // Если у пользователя несколько клиник, после проверки пароля показываем выбор
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([]);
  // Двухфакторный вход: после пароля просим код; если клиник несколько, выбор клиники в том же шаге
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  const [pickClinic, setPickClinic] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      const res = await api<LoginResult>(register ? '/auth/register' : '/auth/login', {
        method: 'POST',
        // Чекбокс приходит из формы строкой «on»; серверу нужно true
        body: JSON.stringify(register ? { ...f, acceptTerms: f.acceptTerms === 'on' } : f),
      });
      if (res.accessToken) {
        router.push('/dashboard'); // сервер уже поставил сессионную cookie
      } else if (res.twoFactorRequired) {
        setCreds({ email: f.email, password: f.password });
        setClinics(res.clinics ?? []);
        setPickClinic(res.clinics?.[0]?.id ?? '');
        setNeedCode(true);
      } else if (res.clinics) {
        setCreds({ email: f.email, password: f.password });
        setClinics(res.clinics);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function choose(clinicId: string) {
    if (!creds) return;
    try {
      const res = await api<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify({ ...creds, clinicId }) });
      if (res.accessToken) router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!creds) return;
    setError('');
    setBusy(true);
    try {
      const res = await api<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify({ ...creds, code: code.trim(), ...(clinics.length > 1 ? { clinicId: pickClinic } : {}) }) });
      if (res.accessToken) router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const brand = (
    <div className="brand">
      <Brand />
    </div>
  );

  if (creds && needCode) {
    return (
      <div key="code-step" className="auth-wrap">
        <div className="auth-lang"><LanguageSwitcher /></div>
        <form className="auth-card" onSubmit={submitCode}>
          {brand}
          <h1>{t('twofa.loginTitle')}</h1>
          <p className="sub">{t('twofa.loginSub')}</p>
          {clinics.length > 1 && (
            <div className="field">
              <label htmlFor="clinic">{t('login.chooseClinic')}</label>
              <select id="clinic" className="select" value={pickClinic} onChange={(e) => setPickClinic(e.target.value)}>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="code">{t('twofa.code')}</label>
            <input id="code" className="input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required maxLength={32} inputMode="text" />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <button type="submit" className="btn btn-primary" disabled={busy || code.trim().length < 6}>{busy ? t('common.wait') : t('login.submit')}</button>
          <p className="auth-switch">
            <button type="button" className="link-btn" onClick={() => { setNeedCode(false); setCreds(null); setCode(''); setError(''); }}>{t('common.back')}</button>
          </p>
        </form>
      </div>
    );
  }

  if (creds) {
    return (
      <div key="clinic-step" className="auth-wrap">
        <div className="auth-lang"><LanguageSwitcher /></div>
        <div className="auth-card">
          {brand}
          <h1>{t('login.chooseClinic')}</h1>
          <p className="sub">{t('login.chooseClinicSub')}</p>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="clinic-pick">
            {clinics.map((c) => (
              <button key={c.id} className="btn" onClick={() => choose(c.id)}>
                <Icon name="home" /> {c.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div key="login-step" className="auth-wrap">
      <div className="auth-lang"><LanguageSwitcher /></div>
      <form className="auth-card" onSubmit={submit}>
        {brand}
        <h1>{register ? t('login.regTitle') : t('login.title')}</h1>
        <p className="sub">{register ? t('login.regSubtitle') : t('login.subtitle')}</p>
        {register && (
          <>
            <div className="field">
              <label htmlFor="clinicName">{t('login.clinicName')}</label>
              <input id="clinicName" className="input" name="clinicName" required />
            </div>
            <div className="field">
              <label htmlFor="name">{t('login.yourName')}</label>
              <input id="name" className="input" name="name" required minLength={2} />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="email">{t('login.email')}</label>
          <input id="email" className="input" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">{register ? t('login.passwordMin') : t('login.password')}</label>
          <input id="password" className="input" name="password" type="password" required minLength={register ? 10 : 1} autoComplete={register ? 'new-password' : 'current-password'} />
        </div>
        {register && (
          <label className="check-row">
            <input type="checkbox" name="acceptTerms" required />
            <span>
              {t('terms.acceptReg')}{' '}
              <button type="button" className="link-btn" onClick={() => setShowTerms(true)}>{t('terms.readLink')}</button>
            </span>
          </label>
        )}
        {showTerms && <TermsViewer onClose={() => setShowTerms(false)} />}
        {error && <Alert tone="error">{error}</Alert>}
        {!register && (
          <p className="auth-switch" style={{ margin: '0 0 12px', textAlign: 'right' }}>
            <Link href="/forgot">{t('auth.forgotLink')}</Link>
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t('common.wait') : register ? t('login.create') : t('login.submit')}
        </button>
        <p className="auth-switch">
          {register ? t('login.haveAccount') : t('login.firstTime')}
          <button type="button" className="link-btn" onClick={() => { setRegister(!register); setError(''); }}>
            {register ? t('login.signIn') : t('login.registerLink')}
          </button>
        </p>
      </form>
    </div>
  );
}
