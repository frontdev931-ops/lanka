'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, downloadPost } from '../../../../lib/api';
import { useI18n } from '../../../../lib/i18n';
import { fmtDateTime, fmtNumber } from '../../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, Loading, PageHeader } from '../../../../components/ui';
import { useConfirm } from '../../../../components/ConfirmDialog';
import { MiniBars } from '../../../../components/MiniBars';

interface FieldInfo {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'enum';
  money: boolean;
  ops: string[];
  values?: Record<string, string>;
}
interface DatasetInfo {
  id: string;
  label: string;
  fields: FieldInfo[];
}
interface Filter {
  field: string;
  op: string;
  value: string;
}
interface Spec {
  dataset: string;
  columns?: string[];
  filters?: { field: string; op: string; value?: unknown }[];
  groupBy?: { field: string; bucket?: 'month' | 'day' };
  aggregates?: { fn: string; field?: string }[];
  sort?: { field: string; dir: 'asc' | 'desc' };
}
interface Result {
  title: string;
  rule: string;
  dataUpdatedAt: string | null;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
  total: number;
}
interface Saved {
  id: string;
  name: string;
  spec: Spec;
  createdAt: string;
}

export default function ReportBuilderPage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [catalog, setCatalog] = useState<DatasetInfo[] | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [dataset, setDataset] = useState('');
  const [mode, setMode] = useState<'list' | 'group'>('list');
  const [columns, setColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [groupField, setGroupField] = useState('');
  const [bucket, setBucket] = useState('');
  const [aggs, setAggs] = useState<{ fn: string; field: string }[]>([{ fn: 'count', field: '' }]);
  const [sortField, setSortField] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [result, setResult] = useState<Result | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const loadSaved = useCallback(() => api<Saved[]>('/report-builder/saved').then(setSaved).catch(() => undefined), []);
  useEffect(() => {
    api<DatasetInfo[]>('/report-builder/catalog')
      .then((c) => {
        setCatalog(c);
        if (c[0]) pick(c[0].id, c);
      })
      .catch((e) => setError((e as Error).message));
    loadSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 5000);
    return () => clearTimeout(id);
  }, [info]);

  const ds = catalog?.find((d) => d.id === dataset);
  const fld = (k: string) => ds?.fields.find((f) => f.key === k);

  function pick(id: string, c = catalog) {
    const d = c?.find((x) => x.id === id);
    setDataset(id);
    setColumns(d ? d.fields.slice(0, 4).map((f) => f.key) : []);
    setFilters([]);
    setGroupField('');
    setBucket('');
    setAggs([{ fn: 'count', field: '' }]);
    setSortField('');
    setResult(null);
  }

  const spec = (): Spec => {
    const f = filters.filter((x) => x.field && (['isNull', 'notNull'].includes(x.op) || x.value !== '')).map((x) => ({ field: x.field, op: x.op, ...(['isNull', 'notNull'].includes(x.op) ? {} : { value: x.op === 'in' ? x.value.split(',').map((v) => v.trim()).filter(Boolean) : fld(x.field)?.type === 'number' ? Number(x.value) : x.value }) }));
    if (mode === 'group') {
      return { dataset, filters: f, groupBy: { field: groupField, ...(bucket ? { bucket: bucket as 'month' | 'day' } : {}) }, aggregates: aggs.map((a) => (a.fn === 'count' ? { fn: 'count' } : { fn: a.fn, field: a.field })), ...(sortField ? { sort: { field: sortField, dir: sortDir } } : {}) };
    }
    return { dataset, columns, filters: f, ...(sortField ? { sort: { field: sortField, dir: sortDir } } : {}) };
  };

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api<Result>('/report-builder/run', { method: 'POST', body: JSON.stringify({ spec: spec() }) }));
    } catch (e) {
      const err = e as Error;
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (fmt: 'xlsx' | 'pdf' | 'csv') => {
    setError('');
    try {
      await downloadPost('/report-builder/export', { spec: spec(), format: fmt, title: name || undefined }, `report.${fmt}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/report-builder/saved', { method: 'POST', body: JSON.stringify({ name, spec: spec() }) });
      setName('');
      setInfo(t('rb.saved'));
      await loadSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = (s: Saved) => {
    const sp = s.spec;
    setDataset(sp.dataset);
    setFilters((sp.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value === undefined ? '' : Array.isArray(f.value) ? f.value.join(', ') : String(f.value) })));
    setMode(sp.groupBy ? 'group' : 'list');
    setColumns(sp.columns ?? []);
    setGroupField(sp.groupBy?.field ?? '');
    setBucket(sp.groupBy?.bucket ?? '');
    setAggs((sp.aggregates ?? [{ fn: 'count' }]).map((a) => ({ fn: a.fn, field: a.field ?? '' })));
    setSortField(sp.sort?.field ?? '');
    setSortDir(sp.sort?.dir ?? 'asc');
    setName(s.name);
    setResult(null);
  };

  const remove = async (s: Saved) => {
    if (!(await ask(t('rb.deleteConfirm', { name: s.name }), { danger: true, confirmLabel: t('common.delete') }))) return;
    await api(`/report-builder/saved/${s.id}`, { method: 'DELETE' }).catch((e) => setError((e as Error).message));
    loadSaved();
  };

  if (!catalog) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const numeric = ds?.fields.filter((f) => f.type === 'number') ?? [];
  const sortOptions = result?.columns ?? [];
  const canRun = mode === 'list' ? columns.length > 0 : !!groupField && aggs.every((a) => a.fn === 'count' || a.field);

  return (
    <>
      {dialog}
      <PageHeader title={t('rb.title')} subtitle={t('rb.subtitle')} actions={<Link className="btn" href="/reports">{t('common.back')}</Link>} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}

      {saved.length > 0 && (
        <Card title={t('rb.savedTitle')}>
          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            {saved.map((s) => (
              <span key={s.id} className="btn-group">
                <button className="btn btn-sm" onClick={() => open(s)}>{s.name}</button>
                <button className="btn btn-sm" aria-label={t('common.delete')} onClick={() => remove(s)}>×</button>
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card title={t('rb.what')}>
        <label className="field">
          <span>{t('rb.dataset')}</span>
          <select className="select" value={dataset} onChange={(e) => pick(e.target.value)}>
            {catalog.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>

        <div className="tabs-row" role="tablist">
          <button className={mode === 'list' ? 'btn btn-primary' : 'btn'} role="tab" aria-selected={mode === 'list'} onClick={() => setMode('list')}>{t('rb.modeList')}</button>
          <button className={mode === 'group' ? 'btn btn-primary' : 'btn'} role="tab" aria-selected={mode === 'group'} onClick={() => setMode('group')}>{t('rb.modeGroup')}</button>
        </div>

        {mode === 'list' ? (
          <fieldset className="rb-fields">
            <legend>{t('rb.columns')}</legend>
            {ds?.fields.map((f) => (
              <label key={f.key} className="check-row" style={{ margin: 0, minHeight: 36 }}>
                <input type="checkbox" checked={columns.includes(f.key)} onChange={(e) => setColumns((c) => (e.target.checked ? [...c, f.key] : c.filter((x) => x !== f.key)))} />
                <span>{f.label}{f.money ? ' ₴' : ''}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <>
            <div className="toolbar">
              <label className="field" style={{ margin: 0 }}>
                <span>{t('rb.groupBy')}</span>
                <select className="select" value={groupField} onChange={(e) => { setGroupField(e.target.value); setBucket(''); }}>
                  <option value="">—</option>
                  {ds?.fields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </label>
              {fld(groupField)?.type === 'date' && (
                <label className="field" style={{ margin: 0 }}>
                  <span>{t('rb.bucket')}</span>
                  <select className="select" value={bucket} onChange={(e) => setBucket(e.target.value)}>
                    <option value="">{t('rb.bucketDay')}</option>
                    <option value="month">{t('rb.bucketMonth')}</option>
                  </select>
                </label>
              )}
            </div>
            <p className="rule" style={{ marginBottom: 4 }}>{t('rb.calc')}</p>
            {aggs.map((a, i) => (
              <div key={i} className="toolbar" style={{ marginBottom: 6 }}>
                <select className="select" value={a.fn} onChange={(e) => setAggs((x) => x.map((y, j) => (j === i ? { fn: e.target.value, field: e.target.value === 'count' ? '' : numeric[0]?.key ?? '' } : y)))}>
                  {['count', 'sum', 'avg', 'min', 'max'].map((fn) => (
                    <option key={fn} value={fn} disabled={fn !== 'count' && !numeric.length}>{t(`rb.fn.${fn}` as never)}</option>
                  ))}
                </select>
                {a.fn !== 'count' && (
                  <select className="select" value={a.field} onChange={(e) => setAggs((x) => x.map((y, j) => (j === i ? { ...y, field: e.target.value } : y)))}>
                    {numeric.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                )}
                {aggs.length > 1 && <button className="btn btn-sm" aria-label={t('common.delete')} onClick={() => setAggs((x) => x.filter((_, j) => j !== i))}>×</button>}
              </div>
            ))}
            {aggs.length < 4 && <button className="btn btn-sm" onClick={() => setAggs((x) => [...x, { fn: 'count', field: '' }])}>+ {t('rb.addCalc')}</button>}
          </>
        )}
      </Card>

      <Card title={t('rb.filters')}>
        {filters.length === 0 && <p className="muted" style={{ marginTop: 0 }}>{t('rb.noFilters')}</p>}
        {filters.map((f, i) => {
          const x = fld(f.field);
          const set = (patch: Partial<Filter>) => setFilters((all) => all.map((y, j) => (j === i ? { ...y, ...patch } : y)));
          const ops = x?.ops ?? [];
          return (
            <div key={i} className="rb-filter">
              <select className="select" value={f.field} onChange={(e) => { const nx = fld(e.target.value); set({ field: e.target.value, op: nx?.ops[0] ?? 'eq', value: '' }); }}>
                {ds?.fields.map((y) => (
                  <option key={y.key} value={y.key}>{y.label}</option>
                ))}
              </select>
              <select className="select" value={f.op} onChange={(e) => set({ op: e.target.value })}>
                {ops.map((o) => (
                  <option key={o} value={o}>{t(`rb.op.${o}` as never)}</option>
                ))}
              </select>
              {['isNull', 'notNull'].includes(f.op) ? null : f.op === 'in' ? (
                <input className="input" value={f.value} onChange={(e) => set({ value: e.target.value })} placeholder={x?.type === 'enum' ? Object.keys(x.values ?? {}).slice(0, 3).join(', ') : t('rb.inPlaceholder')} />
              ) : x?.type === 'enum' ? (
                <select className="select" value={f.value} onChange={(e) => set({ value: e.target.value })}>
                  <option value="">—</option>
                  {Object.entries(x.values ?? {}).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              ) : (
                <input className="input" type={x?.type === 'number' ? 'number' : 'text'} value={f.value} onChange={(e) => set({ value: e.target.value })} placeholder={x?.type === 'date' ? t('rb.datePlaceholder') : ''} />
              )}
              <button className="btn btn-sm" aria-label={t('common.delete')} onClick={() => setFilters((all) => all.filter((_, j) => j !== i))}>×</button>
            </div>
          );
        })}
        <button className="btn btn-sm" onClick={() => ds && setFilters((all) => [...all, { field: ds.fields[0].key, op: ds.fields[0].ops[0], value: '' }])}>+ {t('rb.addFilter')}</button>
      </Card>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn btn-primary" disabled={busy || !canRun} onClick={run}>{busy ? t('common.wait') : t('rb.run')}</button>
      </div>

      {result && (
        <Card
          title={result.title}
          actions={
            <>
              {(['xlsx', 'pdf', 'csv'] as const).map((fmt) => (
                <button key={fmt} className="btn btn-sm" onClick={() => exportAs(fmt)}>
                  <Icon name="download" size={14} /> {fmt === 'xlsx' ? 'Excel' : fmt.toUpperCase()}
                </button>
              ))}
            </>
          }
        >
          <p className="rule" style={{ marginTop: 0 }}>
            {result.rule}
            {result.dataUpdatedAt ? ` · ${t('rep.updated')}: ${fmtDateTime(result.dataUpdatedAt)}` : ''}
          </p>
          {result.rows.length === 0 ? (
            <Empty title={t('rb.empty')} />
          ) : (
            <>
              <div className="toolbar">
                <label className="inline-label">
                  {t('rb.sort')}
                  <select className="select" value={sortField} onChange={(e) => setSortField(e.target.value)}>
                    <option value="">—</option>
                    {(mode === 'list' ? sortOptions : sortOptions).map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </label>
                <select className="select" value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}>
                  <option value="asc">{t('rb.asc')}</option>
                  <option value="desc">{t('rb.desc')}</option>
                </select>
                <button className="btn btn-sm" disabled={busy} onClick={run}>{t('rb.apply')}</button>
              </div>
              {mode === 'group' && result.columns.length === 2 && result.rows.length > 1 && result.rows.length <= 40 && <MiniBars rows={result.rows} labelKey={result.columns[0].key} valueKey={result.columns[1].key} />}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>
                        {result.columns.map((c) => (
                          <td key={c.key}>{typeof r[c.key] === 'number' ? fmtNumber(r[c.key] as number) : r[c.key] ?? '—'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                {t('rb.shown', { n: result.rows.length, total: result.total })} {result.truncated && <Badge tone="amber">{t('rb.moreInFile')}</Badge>}
              </p>
            </>
          )}
          <div className="toolbar" style={{ marginTop: 10 }}>
            <input className="input" style={{ maxWidth: 280 }} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('rb.namePlaceholder')} maxLength={120} />
            <button className="btn" disabled={busy || name.trim().length < 2} onClick={save}>{t('rb.save')}</button>
          </div>
        </Card>
      )}
    </>
  );
}
