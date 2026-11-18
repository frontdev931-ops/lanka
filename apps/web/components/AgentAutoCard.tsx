'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';

type Prerequisite = 'plan' | 'billing' | 'ai' | 'sending' | 'channel' | 'schedule' | 'services';
export interface AgentStatus {
  inPlan: boolean;
  prerequisites: { key: Prerequisite; met: boolean }[];
  ready: boolean;
  active: boolean;
  paused: boolean;
  testMode: boolean;
  services: { id: string; title: string }[];
  serviceIds: string[];
  availableServices: { id: string; title: string }[];
  maxServices: number;
}

// where each missing step is fixed (no link: it is fixed on this page)
const FIX: Partial<Record<Prerequisite, string>> = {
  plan: '/settings?tab=billing',
  billing: '/settings?tab=billing',
  sending: '/settings',
  channel: '/settings?tab=channels',
  schedule: '/ai-admin/booking',
};

// "AI administrator" → "Reply mode": the clinic's own switch of the autonomous patient agent (GET/POST /ai/agent). Three things are shown apart: the plan
// includes it (Pro), the clinic finished the setup (the list of steps, each with the place to fix it), the owner switched it on. The owner chooses the
// services (at most `maxServices`, approved ones only) and switches the agent on or off; a manager sees the same read-only. Paying for Pro switches
// nothing on. The server checks everything again on every action of the agent.
export function AgentAutoCard({ canEdit, onChanged }: { canEdit: boolean; onChanged?: (s: AgentStatus) => void }) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [st, setSt] = useState<AgentStatus | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = useCallback(
    (s: AgentStatus) => {
      setSt(s);
      setPicked(s.serviceIds.filter((id) => s.availableServices.some((a) => a.id === id)));
      onChanged?.(s);
    },
    [onChanged],
  );
  useEffect(() => {
    api<AgentStatus>('/ai/agent').then(apply).catch((e) => setError((e as Error).message));
  }, [apply]);

  const call = async (path: string, method: 'POST' | 'PUT', body?: object) => {
    setBusy(true);
    setError('');
    try {
      apply(await api<AgentStatus>(path, { method, body: body ? JSON.stringify(body) : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return error ? <Alert tone="error">{error}</Alert> : null;
  const saved = st.serviceIds.filter((id) => st.availableServices.some((a) => a.id === id));
  const dirty = picked.length !== saved.length || picked.some((id) => !saved.includes(id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < st.maxServices ? [...p, id] : p));
  const badge: { tone: 'green' | 'gray' | 'amber'; text: Key } = !st.inPlan && !st.active ? { tone: 'gray', text: 'ag.badge.pro' } : st.paused ? { tone: 'amber', text: 'ag.badge.paused' } : st.active ? { tone: 'green', text: 'ag.badge.on' } : { tone: 'gray', text: 'ag.badge.off' };
  // on Start only the offer is shown, unless the agent was left switched on (then the owner must see why it is silent and be able to switch it off)
  const offerOnly = !st.inPlan && !st.active;

  return (
    <Card title={t('ag.title')} actions={<Badge tone={badge.tone}>{t(badge.text)}</Badge>}>
      {dialog}
      <p className="rule" style={{ marginTop: 0 }}>{t('ag.intro')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      {offerOnly ? (
        <Alert tone="info">
          {t('ag.notInPlan')} <Link href="/settings?tab=billing">{t('pro.go')}</Link>
        </Alert>
      ) : (
        <>
          {st.paused && <Alert tone="warn">{t('ag.paused')}</Alert>}
          {st.testMode && <Alert tone="info">{t('ag.testMode')}</Alert>}

          <b>{t('ag.steps')}</b>
          <ul className="agent-steps">
            {st.prerequisites.map((p) => (
              <li key={p.key} className={p.met ? 'met' : 'missing'}>
                <span className="agent-step-mark" aria-hidden="true">{p.met ? '✓' : '!'}</span>
                <span>
                  <span className="sr-only">{p.met ? t('ag.met') : t('ag.missing')}: </span>
                  {t(`ag.pre.${p.key}` as Key)}
                  {!p.met && (
                    <>
                      {' '}
                      <span className="muted">{t(`ag.fix.${p.key}` as Key)}</span>
                      {FIX[p.key] && (
                        <>
                          {' '}
                          <Link href={FIX[p.key]!}>{t('ag.open')}</Link>
                        </>
                      )}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <section className="rule-card" style={{ marginTop: 12 }}>
            <b>{t('ag.services', { n: st.maxServices })}</b>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>{t('ag.servicesHint')}</p>
            {st.availableServices.length === 0 ? (
              <Alert tone="warn">
                {t('ag.noServices')} <Link href="/knowledge">{t('ag.toKnowledge')}</Link>
              </Alert>
            ) : canEdit ? (
              <>
                {st.availableServices.map((s) => (
                  <label key={s.id} className="check-row">
                    <input type="checkbox" checked={picked.includes(s.id)} disabled={busy || (!picked.includes(s.id) && picked.length >= st.maxServices)} onChange={() => toggle(s.id)} />
                    <span>{s.title}</span>
                  </label>
                ))}
                <div className="toolbar">
                  <button type="button" className="btn" disabled={busy || !dirty} onClick={() => call('/ai/agent/services', 'PUT', { ids: picked })}>{t('ag.saveServices')}</button>
                  <span className="muted" style={{ fontSize: 13 }}>{t('ag.picked', { n: picked.length, max: st.maxServices })}</span>
                </div>
              </>
            ) : st.services.length ? (
              <ul className="terms-list" style={{ marginTop: 8 }}>
                {st.services.map((s) => (
                  <li key={s.id}>{s.title}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('ag.noneChosen')}</p>
            )}
          </section>

          {canEdit ? (
            <Switch
              checked={st.active}
              disabled={busy || dirty || (!st.active && !st.ready)}
              label={t('ag.switch')}
              hint={!st.active && !st.ready ? t('ag.switchNotReady') : dirty ? t('ag.switchSaveFirst') : t('ag.switchHint')}
              onChange={async (on) => {
                if (!(await ask(t(on ? 'ag.confirmOn' : 'ag.confirmOff'), { title: t('ag.title'), confirmLabel: t(on ? 'ag.yesOn' : 'ag.yesOff') }))) return;
                call(on ? '/ai/agent/activate' : '/ai/agent/deactivate', 'POST');
              }}
            />
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>{t('ag.ownerOnly')}</p>
          )}
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>{t('ag.limits')}</p>
        </>
      )}
    </Card>
  );
}
