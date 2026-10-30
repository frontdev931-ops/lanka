'use client';

import { PublicPage } from '../../components/PublicPage';
import { useT } from '../../lib/i18n';

const SECTIONS = ['who', 'what', 'why', 'who2', 'meta', 'store', 'rights', 'delete'] as const;

export default function PrivacyPage() {
  const t = useT();
  const contact = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'hello@lankaclinic.app';
  return (
    <PublicPage title={t('public.privacy')}>
      <p className="muted">{t('privacy.date')}</p>
      {SECTIONS.map((k) => (
        <section key={k}>
          <h2 style={{ fontSize: 18, margin: '18px 0 6px' }}>{t(`privacy.${k}.h` as 'privacy.who.h')}</h2>
          <p>{t(`privacy.${k}.t` as 'privacy.who.t')}</p>
        </section>
      ))}
      {contact && <p>{t('privacy.contact')}: <a href={`mailto:${contact}`}>{contact}</a></p>}
    </PublicPage>
  );
}
