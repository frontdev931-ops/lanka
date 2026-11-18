'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { Loading, PageHeader } from '../../../components/ui';
import { AiSettings } from '../../../components/AiSettings';

// "AI administrator" → "Reply mode": how patients' messages are answered, per channel (it was the "Replies to patients" tab of Settings; /settings?tab=replies
// and ?tab=ai lead here). Owner and manager only; the others are sent to the clinic knowledge, the tab they may open.
export default function AiAdminModePage() {
  const { t } = useI18n();
  const router = useRouter();
  const [me, setMe] = useState<{ role: string; billing?: { demo: boolean } } | null>(null);
  useEffect(() => {
    api<{ role: string; billing?: { demo: boolean } }>('/auth/me')
      .then((m) => {
        if (m.role !== 'OWNER' && m.role !== 'MANAGER') router.replace('/knowledge');
        else setMe(m);
      })
      .catch(() => undefined);
  }, [router]);
  if (!me) return <Loading />;
  return (
    <>
      <PageHeader title={t('aiadm.modeTitle')} subtitle={t('set.sub.replies')} />
      <AiSettings isOwner={me.role === 'OWNER'} onOpenGeneral={() => router.push('/settings')} onOpenBilling={me.billing?.demo ? undefined : () => router.push('/settings?tab=billing')} />
    </>
  );
}
