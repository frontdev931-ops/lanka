'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, PageHeader } from '../../../components/ui';
import { SyncBar } from '../../../components/SyncBar';

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
  lastRun: { status: string; error: string | null } | null;
}

export default function IntegrationsPage() {
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

  // Пока идёт загрузка, таблица обновляется сама
  const running = runs[0]?.status === 'RUNNING';
  // Когда загрузка закончилась, обновляем и боковую панель (логотип клиники)
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
      // запись о запуске появляется сразу после ответа; ещё раз обновляем и дальше следим за ней
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
      <PageHeader title={t('int.title')} subtitle={t('int.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {status?.lastRun?.status === 'FAILED' && (
        <Alert tone="warn">{t('int.lastFailed', { error: status.lastRun.error ?? t('int.unknownError') })}</Alert>
      )}

      <Card
        title="Cliniccards"
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
        <p className="rule">
          {!connected ? t('int.textDemo') : running ? t('int.runningHint') : !loaded ? t('int.notLoadedHint') : t('int.textConnected')}
        </p>
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
          {status?.lastSyncAt && t('int.lastOk', { date: fmtDateTime(status.lastSyncAt) })}
        </p>
      </Card>

      <Card flush title={t('int.history')}>
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
      </Card>
    </>
  );
}
