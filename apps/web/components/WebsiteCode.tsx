'use client';

import { useState } from 'react';
import { useI18n } from '../lib/i18n';

export interface WebsiteRequest {
  id: string;
  websiteOrigin: string;
  createdAt: string;
  installedAt: string | null;
  handledAt: string | null;
}

export function WebsiteCode({ code, page }: { code: string; page: string }) {
  const { t } = useI18n();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | null>(null);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('copyFailed');
    }
  }

  return (
    <>
      <p style={{ margin: '8px 0' }}>{t('ld.passCode')}</p>
      <pre className="code-sample" tabIndex={0} aria-label={t('ld.installCode')}><code>{code}</code></pre>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="btn btn-primary" onClick={copyCode}>{t('ld.copyCode')}</button>
        {copyStatus && <span className="muted" role="status">{t(`ld.${copyStatus}`)}</span>}
      </div>
      <p className="muted" style={{ margin: '8px 0 0', overflowWrap: 'anywhere' }}>
        {t(new URL(page).pathname === '/' ? 'ld.elementorHome' : 'ld.elementorPage', { page })}
      </p>
    </>
  );
}
