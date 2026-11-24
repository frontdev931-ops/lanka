'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import LanguageSwitcher from './LanguageSwitcher';
import { Brand } from './Brand';
import { OwnerDetails } from './OwnerDetails';

// A plain public page (terms, privacy, data deletion status): the brand, the language and readable text
export function PublicPage({ title, children }: { title: string; children: ReactNode }) {
  const { t, locale } = useI18n();
  return (
    <div className="land">
      <header className="land-head">
        <Link href="/" className="brand land-brand"><Brand /></Link>
        <div className="land-head-right">
          <LanguageSwitcher compact />
          <Link href="/login" className="btn btn-sm">{t('landing.login')}</Link>
        </div>
      </header>
      <main className="land-section" style={{ maxWidth: 820, margin: '0 auto', padding: '44px 16px' }}>
        <h1 style={{ marginBottom: 16 }}>{title}</h1>
        <div className="public-text">{children}</div>
      </main>
      <footer className="land-foot">
        <OwnerDetails lang={locale} className="public-owner" />
        <Link href="/terms">{t('public.terms')}</Link> · <Link href="/privacy">{t('public.privacy')}</Link> · <a href="mailto:hello@lankaclinic.app">hello@lankaclinic.app</a>
      </footer>
    </div>
  );
}
