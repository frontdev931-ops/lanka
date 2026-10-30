'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';

const CHANNELS = ['PHONE', 'INSTAGRAM', 'TELEGRAM', 'VIBER', 'GOOGLE', 'SITE', 'WALK_IN', 'RECOMMENDATION', 'OTHER'] as const;
type Stage = 'NEW' | 'CARD' | 'BOOKED' | 'CAME' | 'RETURNING' | 'LOST';
interface Row {
  id: string;
  occurredAt: string;
  channel: string;
  phone: string | null;
  name: string | null;
  note: string | null;
  utmSource?: string | null;
  utmCampaign?: string | null;
  landing?: string | null;
  status: 'OPEN' | 'LOST';
  stage: Stage;
  patient: { id: string; fullName: string } | null;
}
interface List {
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
}

const TONE: Record<Stage, 'gray' | 'blue' | 'green' | 'red'> = { NEW: 'gray', CARD: 'blue', BOOKED: 'blue', CAME: 'green', RETURNING: 'gray', LOST: 'red' };
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function InquiriesPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('PHONE');
  const [filter, setFilter] = useState<'all' | 'new' | 'lost'>('all');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<List>(`/inquiries?filter=${filter}&page=${page}`).then(setList).catch((e) => setError((e as Error).message));
  }, [filter, page]);
  useEffect(load, [load]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api('/inquiries', { method: 'POST', body: JSON.stringify({ channel, phone: f.phone, name: f.name, note: f.note }) });
      form.reset();
      setInfo(t('inq.added'));
      setPage(1);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(r: Row, status: 'OPEN' | 'LOST') {
    try {
      await api(`/inquiries/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(r: Row) {
    if (!(await ask(t('inq.confirmDelete'), { danger: true, confirmLabel: t('common.delete') }))) return;
    try {
      await api(`/inquiries/${r.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      {dialog}
      <PageHeader title={t('inq.title')} subtitle={t('inq.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <Card title={t('inq.new')}>
        <form onSubmit={add}>
          <div className="toolbar" role="group" aria-label={t('inq.channel')} style={{ marginBottom: 12 }}>
            {CHANNELS.map((c) => (
              <button key={c} type="button" className={`btn btn-sm${channel === c ? ' btn-primary' : ''}`} aria-pressed={channel === c} onClick={() => setChannel(c)}>
                {t(`inq.ch.${c}` as never)}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <input className="input" name="phone" type="tel" inputMode="tel" placeholder={t('inq.phone')} autoComplete="off" />
            <input className="input" name="name" placeholder={t('inq.name')} autoComplete="off" />
            <input className="input grow" name="note" placeholder={t('inq.note')} autoComplete="off" />
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? t('common.wait') : t('inq.add')}</button>
          </div>
        </form>
      </Card>

      <Card
        flush
        title={t('inq.list')}
        actions={
          <div className="toolbar" role="group" aria-label={t('inq.list')}>
            {(['all', 'new', 'lost'] as const).map((f) => (
              <button key={f} className={`btn btn-sm${filter === f ? ' btn-primary' : ''}`} aria-pressed={filter === f} onClick={() => { setFilter(f); setPage(1); }}>
                {t(`inq.f.${f}` as never)}
              </button>
            ))}
          </div>
        }
      >
        {!list ? (
          <Loading />
        ) : !list.rows.length ? (
          <Empty title={t('inq.empty')}>{t('inq.emptyHint')}</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('inq.when')}</th><th>{t('inq.channel')}</th><th>{t('inq.contact')}</th>
                    <th>{t('inq.noteCol')}</th><th>{t('inq.state')}</th><th>{t('inq.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtWhen(r.occurredAt)}</td>
                      <td>{t(`inq.ch.${r.channel}` as never)}</td>
                      <td>
                        {r.phone ?? <span className="muted">—</span>}
                        {r.name && <div className="cell-sub">{r.name}</div>}
                      </td>
                      <td>{r.note ?? <span className="muted">—</span>}{(r.utmSource || r.utmCampaign) && <div className="cell-sub">{[r.utmSource, r.utmCampaign].filter(Boolean).join(' / ')}</div>}</td>
                      <td>
                        <Badge tone={TONE[r.stage]}>{t(`inq.st.${r.stage}` as never)}</Badge>
                        {r.patient && (
                          <div className="cell-sub"><Link href={`/patients/${r.patient.id}`}>{r.patient.fullName}</Link></div>
                        )}
                      </td>
                      <td>
                        <div className="toolbar">
                          {r.status === 'OPEN' ? (
                            !r.patient && <button className="btn btn-sm" onClick={() => setStatus(r, 'LOST')}>{t('inq.markLost')}</button>
                          ) : (
                            <button className="btn btn-sm" onClick={() => setStatus(r, 'OPEN')}>{t('inq.reopen')}</button>
                          )}
                          <button className="btn btn-sm" onClick={() => remove(r)}>{t('inq.delete')}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.total > list.pageSize && (
              <div className="toolbar" style={{ padding: '12px 20px', justifyContent: 'space-between' }}>
                <span className="muted">{t('pat.page', { page: list.page, pages: Math.ceil(list.total / list.pageSize) })}</span>
                <span className="toolbar">
                  <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.back')}</button>
                  <button className="btn btn-sm" disabled={page >= Math.ceil(list.total / list.pageSize)} onClick={() => setPage((p) => p + 1)}>{t('common.forward')}</button>
                </span>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
