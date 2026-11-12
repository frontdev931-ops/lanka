'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../../lib/api';
import { useI18n } from '../../../../lib/i18n';
import { Loading, PageHeader } from '../../../../components/ui';
import { BookingSettings } from '../../../../components/BookingSettings';

// "AI administrator" → "Booking": the schedule rules used when a visit is booked from a conversation (it was under "Replies to patients" in Settings).
// Owner and manager only.
export default function AiAdminBookingPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((m) => {
        if (m.role !== 'OWNER' && m.role !== 'MANAGER') router.replace('/knowledge');
        else setOk(true);
      })
      .catch(() => undefined);
  }, [router]);
  if (!ok) return <Loading />;
  return (
    <>
      <PageHeader title={t('aiadm.bookingTitle')} subtitle={t('aiadm.bookingSub')} />
      <p className="rule">{t('aiadm.hoursNote')} <a href="/settings">{t('aiadm.hoursLink')}</a></p>
      <BookingSettings />
    </>
  );
}
