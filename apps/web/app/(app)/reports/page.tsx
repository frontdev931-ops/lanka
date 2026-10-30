'use client';

import { ReactNode, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, downloadCsv, isUnauthorized } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { fmtDate, fmtDateTime, fmtNumber } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, Loading, PageHeader, statusTone } from '../../../components/ui';
import { SyncBar } from '../../../components/SyncBar';
import { ColumnChart, ChartDatum } from '../../../components/ColumnChart';
import { useSync } from '../../../lib/sync';

interface CatalogItem {
  id: string;
  title: string;
  defaultDays: number;
  defaultMaxDays: number | null;
  daysLabel: string;
  usesDays: boolean;
  canCreateTasks: boolean;
}

type Cell = string | number | boolean | null;

interface Report {
  id: string;
  title: string;
  rule: string;
  days: number;
  dataUpdatedAt: string | null;
  columns: { key: string; label: string }[];
  rows: Record<string, Cell>[];
  canCreateTasks: boolean;
}

interface Assignee {
  id: string;
  name: string;
}

const NUMERIC = new Set([
  'daysSince', 'patients', 'active', 'visits', 'revenue', 'openItems', 'openSum', 'balanceIssued', 'balancePaid', 'debt',
  'invoiced', 'paid', 'paymentsCount', 'freeMinutes', 'lifetimePaid',
]);
// Суммы в деньгах: показываются с разделителем тысяч
const MONEY = new Set(['revenue', 'openSum', 'balanceIssued', 'balancePaid', 'debt', 'invoiced', 'paid', 'lifetimePaid']);

export default function ReportsPage() {
  const router = useRouter();
  const { t, label, locale } = useI18n();
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [days, setDays] = useState(90);
  // Верхняя граница периода (только у отчёта «давно не бували»)
  const [maxDays, setMaxDays] = useState<number | null>(null);
  const [sourceFilter, setSourceFilter] = useState('');
  const [onlyTreatment, setOnlyTreatment] = useState(false);
  // Давность записи без итога: недавние легко вспомнить, давние закрывают пачкой по расписанию врача
  const [age, setAge] = useState<'all' | 'recent' | 'mid' | 'old'>('all');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [query, setQuery] = useState('');
  // Длинные списки (сотни и тысячи строк) показываются порциями: так страница быстрая, особенно на телефоне
  const PAGE_ROWS = 100;
  const [shown, setShown] = useState(PAGE_ROWS);

  const current = catalog.find((c) => c.id === currentId) ?? null;
  const searchable = !!report?.columns.some((c) => c.key === 'fullName');
  const q = query.trim().toLowerCase();
  const hasSource = !!report?.columns.some((c) => c.key === 'source') && !!report?.columns.some((c) => c.key === 'fullName');
  const hasOpen = !!report?.columns.some((c) => c.key === 'openSum') && searchable;
  const hasAge = currentId === 'unclosed-visits';
  const inAge = (d: number, a: typeof age) => a === 'all' || (a === 'recent' ? d <= 3 : a === 'mid' ? d > 3 && d <= 30 : d > 30);
  const ageCount = (a: typeof age) => (report ? report.rows.filter((r) => inAge(Number(r.daysSince), a)).length : 0);
  const sourceOptions = hasSource ? [...new Set((report?.rows ?? []).map((r) => String(r.source ?? '')))].sort() : [];
  const rows = report
    ? report.rows.filter((r) => {
        if (searchable && q && !(String(r.fullName ?? '').toLowerCase().includes(q) || String(r.phone ?? '').includes(q))) return false;
        if (hasSource && sourceFilter && String(r.source ?? '') !== (sourceFilter === '__none' ? '' : sourceFilter)) return false;
        if (hasOpen && onlyTreatment && !(Number(r.openSum) > 0)) return false;
        if (hasAge && !inAge(Number(r.daysSince), age)) return false;
        return true;
      })
    : [];
  const filtered = !!q || !!sourceFilter || onlyTreatment || age !== 'all';

  // График «записи без итога по неделям»: последние до 26 недель, пустые недели тоже видны (ноль, а не пропуск)
  const weekly: ChartDatum[] = (() => {
    if (currentId !== 'unclosed-visits' || !report) return [];
    const monday = (iso: string) => {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d;
    };
    const counts = new Map<string, number>();
    for (const r of report.rows) {
      const k = monday(String(r.visitAt)).toISOString().slice(0, 10);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const last = monday(new Date().toISOString().slice(0, 10));
    const weeks = Math.min(26, Math.max(4, Math.ceil(report.days / 7) + 1));
    const out: ChartDatum[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(last);
      d.setUTCDate(d.getUTCDate() - i * 7);
      const key = d.toISOString().slice(0, 10);
      const short = `${key.slice(8, 10)}.${key.slice(5, 7)}`;
      // Последняя неделя ещё идёт: в подсказке это сказано, чтобы небольшой столбец не читали как улучшение
      out.push({ key, label: short, value: counts.get(key) ?? 0, tip: t('rep.weekFrom', { date: short }) + (i === 0 ? ` ${t('rep.weekRunning')}` : '') });
    }
    return out;
  })();

  const fail = useCallback(
    (e: unknown) => {
      if (isUnauthorized(e)) {
        router.replace('/login');
      } else setError((e as Error).message);
    },
    [router],
  );

  // Каталог приходит с сервера на выбранном языке, поэтому загружается заново при смене языка
  useEffect(() => {
    api<CatalogItem[]>('/reports')
      .then((c) => {
        setCatalog(c);
        setCurrentId((id) => {
          if (id) return id;
          // Ссылка вида /reports?report=unclosed-visits открывает нужный отчёт сразу
          const wanted = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('report');
          const first = c.find((x) => x.id === wanted) ?? c[0];
          setDays(first.defaultDays);
          setMaxDays(first.defaultMaxDays);
          return first.id;
        });
      })
      .catch(fail);
    api<Assignee[]>('/tasks/assignees').then(setAssignees).catch(() => {});
  }, [fail, locale]);

  const load = useCallback(async () => {
    if (!currentId) return;
    setError('');
    setLoading(true);
    setShown(100);
    try {
      setReport(await api<Report>(`/reports/${currentId}?days=${days}${maxDays ? `&maxDays=${maxDays}` : ''}`));
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [currentId, days, maxDays, fail, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  // Загрузка данных идёт в фоне; когда закончится, отчёт пересчитывается
  const sync = useSync(load);

  function pick(c: CatalogItem) {
    setCurrentId(c.id);
    setDays(c.defaultDays);
    setMaxDays(c.defaultMaxDays);
    setInfo('');
    setQuery('');
    setSourceFilter('');
    setOnlyTreatment(false);
    setAge('all');
    setShown(PAGE_ROWS);
  }

  async function createTasks() {
    if (!currentId) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const r = await api<{ created: number; skippedExisting: number }>('/tasks/from-report', {
        method: 'POST',
        body: JSON.stringify({ reportId: currentId, days, maxDays: maxDays || undefined, assigneeId: assignee || undefined }),
      });
      setInfo(t('rep.created', { created: r.created, skipped: r.skippedExisting }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function renderCell(key: string, v: Cell): ReactNode {
    if (key === 'rebooked') return <Badge tone={v ? 'green' : 'red'}>{v ? t('yes') : t('no')}</Badge>;
    if (key === 'source' && !v) return <span className="muted">{t('common.notSpecified')}</span>;
    if (v === null || v === '') return <span className="muted">—</span>;
    if (key === 'visitStatus') return <Badge tone={statusTone(String(v))}>{label('status', String(v))}</Badge>;
    if (key === 'kind') return <Badge tone={v === 'DID_NOT_COME' ? 'red' : v === 'CANCELLED' ? 'amber' : 'blue'}>{label('kind', String(v))}</Badge>;
    if (key === 'fullName' || key === 'source') return <span className="cell-main">{String(v)}</span>;
    if (/At$/.test(key)) return fmtDate(String(v));
    if (MONEY.has(key)) return key === 'debt' ? <b style={{ color: 'var(--red)' }}>{fmtNumber(Number(v))}</b> : fmtNumber(Number(v));
    if (key === 'windows') return <span style={{ whiteSpace: 'normal' }}>{String(v)}</span>;
    return String(v);
  }

  return (
    <>
      <PageHeader
        title={t('rep.title')}
        subtitle={t('rep.subtitle')}
        actions={
          <>
            <Link className="btn btn-primary" href="/reports/builder">{t('rb.open')}</Link>
            <button className="btn" onClick={sync.start} disabled={sync.busy}>
              <Icon name="refresh" size={16} /> {sync.busy ? t('common.wait') : t('common.refresh')}
            </button>
          </>
        }
      />

      <div className="tabs">
        {catalog.map((c) => (
          <button key={c.id} className={`tab${currentId === c.id ? ' active' : ''}`} onClick={() => pick(c)}>
            {c.title}
          </button>
        ))}
      </div>

      <SyncBar run={sync.run} />
      {(error || sync.error) && <Alert tone="error">{error || sync.error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      <Card
        flush
        title={report?.title ?? current?.title}
        actions={
          <>
            {current?.usesDays && (
              <label className="inline-label">
                {current.daysLabel}
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={730}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value) || current.defaultDays || 90)}
                />
              </label>
            )}
            {current?.defaultMaxDays && (
              <label className="inline-label">
                {t('rep.maxDays')}
                <input
                  className="input"
                  type="number"
                  min={days + 1}
                  max={3650}
                  value={maxDays ?? current.defaultMaxDays}
                  onChange={(e) => setMaxDays(Number(e.target.value) || current.defaultMaxDays)}
                />
              </label>
            )}
            {(['xlsx', 'pdf', 'csv'] as const).map((fmt) => (
              <button
                key={fmt}
                className="btn"
                onClick={() => currentId && downloadCsv(`/reports/${currentId}/${fmt}?days=${days}${maxDays ? `&maxDays=${maxDays}` : ''}`, `${currentId}.${fmt}`).catch((e) => setError(e.message))}
              >
                <Icon name="download" size={16} /> {fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}
              </button>
            ))}
          </>
        }
      >
        {report && (
          <p className="rule" style={{ padding: '0 20px' }}>
            <b>{t('rep.rule')}</b> {report.rule}. <b>{t('rep.updated')}</b>{' '}
            {report.dataUpdatedAt ? fmtDateTime(report.dataUpdatedAt) : t('common.neverSynced')}.
          </p>
        )}

        {weekly.length > 0 && (
          <ColumnChart
            data={weekly}
            ariaLabel={t('rep.unclosedChart')}
            tableTitle={t('rep.chartTable')}
            valueHead={t('rep.unclosedCount')}
            labelHead={t('rep.week')}
          />
        )}

        {current?.canCreateTasks && report && report.rows.some((r) => r.actionable !== 0) && (
          <div className="toolbar" style={{ padding: '0 20px 14px' }}>
            <select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{t('common.unassigned')}</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={createTasks} disabled={busy}>
              <Icon name="plus" size={16} /> {t('rep.createTasks')}
            </button>
          </div>
        )}

        {hasAge && report && (
          <div className="toolbar" style={{ padding: '0 20px 12px' }} role="group" aria-label={t('rep.ageLabel')}>
            {(['all', 'recent', 'mid', 'old'] as const).map((a) => (
              <button key={a} className={`btn btn-sm${age === a ? ' btn-primary' : ''}`} aria-pressed={age === a} onClick={() => { setAge(a); setShown(PAGE_ROWS); }}>
                {t(`rep.age.${a}` as never)} · {ageCount(a)}
              </button>
            ))}
          </div>
        )}

        {searchable && (
          <div className="toolbar" style={{ padding: '0 20px 14px' }}>
            {hasSource && sourceOptions.length > 1 && (
              <select className="select" value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); setShown(PAGE_ROWS); }}>
                <option value="">{t('rep.allSources')}</option>
                {sourceOptions.map((s) => (
                  <option key={s || '__none'} value={s || '__none'}>{s || t('common.notSpecified')}</option>
                ))}
              </select>
            )}
            {hasOpen && (
              <label className="check-row" style={{ margin: 0 }}>
                <input type="checkbox" checked={onlyTreatment} onChange={(e) => { setOnlyTreatment(e.target.checked); setShown(PAGE_ROWS); }} /> {t('rep.onlyTreatment')}
              </label>
            )}
            <input
              className="input grow"
              type="search"
              placeholder={t('rep.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE_ROWS);
              }}
              autoComplete="off"
            />
          </div>
        )}

        {loading && !report ? (
          <Loading />
        ) : report && rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {report.columns.map((c) => (
                    <th key={c.key} className={NUMERIC.has(c.key) ? 'num' : ''}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r, i) => (
                  <tr key={i}>
                    {report.columns.map((c) => (
                      <td key={c.key} className={NUMERIC.has(c.key) ? 'num' : ''}>{renderCell(c.key, r[c.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t('rep.empty')}>{t('rep.emptyHint')}</Empty>
        )}
        {report && rows.length > shown && (
          <div className="toolbar" style={{ padding: '14px 20px', justifyContent: 'center' }}>
            <button className="btn" onClick={() => setShown((n) => n + PAGE_ROWS)}>{t('rep.more', { n: Math.min(PAGE_ROWS, rows.length - shown) })}</button>
          </div>
        )}
        {report && rows.length > 0 && (
          <div className="table-foot">{filtered ? t('rep.rowsFound', { n: rows.length, total: report.rows.length }) : t('rep.rows', { n: report.rows.length })}</div>
        )}
      </Card>
    </>
  );
}
