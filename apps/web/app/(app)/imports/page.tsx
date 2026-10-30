'use client';

import { DragEvent, useCallback, useEffect, useState } from 'react';
import { api, download, upload } from '../../../lib/api';
import { Key, useI18n } from '../../../lib/i18n';
import { fmtDateTime } from '../../../lib/ui';
import { Alert, Badge, Card, Empty, Icon, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

type ImportType = 'PATIENT_EXTRA' | 'CONTACTS';
type MatchBy = 'PHONE' | 'NAME' | 'EXTERNAL_ID';
type Stage = 'file' | 'mapping' | 'check' | 'done';

interface Batch {
  id: string;
  filename: string;
  columns: string[];
  sampleRows: string[][];
  totalRows: number;
  suggestions: { phone?: string; name?: string; externalId?: string; date?: string; outcome?: string; note?: string };
}

interface Summary {
  total: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  emptyKey: number;
  duplicateKeys: number;
  fieldsToSet: number;
  fieldsSkippedFilled: number;
  patientsToUpdate: number;
  contactsToCreate: number;
  contactsDuplicate: number;
  badDates: number;
  samples: { unmatched: { row: number; key: string }[]; ambiguous: { row: number; key: string }[] };
}

interface HistoryRow {
  id: string;
  filename: string;
  type: string | null;
  status: 'DRAFT' | 'DONE';
  createdAt: string;
  user: string | null;
  matched: number | null;
  unmatched: number | null;
  undoneAt: string | null;
}

const CHANNELS = ['PHONE', 'MESSENGER', 'SMS', 'EMAIL', 'VISIT', 'OTHER'];

export default function ImportsPage() {
  const { t, label } = useI18n();
  const { ask, dialog } = useConfirm();
  const [stage, setStage] = useState<Stage>('file');
  const [type, setType] = useState<ImportType>('PATIENT_EXTRA');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [matchBy, setMatchBy] = useState<MatchBy>('PHONE');
  const [matchColumn, setMatchColumn] = useState('');
  const [fields, setFields] = useState<Record<string, string | null>>({}); // столбец -> название поля (null: не сохранять)
  const [dateColumn, setDateColumn] = useState('');
  const [outcomeColumn, setOutcomeColumn] = useState('');
  const [noteColumn, setNoteColumn] = useState('');
  const [channel, setChannel] = useState('PHONE');
  const [overwrite, setOverwrite] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');

  const loadHistory = useCallback(() => {
    api<HistoryRow[]>('/imports').then(setHistory).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(loadHistory, [loadHistory]);

  function reset() {
    setStage('file');
    setBatch(null);
    setSummary(null);
    setFields({});
    setError('');
    loadHistory();
  }

  async function onFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const b = await upload<Batch>('/imports', file);
      setBatch(b);
      // Подсказки сервера: какой столбец похож на телефон, ФИО, дату, результат и комментарий
      const s = b.suggestions;
      if (s.phone) { setMatchBy('PHONE'); setMatchColumn(s.phone); }
      else if (s.name) { setMatchBy('NAME'); setMatchColumn(s.name); }
      else if (s.externalId) { setMatchBy('EXTERNAL_ID'); setMatchColumn(s.externalId); }
      else setMatchColumn(b.columns[0]);
      setDateColumn(s.date ?? '');
      setOutcomeColumn(s.outcome ?? '');
      setNoteColumn(s.note ?? '');
      setFields({});
      setStage('mapping');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDrag(false);
    void onFile(e.dataTransfer.files[0]);
  };

  function mapping() {
    if (type === 'PATIENT_EXTRA') {
      return {
        type, matchBy, matchColumn, overwrite,
        fields: Object.entries(fields).filter(([, v]) => v !== null).map(([column, name]) => ({ column, label: (name as string).trim() || column })),
      };
    }
    return {
      type, matchBy, matchColumn, channel, dateColumn,
      outcomeColumn: outcomeColumn || undefined,
      noteColumn: noteColumn || undefined,
    };
  }

  const ready = !!matchColumn && (type === 'PATIENT_EXTRA' ? Object.values(fields).some((v) => v !== null) : !!dateColumn);

  async function run(kind: 'dry-run' | 'apply') {
    if (!batch) return;
    setBusy(true);
    setError('');
    try {
      setSummary(await api<Summary>(`/imports/${batch.id}/${kind}`, { method: 'POST', body: JSON.stringify(mapping()) }));
      setStage(kind === 'dry-run' ? 'check' : 'done');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (batch) await api(`/imports/${batch.id}`, { method: 'DELETE' }).catch(() => undefined);
    reset();
  }

  const steps: [Stage, Key][] = [['file', 'imp.what'], ['mapping', 'imp.fields'], ['check', 'imp.sumTitle'], ['done', 'imp.done']];
  const order = steps.map(([s]) => s);

  const Item = ({ value, text, tone }: { value: number; text: string; tone?: 'warn' | 'ok' }) => (
    <div className={`sum-item${tone ? ' ' + tone : ''}`}><b>{value}</b><span>{text}</span></div>
  );

  const columnSelect = (value: string, onChange: (v: string) => void, optional = false) => (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {optional && <option value="">{t('imp.none')}</option>}
      {batch?.columns.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );

  return (
    <>
      {dialog}
      <PageHeader title={t('imp.title')} subtitle={t('imp.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}

      <div className="steps">
        {steps.map(([s, k], i) => (
          <span key={s} className={`step${stage === s ? ' active' : order.indexOf(stage) > i ? ' done' : ''}`}>{i + 1}. {t(k)}</span>
        ))}
      </div>

      {stage === 'file' && (
        <Card title={t('imp.what')}>
          <button type="button" className={`choice${type === 'PATIENT_EXTRA' ? ' selected' : ''}`} onClick={() => setType('PATIENT_EXTRA')}>
            <b>{t('imp.typeExtra')}</b><span>{t('imp.typeExtraHint')}</span>
          </button>
          <button type="button" className={`choice${type === 'CONTACTS' ? ' selected' : ''}`} onClick={() => setType('CONTACTS')}>
            <b>{t('imp.typeContacts')}</b><span>{t('imp.typeContactsHint')}</span>
          </button>
          <label className={`dropzone${drag ? ' drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
            <Icon name="upload" size={28} />
            <div style={{ marginTop: 8 }}>{busy ? t('imp.uploading') : t('imp.choose')}</div>
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </Card>
      )}

      {stage === 'mapping' && batch && (
        <>
          <Card title={batch.filename}>
            <p className="rule">{t('imp.found', { rows: batch.totalRows, cols: batch.columns.length })}</p>
            <b style={{ fontSize: 13 }}>{t('imp.sample')}</b>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="sample-table">
                <thead><tr>{batch.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{batch.sampleRows.slice(0, 5).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </Card>

          <Card title={t('imp.matchBy')}>
            <div className="form-grid">
              <div className="field">
                <label>{t('imp.matchBy')}</label>
                <select className="select" value={matchBy} onChange={(e) => setMatchBy(e.target.value as MatchBy)}>
                  <option value="PHONE">{t('imp.byPhone')}</option>
                  <option value="NAME">{t('imp.byName')}</option>
                  <option value="EXTERNAL_ID">{t('imp.byId')}</option>
                </select>
              </div>
              <div className="field">
                <label>{t('imp.matchColumn')}</label>
                {columnSelect(matchColumn, setMatchColumn)}
              </div>
            </div>
          </Card>

          {type === 'PATIENT_EXTRA' ? (
            <Card title={t('imp.fields')}>
              {batch.columns.filter((c) => c !== matchColumn).map((c) => (
                <div key={c} className="toolbar" style={{ marginBottom: 10 }}>
                  <label className="checkbox" style={{ minWidth: 180 }}>
                    <input type="checkbox" checked={fields[c] !== undefined && fields[c] !== null} onChange={(e) => setFields({ ...fields, [c]: e.target.checked ? c : null })} />
                    {c}
                  </label>
                  {fields[c] !== undefined && fields[c] !== null && (
                    <input className="input grow" aria-label={t('imp.fieldLabel')} placeholder={t('imp.fieldLabel')} value={fields[c] ?? ''} maxLength={60} onChange={(e) => setFields({ ...fields, [c]: e.target.value })} />
                  )}
                </div>
              ))}
              <label className="checkbox" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> {t('imp.overwrite')}
              </label>
              <p className="rule" style={{ margin: '6px 0 0' }}>{t('imp.overwriteHint')}</p>
            </Card>
          ) : (
            <Card title={t('imp.typeContacts')}>
              <div className="form-grid">
                <div className="field"><label>{t('imp.dateColumn')}</label>{columnSelect(dateColumn, setDateColumn, true)}</div>
                <div className="field"><label>{t('imp.outcomeColumn')}</label>{columnSelect(outcomeColumn, setOutcomeColumn, true)}</div>
                <div className="field"><label>{t('imp.noteColumn')}</label>{columnSelect(noteColumn, setNoteColumn, true)}</div>
                <div className="field">
                  <label>{t('imp.channel')}</label>
                  <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                    {CHANNELS.map((c) => <option key={c} value={c}>{label('channel', c)}</option>)}
                  </select>
                </div>
              </div>
            </Card>
          )}

          <div className="toolbar">
            <button className="btn btn-primary" disabled={!ready || busy} onClick={() => run('dry-run')}>{busy ? t('common.wait') : t('imp.check')}</button>
            <button className="btn" onClick={discard}>{t('imp.discard')}</button>
          </div>
        </>
      )}

      {(stage === 'check' || stage === 'done') && summary && batch && (
        <Card title={stage === 'done' ? t('imp.done') : t('imp.sumTitle')}>
          {stage === 'check' && <Alert tone="info">{t('imp.noWrite')}</Alert>}
          <div className="sum-grid">
            <Item value={summary.total} text={t('imp.sumTotal')} />
            <Item value={summary.matched} text={t('imp.sumMatched')} tone="ok" />
            {type === 'PATIENT_EXTRA' ? (
              <>
                <Item value={summary.patientsToUpdate} text={t('imp.sumPatients')} tone="ok" />
                <Item value={summary.fieldsToSet} text={t('imp.sumFields')} tone="ok" />
                {summary.fieldsSkippedFilled > 0 && <Item value={summary.fieldsSkippedFilled} text={t('imp.sumSkipped')} />}
              </>
            ) : (
              <>
                <Item value={summary.contactsToCreate} text={t('imp.sumContacts')} tone="ok" />
                {summary.contactsDuplicate > 0 && <Item value={summary.contactsDuplicate} text={t('imp.sumContactsDup')} />}
                {summary.badDates > 0 && <Item value={summary.badDates} text={t('imp.sumBadDates')} tone="warn" />}
              </>
            )}
            {summary.unmatched > 0 && <Item value={summary.unmatched} text={t('imp.sumUnmatched')} tone="warn" />}
            {summary.ambiguous > 0 && <Item value={summary.ambiguous} text={t('imp.sumAmbiguous')} tone="warn" />}
            {summary.emptyKey > 0 && <Item value={summary.emptyKey} text={t('imp.sumEmpty')} tone="warn" />}
            {summary.duplicateKeys > 0 && <Item value={summary.duplicateKeys} text={t('imp.sumDup')} tone="warn" />}
          </div>

          {summary.samples.unmatched.length > 0 && (
            <p className="rule"><b>{t('imp.sampleUnmatched')}:</b> {summary.samples.unmatched.map((s) => `${s.key} (${t('imp.rowN', { n: s.row })})`).join(', ')}</p>
          )}
          {summary.samples.ambiguous.length > 0 && (
            <p className="rule"><b>{t('imp.sampleAmbiguous')}:</b> {summary.samples.ambiguous.map((s) => `${s.key} (${t('imp.rowN', { n: s.row })})`).join(', ')}</p>
          )}

          <div className="toolbar">
            {stage === 'check' ? (
              <>
                <button className="btn btn-primary" disabled={busy} onClick={() => run('apply')}>{busy ? t('common.wait') : t('imp.apply')}</button>
                <button className="btn" onClick={() => setStage('mapping')}>{t('common.back')}</button>
                <button className="btn" onClick={discard}>{t('imp.discard')}</button>
              </>
            ) : (
              <>
                {summary.total > summary.matched && (
                  <button className="btn" onClick={() => download(`/imports/${batch.id}/unmatched.csv`, 'unmatched.csv').catch((e) => setError((e as Error).message))}>
                    <Icon name="download" size={16} /> {t('imp.downloadUnmatched')}
                  </button>
                )}
                <button className="btn btn-primary" onClick={reset}>{t('imp.another')}</button>
              </>
            )}
          </div>
        </Card>
      )}

      <Card flush title={t('imp.history')}>
        {history === null ? (
          <Loading />
        ) : !history.length ? (
          <Empty title={t('imp.noHistory')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('imp.colFile')}</th><th>{t('imp.colType')}</th><th>{t('imp.colStatus')}</th>
                  <th className="num">{t('imp.colMatched')}</th><th className="num">{t('imp.colSkipped')}</th>
                  <th>{t('imp.colWho')}</th><th>{t('imp.colWhen')}</th><th>{t('imp.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="cell-main">{h.filename}</td>
                    <td>{h.type ? label('imp.type', h.type) : '—'}</td>
                    <td><Badge tone={h.undoneAt ? 'gray' : h.status === 'DONE' ? 'green' : 'amber'}>{h.undoneAt ? t('imp.statusUNDONE') : h.status === 'DONE' ? t('imp.statusDONE') : t('imp.statusDRAFT')}</Badge></td>
                    <td className="num">{h.matched ?? '—'}</td>
                    <td className="num">{h.unmatched ?? '—'}</td>
                    <td>{h.user ?? '—'}</td>
                    <td>{fmtDateTime(h.createdAt)}</td>
                    <td>
                      {h.status === 'DONE' && !h.undoneAt && (
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            if (!(await ask(t('imp.undoConfirm', { name: h.filename }), { danger: true, confirmLabel: t('imp.undo') }))) return;
                            api(`/imports/${h.id}/undo`, { method: 'POST' }).then(() => loadHistory()).catch((e) => setError((e as Error).message));
                          }}
                        >
                          {t('imp.undo')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
