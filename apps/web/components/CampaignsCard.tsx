'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { Alert, Badge, Card } from './ui';
import { useConfirm } from './ConfirmDialog';

interface Campaign {
  id: string;
  name: string;
  text: string;
  status: 'DRAFT' | 'QUEUED';
  queuedAt: string | null;
  queuedCount: number;
  filters: { monthsSinceVisitMin?: number; monthsSinceVisitMax?: number; noFutureVisit?: boolean };
}
interface Audience {
  matched: number;
  noConsent: number;
  paused: number;
  noChannel: number;
  tooSoon: number;
  toQueue: number;
  sample: { patient: string; text: string }[];
}

// Своя рассылка (акция и т. п.): текст, фильтр аудитории, предпросмотр «сколько человек получат», затем постановка в очередь
// на подтверждение. Только пациентам с согласием.
export function CampaignsCard({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [list, setList] = useState<Campaign[] | null>(null);
  const [form, setForm] = useState<{ name: string; text: string; min: string; max: string; noFuture: boolean } | null>(null);
  const [preview, setPreview] = useState<Record<string, Audience>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(() => api<Campaign[]>('/campaigns').then(setList).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!info) return;
    const id = setTimeout(() => setInfo(''), 6000);
    return () => clearTimeout(id);
  }, [info]);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (ok) setInfo(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!form) return;
      const filters: Record<string, unknown> = {};
      if (form.min !== '') filters.monthsSinceVisitMin = Number(form.min);
      if (form.max !== '') filters.monthsSinceVisitMax = Number(form.max);
      if (form.noFuture) filters.noFutureVisit = true;
      const c = await api<Campaign>('/campaigns', { method: 'POST', body: JSON.stringify({ name: form.name, text: form.text, filters }) });
      setForm(null);
      await load();
      setPreview((p) => ({ ...p, [c.id]: undefined as never }));
      await showPreview(c.id);
    }, t('camp.saved'));

  const showPreview = async (id: string) => {
    const a = await api<Audience>(`/campaigns/${id}/preview`);
    setPreview((p) => ({ ...p, [id]: a }));
  };

  const queue = async (c: Campaign, a: Audience) => {
    if (!(await ask(t('camp.queueConfirm', { n: a.toQueue }), { confirmLabel: t('camp.queue') }))) return;
    await run(async () => {
      await api(`/campaigns/${c.id}/queue`, { method: 'POST' });
      await load();
      onChanged();
    }, t('camp.queued', { n: a.toQueue }));
  };

  const remove = async (c: Campaign) => {
    if (!(await ask(t('camp.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') }))) return;
    await run(async () => {
      await api(`/campaigns/${c.id}`, { method: 'DELETE' });
      await load();
    });
  };

  const filtersText = (f: Campaign['filters']) =>
    [
      f.monthsSinceVisitMin !== undefined ? t('camp.fMin', { n: f.monthsSinceVisitMin }) : '',
      f.monthsSinceVisitMax !== undefined ? t('camp.fMax', { n: f.monthsSinceVisitMax }) : '',
      f.noFutureVisit ? t('camp.fNoFuture') : '',
    ]
      .filter(Boolean)
      .join(' · ') || t('camp.fAll');

  return (
    <Card title={t('camp.title')} actions={!form ? <button className="btn btn-sm btn-primary" onClick={() => setForm({ name: '', text: '', min: '', max: '', noFuture: false })}>{t('camp.new')}</button> : undefined}>
      {dialog}
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <p className="rule" style={{ marginTop: 0 }}>{t('camp.intro')}</p>

      {form && (
        <section className="rule-card">
          <label className="field">
            <span>{t('camp.name')}</span>
            <input className="input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span>{t('au.text')}</span>
            <textarea className="input" rows={4} maxLength={600} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder={t('camp.textPlaceholder')} />
          </label>
          <p className="rule" style={{ margin: '4px 0 8px' }}>{t('au.vars')}</p>
          <div className="toolbar">
            <label className="inline-label">
              {t('camp.min')}
              <input className="input" type="number" min={0} max={120} value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} style={{ width: 90 }} />
            </label>
            <label className="inline-label">
              {t('camp.max')}
              <input className="input" type="number" min={0} max={120} value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} style={{ width: 90 }} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.noFuture} onChange={(e) => setForm({ ...form, noFuture: e.target.checked })} />
            <span>{t('camp.noFuture')}</span>
          </label>
          <div className="toolbar">
            <button className="btn btn-primary" disabled={busy || form.name.trim().length < 2 || form.text.trim().length < 10} onClick={save}>{t('camp.create')}</button>
            <button className="btn" disabled={busy} onClick={() => setForm(null)}>{t('common.cancel')}</button>
          </div>
        </section>
      )}

      {list && list.length === 0 && !form && <p className="muted">{t('camp.empty')}</p>}
      {list?.map((c) => {
        const a = preview[c.id];
        return (
          <section key={c.id} className="rule-card">
            <div className="rule-head">
              <b>{c.name}</b>
              <Badge tone={c.status === 'QUEUED' ? 'green' : 'gray'}>{c.status === 'QUEUED' ? t('camp.stQueued') : t('camp.stDraft')}</Badge>
            </div>
            <p className="rule" style={{ margin: '4px 0' }}>{c.text}</p>
            <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>{filtersText(c.filters)}</p>
            {c.status === 'QUEUED' ? (
              <p className="rule">{t('camp.queuedInfo', { n: c.queuedCount, date: fmtDateTime(c.queuedAt) })}</p>
            ) : (
              <>
                {a && (
                  <div className="rule-preview">
                    <b>{t('camp.audience')}:</b> {t('camp.audienceLine', { m: a.matched, q: a.toQueue })}
                    {a.noConsent > 0 && <span> · {t('au.noConsent', { n: a.noConsent })}</span>}
                    {a.paused > 0 && <span> · {t('au.paused', { n: a.paused })}</span>}
                    {a.noChannel > 0 && <span> · {t('au.noChannel', { n: a.noChannel })}</span>}
                    {a.tooSoon > 0 && <span> · {t('au.tooSoon', { n: a.tooSoon })}</span>}
                    {a.sample.length > 0 && (
                      <ul className="sample">
                        {a.sample.map((s, i) => (
                          <li key={i}><b>{s.patient}:</b> {s.text}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="toolbar" style={{ marginTop: 8 }}>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run(() => showPreview(c.id))}>{t('camp.preview')}</button>
                  <button className="btn btn-sm btn-primary" disabled={busy || !a || a.toQueue === 0} onClick={() => a && queue(c, a)}>{t('camp.queue')}</button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => remove(c)}>{t('common.delete')}</button>
                </div>
              </>
            )}
          </section>
        );
      })}
    </Card>
  );
}
