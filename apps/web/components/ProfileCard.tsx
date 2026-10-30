'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Card } from './ui';

interface Profile {
  name: string;
  email: string;
  pendingEmail: string | null;
}

// The person's own data: name, sign-in email and password. The email changes only after the link sent to the new address is
// opened; the password change closes the sessions on other devices.
export function ProfileCard() {
  const { t } = useI18n();
  const [me, setMe] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'none' | 'email' | 'password'>('none');
  const [email, setEmail] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(
    () =>
      api<Profile>('/auth/me')
        .then((p) => {
          setMe(p);
          setName(p.name);
        })
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setMode('none');
    setEmail('');
    setCurrent('');
    setNext('');
  };

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api('/auth/profile', { method: 'PATCH', body: JSON.stringify({ name }) });
      await load();
      window.dispatchEvent(new Event('stomat:me-changed'));
    }, t('prof.nameSaved'));
  };
  const sendEmail = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api('/auth/change-email', { method: 'POST', body: JSON.stringify({ email, password: current }) });
      close();
      await load();
    }, t('prof.linkSent'));
  };
  const cancelEmail = () =>
    run(async () => {
      await api('/auth/change-email/cancel', { method: 'POST' });
      await load();
    }, t('prof.cancelChange'));
  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      close();
    }, t('prof.passwordChanged'));
  };

  if (!me) return error ? <Alert tone="error">{error}</Alert> : null;

  return (
    <Card title={t('prof.title')}>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <form onSubmit={saveName} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ margin: 0, flex: '1 1 240px' }}>
          <span>{t('prof.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
        </label>
        <button className="btn" type="submit" disabled={busy || name.trim().length < 2 || name.trim() === me.name}>{t('prof.saveName')}</button>
      </form>

      <p style={{ margin: '16px 0 4px' }}>
        <span className="muted">{t('prof.email')}: </span>
        <b style={{ overflowWrap: 'anywhere' }}>{me.email}</b>
      </p>
      {me.pendingEmail && (
        <Alert tone="info">
          {t('prof.pending', { email: me.pendingEmail })}{' '}
          <button className="btn btn-sm" type="button" disabled={busy} onClick={cancelEmail}>{t('prof.cancelChange')}</button>
        </Alert>
      )}

      {mode === 'none' && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn" type="button" onClick={() => { setMode('email'); setInfo(''); }}>{t('prof.changeEmail')}</button>
          <button className="btn" type="button" onClick={() => { setMode('password'); setInfo(''); }}>{t('prof.changePassword')}</button>
        </div>
      )}

      {mode === 'email' && (
        <form onSubmit={sendEmail} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
          <label className="field" style={{ margin: 0, flex: '1 1 220px' }}>
            <span>{t('prof.newEmail')}</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="field" style={{ margin: 0, flex: '1 1 200px' }}>
            <span>{t('prof.currentPassword')}</span>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy || !email || !current}>{t('prof.sendLink')}</button>
          <button className="btn" type="button" onClick={close}>{t('common.cancel')}</button>
        </form>
      )}

      {mode === 'password' && (
        <form onSubmit={savePassword} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 8 }}>
          <label className="field" style={{ margin: 0, flex: '1 1 200px' }}>
            <span>{t('prof.currentPassword')}</span>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
          <label className="field" style={{ margin: 0, flex: '1 1 200px' }}>
            <span>{t('prof.newPassword')}</span>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy || !current || next.length < 10}>{t('common.save')}</button>
          <button className="btn" type="button" onClick={close}>{t('common.cancel')}</button>
          <p className="rule" style={{ flexBasis: '100%', margin: 0 }}>{t('prof.newPasswordHint')}</p>
        </form>
      )}
    </Card>
  );
}
