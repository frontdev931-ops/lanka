'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { Key, useI18n } from '../../../../lib/i18n';
import { fmtDate, fmtDateTime } from '../../../../lib/ui';
import { Alert, Loading, PageHeader } from '../../../../components/ui';
import { ProHint } from '../../../../components/ProHint';
import { SignalClinic } from '../../../../components/SignalClinic';
import { Kind, rich, Signal, signalText } from '../../../../components/signalText';

const KINDS: Kind[] = ['CANCEL_RATE', 'NO_REBOOK', 'OVERDUE_TASKS', 'PAYMENTS_DROP', 'RETURN_DROP', 'STALE_REQUESTS', 'SYNC_OVERDUE', 'UNFINISHED_NO_NEXT'];
const PCT: Kind[] = ['CANCEL_RATE', 'RETURN_DROP', 'PAYMENTS_DROP'];
type Details =
  | { inPlan: false; kind: Kind }
  | (Signal & {
      inPlan: true;
      clinic: string;
      checkedAt: string;
      sync: { lastSyncAt: string | null; fresh: boolean };
      // what the message showed (the link's ?e=); null without one
      event: { at: string; value: number } | null;
      // the patient rules: the very patients the rule counted (at most `limit`), the total always
      patients?: { id: string; name: string; at: string | null; days: number | null }[];
      total?: number;
      limit: number;
    });

// One signal opened from a message (/signals/<KIND>?c=<clinicId>&e=<eventId>, ids only) or from the section: the current measurement, the exact
// condition, the matching section and, for the patient rules, the patients the rule counted with links to their cards. The data may have changed
// since the message: the page always shows the current list and says so.
export default function SignalDetailsPage() {
  return (
    <SignalClinic>
      <SignalDetails />
    </SignalClinic>
  );
}

function SignalDetails() {
  const { t } = useI18n();
  const { kind } = useParams<{ kind: string }>();
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState('');
  // the event of the message (?e=), read after the first render like the clinic
  const [event, setEvent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setEvent(new URLSearchParams(window.location.search).get('e'));
  }, []);
  const known = KINDS.includes(kind as Kind);

  const load = useCallback(() => {
    setError('');
    return api<Details>(`/signals/${kind}${event ? `?e=${encodeURIComponent(event)}` : ''}`)
      .then(setD)
      .catch((e) => setError((e as Error).message));
  }, [kind, event]);
  useEffect(() => {
    if (known && event !== undefined) void load();
  }, [known, event, load]);

  const back = <Link href="/signals" className="sig-back">← {t('sigd.back')}</Link>;
  const title = known ? t(`ins.alert.${kind}` as Key) : t('sig.title');
  const header = <PageHeader title={title} subtitle={t('sigd.subtitle')} actions={back} />;
  if (!known) return <>{header}<Alert tone="warn">{t('sigd.unknown')}</Alert></>;
  if (error && !d) return <>{header}<Alert tone="error">{t('sig.error')} <button className="btn btn-sm" onClick={() => void load()}>{t('sig.retry')}</button></Alert></>;
  if (!d) return <>{header}<Loading /></>;
  if (!d.inPlan) return <>{header}<ProHint feature="advanced_analytics" /></>;

  const { what, details } = signalText(d, t);
  const unit = PCT.includes(d.kind) ? '%' : '';
  const changed = d.event && d.state !== 'off' && typeof d.value === 'number' && d.value !== d.event.value;
  return (
    <>
      {header}
      {d.event && (
        <Alert tone="info">
          {t('sigd.event', { date: fmtDateTime(d.event.at), v: `${d.event.value}${unit}` })} {changed ? t('sigd.changed') : t('sigd.mayChange')}
        </Alert>
      )}
      <section className={`sig-card sig-${d.state}`} aria-label={title}>
        <span className={`sig-status st-${d.state}`}>{t(`sig.state.${d.state}` as Key)}</span>
        <p className="sig-what">{d.active ? rich(what()) : t('sig.offNote')}</p>
        {details().map((x) => <p key={x} className="sig-sub-line">{x}</p>)}
        <h2 className="sigd-h">{t('sigd.condition')}</h2>
        <p>{t(`sig.${d.kind}.how` as Key)}</p>
        <p className="sig-sub-line">{t('sigd.settings', { threshold: `${d.threshold}${unit}` })} <Link href="/signals">{t('sigd.toSettings')}</Link></p>
        {d.link && (
          <p>
            <Link className="btn btn-primary" href={d.link}>{t(`sig.${d.kind}.open` as Key)}</Link>
          </p>
        )}
      </section>

      {d.patients && (
        <section className="card sigd-list" aria-labelledby="sigd-patients">
          <h2 id="sigd-patients" className="sigd-h">{t('sigd.patientsTitle', { n: d.total ?? 0 })}</h2>
          <p className="rule">{t(d.kind === 'NO_REBOOK' ? 'sigd.listNoRebook' : 'sigd.listUnfinished')}</p>
          {d.patients.length === 0 ? (
            <p>{t('sigd.empty')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('sigd.colPatient')}</th>
                  <th>{d.kind === 'NO_REBOOK' ? t('sigd.colMissed') : t('sigd.colLastWork')}</th>
                </tr>
              </thead>
              <tbody>
                {d.patients.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/patients/${p.id}`}>{p.name}</Link></td>
                    <td>{p.at ? `${fmtDate(p.at)} · ${t('sigd.daysAgo', { n: p.days ?? 0 })}` : t('sigd.daysAgo', { n: p.days ?? 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(d.total ?? 0) > d.patients.length && <p className="sig-sub-line">{t('sigd.more', { shown: d.patients.length, total: d.total ?? 0 })}</p>}
        </section>
      )}
      <p className="sig-foot">
        {t('sig.checkedAt', { date: fmtDateTime(d.checkedAt) })}{' '}
        {d.sync.lastSyncAt ? t('sigd.syncAt', { date: fmtDateTime(d.sync.lastSyncAt) }) : ''}
      </p>
    </>
  );
}
