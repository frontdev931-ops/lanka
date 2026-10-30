'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { Modal } from './Terms';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// The "Install the app" button. Chrome and Android give a system install dialog; iPhone (Safari) does not, so we show a hint instead.
export function InstallApp() {
  const { t } = useI18n();
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [help, setHelp] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || (!event && !ios)) return null;
  return (
    <>
      <button
        className="btn btn-sm"
        onClick={async () => {
          if (event) {
            await event.prompt();
            await event.userChoice;
            setEvent(null);
          } else setHelp(true);
        }}
      >
        {t('pwa.install')}
      </button>
      {help && (
        <Modal title={t('pwa.installTitle')} onClose={() => setHelp(false)}>
          <p>{t('pwa.iosHelp')}</p>
        </Modal>
      )}
    </>
  );
}
