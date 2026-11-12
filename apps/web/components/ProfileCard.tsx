'use client';

import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { initials } from '../lib/ui';
import { Alert, Card, Icon } from './ui';

interface Profile {
  name: string;
  email: string;
  pendingEmail: string | null;
  avatar: string | null;
}

// The photo is cut to a centred square and shrunk in the browser; the server takes at most 60 KB (its own check is the one that counts)
const AVATAR_PX = 256;
const AVATAR_MAX_CHARS = 80_000;
async function squareJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('bad_image'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx || !side) throw new Error('bad_image');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length <= AVATAR_MAX_CHARS) return data;
    }
    throw new Error('bad_image');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The person's own data: name, sign-in email and password. The email changes only after the link sent to the new address is
// opened; the password change closes the sessions on other devices. `bare` renders it without its card, for the profile dialog of the side panel.
export function ProfileCard({ bare }: { bare?: boolean }) {
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
  const fileRef = useRef<HTMLInputElement>(null);

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

  const pickPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    return run(async () => {
      let image: string;
      try {
        image = await squareJpeg(file);
      } catch {
        throw new Error(t('prof.photoBad'));
      }
      await api('/auth/avatar', { method: 'PUT', body: JSON.stringify({ image }) });
      await load();
      window.dispatchEvent(new Event('stomat:me-changed'));
    }, t('prof.photoSaved'));
  };
  const removePhoto = () =>
    run(async () => {
      await api('/auth/avatar', { method: 'DELETE' });
      await load();
      window.dispatchEvent(new Event('stomat:me-changed'));
    }, t('prof.photoRemoved'));

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

  const wrap = (body: ReactNode) => (bare ? <>{body}</> : <Card title={t('prof.title')}>{body}</Card>);
  return wrap(
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <div className="profile-photo">
        {me.avatar ? <img className="avatar lg avatar-logo" src={me.avatar} alt={t('prof.photo')} /> : <span className="avatar lg" aria-hidden="true">{initials(me.name)}</span>}
        <div className="toolbar">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pickPhoto} />
          <button className="btn" type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={16} /> {me.avatar ? t('prof.photoChange') : t('prof.photoUpload')}
          </button>
          {me.avatar && <button className="btn" type="button" disabled={busy} onClick={removePhoto}>{t('prof.photoRemove')}</button>}
        </div>
      </div>

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
    </>,
  );
}
