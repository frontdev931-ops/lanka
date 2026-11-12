'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card, Loading } from './ui';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';
import { SendingOffNotice } from './SendingSettings';

interface Rule {
  key: string;
  kind: 'service' | 'marketing';
  enabled: boolean;
  params: { hoursBefore?: number[]; months?: number; days?: number; confirmButtons?: boolean };
  text: string;
  defaultText: string;
}
interface Overview {
  rules: Rule[];
  settings: { autoSendService: boolean; sendingEnabled: boolean; assumeConsent: boolean };
}
interface Preview {
  key: string;
  candidates: number;
  alreadyQueued: number;
  toQueue: number;
  noChannel: number;
  channelDisconnected?: number;
  windowClosed?: number;
  optedOut?: number;
  blockedConsent: number;
  paused: number;
  tooSoon: number;
  sample: { patient: string; channel: string; text: string }[];
}
const HOURS = [2, 3, 6, 12, 24, 48];

// Settings → "Automatic messages": messages sent on a schedule or after an event. Whether service messages need approval, the clinic's consent statement,
// and the rules themselves (who gets the message, when, what it says, on or off). The main sending switch is in General (it covers every message to
// patients); here only a notice while it is off. Every control writes the same settings as before (/automations/settings, /automations/rules/:key).
export function AutoMessagesSettings({ onOpenGeneral }: { onOpenGeneral?: () => void }) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<Preview[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(() => {
    api<Overview>('/automations').then(setData).catch((e) => setError((e as Error).message));
    api<Preview[]>('/automations/preview').then(setPreview).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const patchSettings = (body: object, ok = t('common.saved')) => act(() => api('/automations/settings', { method: 'PATCH', body: JSON.stringify(body) }), ok);
  const patchRule = (key: string, body: object, ok?: string) => act(() => api(`/automations/rules/${key}`, { method: 'PATCH', body: JSON.stringify(body) }), ok ?? t('common.saved'));

  if (!data) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const s = data.settings;

  return (
    <>
      {dialog}
      <p className="rule" style={{ marginTop: 0 }}>{t('ams.intro')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      {!s.sendingEnabled && <SendingOffNotice onOpen={onOpenGeneral} />}

      <Card title={t('ams.approvalTitle')}>
        <Switch
          checked={s.autoSendService}
          disabled={busy}
          label={t('ams.autoSendLabel')}
          hint={s.autoSendService ? t('ams.autoSendOnHint') : t('ams.autoSendOffHint')}
          onChange={(on) => patchSettings({ autoSendService: on })}
        />
        <Switch
          checked={s.assumeConsent}
          disabled={busy}
          label={t('ams.consentLabel')}
          hint={t('ams.consentHint')}
          onChange={async (on) => {
            if (on && !(await ask(t('cons.confirm'), { title: t('ams.consentLabel'), confirmLabel: t('cons.yes') }))) return;
            patchSettings({ assumeConsent: on });
          }}
        />
      </Card>

      <Card title={t('ams.rulesTitle')}>
        <div className="rules">
          {data.rules.map((r) => {
            const p = preview.find((x) => x.key === r.key);
            const draft = drafts[r.key] ?? r.text;
            // service messages go out by themselves only when the clinic allowed it; everything else waits for a person's approval (planner.service.ts)
            const needsApproval = !(r.kind === 'service' && s.autoSendService);
            return (
              <section key={r.key} className="rule-card">
                <Switch checked={r.enabled} disabled={busy} label={t(`au.r.${r.key}` as never)} hint={t(`au.rd.${r.key}` as never)} onChange={(on) => patchRule(r.key, { enabled: on })} />
                <p className="rule" style={{ margin: '0 0 6px' }}>
                  <Badge tone={r.enabled ? 'green' : 'gray'}>{r.enabled ? t('ams.on') : t('ams.off')}</Badge>{' '}
                  <Badge tone={needsApproval ? 'amber' : 'blue'}>{needsApproval ? t('ams.needsApproval') : t('ams.noApproval')}</Badge>{' '}
                  {r.kind === 'marketing' && <Badge tone="gray">{t('ams.consentOnly')}</Badge>}
                </p>
                {/* where the rule can deliver (planner.service.ts): Telegram; the visit reminder also in Instagram while the 24-hour window is open */}
                <p className="muted" style={{ fontSize: 13, margin: '0 0 6px' }}>{t('ams.channelsLabel')}: {r.key === 'visit-reminder' ? t('ams.chReminder') : t('ams.chTelegram')}</p>
                <p className="rule" style={{ margin: '4px 0' }}><b>{t('ams.whatPatientGets')}</b></p>
                <blockquote className="rule" style={{ margin: '0 0 8px', paddingLeft: 10, borderLeft: '3px solid var(--border)', whiteSpace: 'pre-wrap' }}>{r.text}</blockquote>

                {p && (
                  <div className="rule-preview">
                    <b>{t('au.now')}:</b> {t('au.nowLine', { c: p.candidates, q: p.toQueue, w: p.alreadyQueued })}
                    {p.noChannel > 0 && <span> · {t('au.noChannel', { n: p.noChannel })}</span>}
                    {!!p.channelDisconnected && <span> · {t('au.igDisconnected', { n: p.channelDisconnected })}</span>}
                    {!!p.windowClosed && <span> · {t('au.igWindow', { n: p.windowClosed })}</span>}
                    {!!p.optedOut && <span> · {t('au.optedOut', { n: p.optedOut })}</span>}
                    {p.blockedConsent > 0 && <span> · {t('au.noConsent', { n: p.blockedConsent })}</span>}
                    {p.paused > 0 && <span> · {t('au.paused', { n: p.paused })}</span>}
                    {p.tooSoon > 0 && <span> · {t('au.tooSoon', { n: p.tooSoon })}</span>}
                  </div>
                )}

                <details className="more-details">
                  <summary>{t('ams.edit')}</summary>
                  {r.key === 'visit-reminder' && (
                    <>
                      <div className="toolbar" role="group" aria-label={t('au.hoursLabel')}>
                        <span className="muted">{t('au.hoursLabel')}:</span>
                        {HOURS.map((h) => {
                          const on = (r.params.hoursBefore ?? [24]).includes(h);
                          return (
                            <button
                              key={h}
                              className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                              aria-pressed={on}
                              disabled={busy}
                              onClick={() => {
                                const cur = r.params.hoursBefore ?? [24];
                                const next = on ? cur.filter((x) => x !== h) : [...cur, h];
                                if (next.length && next.length <= 3) patchRule(r.key, { params: { hoursBefore: next } });
                              }}
                            >
                              {t('au.hoursN', { n: h })}
                            </button>
                          );
                        })}
                      </div>
                      <Switch checked={!!r.params.confirmButtons} disabled={busy} label={t('au.confirmButtons')} hint={t('au.confirmButtonsHint')} onChange={(on) => patchRule(r.key, { params: { confirmButtons: on } })} />
                    </>
                  )}
                  {(r.key === 'continue-treatment' || r.key === 'lapsed') && (
                    <label className="inline-label">
                      {t('au.daysLabel')}
                      <input className="input" type="number" min={7} max={1095} defaultValue={r.params.days ?? (r.key === 'lapsed' ? 180 : 30)} style={{ width: 100 }} onBlur={(e) => { const d = Number(e.target.value); if (d >= 7 && d <= 1095 && d !== r.params.days) patchRule(r.key, { params: { days: d } }); }} />
                    </label>
                  )}
                  {r.key === 'hygiene-recall' && (
                    <label className="inline-label">
                      {t('au.monthsLabel')}
                      <input className="input" type="number" min={1} max={24} defaultValue={r.params.months ?? 6} style={{ width: 90 }} onBlur={(e) => { const m = Number(e.target.value); if (m >= 1 && m <= 24 && m !== r.params.months) patchRule(r.key, { params: { months: m } }); }} />
                    </label>
                  )}
                  <label className="field" style={{ marginTop: 10 }}>
                    <span>{t('au.text')}</span>
                    <textarea className="input" rows={3} value={draft} onChange={(e) => setDrafts((d) => ({ ...d, [r.key]: e.target.value }))} maxLength={600} />
                  </label>
                  <p className="rule" style={{ margin: '4px 0 8px' }}>{t('au.vars')}</p>
                  <div className="toolbar">
                    <button className="btn btn-sm" disabled={busy || draft === r.text || draft.trim().length < 10} onClick={() => patchRule(r.key, { text: draft }, t('au.textSaved')).then(() => setDrafts((d) => { const n = { ...d }; delete n[r.key]; return n; }))}>
                      {t('common.save')}
                    </button>
                    {draft !== r.defaultText && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => setDrafts((d) => ({ ...d, [r.key]: r.defaultText }))}>{t('au.resetText')}</button>
                    )}
                  </div>
                  {p && p.sample.length > 0 && (
                    <ul className="sample">
                      {p.sample.slice(0, 2).map((x, i) => (
                        <li key={i}><b>{x.patient}:</b> {x.text}</li>
                      ))}
                    </ul>
                  )}
                </details>
              </section>
            );
          })}
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy} onClick={() => act(() => api('/automations/run', { method: 'POST' }), t('au.checked'))}>{t('au.runNow')}</button>
        </div>
      </Card>
    </>
  );
}
