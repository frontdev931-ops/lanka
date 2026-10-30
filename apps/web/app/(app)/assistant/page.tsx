'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, downloadPost } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDateTime, fmtNumber } from '../../../lib/ui';
import { Alert, Badge, Card, Icon, Loading, PageHeader } from '../../../components/ui';
import { MiniBars } from '../../../components/MiniBars';

interface Report {
  title: string;
  rule: string;
  dataUpdatedAt: string | null;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | null>[];
  total: number;
  truncated: boolean;
}
interface Turn {
  q: string;
  a: string;
  title: string | null;
  spec: Record<string, unknown> | null;
  report: Report | null;
  saved?: boolean;
}
interface AiStatus {
  available: boolean;
  assistant: boolean;
}

const EXAMPLES = ['as.ex1', 'as.ex2', 'as.ex3', 'as.ex4'] as const;

export default function AssistantPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<AiStatus>('/ai').then(setStatus).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, busy]);

  const ask = async (text: string) => {
    const question = text.trim();
    if (question.length < 3 || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<Omit<Turn, 'q' | 'a'> & { answer: string }>('/assistant/ask', { method: 'POST', body: JSON.stringify({ question, history: turns.slice(-4).map((x) => ({ q: x.q, a: x.a })) }) });
      setTurns((all) => [...all, { q: question, a: r.answer, title: r.title, spec: r.spec, report: r.report }]);
      setQ('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (turn: Turn, fmt: 'xlsx' | 'pdf' | 'csv') => {
    try {
      await downloadPost('/report-builder/export', { spec: turn.spec, format: fmt, title: turn.title ?? undefined }, `report.${fmt}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async (i: number) => {
    const turn = turns[i];
    try {
      await api('/report-builder/saved', { method: 'POST', body: JSON.stringify({ name: turn.title || turn.q.slice(0, 80), spec: turn.spec }) });
      setTurns((all) => all.map((x, j) => (j === i ? { ...x, saved: true } : x)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!status) return error ? <Alert tone="error">{error}</Alert> : <Loading />;

  return (
    <>
      <PageHeader title={t('as.title')} subtitle={t('as.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}

      {!status.assistant ? (
        <Card>
          <Alert tone="warn">{status.available ? t('as.off') : t('ai.notConfigured')}</Alert>
          <Link className="btn btn-primary" href="/automations">{t('as.goSettings')}</Link>
        </Card>
      ) : (
        <>
          {turns.length === 0 && (
            <Card title={t('as.tryTitle')}>
              <p className="rule" style={{ marginTop: 0 }}>{t('as.tryHint')}</p>
              <div className="toolbar" style={{ flexWrap: 'wrap' }}>
                {EXAMPLES.map((k) => (
                  <button key={k} className="btn btn-sm" disabled={busy} onClick={() => ask(t(k))}>{t(k)}</button>
                ))}
              </div>
            </Card>
          )}

          {turns.map((turn, i) => (
            <div key={i} className="as-turn">
              <div className="bubble out as-q">{turn.q}</div>
              <Card>
                <p style={{ marginTop: 0 }}>{turn.a}</p>
                {turn.report && (
                  <>
                    <p className="rule">{turn.report.rule}{turn.report.dataUpdatedAt ? ` · ${t('rep.updated')}: ${fmtDateTime(turn.report.dataUpdatedAt)}` : ''}</p>
                    {turn.report.columns.length === 2 && turn.report.rows.length > 1 && turn.report.rows.length <= 40 && turn.report.rows.every((r) => typeof r[turn.report!.columns[1].key] === 'number') && (
                      <MiniBars rows={turn.report.rows} labelKey={turn.report.columns[0].key} valueKey={turn.report.columns[1].key} />
                    )}
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            {turn.report.columns.map((c) => (
                              <th key={c.key}>{c.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {turn.report.rows.slice(0, 25).map((r, k) => (
                            <tr key={k}>
                              {turn.report!.columns.map((c) => (
                                <td key={c.key}>{typeof r[c.key] === 'number' ? fmtNumber(r[c.key] as number) : r[c.key] ?? '—'}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {turn.report.rows.length > 25 && <p className="muted" style={{ fontSize: 13 }}>{t('as.firstRows', { n: 25, total: turn.report.total })} <Badge tone="amber">{t('rb.moreInFile')}</Badge></p>}
                    <div className="toolbar" style={{ marginTop: 8 }}>
                      {(['xlsx', 'pdf', 'csv'] as const).map((fmt) => (
                        <button key={fmt} className="btn btn-sm" onClick={() => exportAs(turn, fmt)}>
                          <Icon name="download" size={14} /> {fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}
                        </button>
                      ))}
                      <button className="btn btn-sm" disabled={turn.saved} onClick={() => save(i)}>{turn.saved ? t('as.savedDone') : t('rb.save')}</button>
                    </div>
                  </>
                )}
              </Card>
            </div>
          ))}
          {busy && <p className="muted">{t('as.thinking')}</p>}
          <div ref={end} />

          <form
            className="as-input"
            onSubmit={(e) => {
              e.preventDefault();
              ask(q);
            }}
          >
            <textarea className="input" rows={2} maxLength={600} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('as.placeholder')} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(q); } }} />
            <button className="btn btn-primary" type="submit" disabled={busy || q.trim().length < 3}>{t('as.ask')}</button>
          </form>
          <p className="muted" style={{ fontSize: 13 }}>{t('as.note')}</p>
        </>
      )}
    </>
  );
}
