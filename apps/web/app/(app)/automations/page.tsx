'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { ChannelsCard } from '../../../components/ChannelsCard';
import { WebChatCard } from '../../../components/WebChatCard';
import { LeadsCard } from '../../../components/LeadsCard';
import { MetaLoginCard } from '../../../components/MetaLoginCard';
import { QrCode } from '../../../components/QrCode';
import { useConfirm } from '../../../components/ConfirmDialog';
import { CampaignsCard } from '../../../components/CampaignsCard';
import { DigestCard } from '../../../components/DigestCard';

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
  telegram: { connected: boolean; username: string | null; linkedPatients: number; staffChat: string | null };
  instagram: { connected: boolean; username: string | null; linkedPatients: number; serverReady: boolean; oauthReady: boolean; facebookLoginReady: boolean; via: string | null; tokenProblem: string | null };
  queue: Record<string, number>;
}
interface AiStatus {
  available: boolean;
  enabled: boolean;
  monthlyLimit: number;
  autoReply: boolean;
  sendingEnabled: boolean;
  autoBooking: boolean;
  assistant: boolean;
  autoBookingSupported: boolean;
  used: number;
  tokens: number;
}

interface Preview {
  key: string;
  candidates: number;
  alreadyQueued: number;
  toQueue: number;
  noChannel: number;
  blockedConsent: number;
  paused: number;
  tooSoon: number;
  sample: { patient: string; channel: string; text: string }[];
}
interface Msg {
  id: string;
  patient: { id: string; fullName: string };
  ruleKey: string;
  campaignName?: string | null;
  channel: string;
  text: string;
  status: string;
  scheduledFor: string;
  sentAt: string | null;
  error: string | null;
}
interface MsgList {
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  rows: Msg[];
}

const TONE: Record<string, 'gray' | 'amber' | 'blue' | 'green' | 'red'> = {
  PENDING_APPROVAL: 'amber',
  APPROVED: 'blue',
  SENT: 'green',
  FAILED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
};
const STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
const HOURS = [2, 3, 6, 12, 24, 48];

export default function AutomationsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<Preview[]>([]);
  const [msgs, setMsgs] = useState<MsgList | null>(null);
  const [status, setStatus] = useState<string>('PENDING_APPROVAL');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [token, setToken] = useState('');
  const [igToken, setIgToken] = useState('');
  const [link, setLink] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [limit, setLimit] = useState('');
  const [staffCode, setStaffCode] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();

  const loadAll = useCallback(() => {
    api<Overview>('/automations').then(setData).catch((e) => setError((e as Error).message));
    api<AiStatus>('/ai').then((a) => { setAi(a); setLimit(String(a.monthlyLimit)); }).catch(() => undefined);
    api<Preview[]>('/automations/preview').then(setPreview).catch(() => undefined);
  }, []);
  const loadMsgs = useCallback(() => {
    api<MsgList>(`/messages?status=${status}&page=${page}`).then(setMsgs).catch((e) => setError((e as Error).message));
  }, [status, page]);
  useEffect(loadAll, [loadAll]);
  useEffect(loadMsgs, [loadMsgs]);

  // Общая ссылка на бота (для QR на ресепшн)
  useEffect(() => {
    if (data?.telegram.connected) api<{ url: string }>('/automations/telegram/link').then((r) => setLink(r.url)).catch(() => undefined);
    else setLink('');
  }, [data?.telegram.connected]);

  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ig');
    if (!code) return;
    const ok: Record<string, string> = { ok: t('au.igDone') };
    const bad: Record<string, string> = {
      denied: t('au.igDenied'),
      fail: t('au.igFail'),
      taken: t('au.igTaken'),
      plan: t('au.igPlan'),
      off: t('au.igOff'),
      demo: t('au.igFail'),
    };
    if (ok[code]) setInfo(ok[code]);
    else setError(bad[code] ?? t('au.igFail'));
    window.history.replaceState(null, '', window.location.pathname);
  }, [t]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      loadAll();
      loadMsgs();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const patchAi = (body: object) => act(() => api('/ai', { method: 'PATCH', body: JSON.stringify(body) }), t('common.saved'));
  const patchRule = (key: string, body: object, ok?: string) => act(() => api(`/automations/rules/${key}`, { method: 'PATCH', body: JSON.stringify(body) }), ok);
  const pv = (key: string) => preview.find((p) => p.key === key);

  if (!data) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const pending = data.queue.PENDING_APPROVAL ?? 0;

  return (
    <>
      {dialog}
      <PageHeader title={t('au.title')} subtitle={t('au.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      {/* Подключение Telegram */}
      <Card title={t('au.tgTitle')}>
        {data.telegram.connected ? (
          <>
            <p className="rule">
              <Badge tone="green">{t('au.tgConnected')}</Badge> @{data.telegram.username} · {t('au.tgLinked', { n: data.telegram.linkedPatients })}
            </p>
            <p className="rule">{t('au.tgHowPatients')}</p>
            {link && (
              <div className="toolbar" style={{ alignItems: 'flex-start', gap: 20 }}>
                <QrCode value={link} label={t('au.tgQr')} />
                <div style={{ minWidth: 0 }}>
                  <p className="rule" style={{ marginTop: 0 }}>{t('au.tgQrHint')}</p>
                  <input className="input" style={{ width: '100%', maxWidth: 420 }} readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={t('au.tgQr')} />
                </div>
              </div>
            )}
            <section className="rule-card" style={{ marginTop: 12 }}>
              <b>{t('au.staffTitle')}</b>
              <p className="rule" style={{ margin: '4px 0 8px' }}>{t('au.staffIntro')}</p>
              {data.telegram.staffChat ? (
                <>
                  <p className="rule"><Badge tone="green">{t('au.staffOn')}</Badge> {data.telegram.staffChat}</p>
                  <div className="toolbar">
                    <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => { const r = await api<{ sent: boolean }>('/automations/telegram/staff-chat/test', { method: 'POST' }); if (!r.sent) throw new Error(t('au.staffTestFail')); }, t('au.staffTestOk'))}>{t('au.staffTest')}</button>
                    <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('au.staffOffConfirm'), { danger: true, confirmLabel: t('au.staffOff') })) && act(async () => { await api('/automations/telegram/staff-chat', { method: 'DELETE' }); setStaffCode(null); })}>{t('au.staffOff')}</button>
                  </div>
                </>
              ) : staffCode ? (
                <>
                  <ol className="terms-list">
                    <li>{t('au.staffStep1', { bot: data.telegram.username ?? '' })}</li>
                    <li>{t('au.staffStep2')}</li>
                  </ol>
                  <input className="input" style={{ width: '100%', maxWidth: 320 }} readOnly value={`/chat ${staffCode}`} onFocus={(e) => e.currentTarget.select()} aria-label={t('au.staffCmd')} />
                  <p className="muted" style={{ fontSize: 13 }}>{t('au.staffCodeHint')}</p>
                  <div className="toolbar">
                    <button className="btn btn-sm" disabled={busy} onClick={() => { setStaffCode(null); loadAll(); }}>{t('au.staffCheck')}</button>
                  </div>
                </>
              ) : (
                <div className="toolbar">
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(async () => { const r = await api<{ code: string }>('/automations/telegram/staff-chat', { method: 'POST' }); setStaffCode(r.code); })}>{t('au.staffOn2')}</button>
                </div>
              )}
            </section>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={async () => (await ask(t('au.tgDisconnectConfirm'), { danger: true, confirmLabel: t('au.tgDisconnect') })) && act(() => api('/automations/telegram', { method: 'DELETE' }))}>
                {t('au.tgDisconnect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="rule">{t('au.tgIntro')}</p>
            <ol className="terms-list">
              <li>{t('au.tgStep1')}</li>
              <li>{t('au.tgStep2')}</li>
              <li>{t('au.tgStep3')}</li>
            </ol>
            <div className="toolbar">
              <input className="input grow" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('au.tgToken')} autoComplete="off" />
              <button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={() => act(async () => { await api('/automations/telegram', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); }, t('au.tgDone'))}>
                {t('au.tgConnect')}
              </button>
            </div>
          </>
        )}
      </Card>

      {/* Режим работы: один выбор вместо отдельных переключателей */}
      {ai && (
        <Card title={t('mode.title')}>
          <p className="rule" style={{ marginTop: 0 }}>{t('mode.intro')}</p>
          {(() => {
            const sending = data.settings.sendingEnabled;
            const level = !sending ? 'off' : !ai.enabled ? 'staff' : ai.autoReply ? 'auto' : 'draft';
            const options: { key: 'off' | 'staff' | 'draft' | 'auto'; needsAi: boolean }[] = [
              { key: 'off', needsAi: false },
              { key: 'staff', needsAi: false },
              { key: 'draft', needsAi: true },
              { key: 'auto', needsAi: true },
            ];
            const choose = async (key: (typeof options)[number]['key']) => {
              if (key === level) return;
              const order = ['off', 'staff', 'draft', 'auto'];
              if (key !== 'off' && order.indexOf(key) > order.indexOf(level) && !(await ask(t(`mode.confirm.${key}`), { title: t(`mode.${key}`) }))) return;
              act(async () => {
                await api('/automations/settings', { method: 'PATCH', body: JSON.stringify({ sendingEnabled: key !== 'off' }) });
                if (key !== 'off') await api('/ai', { method: 'PATCH', body: JSON.stringify({ enabled: key === 'draft' || key === 'auto', autoReply: key === 'auto' }) });
              }, t(`mode.saved.${key}`));
            };
            return (
              <div role="radiogroup" aria-label={t('mode.title')}>
                {options.map((o) => (
                  <label key={o.key} className="check-row">
                    <input type="radio" name="mode" checked={level === o.key} disabled={busy || (o.needsAi && !ai.available)} onChange={() => choose(o.key)} />
                    <span>
                      <b>{t(`mode.${o.key}`)}</b>
                      <br />
                      <span className="muted">{t(`mode.${o.key}Hint`)}</span>
                    </span>
                  </label>
                ))}
                {!ai.available && <Alert tone="warn">{t('ai.notConfigured')}</Alert>}
              </div>
            );
          })()}
          {data.settings.sendingEnabled && ai.enabled && (
            <div style={{ marginTop: 10 }}>
              <p>{t('ai.usage', { used: ai.used, limit: ai.monthlyLimit })}</p>
              <div className="toolbar">
                <label className="field" style={{ margin: 0 }}>
                  <span>{t('ai.limit')}</span>
                  <input className="input" type="number" min={0} max={100000} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 140 }} />
                </label>
                <button className="btn" disabled={busy || Number(limit) === ai.monthlyLimit || limit === ''} onClick={() => patchAi({ monthlyLimit: Number(limit) })}>{t('common.save')}</button>
              </div>
              <label className="check-row">
                <input type="checkbox" checked={ai.autoBooking} disabled={busy || !ai.autoBookingSupported} onChange={(e) => patchAi({ autoBooking: e.target.checked })} />
                <span>
                  <b>{t('ai.autoBooking')}</b>
                  <br />
                  <span className="muted">{ai.autoBookingSupported ? t('ai.autoBookingHint') : t('ai.autoBookingUnsupported')}</span>
                </span>
              </label>
            </div>
          )}
        </Card>
      )}

      {ai && (
        <Card title={t('as.cardTitle')}>
          <label className="check-row" style={{ marginTop: 0 }}>
            <input
              type="checkbox"
              checked={ai.assistant}
              disabled={busy || !ai.available}
              onChange={async (e) => {
                const on = e.target.checked;
                if (on && !(await ask(t('as.confirm'), { title: t('as.cardTitle'), confirmLabel: t('as.yes') }))) return;
                patchAi({ assistant: on });
              }}
            />
            <span>
              <b>{t('as.label')}</b>
              <br />
              <span className="muted">{t('as.hint')}</span>
              {ai.assistant && (
                <>
                  {' '}
                  <Link href="/assistant">{t('as.open')}</Link>
                </>
              )}
            </span>
          </label>
        </Card>
      )}

      <Card title={t('cons.title')}>
        <p className="rule" style={{ marginTop: 0 }}>{t('cons.intro')}</p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={data.settings.assumeConsent}
            disabled={busy}
            onChange={async (e) => {
              const on = e.target.checked;
              if (on && !(await ask(t('cons.confirm'), { title: t('cons.title'), confirmLabel: t('cons.yes') }))) return;
              act(() => api('/automations/settings', { method: 'PATCH', body: JSON.stringify({ assumeConsent: on }) }), t('common.saved'));
            }}
          />
          <span>
            <b>{t('cons.label')}</b>
            <br />
            <span className="muted">{t('cons.hint')}</span>
          </span>
        </label>
      </Card>

      <MetaLoginCard ready={data.instagram.facebookLoginReady} connected={data.instagram.connected} via={data.instagram.via} account={data.instagram.username} tokenProblem={data.instagram.tokenProblem} onChanged={loadAll} />

      {/* Instagram */}
      <Card title={t('au.igTitle')}>
        {data.instagram.connected ? (
          <>
            <p className="rule">
              <Badge tone="green">{t('au.igConnected')}</Badge> {data.instagram.username ? `@${data.instagram.username} · ` : ''}{t('au.igLinked', { n: data.instagram.linkedPatients })}
            </p>
            <p className="rule">{t('au.igHow')}</p>
            {!data.instagram.serverReady && <Alert tone="warn">{t('au.igNotReady')}</Alert>}
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" disabled={busy} onClick={async () => (await ask(t('au.igDisconnectConfirm'), { danger: true, confirmLabel: t('au.igDisconnect') })) && act(() => api('/automations/instagram', { method: 'DELETE' }))}>
                {t('au.igDisconnect')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="rule">{t('au.igIntro')}</p>
            <p className="muted">{t('au.igConnectHint')}</p>
            {data.instagram.oauthReady ? (
              <div className="toolbar" style={{ marginTop: 12 }}>
                <a className="btn btn-primary" href="/backend/automations/instagram/oauth">{t('au.igConnect')}</a>
              </div>
            ) : (
              <Alert tone="warn">{t('au.igOff')}</Alert>
            )}
            <details style={{ marginTop: 12 }}>
              <summary className="muted" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>{t('au.igManual')}</summary>
              <div className="toolbar" style={{ marginTop: 8 }}>
                <input className="input grow" type="password" value={igToken} onChange={(e) => setIgToken(e.target.value)} placeholder={t('au.igToken')} autoComplete="off" />
                <button className="btn btn-primary" disabled={busy || igToken.trim().length < 20} onClick={() => act(async () => { await api('/automations/instagram', { method: 'POST', body: JSON.stringify({ token: igToken }) }); setIgToken(''); }, t('au.igDone'))}>
                  {t('au.igConnect')}
                </button>
              </div>
            </details>
          </>
        )}
      </Card>

      <ChannelsCard />
      <WebChatCard />
      <LeadsCard />

      {/* Сценарии */}
      <Card title={t('au.rulesTitle')}>
        <p className="rule">{t('au.rulesIntro')}</p>
        <div className="rules">
          {data.rules.map((r) => {
            const p = pv(r.key);
            const draft = drafts[r.key] ?? r.text;
            return (
              <section key={r.key} className="rule-card">
                <div className="rule-head">
                  <label className="check-row" style={{ margin: 0, minHeight: 0 }}>
                    <input type="checkbox" checked={r.enabled} disabled={busy} onChange={(e) => patchRule(r.key, { enabled: e.target.checked })} />
                    <b>{t(`au.r.${r.key}` as never)}</b>
                  </label>
                  <Badge tone={r.kind === 'service' ? 'blue' : 'amber'}>{t(`au.kind.${r.kind}` as never)}</Badge>
                </div>
                <p className="rule">{t(`au.rd.${r.key}` as never)}</p>

                {r.key === 'visit-reminder' && (
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
                )}
                {r.key === 'visit-reminder' && (
                  <label className="check-row">
                    <input type="checkbox" checked={!!r.params.confirmButtons} disabled={busy} onChange={(e) => patchRule(r.key, { params: { confirmButtons: e.target.checked } })} />
                    <span>
                      <b>{t('au.confirmButtons')}</b>
                      <br />
                      <span className="muted">{t('au.confirmButtonsHint')}</span>
                    </span>
                  </label>
                )}
                {(r.key === 'continue-treatment' || r.key === 'lapsed') && (
                  <label className="inline-label">
                    {t('au.daysLabel')}
                    <input
                      className="input"
                      type="number"
                      min={7}
                      max={1095}
                      defaultValue={r.params.days ?? (r.key === 'lapsed' ? 180 : 30)}
                      style={{ width: 100 }}
                      onBlur={(e) => {
                        const d = Number(e.target.value);
                        if (d >= 7 && d <= 1095 && d !== r.params.days) patchRule(r.key, { params: { days: d } });
                      }}
                    />
                  </label>
                )}
                {r.key === 'hygiene-recall' && (
                  <label className="inline-label">
                    {t('au.monthsLabel')}
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={24}
                      defaultValue={r.params.months ?? 6}
                      style={{ width: 90 }}
                      onBlur={(e) => {
                        const m = Number(e.target.value);
                        if (m >= 1 && m <= 24 && m !== r.params.months) patchRule(r.key, { params: { months: m } });
                      }}
                    />
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
                    <button className="btn btn-sm" disabled={busy} onClick={() => { setDrafts((d) => ({ ...d, [r.key]: r.defaultText })); }}>
                      {t('au.resetText')}
                    </button>
                  )}
                </div>

                {p && (
                  <div className="rule-preview">
                    <b>{t('au.now')}:</b> {t('au.nowLine', { c: p.candidates, q: p.toQueue, w: p.alreadyQueued })}
                    {p.noChannel > 0 && <span> · {t('au.noChannel', { n: p.noChannel })}</span>}
                    {p.blockedConsent > 0 && <span> · {t('au.noConsent', { n: p.blockedConsent })}</span>}
                    {p.paused > 0 && <span> · {t('au.paused', { n: p.paused })}</span>}
                    {p.tooSoon > 0 && <span> · {t('au.tooSoon', { n: p.tooSoon })}</span>}
                    {p.sample.length > 0 && (
                      <ul className="sample">
                        {p.sample.slice(0, 2).map((s, i) => (
                          <li key={i}><b>{s.patient}:</b> {s.text}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <label className="check-row" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={data.settings.autoSendService} disabled={busy} onChange={(e) => act(() => api('/automations/settings', { method: 'PATCH', body: JSON.stringify({ autoSendService: e.target.checked }) }))} />
          <span>
            <b>{t('au.autoSend')}</b>
            <br />
            <span className="muted">{t('au.autoSendHint')}</span>
          </span>
        </label>
        <div className="toolbar" style={{ marginTop: 6 }}>
          <button className="btn" disabled={busy} onClick={() => act(() => api('/automations/run', { method: 'POST' }), t('au.checked'))}>
            {t('au.runNow')}
          </button>
        </div>
      </Card>

      <DigestCard />

      <CampaignsCard onChanged={() => { loadAll(); loadMsgs(); }} />

      {/* Очередь и журнал */}
      <Card
        flush
        title={t('au.logTitle')}
        actions={
          pending > 0 ? (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => (await ask(t('au.approveConfirm', { n: pending }), { confirmLabel: t('au.approveAll', { n: pending }) })) && act(() => api('/messages/approve', { method: 'POST', body: JSON.stringify({ all: true }) }), t('au.approved'))}>
              {t('au.approveAll', { n: pending })}
            </button>
          ) : undefined
        }
      >
        <div className="toolbar" role="group" aria-label={t('au.logTitle')} style={{ padding: '0 20px 12px' }}>
          {STATUSES.map((s) => (
            <button key={s} className={`btn btn-sm${status === s ? ' btn-primary' : ''}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(1); }}>
              {t(`au.st.${s}` as never)} · {data.queue[s] ?? msgs?.counts[s] ?? 0}
            </button>
          ))}
        </div>
        {!msgs ? (
          <Loading />
        ) : !msgs.rows.length ? (
          <Empty title={t('au.empty')}>{t('au.emptyHint')}</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('au.colPatient')}</th><th>{t('au.colText')}</th>
                    <th>{t('au.colStatus')}</th><th>{t('au.colWhen')}</th><th>{t('au.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {msgs.rows.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Link href={`/patients/${m.patient.id}`} className="cell-main">{m.patient.fullName}</Link>
                        <div className="cell-sub">{m.ruleKey.startsWith('campaign:') ? `${t('camp.label')}: ${m.campaignName ?? ''}` : t(`au.r.${m.ruleKey}` as never)}</div>
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{m.text}</td>
                      <td>
                        <Badge tone={TONE[m.status] ?? 'gray'}>{t(`au.st.${m.status}` as never)}</Badge>
                        {m.error && <div className="cell-sub">{m.error}</div>}
                      </td>
                      <td>{fmtDateTime(m.sentAt ?? m.scheduledFor)}</td>
                      <td>
                        <div className="toolbar" style={{ flexWrap: 'nowrap' }}>
                          {m.status === 'PENDING_APPROVAL' && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api('/messages/approve', { method: 'POST', body: JSON.stringify({ ids: [m.id] }) }))}>{t('au.approve')}</button>
                          )}
                          {(m.status === 'PENDING_APPROVAL' || m.status === 'APPROVED') && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api('/messages/cancel', { method: 'POST', body: JSON.stringify({ ids: [m.id] }) }))}>{t('au.cancel')}</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {msgs.total > msgs.pageSize && (
              <div className="toolbar" style={{ padding: '12px 20px', justifyContent: 'space-between' }}>
                <span className="muted">{t('pat.page', { page: msgs.page, pages: Math.ceil(msgs.total / msgs.pageSize) })}</span>
                <span className="toolbar">
                  <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.back')}</button>
                  <button className="btn btn-sm" disabled={page >= Math.ceil(msgs.total / msgs.pageSize)} onClick={() => setPage((p) => p + 1)}>{t('common.forward')}</button>
                </span>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
