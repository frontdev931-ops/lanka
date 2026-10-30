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

// Запуск загрузки данных из Cliniccards в фоне и слежение за ходом. onDone вызывается, когда загрузка закончилась.
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

  // Пока идёт загрузка (или она только запускается), состояние обновляется само
  useEffect(() => {
    if (!running && !starting) return;
    const id = setInterval(() => refresh().catch(() => {}), 2000);
    // Если запись о запуске так и не появилась, перестаём ждать
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
