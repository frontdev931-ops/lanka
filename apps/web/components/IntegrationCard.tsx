'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { Alert, Badge, Card, Empty, Icon } from './ui';
import { SyncBar } from './SyncBar';

interface Run {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'RUNNING' | 'OK' | 'FAILED';
  patients: number;
  visits: number;
  progress: number;
  stage: string | null;
  error: string | null;
}

interface Status {
  mode: 'demo' | 'cliniccards';
  lastSyncAt: string | null;
  lastRun: { status: string; error: string | null; errorKind?: 'network' | 'interrupted' | 'access' | 'other' | null } | null;
  // the daily automatic load: enabled only when the server runs it and the clinic has a key
  autoSync?: { enabled: boolean; hour: number; timeZone: string; nextAt: string | null };
}

// Settings → General: the clinic's data source (the Cliniccards key, loading the data and the history of loads); it was the separate "Integrations" page
export function IntegrationCard() {
  const t = useT();
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingKey, setEditingKey] = useState(false);

  const load = useCallback(() => {
    api<Run[]>('/integrations/cliniccards/runs').then(setRuns).catch((e) => setError(e.message));
    api<Status>('/integrations/cliniccards').then(setStatus).catch(() => {});
  }, []);
  useEffect(load, [load]);

  // While a load is running, the table refreshes by itself
  const running = runs[0]?.status === 'RUNNING';
  // When the load is finished, we also refresh the side panel (the clinic's logo)
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) window.dispatchEvent(new Event('stomat:me-changed'));
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [running, load]);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      await api('/integrations/cliniccards/key', { method: 'PUT', body: JSON.stringify({ apiKey, sync: true }) });
      setApiKey('');
      setEditingKey(false);
      load();
      // the run record appears right after the answer; we refresh once more and keep watching it
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    setError('');
    try {
      await api('/integrations/cliniccards/sync?background=1', { method: 'POST' });
      load();
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
      load();
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.mode === 'cliniccards';
  const loaded = !!status?.lastSyncAt;
  const failed = status?.lastRun?.status === 'FAILED';
  const showKeyField = !connected || editingKey;
  const state: { tone: 'green' | 'amber' | 'red' | 'blue'; label: string } = !connected
    ? { tone: 'amber', label: t('int.demo') }
    : running
      ? { tone: 'blue', label: t('int.stRunning') }
      : failed && !loaded
        ? { tone: 'red', label: t('int.stFailed') }
        : !loaded
          ? { tone: 'amber', label: t('int.stNotLoaded') }
          : { tone: 'green', label: t('int.connected') };
  const firstLoad = connected && !loaded && !running;
  const runTone = (s: Run['status']) => (s === 'OK' ? 'green' : s === 'FAILED' ? 'red' : 'blue');
  const runLabel = (s: Run['status']) => (s === 'OK' ? t('int.ok') : s === 'FAILED' ? t('int.failed') : t('int.running'));

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {/* a readable sentence; the exact message of the clinic's system stays in the history below */}
      {status?.lastRun?.status === 'FAILED' && !running && <Alert tone="warn">{t(`int.err.${status.lastRun.errorKind ?? 'other'}`)}</Alert>}

      <Card
        title={t('int.cardTitle')}
        actions={
          <>
            <Badge tone={state.tone}>{state.label}</Badge>
            {connected && (
              <button className={firstLoad ? 'btn btn-primary' : 'btn'} onClick={sync} disabled={busy || running}>
                <Icon name="refresh" size={16} /> {busy ? t('common.wait') : firstLoad ? t('int.loadData') : t('int.sync')}
              </button>
            )}
          </>
        }
      >
        <p className="rule" style={{ marginTop: 0 }}>{t('int.subtitle')}</p>
        <p className="rule">
          {!connected ? t('int.textDemo') : running ? t('int.runningHint') : !loaded ? t('int.notLoadedHint') : t('int.textConnected')}
        </p>
        {connected && (
          <ul className="terms-list" aria-label={t('int.autoTitle')}>
            <li>
              {status?.autoSync?.enabled
                ? t('int.autoOn', { time: `${String(status.autoSync.hour).padStart(2, '0')}:00`, zone: status.autoSync.timeZone === 'Europe/Kyiv' ? t('int.tzKyiv') : status.autoSync.timeZone })
                : t('int.autoOff')}
              {status?.autoSync?.enabled && status.autoSync.nextAt ? ` ${t('int.autoNext', { date: fmtDateTime(status.autoSync.nextAt) })}` : ''}
            </li>
            <li>{status?.lastSyncAt ? t('int.lastOkLine', { date: fmtDateTime(status.lastSyncAt) }) : t('int.neverOk')}</li>
            <li>{t('int.freshChecks')}</li>
          </ul>
        )}
        <SyncBar run={runs[0] ?? null} />
        {showKeyField ? (
          <div className="toolbar">
            <input
              className="input grow"
              type="password"
              placeholder={t('int.keyPlaceholder')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              aria-label={t('int.keyPlaceholder')}
            />
            <button className="btn btn-primary" onClick={connect} disabled={busy || apiKey.length < 8}>
              {connected ? t('int.replaceKey') : t('int.connect')}
            </button>
            {connected && (
              <button className="btn" onClick={() => { setEditingKey(false); setApiKey(''); }}>{t('int.cancel')}</button>
            )}
          </div>
        ) : (
          <div className="toolbar">
            <span className="grow">{t('int.keySaved')}</span>
            <button className="btn" onClick={() => setEditingKey(true)}>{t('int.changeKey')}</button>
          </div>
        )}
        <p className="rule" style={{ margin: '10px 0 0' }}>
          {t('int.keyHint')}
        </p>
        <details className="more-details" style={{ marginTop: 12 }}>
          <summary>{t('int.history')}</summary>
        {runs.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('int.colRun')}</th><th>{t('int.colResult')}</th><th className="num">{t('int.colPatients')}</th>
                  <th className="num">{t('int.colVisits')}</th><th>{t('int.colMessage')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.startedAt)}</td>
                    <td><Badge tone={runTone(r.status)}>{runLabel(r.status)}</Badge></td>
                    <td className="num">{r.patients}</td>
                    <td className="num">{r.visits}</td>
                    <td>{r.error ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t('int.noRuns')}>{t('int.noRunsHint')}</Empty>
        )}
        </details>
      </Card>
    </>
  );
}
