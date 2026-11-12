'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card, Loading } from './ui';
import { ProHint } from './ProHint';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';
import { SendingOffNotice } from './SendingSettings';

interface AiStatus {
  available: boolean;
  enabled: boolean;
  monthlyLimit: number;
  autoReply: boolean;
  repliesPerChatDay: number;
  pauseMinutes: number;
  sendingEnabled: boolean;
  autoBooking: boolean;
  assistant: boolean;
  autoBookingSupported: boolean;
  autoBookingTest?: { restricted: boolean; dialogs: number };
  // the new agent (the service owner's switches, read-only here)
  agentMode: boolean;
  agentAuto: boolean;
  autoReplyHeldByAgent: boolean;
  used: number;
  purchased: number;
}

// Settings → "Replies to patients" (the tab was "AI assistant": ?tab=ai still opens it).
//   - How incoming patient messages are answered. With the agent on (Clinic.aiAgentMode) the agent answers: drafts approved by staff, or by itself only in the dialogs of the
//      server list (aiAgentAuto + AGENT_AUTO_DIALOGS); the older bot's automatic reply is held back then (autoReplyHeldByAgent), and the agent does not
//      reply by itself in Telegram. With the agent off, the older bot: drafts on request (aiEnabled) or automatic replies that hand requests to staff
//      (aiEnabled + aiAutoReply); it never moves or cancels a visit itself. aiEnabled off stops every model call of the patient side (drafts too),
//      so a clinic with it off is shown as such and nothing is rewritten on load.
//   - Booking from the conversation: whether a visit is created by itself after the patient confirmed (aiAutoBooking; the schedule settings are below it).
// The shared parts are only noted here: the monthly AI allowance (shared with the manager's assistant; in Payment) and the sending switch (in General).
export function AiSettings({ onOpenGeneral, onOpenBilling }: { onOpenGeneral?: () => void; onOpenBilling?: () => void }) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [telegram, setTelegram] = useState(false);
  const [perChat, setPerChat] = useState('');
  const [pause, setPause] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(() => {
    api<AiStatus>('/ai')
      .then((a) => {
        setAi(a);
        setPerChat(String(a.repliesPerChatDay));
        setPause(String(a.pauseMinutes));
      })
      .catch((e) => setError((e as Error).message));
    api<{ telegram: { connected: boolean } }>('/automations').then((o) => setTelegram(o.telegram.connected)).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  const patchAi = async (body: object) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api('/ai', { method: 'PATCH', body: JSON.stringify(body) });
      setInfo(t('common.saved'));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!ai) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const agent = ai.agentMode;
  // the older bot's level as it really works: off stops drafts too; it is not rewritten until a person picks an option
  const legacy: 'off' | 'drafts' | 'auto' = !ai.enabled ? 'off' : ai.autoReply ? 'auto' : 'drafts';
  const chooseLegacy = async (key: 'drafts' | 'auto') => {
    if (key === legacy) return;
    if (key === 'auto' && !(await ask(t('mode.confirm.auto'), { title: t('aiset.auto') }))) return;
    if (key === 'drafts' && legacy === 'off' && !(await ask(t('mode.confirm.draft'), { title: t('aiset.drafts') }))) return;
    patchAi({ enabled: true, autoReply: key === 'auto' });
  };
  const badge = agent ? (ai.agentAuto ? t('aiset.agentAutoBadge') : t('aiset.agentDraftsBadge')) : legacy === 'off' ? t('aiset.offBadge') : legacy === 'auto' ? t('aiset.auto') : t('aiset.drafts');

  return (
    <>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      {!ai.available && <Alert tone="warn">{t('ai.notConfigured')}</Alert>}

      <Card title={t('aiset.repliesTitle')} actions={<Badge tone={!agent && legacy === 'off' ? 'gray' : 'green'}>{badge}</Badge>}>
        {agent ? (
          <>
            <p className="rule" style={{ marginTop: 0 }}><b>{ai.agentAuto ? t('aiset.agentAuto') : t('aiset.agentDrafts')}</b></p>
            {ai.agentAuto && <p className="rule">{t('aiset.agentAutoLimited')}</p>}
            <p className="muted" style={{ fontSize: 13 }}>{t('aiset.agentOwner')}</p>
            {!ai.enabled && (
              <Alert tone="warn">
                {t('aiset.agentAiOff')}{' '}
                <button type="button" className="link-btn" disabled={busy || !ai.available} onClick={async () => (await ask(t('mode.confirm.draft'), { title: t('aiset.repliesTitle') })) && patchAi({ enabled: true })}>{t('aiset.turnAiOn')}</button>
              </Alert>
            )}
            {ai.autoReplyHeldByAgent && <p className="muted" style={{ fontSize: 13 }}>{t('aiset.heldByAgent')}</p>}
            <ul className="terms-list" aria-label={t('aiset.channelsTitle')}>
              <li>{t('aiset.chMeta')}: {ai.agentAuto ? t('aiset.chAutoAllowed') : t('aiset.chDrafts')}</li>
              {telegram && <li>{t('aiset.telegramNoAuto')}</li>}
            </ul>
          </>
        ) : (
          <>
            <p className="rule" style={{ marginTop: 0 }}>{t('aiset.repliesIntro')}</p>
            {legacy === 'off' && <Alert tone="warn">{t('aiset.legacyOff')}</Alert>}
            <ProHint feature="ai_autoreply" />
            <div role="radiogroup" aria-label={t('aiset.repliesTitle')}>
              {(['drafts', 'auto'] as const).map((k) => (
                <label key={k} className="check-row">
                  <input type="radio" name="ai-replies" checked={legacy === k} disabled={busy || !ai.available} onChange={() => chooseLegacy(k)} />
                  <span>
                    <b>{t(`aiset.${k}`)}</b>
                    <br />
                    <span className="muted">{t(`aiset.${k}Hint`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {!ai.sendingEnabled && <SendingOffNotice onOpen={onOpenGeneral} />}
        {ai.used >= ai.monthlyLimit && ai.purchased <= 0 && (
          <Alert tone="warn">
            {t('aiset.limitReached')}{' '}
            {onOpenBilling ? <button type="button" className="link-btn" onClick={onOpenBilling}>{t('aiset.toLimit')}</button> : null}
          </Alert>
        )}

        <div style={{ marginTop: 10 }}>
          <div className="toolbar">
            <label className="field" style={{ margin: 0 }}>
              <span>{t('ai.perChat')}</span>
              <input className="input" type="number" min={1} max={200} value={perChat} onChange={(e) => setPerChat(e.target.value)} style={{ width: 140 }} />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>{t('ai.pause')}</span>
              <input className="input" type="number" min={0} max={720} value={pause} onChange={(e) => setPause(e.target.value)} style={{ width: 140 }} />
            </label>
            <button className="btn" disabled={busy || perChat === '' || pause === '' || (Number(perChat) === ai.repliesPerChatDay && Number(pause) === ai.pauseMinutes)} onClick={() => patchAi({ repliesPerChatDay: Number(perChat), pauseMinutes: Number(pause) })}>{t('common.save')}</button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{t('ai.perChatHint')}</p>
        </div>

        {/* Booking in the conversation.
            Without the agent: once the patient chose a time, gave their details and confirmed, the visit is created by itself only where aiAutoBooking is on
            AND writing to Cliniccards is allowed (BookingService.autoModeFor); otherwise the administrator gets a request.
            With the agent the switch has no effect: every booking-flow step that reads it returns early in an agent clinic, and the agent creates a visit
            through BookingFlowService.bookApproved, which checks only the clinic's and the server's write switches. So it is not shown then (its saved value
            stays as it is). */}
        <section className="rule-card" style={{ marginTop: 12 }}>
          <b>{t('aiset.bookingTitle')}</b>
          {agent ? (
            <>
              <p className="rule" style={{ margin: '4px 0' }}>{ai.agentAuto ? t('aiset.agentBookingAuto') : t('aiset.agentBookingDrafts')}</p>
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('aiset.autoBookingAgent')}</p>
            </>
          ) : (
            <Switch checked={ai.autoBooking} disabled={busy || !ai.autoBookingSupported} label={t('ai.autoBooking')} hint={ai.autoBookingSupported ? t('ai.autoBookingHint') : t('ai.autoBookingUnsupported')} onChange={(on) => patchAi({ autoBooking: on })} />
          )}
          {ai.autoBookingTest?.restricted && <Alert tone="warn">{ai.autoBookingTest.dialogs > 0 ? t('ai.testOnly', { n: ai.autoBookingTest.dialogs }) : t('ai.testOnlyNone')}</Alert>}
        </section>
      </Card>

    </>
  );
}
