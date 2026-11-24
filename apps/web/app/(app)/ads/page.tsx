'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { Key, intlLocale, useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

// Reports → "Advertising" (Meta ad analytics, stage 1): one ad account of the clinic, read only. Spend, impressions, reach of the period and link
// clicks; three kinds of results that are never added together, each with its own cost; a campaign table; the leads that really arrived in
// LANKA next to Meta's numbers. Amounts in the ad account's currency, days in its time zone, nothing converted.

type Kind = 'leadForm' | 'messaging' | 'website';
const KINDS: Kind[] = ['leadForm', 'messaging', 'website'];
interface Result { count: number | null; cost: number | null }
interface Totals { spend: number; impressions: number; linkClicks: number | null; reach: number | null; results: Record<Kind, Result> }
interface Campaign extends Totals { campaignId: string; name: string }
interface Status {
  platformReady: boolean;
  canManage: boolean;
  leadAdsConnected: boolean;
  account: { accountId: string; name: string; currency: string; timezoneName: string; state: 'ACTIVE' | 'EXPIRED' | 'NO_PERMISSION'; connectedAt: string; lastSuccessAt: string | null; lastAttemptAt: string | null; lastError: string | null } | null;
  attribution: string[];
  resultTypes: Record<Kind, { actionType: string; verified: boolean }>;
}
interface Report {
  state: 'not_connected' | 'not_loaded' | 'loaded';
  account?: { name: string; currency: string; timezoneName: string };
  updatedAt?: string | null;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  totals?: Totals;
  campaigns?: Campaign[];
  received?: { total: number; byCampaign: Record<string, number> } | null;
}
type Preset = 7 | 30 | 90;

// days in the ad account's time zone
const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export default function AdsPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [st, setSt] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'warn'; text: string } | null>(null);
  const [accounts, setAccounts] = useState<{ sessionId: string; list: { accountId: string; name: string; currency: string; timezoneName: string }[] } | null>(null);
  const [period, setPeriod] = useState<{ since: string; until: string } | null>(null);
  const [preset, setPreset] = useState<Preset | null>(30);
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState('');
  const [busy, setBusy] = useState(false);
  // periods already loaded automatically on this visit (so a failure is not repeated in a loop)
  const autoTried = useRef(new Set<string>());

  const loadStatus = useCallback(() => api<Status>('/meta-ads').then(setSt).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    void loadStatus();
    // back from Facebook: ?meta=ok | select&s=… | a reason
    const q = new URLSearchParams(window.location.search);
    const m = q.get('meta');
    if (m) {
      if (m === 'ok') setNotice({ tone: 'success', text: t('ads.connected') });
      else if (m === 'select' && q.get('s')) {
        const s = q.get('s')!;
        api<{ accounts: { accountId: string; name: string; currency: string; timezoneName: string }[] }>(`/meta-ads/sessions/${encodeURIComponent(s)}`).then((r) => setAccounts({ sessionId: s, list: r.accounts })).catch(() => setNotice({ tone: 'error', text: t('ads.err.session') }));
      } else setNotice({ tone: m === 'denied' ? 'warn' : 'error', text: t(`ads.err.${['denied', 'noperm', 'noaccounts', 'off', 'demo'].includes(m) ? m : 'fail'}` as Key) });
      window.history.replaceState(null, '', '/ads');
    }
  }, [loadStatus, t]);

  // the default period: the last 30 days of the ad account
  useEffect(() => {
    if (st?.account && !period) setPeriod({ since: addDays(todayIn(st.account.timezoneName), -29), until: todayIn(st.account.timezoneName) });
  }, [st, period]);
  const loadReport = useCallback(() => {
    if (!period) return;
    setReportError('');
    api<Report>(`/meta-ads/report?since=${period.since}&until=${period.until}`).then(setReport).catch((e) => setReportError((e as Error).message));
  }, [period]);
  useEffect(loadReport, [loadReport]);

  const pick = (p: Preset) => {
    if (!st?.account) return;
    const today = todayIn(st.account.timezoneName);
    setPreset(p);
    setPeriod({ since: addDays(today, -(p - 1)), until: today });
  };
  const refresh = async () => {
    if (!period) return;
    setBusy(true);
    setNotice(null);
    try {
      setReport(await api<Report>('/meta-ads/refresh', { method: 'POST', body: JSON.stringify(period) }));
    } catch (e) {
      setNotice({ tone: 'error', text: (e as Error).message });
      loadReport();
    } finally {
      setBusy(false);
      void loadStatus();
    }
  };
  // A period opened for the first time is loaded at once, all of its days (the server reads the whole period plus the recent days); until that
  // succeeds the page says "not loaded" and never shows part of the days as the full report
  useEffect(() => {
    if (!period || report?.state !== 'not_loaded' || st?.account?.state !== 'ACTIVE' || busy) return;
    const key = `${period.since}_${period.until}`;
    if (autoTried.current.has(key)) return;
    autoTried.current.add(key);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, period, st, busy]);

  const connect = async () => {
    try {
      window.location.href = (await api<{ url: string }>('/meta-ads/connect-url')).url;
    } catch (e) {
      setNotice({ tone: 'error', text: (e as Error).message });
    }
  };

  const header = <PageHeader title={t('ads.title')} subtitle={t('ads.subtitle')} />;
  if (error && !st) return <>{header}<Alert tone="error">{error}</Alert></>;
  if (!st) return <>{header}<Loading /></>;
  const acc = st.account;
  const cur = acc?.currency ?? 'USD';
  const money = (n: number | null) => (n === null ? '—' : new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n));
  const int = (n: number | null) => (n === null ? '—' : new Intl.NumberFormat(intlLocale()).format(n));

  return (
    <>
      {dialog}
      {header}
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {accounts && st.canManage && (
        <Card title={t('ads.pickTitle')}>
          <p className="rule" style={{ marginTop: 0 }}>{t('ads.pickHint')}</p>
          <ul className="list">
            {accounts.list.map((a) => (
              <li key={a.accountId}>
                <span><span className="cell-main">{a.name}</span><div className="cell-sub">{a.currency} · {a.timezoneName}</div></span>
                <button className="btn btn-sm btn-primary" onClick={async () => { await api('/meta-ads/select', { method: 'POST', body: JSON.stringify({ sessionId: accounts.sessionId, accountId: a.accountId }) }).then(() => { setAccounts(null); setPeriod(null); setNotice({ tone: 'success', text: t('ads.connected') }); void loadStatus(); }).catch((e) => setNotice({ tone: 'error', text: (e as Error).message })); }}>{t('ads.pick')}</button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!acc ? (
        <Card title={t('ads.connectTitle')}>
          {!st.platformReady ? (
            <Alert tone="info">{t('ads.platformOff')}</Alert>
          ) : st.canManage ? (
            <>
              <p className="rule" style={{ marginTop: 0 }}>{t('ads.connectHint')}</p>
              <button className="btn btn-primary" onClick={() => void connect()}>{t('ads.connect')}</button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t('ads.ownerConnects')}</p>
          )}
        </Card>
      ) : (
        <>
          <section className="card ads-head">
            <div style={{ minWidth: 0 }}>
              <b className="ads-account">{acc.name}</b>
              <div className="muted" style={{ fontSize: 14 }}>{t('ads.accountLine', { cur: acc.currency, tz: acc.timezoneName })}</div>
            </div>
            <div className="toolbar">
              {acc.state !== 'ACTIVE' && <Badge tone="amber">{t(`ads.state.${acc.state}` as Key)}</Badge>}
              {st.canManage && acc.state !== 'ACTIVE' && st.platformReady && <button className="btn btn-sm btn-primary" onClick={() => void connect()}>{t('ads.reconnect')}</button>}
              {st.canManage && <button className="btn btn-sm" onClick={async () => (await ask(t('ads.offConfirm'), { danger: true, confirmLabel: t('ads.disconnect') })) && api('/meta-ads', { method: 'DELETE' }).then(() => { setReport(null); setPeriod(null); void loadStatus(); })}>{t('ads.disconnect')}</button>}
            </div>
          </section>
          {acc.state !== 'ACTIVE' && <Alert tone="warn">{t(`ads.stateText.${acc.state}` as Key)}</Alert>}

          <div className="toolbar ads-period">
            <div className="toolbar seg">
              {([7, 30, 90] as Preset[]).map((p) => <button key={p} className={`btn btn-sm${preset === p ? ' btn-primary' : ''}`} onClick={() => pick(p)}>{t('ads.days', { n: p })}</button>)}
            </div>
            {period && (
              <>
                <label className="inline-label">{t('ads.from')}<input className="input" type="date" value={period.since} max={period.until} onChange={(e) => { setPreset(null); setPeriod({ ...period, since: e.target.value }); }} /></label>
                <label className="inline-label">{t('ads.to')}<input className="input" type="date" value={period.until} min={period.since} onChange={(e) => { setPreset(null); setPeriod({ ...period, until: e.target.value }); }} /></label>
              </>
            )}
            <span className="grow" />
            <button className="btn btn-primary" disabled={busy || acc.state !== 'ACTIVE'} onClick={() => void refresh()}>{busy ? t('ads.refreshing') : t('ads.refresh')}</button>
          </div>

          {reportError ? (
            <Alert tone="error">{reportError}</Alert>
          ) : !report ? (
            <Loading />
          ) : report.state === 'not_loaded' ? (
            <Card>{busy ? <Loading /> : <Empty title={t('ads.notLoaded')} />}</Card>
          ) : report.state === 'loaded' && report.totals ? (
            <>
              <p className="ads-updated">
                {t('ads.updated', { date: fmtDateTime(report.updatedAt ?? null) })}
                {report.lastError && report.lastAttemptAt && report.updatedAt && report.lastAttemptAt > report.updatedAt && <> · <span className="ads-stale">{t('ads.stale', { reason: t(`ads.reason.${report.lastError}` as Key) })}</span></>}
              </p>
              <div className="ads-kpis">
                <Kpi label={t('ads.spend')} value={money(report.totals.spend)} />
                <Kpi label={t('ads.impressions')} value={int(report.totals.impressions)} />
                <Kpi label={t('ads.reach')} value={int(report.totals.reach)} hint={t('ads.reachHint')} />
                <Kpi label={t('ads.clicks')} value={int(report.totals.linkClicks)} />
              </div>
              <div className="ads-results">
                {KINDS.map((k) => {
                  const r = report.totals!.results[k];
                  return (
                    <div key={k} className="ads-result">
                      <span className="l">{t(`ads.kind.${k}` as Key)}</span>
                      <b>{r.count === null ? '—' : int(r.count)}</b>
                      <span className="c">{r.count === null ? t('ads.notReported') : t('ads.costOf', { cost: r.count ? money(r.cost) : '—' })}</span>
                      {!st.resultTypes[k].verified && <span className="v">{t('ads.unverified')}</span>}
                    </div>
                  );
                })}
                {report.received !== undefined && (
                  <div className="ads-result lanka">
                    <span className="l">{t('ads.received')}</span>
                    <b>{report.received ? int(report.received.total) : '—'}</b>
                    <span className="c">{report.received ? t('ads.receivedHint') : t('ads.leadsOff')}</span>
                  </div>
                )}
              </div>

              <Card flush title={t('ads.campaigns')}>
                {report.campaigns?.length ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('ads.col.campaign')}</th><th className="num">{t('ads.spend')}</th><th className="num">{t('ads.impressions')}</th><th className="num">{t('ads.reach')}</th><th className="num">{t('ads.clicks')}</th>
                          {KINDS.map((k) => <th key={k} className="num">{t(`ads.kind.${k}` as Key)}</th>)}
                          {report.received && <th className="num">{t('ads.received')}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {report.campaigns.map((c) => (
                          <tr key={c.campaignId}>
                            <td><span className="cell-main">{c.name}</span></td>
                            <td className="num">{money(c.spend)}</td>
                            <td className="num">{int(c.impressions)}</td>
                            <td className="num">{int(c.reach)}</td>
                            <td className="num">{int(c.linkClicks)}</td>
                            {KINDS.map((k) => (
                              <td key={k} className="num">
                                {c.results[k].count === null ? '—' : int(c.results[k].count)}
                                {c.results[k].count !== null && <div className="cell-sub">{c.results[k].count ? money(c.results[k].cost) : '—'}</div>}
                              </td>
                            ))}
                            {report.received && <td className="num">{int(report.received.byCampaign[c.campaignId] ?? 0)}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t('ads.noCampaigns')} />
                )}
              </Card>

              <Card title={t('ads.howTitle')}>
                <ul className="rule" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
                  <li>{t('ads.how.attribution')}</li>
                  <li>{t('ads.how.reach')}</li>
                  <li>{t('ads.how.kinds')}</li>
                  <li>{t('ads.how.recount')}</li>
                  <li>{t('ads.how.lanka')}</li>
                  <li>{t('ads.how.currency', { cur: acc.currency, tz: acc.timezoneName })}</li>
                </ul>
              </Card>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="ads-kpi" title={hint}>
      <span>{label}</span>
      <b>{value}</b>
      {hint && <span className="h">{hint}</span>}
    </div>
  );
}
