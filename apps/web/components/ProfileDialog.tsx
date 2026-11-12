'use client';

import { useEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';
import { ProfileCard } from './ProfileCard';
import { Icon } from './ui';

// "My profile" in a dialog, opened from the person's name in the side panel: the same name, email and password forms as before in Settings
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      back?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2 id="profile-title">{t('prof.title')}</h2>
          <button ref={closeRef} type="button" className="btn btn-sm modal-close" onClick={onClose} aria-label={t('prof.close')}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <ProfileCard bare />
      </div>
    </div>
  );
}
