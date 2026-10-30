'use client';

import { PublicPage } from '../../components/PublicPage';
import { TermsText } from '../../components/Terms';
import { useT } from '../../lib/i18n';

export default function TermsPage() {
  const t = useT();
  return (
    <PublicPage title={t('public.terms')}>
      <TermsText />
    </PublicPage>
  );
}
