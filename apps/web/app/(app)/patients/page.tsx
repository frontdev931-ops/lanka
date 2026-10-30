'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { fmtDate, fmtNumber } from '../../../lib/ui';
import { Alert, Card, Empty, Icon, Loading, PageHeader } from '../../../components/ui';

interface Result {
  total: number;
  page: number;
  pageSize: number;
  sources: string[];
  rows: { id: string; fullName: string; phone: string | null; source: string | null; lastVisitAt: string | null; debt?: number }[];
}

export default function PatientsPage() {
  const t = useT();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  // Врачу сервер деньги не отдаёт: колонку долга для него не показываем
  const showMoney = !data || data.rows.length === 0 || data.rows[0].debt !== undefined;
  const [error, setError] = useState('');

  useEffect(() => {
    // небольшая задержка, чтобы не слать запрос на каждую букву
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ search, page: String(page) });
      if (source) q.set('source', source);
      api<Result>(`/patients?${q}`).then(setData).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, source, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader title={t('pat.title')} subtitle={data ? t('pat.total', { n: data.total }) : undefined} />
      {error && <Alert tone="error">{error}</Alert>}

      <Card flush>
        <div className="toolbar" style={{ padding: 16 }}>
          <div className="search">
            <Icon name="search" size={16} />
            <input className="input" placeholder={t('pat.search')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <select className="select" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
            <option value="">{t('pat.allSources')}</option>
            {data?.sources.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="__none">{t('pat.noSource')}</option>
          </select>
        </div>

        {!data ? (
          <Loading />
        ) : !data.rows.length ? (
          <Empty title={t('pat.empty')}>{t('pat.emptyHint')}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pat.colPatient')}</th><th>{t('pat.colPhone')}</th><th>{t('pat.colSource')}</th>
                  <th>{t('pat.colLastVisit')}</th>{showMoney && <th className="num">{t('pat.colDue')}</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/patients/${p.id}`} className="cell-main">{p.fullName}</Link></td>
                    <td>{p.phone ?? <span className="muted">—</span>}</td>
                    <td>{p.source ?? <span className="muted">—</span>}</td>
                    <td>{fmtDate(p.lastVisitAt)}</td>
                    {showMoney && <td className="num">{p.debt ? <b style={{ color: 'var(--red)' }}>{fmtNumber(p.debt)}</b> : <span className="muted">—</span>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > 0 && (
          <div className="table-foot">
            <span>{t('pat.page', { page, pages })}</span>
            <span className="toolbar">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon name="back" size={14} /> {t('common.back')}</button>
              <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('common.forward')} <Icon name="next" size={14} /></button>
            </span>
          </div>
        )}
      </Card>
    </>
  );
}
