'use client';

import { useEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';
import { Platform, PushState, usePushDevice } from '../lib/push-device';
import { Alert, Badge, Card } from './ui';
import { Switch } from './Switch';

const INSTALL: Record<Platform, string> = {
  ios: 'pushd.installIos',
  android: 'pushd.installAndroid',
  desktop_chromium: 'pushd.installChromium',
  desktop_safari: 'pushd.installSafari',
  desktop_firefox: 'pushd.installFirefox',
  other: 'pushd.installOther',
};
const DENIED: Record<Platform, string> = {
  ios: 'pushd.deniedIos',
  android: 'pushd.deniedAndroid',
  desktop_chromium: 'pushd.deniedDesktop',
  desktop_safari: 'pushd.deniedDesktop',
  desktop_firefox: 'pushd.deniedDesktop',
  other: 'pushd.deniedDesktop',
};
const BADGE: Record<PushState, { tone: 'green' | 'gray' | 'amber'; key: string }> = {
  loading: { tone: 'gray', key: 'pushd.badgeOff' },
  server_off: { tone: 'gray', key: 'pushd.badgeOff' },
  browser: { tone: 'gray', key: 'pushd.badgeBrowser' },
  unsupported: { tone: 'gray', key: 'pushd.badgeOff' },
  off: { tone: 'gray', key: 'pushd.badgeOff' },
  denied: { tone: 'amber', key: 'pushd.badgeDenied' },
  granted_no_server: { tone: 'amber', key: 'pushd.badgeOff' },
  on: { tone: 'green', key: 'pushd.badgeOn' },
  error: { tone: 'amber', key: 'pushd.badgeError' },
};

// Settings → General → "Push notifications" (#push): the switch of THIS device only (another phone or computer is not changed), with every state
// told apart. The list says exactly which events send Push today.
export function PushDeviceCard() {
  const { t, locale } = useI18n();
  const d = usePushDevice(locale);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (d.state !== 'loading' && window.location.hash === '#push') ref.current?.scrollIntoView({ block: 'start' });
  }, [d.state]);
  const tk = t as (k: string, v?: Record<string, string | number>) => string;
  const on = d.state === 'on';
  // the switch can act in these states; elsewhere the state's own explanation says what to do
  const actionable = d.state === 'on' || d.state === 'off' || d.state === 'granted_no_server' || d.state === 'error';
  return (
    <div id="push" ref={ref} style={{ scrollMarginTop: 80 }}>
      <Card title={t('pushd.title')} actions={<Badge tone={BADGE[d.state].tone}>{tk(BADGE[d.state].key)}</Badge>}>
        <p className="rule" style={{ marginTop: 0 }}>{t('pushd.intro')}</p>
        {d.state === 'loading' && <p className="muted">…</p>}
        {d.state === 'server_off' && <Alert tone="info">{t('pushd.serverOff')}</Alert>}
        {d.state === 'browser' && (
          <Alert tone="info">
            <b>{t('pushd.browser')}</b>
            <br />
            {tk(INSTALL[d.platform])}
          </Alert>
        )}
        {d.state === 'unsupported' && <Alert tone="warn">{d.platform === 'ios' ? t('pushd.unsupportedIos') : t('pushd.unsupported')}</Alert>}
        {d.state === 'denied' && (
          <Alert tone="warn">
            <b>{t('pushd.denied')}</b>
            <br />
            {tk(DENIED[d.platform])}
          </Alert>
        )}
        {d.state === 'granted_no_server' && <Alert tone="info">{d.reconfirm ? t('pushd.reconfirm') : t('pushd.grantedNoServer')}</Alert>}
        {d.state === 'error' && (
          <Alert tone="error">
            {t('pushd.error')} {d.error && <span className="muted">({d.error})</span>}{' '}
            <button className="btn btn-sm" disabled={d.busy} onClick={() => void d.retry()}>{t('sig.retry')}</button>
          </Alert>
        )}
        {actionable && (
          <Switch
            checked={on}
            disabled={d.busy}
            onChange={(v) => void (v ? d.enable() : d.disable())}
            label={t('pushd.switch')}
            hint={t('pushd.switchHint')}
          />
        )}
        {d.state === 'on' && d.note === 'off_failed' && (
          <Alert tone="error">
            {t('pushd.offFailed')} <button className="btn btn-sm" disabled={d.busy} onClick={() => void d.disable()}>{t('sig.retry')}</button>
          </Alert>
        )}
        {d.state === 'on' && d.error && d.note !== 'off_failed' && <Alert tone="error">{d.error}</Alert>}
        {d.note === 'off_ok' && <Alert tone="success">{t('pushd.offOk')}</Alert>}
        {d.note === 'browser_kept' && <Alert tone="success">{t('pushd.offOkBrowserKept')}</Alert>}
        {d.note === 'test_sent' && <Alert tone="success">{t('pushd.testSent')}</Alert>}
        {d.note === 'test_failed' && <Alert tone="warn">{t('pushd.testFailed')}</Alert>}
        {on && (
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" disabled={d.busy} onClick={() => void d.test()}>{t('pushd.test')}</button>
          </div>
        )}
        <div className="rule-card" style={{ marginTop: 12 }}>
          <b style={{ fontSize: 14 }}>{t('pushd.whatTitle')}</b>
          <ul className="rule" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            <li>{t('pushd.whatRequests')}</li>
            <li>{t('pushd.whatLeads')}</li>
            <li>{t('pushd.whatSignals')}</li>
          </ul>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 13 }}>{t('pushd.privacy')}</p>
        </div>
      </Card>
    </div>
  );
}
