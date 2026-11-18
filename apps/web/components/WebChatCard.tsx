'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { useConfirm } from './ConfirmDialog';
import { ProHint } from './ProHint';
import { Switch } from './Switch';
import { Alert, Badge, Card } from './ui';

interface Settings {
  enabled: boolean;
  inPlan: boolean;
  origins: string[];
  greeting: string | null;
  color: string | null;
  position: 'RIGHT' | 'LEFT';
  aiAnswers: boolean;
  verifiedAt: string | null;
  snippet: string | null;
  canChooseAi?: boolean;
}

const DEFAULT_COLOR = '#0e9aa0';

// Settings → Channels → Website: the chat widget for the clinic's own website. The switch, the allowed sites, the greeting and the look, the code to paste,
// and the owner's separate choice whether the AI answers there by itself (off by default; turning the widget on never turns it on). "Configured" is told
// apart from "verified" (a visitor's message really arrived from an allowed site).
export function WebChatCard() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
  const [greeting, setGreeting] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [position, setPosition] = useState<'RIGHT' | 'LEFT'>('RIGHT');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const take = (r: Settings) => {
    setS((cur) => ({ ...r, canChooseAi: r.canChooseAi ?? cur?.canChooseAi }));
    setOrigins(r.origins.join('\n'));
    setGreeting(r.greeting ?? '');
    setColor(r.color ?? DEFAULT_COLOR);
    setPosition(r.position ?? 'RIGHT');
  };
  const load = useCallback(() => api<Settings>('/automations/webchat').then(take).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: object, ok: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      take(await api<Settings>('/automations/webchat', { method: 'PATCH', body: JSON.stringify(patch) }));
      setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!s?.enabled) return null;
  const list = () => origins.split(/[\s,]+/).filter(Boolean);
  const look = { origins: list(), greeting, color, position };
  const state = s.verifiedAt ? <Badge tone="green">{t('site.verified')}</Badge> : <Badge tone="amber">{t('site.configured')}</Badge>;

  return (
    <Card title={t('wc.title')} actions={state}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('wc.intro')}</p>
      {!s.inPlan && <ProHint feature="multi_channel" />}
      <p className="muted" style={{ margin: '4px 0 12px' }}>{s.verifiedAt ? t('wc.verifiedAt', { d: fmtDateTime(s.verifiedAt) }) : t('wc.notVerified')}</p>
      <label className="field">
        <span>{t('wc.origins')}</span>
        <textarea className="input" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://your-clinic.com" />
      </label>
      <label className="field">
        <span>{t('wc.greeting')}</span>
        <input className="input" maxLength={300} value={greeting} onChange={(e) => setGreeting(e.target.value)} />
      </label>
      <div className="toolbar" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ margin: 0 }}>
          <span>{t('wc.color')}</span>
          <input className="input" type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 64, padding: 4 }} aria-label={t('wc.color')} />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span>{t('wc.position')}</span>
          <select className="input" value={position} onChange={(e) => setPosition(e.target.value as 'RIGHT' | 'LEFT')}>
            <option value="RIGHT">{t('wc.pos.RIGHT')}</option>
            <option value="LEFT">{t('wc.pos.LEFT')}</option>
          </select>
        </label>
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy} onClick={() => save(look, t('wc.saved'))}>{t('common.save')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => save({ enabled: false, ...look }, t('wc.offDone'))}>
          {t('wc.turnOff')}
        </button>
      </div>

      <section className="rule-card" style={{ marginTop: 14 }}>
        <Switch
          checked={s.aiAnswers}
          disabled={busy || !s.canChooseAi}
          label={t('wc.aiTitle')}
          hint={s.aiAnswers ? t('wc.aiOnHint') : t('wc.aiOffHint')}
          onChange={async (on) => {
            if (on && !(await ask(t('wc.aiConfirm'), { confirmLabel: t('wc.aiOn') }))) return;
            await save({ aiAnswers: on }, on ? t('wc.aiOnDone') : t('wc.aiOffDone'));
          }}
        />
        {!s.canChooseAi && <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>{t('wc.aiOwnerOnly')}</p>}
      </section>

      {s.snippet && (
        <section className="rule-card" style={{ marginTop: 14 }}>
          <b>{t('wc.snippet')}</b>
          <input className="input" readOnly value={s.snippet} onFocus={(e) => e.currentTarget.select()} aria-label={t('wc.snippet')} style={{ marginTop: 6 }} />
          <p className="muted" style={{ fontSize: 13, margin: '6px 0' }}>{t('wc.session')}</p>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                if (!(await ask(t('wc.rotateConfirm'), { danger: true, confirmLabel: t('wc.rotate') }))) return;
                try {
                  take(await api<Settings>('/automations/webchat/rotate-key', { method: 'POST' }));
                  setInfo(t('wc.rotated'));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {t('wc.rotate')}
            </button>
          </div>
        </section>
      )}
      <p className="muted" style={{ fontSize: 13 }}>{t('wc.note')}</p>
    </Card>
  );
}
