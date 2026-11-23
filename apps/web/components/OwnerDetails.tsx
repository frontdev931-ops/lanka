import type { Locale } from '../lib/i18n';
import { LANDING } from '../lib/landing-text';

// The service owner's legal name, shown in the footer of the landing and of the public pages (terms, privacy, data deletion) so that a
// reviewer (Meta) can match the site with the sole proprietor. The Latin name stays in every language: it is how the bank statement spells it.
// For now only the name is public (2026-11-23): no address, phone, tax number or bank details.
export const OWNER = {
  nameUk: 'ФОП Бойко Анастасія Сергіївна',
  nameLatin: 'BOIKO ANASTASIIA SERHIIVNA',
};

export function OwnerDetails({ lang, className }: { lang: Locale; className?: string }) {
  const o = LANDING[lang].footer.owner;
  return (
    <address className={`owner-details${className ? ` ${className}` : ''}`} aria-label={o.title}>
      <span><b>{o.title}</b> — {OWNER.nameUk}</span>
      <span>{OWNER.nameLatin}</span>
    </address>
  );
}
