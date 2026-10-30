'use client';

import { useI18n } from '../lib/i18n';
import { Badge, Card, PageHeader } from './ui';

type Section = 'assistant' | 'automations' | 'inbox' | 'booking' | 'quality' | 'analytics';

export default function Placeholder({ ns, stage }: { ns: Section; stage: string }) {
  const { t, tl } = useI18n();
  return (
    <>
      <PageHeader
        title={t(`ph.${ns}.title` as const)}
        subtitle={t(`ph.${ns}.desc` as const)}
        actions={<Badge tone="amber">{t('common.soon')}</Badge>}
      />
      <Card title={t('ph.what')}>
        <div className="soon">
          <ul>
            {tl(`ph.${ns}.items` as const).map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
          <span className="muted">{t('ph.stage', { stage })}</span>
        </div>
      </Card>
    </>
  );
}
