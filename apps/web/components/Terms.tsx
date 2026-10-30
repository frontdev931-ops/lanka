'use client';

import { ReactNode, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { TERMS_VERSION } from '../lib/terms';
import { Alert } from './ui';

const POINTS = ['terms.p1', 'terms.p2', 'terms.p3', 'terms.p4', 'terms.p5', 'terms.p6', 'terms.p7', 'terms.p8', 'terms.p9', 'terms.p10', 'terms.p11', 'terms.p12'] as const;

// Окно поверх страницы; закрывается кнопкой (если onClose передан)
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h2>{title}</h2>
        {children}
        {onClose && <div className="modal-actions"><button className="btn" onClick={onClose}>OK</button></div>}
      </div>
    </div>
  );
}

export function TermsText() {
  const t = useT();
  return (
    <ol className="terms-list">
      {POINTS.map((k) => (
        <li key={k}>{t(k)}</li>
      ))}
    </ol>
  );
}

// Просмотр текста при регистрации (без принятия: чекбокс на самой форме)
export function TermsViewer({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t('terms.title')} onClose={onClose}>
      <TermsText />
    </Modal>
  );
}

// Окно для владельца клиники, созданной до появления соглашения (или после смены версии): пока не принято, работать нельзя
export function AcceptTermsGate({ onAccepted }: { onAccepted: () => void }) {
  const t = useT();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function accept() {
    setBusy(true);
    setError('');
    try {
      await api('/clinic/terms', { method: 'PUT', body: JSON.stringify({ version: TERMS_VERSION }) });
      onAccepted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('terms.title')}>
      <p className="rule">{t('terms.gateIntro')}</p>
      <TermsText />
      {error && <Alert tone="error">{error}</Alert>}
      <label className="check-row">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {t('terms.accept')}
      </label>
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={!checked || busy} onClick={accept}>{busy ? t('common.wait') : t('terms.acceptBtn')}</button>
      </div>
    </Modal>
  );
}
