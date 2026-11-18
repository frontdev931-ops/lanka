'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { Alert } from './ui';

export type ProFeature = 'ai_autoreply' | 'multi_channel' | 'advanced_analytics' | 'daily_digest' | 'ai_assistant' | 'patient_agent';

// One request for all the hints of a page (the plan's features: GET /service/usage, owner and manager; another role gets no hint)
let cached: Promise<string[] | null> | null = null;
const features = () => (cached ??= api<{ features: string[] }>('/service/usage').then((u) => u.features).catch(() => null));

// A note where the Start plan stops: what the Pro plan adds here and the way to the payment tab. Nothing is shown when the plan already has the feature.
export function ProHint({ feature }: { feature: ProFeature }) {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    features().then((f) => alive && setMissing(!!f && !f.includes(feature)));
    return () => {
      alive = false;
    };
  }, [feature]);
  if (!missing) return null;
  return (
    <Alert tone="info">
      {t(`pro.${feature}` as Key)} <a href="/settings?tab=billing">{t('pro.go')}</a>
    </Alert>
  );
}
