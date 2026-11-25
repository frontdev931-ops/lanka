'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { Alert, Loading, PageHeader } from '../../../components/ui';
import { SignalClinic } from '../../../components/SignalClinic';

type Kind = 'WEEKLY' | 'MONTHLY';
interface Totals { completed: number; cancelled: number; noShow: number; scheduled: number; unclosed: number; newPatients: number; paid: { currency: string | null; amount: number }[] }
interface Preview {
  kind: Kind;
  period: { from: string; to: string; days: number };
  prevPeriod: { from: string; to: string; days: number };
  periods: { from: string; to: string }[];
  facts: { state: 'READY' | 'STALE'; connected: boolean; lastSyncAt: string | null; cur?: Totals; prev?: Totals };
  text: string;
}

const day = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;

// The weekly or monthly report of a completed period (/period-report?kind=WEEKLY&from=YYYY-MM-DD, ids and dates only; ?c= the clinic of a
// message): the figures of the period next to the previous one and the exact Telegram text, from the same calculation as the message. Opening it
// sends nothing; "Send to my Telegram" is a separate button.
export default function PeriodReportPage() {
  return (
    <SignalClinic>
      <PeriodReport />
    </SignalClinic>
  );
}

function PeriodReport() {
  const { t, locale } = useI18n();
  const [sel, setSel] = useState<{ kind: Kind; from?: string } | null>(null);
  const [v, setV] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [me, setMe] = useState<{ blocked: boolean } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // the address is read after the first render (the server has none)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setSel({ kind: q.get('kind') === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY', from: q.get('from') ?? undefined });
    api<{ me: { blocked: boolean } | null }>('/leader-telegram').then((r) => setMe(r.me)).catch(() => setMe(null));
  }, []);
  const load = useCallback(() => {
    if (!sel) return;
    setError('');
    setV(null);
    api<Preview>(`/period-reports/preview?kind=${sel.kind}${sel.from ? `&from=${sel.from}` : ''}&lang=${locale}`)
      .then(setV)
      .catch((e) => setError((e as Error).message));
  }, [sel, locale]);
  useEffect(() => {
    load();
  }, [load]);

  const choose = (kind: Kind, from?: string) => {
    setMsg(null);
    setSel({ kind, from });
    const q = new URLSearchParams(window.location.search);
    q.set('kind', kind);
    if (from) q.set('from', from);
    else q.delete('from');
    q.delete('c');
    window.history.replaceState(null, '', `?${q.toString()}`);
  };
  const send = async () => {
    if (!v) return;
    setBusy(true);
    setMsg(null);
    try {
      await api('/period-reports/send-to-me', { method: 'POST', body: JSON.stringify({ kind: v.kind, from: v.period.from, lang: locale }) });
      setMsg({ ok: true, text: t('sigo.sent') });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const header = <PageHeader title={t('pr.title')} subtitle={t('pr.subtitle')} />;
  if (!sel) return <>{header}<Loading /></>;
  const c = v?.facts.cur;
  const p = v?.facts.prev;
  const share = (x?: Totals) => (x && x.scheduled > 0 ? `${(((x.cancelled + x.noShow) / x.scheduled) * 100).toLocaleString(locale === 'en' ? 'en-GB' : 'uk-UA', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}% (${x.cancelled + x.noShow} / ${x.scheduled})` : '—');
  const money = (x?: Totals) => (x ? (x.paid.length ? x.paid.map((m) => `${m.amount.toLocaleString('uk-UA')} ${m.currency === 'UAH' ? t('billing.uah') : m.currency ?? ''}`).join('; ') : '0') : '—');
  const rows: [string, string, string][] = c
    ? [
        [t('pr.rowCompleted'), String(c.completed), String(p?.completed ?? '—')],
        [t('pr.rowNew'), String(c.newPatients), String(p?.newPatients ?? '—')],
        [t('pr.rowMissed'), share(c), share(p)],
        [t('pr.rowPaid'), money(c), money(p)],
        [t('pr.rowUnclosed'), String(c.unclosed), String(p?.unclosed ?? '—')],
      ]
    : [];
  return (
    <>
      {header}
      <div className="toolbar" style={{ alignItems: 'flex-end' }}>
        <div className="seg" role="tablist" aria-label={t('pr.kind')}>
          {(['WEEKLY', 'MONTHLY'] as Kind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={sel.kind === k} className={`btn btn-sm${sel.kind === k ? ' btn-primary' : ''}`} onClick={() => choose(k)}>
              {t(k === 'WEEKLY' ? 'pr.week' : 'pr.month')}
            </button>
          ))}
        </div>
        {v && (
          <label className="field" style={{ margin: 0 }}>
            <span>{t('pr.period')}</span>
            <select className="select" value={v.period.from} onChange={(e) => choose(sel.kind, e.target.value)}>
              {v.periods.map((x) => <option key={x.from} value={x.from}>{`${day(x.from)} — ${day(x.to)}`}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!v && !error && <Loading />}
      {v && (
        <>
          {v.facts.state === 'STALE' && <Alert tone="warn">{v.facts.connected ? t('pr.stale') : t('pr.notConnected')}</Alert>}
          {c && (
            <section className="card" aria-labelledby="pr-figures">
              <h2 id="pr-figures" className="sigd-h" style={{ marginTop: 0 }}>{`${day(v.period.from)} — ${day(v.period.to)}`}</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('pr.colMetric')}</th>
                    <th>{t('pr.colThis')}</th>
                    <th>{`${t('pr.colPrev')} ${day(v.prevPeriod.from)} — ${day(v.prevPeriod.to)}`}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([a, b, d]) => (
                    <tr key={a}>
                      <td>{a}</td>
                      <td><b>{b}</b></td>
                      <td>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="sig-sub-line">{t('pr.definitions')}</p>
              <div className="toolbar">
                <Link className="btn btn-sm" href={`/reports?report=missed-visits&from=${v.period.from}&to=${v.period.to}`}>{t('sig.CANCEL_RATE.open')}</Link>
                <Link className="btn btn-sm" href={`/reports?report=unclosed-visits&from=${v.period.from}&to=${v.period.to}`}>{t('pr.unclosedReport')}</Link>
                <Link className="btn btn-sm" href="/reports?report=revenue">{t('sig.PAYMENTS_DROP.open')}</Link>
              </div>
            </section>
          )}
          <section className="card" aria-labelledby="pr-text" style={{ marginTop: 16 }}>
            <h2 id="pr-text" className="sigd-h" style={{ marginTop: 0 }}>{t('pr.textTitle')}</h2>
            <p className="rule">{t('sigo.hint')}</p>
            <pre className="sigo-text">{v.text}</pre>
            {msg && <p className={msg.ok ? 'sig-msg ok' : 'sig-msg err'} role="status">{msg.text}</p>}
            <div className="toolbar" style={{ marginTop: 10 }}>
              {me ? (
                <button className="btn btn-primary" disabled={busy || me.blocked} onClick={() => void send()}>{t('sigo.send')}</button>
              ) : me === null ? (
                <Link className="btn" href="/settings#leader-telegram">{t('sigo.connect')}</Link>
              ) : null}
              <Link className="btn" href="/insights">{t('pr.schedule')}</Link>
            </div>
          </section>
        </>
      )}
    </>
  );
}
