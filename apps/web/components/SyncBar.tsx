'use client';

import { useT } from '../lib/i18n';
import type { SyncRun } from '../lib/sync';

const STAGE_KEYS = {
  patients: 'int.stage.patients',
  visits: 'int.stage.visits',
  treatment: 'int.stage.treatment',
  finance: 'int.stage.finance',
  schedule: 'int.stage.schedule',
  saving: 'int.stage.saving',
} as const;

// Полоса хода загрузки данных из Cliniccards: этап и процент
export function SyncBar({ run }: { run: SyncRun | null }) {
  const t = useT();
  if (!run || run.status !== 'RUNNING') return null;
  const label = run.stage && run.stage in STAGE_KEYS ? t(STAGE_KEYS[run.stage as keyof typeof STAGE_KEYS]) : t('int.stRunning');
  return (
    <div className="progress-box" role="progressbar" aria-valuenow={run.progress} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-head">
        <span>{label}</span>
        <b>{run.progress}%</b>
      </div>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${run.progress}%` }} />
      </div>
    </div>
  );
}
