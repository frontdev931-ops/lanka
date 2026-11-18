'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { BillingPaymentStatus, type BillingCheckout } from './BillingPaymentStatus';
import { useConfirm } from './ConfirmDialog';
import { Alert, Card } from './ui';

const PATH = '/platform/mono-diagnostic';

interface DiagnosticSettings {
  enabled: boolean;
  configured: boolean;
  paymentId: string | null;
}

export function PlatformMonoDiagnostic() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [settings, setSettings] = useState<DiagnosticSettings | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPaymentId(new URLSearchParams(window.location.search).get('diagnosticPayment'));
    api<DiagnosticSettings>(PATH).then(setSettings).catch((e) => setError((e as Error).message));
  }, []);

  async function checkout() {
    setBusy(true);
    setError('');
    try {
      if (!(await ask(t('pf.monoRealCharge'), { title: t('pf.monoDiagnostic'), confirmLabel: t('billing.pay') }))) return;
      const payment = await api<BillingCheckout>(`${PATH}/checkout`, { method: 'POST' });
      if (payment.url) window.location.assign(payment.url);
      else setPaymentId(payment.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tracked = paymentId ?? settings?.paymentId;
  if (!settings) return error ? <Alert tone="error">{error}</Alert> : null;
  if (!settings.enabled && !tracked) return null;
  return (
    <Card title={t('pf.monoDiagnostic')}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {tracked && <BillingPaymentStatus key={tracked} path={`${PATH}/${encodeURIComponent(tracked)}`} />}
      {settings.enabled && (
        <>
          <p>{t('pf.monoRealCharge')}</p>
          {!settings.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
          <button className="btn btn-primary" disabled={busy || !settings.configured} onClick={checkout}>{t('pf.monoCheck')}</button>
        </>
      )}
    </Card>
  );
}
