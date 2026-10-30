'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { QrCode } from './QrCode';
import { useConfirm } from './ConfirmDialog';

interface Status {
  enabled: boolean;
  recoveryLeft: number;
}

// Двухфакторный вход: включение с QR, резервные коды (показываются один раз), выключение по паролю и коду
export function SecurityCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [st, setSt] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'off' | 'disable' | 'regen'>('off');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(() => api<Status>('/auth/2fa').then(setSt).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return error ? <Alert tone="error">{error}</Alert> : null;

  return (
    <Card title={t('twofa.title')} actions={<Badge tone={st.enabled ? 'green' : 'gray'}>{st.enabled ? t('twofa.on') : t('twofa.off')}</Badge>}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('twofa.intro')}</p>

      {codes && (
        <div className="rule-card">
          <b>{t('twofa.codesTitle')}</b>
          <p className="rule" style={{ margin: '4px 0 8px' }}>{t('twofa.codesHint')}</p>
          <ul className="recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="toolbar">
            <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => setInfo(t('twofa.copied')))}>{t('twofa.copy')}</button>
            <button className="btn btn-sm btn-primary" onClick={() => setCodes(null)}>{t('twofa.saved')}</button>
          </div>
        </div>
      )}

      {!st.enabled && !setup && (
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => { setSetup(await api('/auth/2fa/setup', { method: 'POST' })); setCode(''); })}>{t('twofa.enable')}</button>
      )}

      {!st.enabled && setup && (
        <div className="toolbar" style={{ alignItems: 'flex-start', gap: 20 }}>
          <QrCode value={setup.otpauthUrl} label={t('twofa.qr')} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <ol className="terms-list">
              <li>{t('twofa.step1')}</li>
              <li>{t('twofa.step2')}</li>
            </ol>
            <p className="muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{t('twofa.manual')}: <code>{setup.secret}</code></p>
            <form
              className="toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const r = await api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
                  setCodes(r.recoveryCodes);
                  setSetup(null);
                  setCode('');
                  await load();
                }, t('twofa.enabled'));
              }}
            >
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6} style={{ width: 140 }} aria-label={t('twofa.code')} />
              <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length !== 6}>{t('twofa.confirm')}</button>
              <button className="btn" type="button" onClick={() => setSetup(null)}>{t('common.cancel')}</button>
            </form>
          </div>
        </div>
      )}

      {st.enabled && (
        <>
          <p>{t('twofa.recoveryLeft', { n: st.recoveryLeft })}</p>
          {mode === 'off' ? (
            <div className="toolbar">
              <button className="btn btn-sm" onClick={() => { setMode('regen'); setCode(''); }}>{t('twofa.regen')}</button>
              <button className="btn btn-sm" onClick={() => { setMode('disable'); setCode(''); setPassword(''); }}>{t('twofa.disable')}</button>
            </div>
          ) : (
            <form
              className="toolbar"
              style={{ alignItems: 'flex-end' }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (mode === 'disable' && !(await ask(t('twofa.disableConfirm'), { danger: true, confirmLabel: t('twofa.disable') }))) return;
                run(async () => {
                  if (mode === 'disable') await api('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password, code: code.trim() }) });
                  else setCodes((await api<{ recoveryCodes: string[] }>('/auth/2fa/recovery-codes', { method: 'POST', body: JSON.stringify({ code: code.trim() }) })).recoveryCodes);
                  setMode('off');
                  await load();
                }, mode === 'disable' ? t('twofa.disabled') : undefined);
              }}
            >
              {mode === 'disable' && (
                <label className="field" style={{ margin: 0 }}>
                  <span>{t('login.password')}</span>
                  <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </label>
              )}
              <label className="field" style={{ margin: 0 }}>
                <span>{t('twofa.code')}</span>
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={32} style={{ width: 160 }} />
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length < 6 || (mode === 'disable' && !password)}>{t('twofa.confirm')}</button>
              <button className="btn" type="button" onClick={() => setMode('off')}>{t('common.cancel')}</button>
            </form>
          )}
        </>
      )}
    </Card>
  );
}
