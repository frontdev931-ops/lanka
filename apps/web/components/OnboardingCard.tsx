'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { Card } from './ui';

interface Step {
  key: string;
  done: boolean;
  required: boolean;
  link: string;
}

// Home page: the setup path after the payment (GET /onboarding; owner and manager, the server decides who gets it). Each step says whether it is done
// and opens the place where it is done. Shown while a required step is open; then the owner may hide it (per browser). Nothing is switched on here.
const HIDE_KEY = 'stomat_onboarding_hidden';

export function OnboardingCard() {
  const { t } = useI18n();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [complete, setComplete] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDE_KEY) === '1');
    } catch {
      // no storage: the card simply stays
    }
    api<{ steps: Step[]; complete: boolean }>('/onboarding')
      .then((r) => {
        setSteps(r.steps);
        setComplete(r.complete);
      })
      .catch(() => setSteps(null));
  }, []);
  if (!steps || (complete && hidden) || steps.every((s) => s.done)) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <Card
      title={t('ob.title')}
      actions={
        complete ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setHidden(true);
              try {
                window.localStorage.setItem(HIDE_KEY, '1');
              } catch {
                // nothing to remember
              }
            }}
          >
            {t('ob.hide')}
          </button>
        ) : undefined
      }
    >
      <p className="rule" style={{ marginTop: 0 }}>{t('ob.intro', { done, total: steps.length })}</p>
      <ul className="agent-steps">
        {steps.map((s) => (
          <li key={s.key} className={s.done ? 'met' : 'missing'}>
            <span className="agent-step-mark" aria-hidden="true">{s.done ? '✓' : s.required ? '!' : '·'}</span>
            <span>
              <span className="sr-only">{s.done ? t('ag.met') : t('ag.missing')}: </span>
              {t(`ob.${s.key}` as Key)}
              {!s.required && <span className="muted"> {t('ob.optional')}</span>}
              {!s.done && (
                <>
                  {' '}
                  <Link href={s.link}>{t('ag.open')}</Link>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
