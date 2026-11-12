'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Alert, Badge, Card } from './ui';
import { Switch } from './Switch';
import { useConfirm } from './ConfirmDialog';

// Settings → General: the clinic's one switch for everything that goes to patients (Clinic.sendingEnabled): automatic messages and campaigns, AI replies,
// booking messages, the waitlist and staff replies in the inbox. The other sections show only a notice with a way here.
export function SendingSettings() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ settings: { sendingEnabled: boolean } }>('/automations').then((o) => setOn(o.settings.sendingEnabled)).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  if (on === null) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <Card title={t('snd.title')} actions={<Badge tone={on ? 'green' : 'gray'}>{on ? t('ams.sendingOnBadge') : t('ams.sendingOffBadge')}</Badge>}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('snd.scope')}</p>
      <Switch
        checked={on}
        disabled={busy}
        label={t('ams.sendingLabel')}
        hint={on ? t('ams.sendingOnHint') : t('ams.sendingOffHint')}
        onChange={async (next) => {
          if (next && !(await ask(t('mode.confirm.staff'), { title: t('ams.sendingLabel') }))) return;
          setBusy(true);
          setError('');
          try {
            await api('/automations/settings', { method: 'PATCH', body: JSON.stringify({ sendingEnabled: next }) });
            load();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </Card>
  );
}

// The short notice of the other sections while sending is off (the switch itself is only in General)
export function SendingOffNotice({ onOpen }: { onOpen?: () => void }) {
  const { t } = useI18n();
  return (
    <Alert tone="warn">
      {t('snd.offNotice')} {onOpen ? <button type="button" className="link-btn" onClick={onOpen}>{t('snd.toGeneral')}</button> : <a href="/settings">{t('snd.toGeneral')}</a>}
    </Alert>
  );
}
