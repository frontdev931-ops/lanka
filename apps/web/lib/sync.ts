import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export interface SyncRun {
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

// Starting the data load from Cliniccards in the background and following its progress. onDone is called when the load is finished.
export function useSync(onDone?: () => void) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const was = useRef(false);

  const refresh = useCallback(async () => {
    const runs = await api<SyncRun[]>('/integrations/cliniccards/runs');
    setRun(runs[0] ?? null);
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const running = run?.status === 'RUNNING';
  useEffect(() => {
    if (running) setStarting(false);
    if (was.current && !running) {
      doneRef.current?.();
      window.dispatchEvent(new Event('stomat:me-changed'));
    }
    was.current = running;
  }, [running]);

  // While a load is running (or only starting), the state refreshes by itself
  useEffect(() => {
    if (!running && !starting) return;
    const id = setInterval(() => refresh().catch(() => {}), 2000);
    // If the run record never appeared, we stop waiting
    const stop = starting ? setTimeout(() => setStarting(false), 15000) : undefined;
    return () => {
      clearInterval(id);
      if (stop) clearTimeout(stop);
    };
  }, [running, starting, refresh]);

  async function start() {
    setError('');
    setStarting(true);
    try {
      await api('/integrations/cliniccards/sync?background=1', { method: 'POST' });
      setTimeout(() => refresh().catch(() => {}), 800);
    } catch (e) {
      setStarting(false);
      setError((e as Error).message);
    }
  }

  return { run, running, busy: running || starting, error, start, refresh };
}
