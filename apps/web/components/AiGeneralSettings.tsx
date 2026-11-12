'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';

interface AiStatus {
  available: boolean;
  monthlyLimit: number;
  used: number;
  assistant: boolean;
}

// The AI settings outside patients' conversations, each in one place:
//   - AiLimitCard (Settings → Payment): the monthly AI allowance (Clinic.aiMonthlyLimit), ONE budget for replies to patients and the manager's assistant
//     (AiService.complete counts both);
//   - AiGeneralSettings (Settings → General): the manager's assistant for questions about the clinic's data (aiAssistantEnabled).
function useAi() {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<AiStatus>('/ai')
      .then((a) => {
        setAi(a);
        setLimit(String(a.monthlyLimit));
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const patchAi = async (body: object) => {
    setBusy(true);
    setError('');
    try {
      await api('/ai', { method: 'PATCH', body: JSON.stringify(body) });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { ai, limit, setLimit, busy, error, patchAi };
}

export function AiLimitCard() {
  const { t } = useI18n();
  const { ai, limit, setLimit, busy, error, patchAi } = useAi();
  if (!ai) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
      <Card title={t('aig.title')}>
        {error && <Alert tone="error">{error}</Alert>}
        {!ai.available && <Alert tone="warn">{t('ai.notConfigured')}</Alert>}
        <p className="rule" style={{ marginTop: 0 }}>{t('aig.shared')}</p>
        <p>{t('ai.usage', { used: ai.used, limit: ai.monthlyLimit })}</p>
        <div className="toolbar">
          <label className="field" style={{ margin: 0 }}>
            <span>{t('ai.limit')}</span>
            <input className="input" type="number" min={0} max={100000} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 140 }} />
          </label>
          <button className="btn" disabled={busy || Number(limit) === ai.monthlyLimit || limit === ''} onClick={() => patchAi({ monthlyLimit: Number(limit) })}>{t('common.save')}</button>
        </div>
      </Card>
  );
}

export function AiGeneralSettings() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const { ai, busy, error, patchAi } = useAi();
  if (!ai) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <>
      {dialog}
      <Card title={t('as.cardTitle')} actions={<Badge tone={ai.assistant ? 'green' : 'gray'}>{ai.assistant ? t('ams.on') : t('ams.off')}</Badge>}>
        <Switch
          checked={ai.assistant}
          disabled={busy || !ai.available}
          label={t('as.label')}
          hint={t('as.hint')}
          onChange={async (on) => {
            if (on && !(await ask(t('as.confirm'), { title: t('as.cardTitle'), confirmLabel: t('as.yes') }))) return;
            patchAi({ assistant: on });
          }}
        />
        {error && <Alert tone="error">{error}</Alert>}
        {ai.assistant && <Link href="/assistant">{t('as.open')}</Link>}
      </Card>
    </>
  );
}
