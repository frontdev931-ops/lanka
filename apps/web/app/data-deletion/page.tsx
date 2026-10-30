'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PublicPage } from '../../components/PublicPage';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

interface Status {
  status: 'DELETED' | 'DEAUTHORIZED';
  createdAt: string;
  summary: { disconnected?: number; messages?: number; chatLinks?: number; requests?: number };
}

function Body() {
  const t = useT();
  const code = useSearchParams().get('code') ?? '';
  const [s, setS] = useState<Status | null | 'none'>(null);
  useEffect(() => {
    if (!code) return setS('none');
    api<Status>(`/meta/data-deletion/status/${encodeURIComponent(code)}`).then(setS).catch(() => setS('none'));
  }, [code]);
  return (
    <PublicPage title={t('deletion.title')}>
      <p>{t('deletion.intro')}</p>
      {s === null && <p className="muted">{t('common.loading')}</p>}
      {s === 'none' && <p>{code ? t('deletion.notFound') : t('deletion.noCode')}</p>}
      {s && s !== 'none' && (
        <>
          <p><b>{t('deletion.code')}:</b> {code}</p>
          <p><b>{t('deletion.status')}:</b> {s.status === 'DELETED' ? t('deletion.done') : t('deletion.revoked')} ({new Date(s.createdAt).toLocaleString()})</p>
          <ul>
            <li>{t('deletion.accounts')}: {s.summary.disconnected ?? 0}</li>
            <li>{t('deletion.messages')}: {s.summary.messages ?? 0}</li>
            <li>{t('deletion.links')}: {s.summary.chatLinks ?? 0}</li>
            <li>{t('deletion.requests')}: {s.summary.requests ?? 0}</li>
          </ul>
        </>
      )}
    </PublicPage>
  );
}

export default function DataDeletionPage() {
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}
