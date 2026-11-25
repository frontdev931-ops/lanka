'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '../../../../../lib/api';
import { Key, useI18n } from '../../../../../lib/i18n';
import { fmtDateTime } from '../../../../../lib/ui';
import { Alert, Badge, Loading, PageHeader } from '../../../../../components/ui';
import { SignalClinic } from '../../../../../components/SignalClinic';
import { PeriodFigures, PeriodTotals, day } from '../../../../../components/PeriodFigures';

type RunStatus = 'pending' | 'sent' | 'partial' | 'failed' | 'unknown' | 'cancelled' | 'no_recipients';
interface Saved {
  id: string;
  kind: 'WEEKLY' | 'MONTHLY';
  source: 'SCHEDULED' | 'MANUAL';
  state: 'READY' | 'STALE';
  clinic: string | null;
  period: { from: string; to: string; days: number };
  prevPeriod: { from: string; to: string; days: number };
  preparedAt: string;
  facts: { connected: boolean; lastSyncAt: string | null; cur?: PeriodTotals; prev?: PeriodTotals };
  missing: string[];
  attention: string[];
  texts: { lang: string; text: string; sentCount: number }[];
  mine: { status: string; sentAt: string | null; lang: string | null } | null;
  status: RunStatus;
  counts: { total: number; sent: number; failed: number; unknown: number; dropped: number; pending: number };
}
const LANG_NAME: Record<string, string> = { uk: 'Українська', ru: 'Русский', en: 'English' };

// A saved weekly or monthly report (/period-report/r/<id>?c=<clinicId>, the link of a sent message): exactly what was prepared, from its snapshot
// only. Nothing here is recalculated; "See the current data" opens the live calculation of the same period separately.
export default function SavedReportPage() {
  return (
    <SignalClinic>
      <SavedReport />
    </SignalClinic>
  );
}

function SavedReport() {
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Saved | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Saved>(`/period-reports/runs/${encodeURIComponent(id)}?lang=${locale}`).then(setR).catch((e) => setError((e as Error).message));
  }, [id, locale]);
  const header = <PageHeader title={t('prh.savedTitle')} subtitle={t('prh.savedSubtitle')} actions={<Link className="btn btn-sm" href="/period-report/history">{t('prh.open')}</Link>} />;
  if (error) return <>{header}<Alert tone="error">{error}</Alert></>;
  if (!r) return <>{header}<Loading /></>;
  // the text this person received first, then the other languages; none claims to be the text of every delivery
  const texts = [...r.texts].sort((a, b) => (a.lang === r.mine?.lang ? -1 : b.lang === r.mine?.lang ? 1 : 0));
  return (
    <>
      {header}
      <Alert tone="info">
        <b>{t('prh.savedAsOf', { date: fmtDateTime(r.preparedAt) })}</b> {t('prh.savedNoRecalc')}
      </Alert>
      <section className="card">
        <h2 className="sigd-h" style={{ marginTop: 0 }}>
          {r.clinic ? `${r.clinic} · ` : ''}{t(r.kind === 'WEEKLY' ? 'pr.week' : 'pr.month')} · {`${day(r.period.from)} — ${day(r.period.to)}`}
        </h2>
        <p className="sig-sub-line">
          {t('prh.colPrepared')}: {fmtDateTime(r.preparedAt)} · {t(r.source === 'MANUAL' ? 'prh.manual' : 'prh.scheduled')}
        </p>
        <p style={{ margin: '6px 0' }}>
          <Badge className="badge-wrap" tone={r.status === 'sent' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'partial' || r.status === 'unknown' ? 'amber' : 'gray'}>{t(`prh.st.${r.status}` as Key, { n: r.counts.sent, total: r.counts.total })}</Badge>{' '}
          {r.mine && <span className="muted">{t('prh.mine', { s: t(`prh.d.${r.mine.status}` as Key) })}</span>}
        </p>
        <p className="sig-sub-line">{t('prh.acceptedNote')}</p>
      </section>

      {r.missing.map((m) => <Alert key={m} tone="warn">{t(`prh.missing.${m}` as Key)}</Alert>)}

      {r.state === 'STALE' ? (
        <Alert tone="warn">{r.facts.connected ? t('prh.staleSaved', { date: r.facts.lastSyncAt ? fmtDateTime(r.facts.lastSyncAt) : '—' }) : t('pr.notConnected')}</Alert>
      ) : (
        r.facts.cur && (
          <section className="card" style={{ marginTop: 16 }} aria-labelledby="prs-figures">
            <h2 id="prs-figures" className="sigd-h" style={{ marginTop: 0 }}>{t('prh.figures')}</h2>
            <PeriodFigures cur={r.facts.cur} prev={r.facts.prev} prevPeriod={r.prevPeriod} />
          </section>
        )
      )}

      {r.attention.length > 0 && (
        <section className="card" style={{ marginTop: 16 }} aria-labelledby="prs-attention">
          <h2 id="prs-attention" className="sigd-h" style={{ marginTop: 0 }}>{t('prh.attention')}</h2>
          {r.attention.map((l, i) => <p key={i} style={{ margin: '4px 0' }}>{l}</p>)}
          <p className="sig-sub-line">{t('prh.attentionNote')}</p>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }} aria-labelledby="prs-text">
        <h2 id="prs-text" className="sigd-h" style={{ marginTop: 0 }}>{t('prh.textTitle')}</h2>
        {texts.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{r.counts.total ? t('prh.noTextOld') : t('prh.noTextNoRecipients')}</p>
        ) : (
          texts.map((x) => (
            <div key={x.lang} style={{ marginBottom: 12 }}>
              <p className="sig-sub-line">
                {x.lang === r.mine?.lang ? t('prh.textMine') : t('prh.textLang', { lang: LANG_NAME[x.lang] ?? x.lang })} · {t('prh.textSent', { n: x.sentCount })}
              </p>
              <pre className="sigo-text">{x.text}</pre>
            </div>
          ))
        )}
      </section>

      <div className="toolbar" style={{ marginTop: 16 }}>
        <Link className="btn btn-primary" href={`/period-report?kind=${r.kind}&from=${r.period.from}`}>{t('prh.live')}</Link>
        <Link className="btn" href="/period-report/history">{t('prh.open')}</Link>
      </div>
      <p className="sig-sub-line">{t('prh.liveHint')}</p>
    </>
  );
}
