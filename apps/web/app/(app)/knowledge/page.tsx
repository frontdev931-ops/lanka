'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { Alert, Badge, Card, Empty, Loading, PageHeader } from '../../../components/ui';
import { useConfirm } from '../../../components/ConfirmDialog';

type Kind = 'SERVICE' | 'DOCTOR' | 'LOCATION' | 'FAQ';
interface Item {
  id: string;
  kind: Kind;
  title: string;
  category: string | null;
  text: string;
  durationMin: number | null;
  priceUah: number | null;
  active: boolean;
  source: string;
  approved: boolean;
  stale: boolean;
}
interface Data {
  items: Item[];
  summary: { total: number; approved: number; drafts: number; stale: number };
}
const KINDS: Kind[] = ['SERVICE', 'DOCTOR', 'LOCATION', 'FAQ'];

// What the AI may tell patients. Only approved entries reach it; a changed entry waits for a new approval;
// a price older than 90 days without confirmation is not quoted.
export default function KnowledgePage() {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState<Data | null>(null);
  const [kind, setKind] = useState<Kind>('SERVICE');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<string, Partial<Item> & { priceText?: string; durText?: string }>>({});
  const [draft, setDraft] = useState({ title: '', text: '', price: '', dur: '' });
  const [me, setMe] = useState<{ role: string } | null>(null);
  const canEdit = me?.role === 'OWNER' || me?.role === 'MANAGER';

  const load = useCallback(() => api<Data>('/knowledge').then(setData).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
    api<{ role: string }>('/auth/me').then(setMe).catch(() => undefined);
  }, [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s));
  const field = (i: Item) => edits[i.id] ?? {};
  const patch = (i: Item, p: Record<string, unknown>) => setEdits({ ...edits, [i.id]: { ...field(i), ...p } });

  async function save(i: Item) {
    const e = field(i);
    await act(async () => {
      await api(`/knowledge/${i.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: e.title ?? i.title, text: e.text ?? i.text, ...(i.kind === 'SERVICE' ? { priceUah: e.priceText !== undefined ? num(e.priceText) : i.priceUah, durationMin: e.durText !== undefined ? num(e.durText) : i.durationMin } : {}) }),
      });
      setEdits({ ...edits, [i.id]: {} });
    }, t('kb.saved'));
  }

  if (!data) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  const rows = data.items.filter((i) => i.kind === kind);
  // Drafts per price-list group, so that a whole group can be approved after one look
  const draftGroups = [...rows.filter((i) => !i.approved).reduce((m, i) => m.set(i.category ?? '', (m.get(i.category ?? '') ?? 0) + 1), new Map<string, number>())];
  const s = data.summary;

  return (
    <>
      {dialog}
      <PageHeader title={t('kb.title')} subtitle={t('kb.subtitle')} />
      {error && <Alert tone="error">{error}</Alert>}
      {info && <Alert tone="success">{info}</Alert>}
      <Alert tone="info">{t('kb.rules')}</Alert>
      <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <section className="card stat"><div className="stat-top">{t('kb.approved')}</div><div className="stat-value">{s.approved}</div></section>
        <section className="card stat"><div className="stat-top">{t('kb.drafts')}</div><div className="stat-value">{s.drafts}</div></section>
        <section className="card stat"><div className="stat-top">{t('kb.stale')}</div><div className="stat-value">{s.stale}</div></section>
      </div>

      <div className="toolbar" role="tablist" style={{ marginBottom: 10 }}>
        {KINDS.map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'btn btn-primary' : 'btn'} onClick={() => setKind(k)}>{t(`kb.kind.${k}`)}</button>
        ))}
        {canEdit && kind === 'SERVICE' && (
          <button className="btn" disabled={busy} onClick={() => act(async () => { const r = await api<{ added: number }>('/knowledge/import/services', { method: 'POST' }); setInfo(t('kb.imported', { n: r.added })); })}>{t('kb.import')}</button>
        )}
      </div>

      {canEdit && draftGroups.length > 1 && (
        <Card title={t('kb.groupsTitle')}>
          <p className="rule" style={{ marginTop: 0 }}>{t('kb.groupsHint')}</p>
          {draftGroups.map(([g, n]) => (
            <div key={g || '-'} className="toolbar" style={{ justifyContent: 'space-between' }}>
              <span>{g || t('kb.noGroup')} · {n}</span>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (!(await ask(t('kb.groupConfirm', { name: g || t('kb.noGroup'), n }), { confirmLabel: t('kb.approve') }))) return;
                  await act(async () => {
                    const r = await api<{ approved: number; skipped: number }>('/knowledge/approve-group', { method: 'POST', body: JSON.stringify({ kind, category: g || null }) });
                    setInfo(t('kb.groupDone', { a: r.approved, s: r.skipped }));
                  });
                }}
              >
                {t('kb.approveGroup')}
              </button>
            </div>
          ))}
        </Card>
      )}

      {canEdit && (
        <Card title={t('kb.add')}>
          <div className="toolbar" style={{ alignItems: 'flex-end' }}>
            <label className="field grow" style={{ margin: 0 }}><span>{kind === 'FAQ' ? t('kb.question') : t('kb.name')}</span><input className="input" value={draft.title} maxLength={160} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            {kind === 'SERVICE' && (
              <>
                <label className="field" style={{ margin: 0 }}><span>{t('kb.price')}</span><input className="input" type="number" min={0} style={{ width: 120 }} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /></label>
                <label className="field" style={{ margin: 0 }}><span>{t('kb.duration')}</span><input className="input" type="number" min={5} step={5} style={{ width: 100 }} value={draft.dur} onChange={(e) => setDraft({ ...draft, dur: e.target.value })} /></label>
              </>
            )}
          </div>
          <label className="field"><span>{t(`kb.text.${kind}`)}</span><textarea className="input" rows={2} maxLength={900} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></label>
          <button
            className="btn btn-primary"
            disabled={busy || !draft.title.trim()}
            onClick={() => act(async () => { await api('/knowledge', { method: 'POST', body: JSON.stringify({ kind, title: draft.title, text: draft.text, ...(kind === 'SERVICE' ? { priceUah: num(draft.price), durationMin: num(draft.dur) } : {}) }) }); setDraft({ title: '', text: '', price: '', dur: '' }); }, t('kb.added'))}
          >
            {t('kb.addBtn')}
          </button>
        </Card>
      )}

      <Card flush title={t(`kb.kind.${kind}`)}>
        {rows.length === 0 ? (
          <Empty title={t('kb.empty')}>{t('kb.emptyHint')}</Empty>
        ) : (
          rows.map((i) => {
            const e = field(i);
            return (
              <div key={i.id} className="req-item">
                <span className="chat-name">
                  <b>{i.title}</b>
                  {i.category && <span className="muted">{i.category}</span>}
                  {!i.approved ? <Badge tone="amber">{t('kb.draft')}</Badge> : i.stale ? <Badge tone="amber">{t('kb.needsReview')}</Badge> : <Badge tone="green">{t('kb.live')}</Badge>}
                  {!i.active && <Badge>{t('kb.off')}</Badge>}
                </span>
                {canEdit ? (
                  <>
                    <input className="input" value={e.title ?? i.title} maxLength={160} onChange={(ev) => patch(i, { title: ev.target.value })} aria-label={t('kb.name')} />
                    {i.kind === 'SERVICE' && (
                      <div className="toolbar">
                        <label className="field" style={{ margin: 0 }}><span>{t('kb.price')}</span><input className="input" type="number" min={0} style={{ width: 120 }} value={e.priceText ?? (i.priceUah ?? '')} onChange={(ev) => patch(i, { priceText: ev.target.value })} /></label>
                        <label className="field" style={{ margin: 0 }}><span>{t('kb.duration')}</span><input className="input" type="number" min={5} step={5} style={{ width: 100 }} value={e.durText ?? (i.durationMin ?? '')} onChange={(ev) => patch(i, { durText: ev.target.value })} /></label>
                      </div>
                    )}
                    <textarea className="input" rows={2} maxLength={900} value={e.text ?? i.text} onChange={(ev) => patch(i, { text: ev.target.value })} aria-label={t(`kb.text.${i.kind}`)} />
                    <div className="toolbar">
                      <button className="btn btn-sm" disabled={busy || !Object.keys(e).length} onClick={() => save(i)}>{t('common.save')}</button>
                      {(!i.approved) && <button className="btn btn-sm btn-primary" disabled={busy || Object.keys(e).length > 0} onClick={() => act(() => api(`/knowledge/${i.id}/approve`, { method: 'POST' }), t('kb.approvedMsg'))}>{t('kb.approve')}</button>}
                      {i.approved && i.stale && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(() => api(`/knowledge/${i.id}/confirm`, { method: 'POST' }), t('kb.confirmedMsg'))}>{t('kb.stillTrue')}</button>}
                      <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api(`/knowledge/${i.id}`, { method: 'PATCH', body: JSON.stringify({ active: !i.active }) }))}>{i.active ? t('kb.disable') : t('kb.enable')}</button>
                      <button className="btn btn-sm" disabled={busy} onClick={async () => (await ask(t('kb.deleteConfirm'), { danger: true, confirmLabel: t('common.delete') })) && act(() => api(`/knowledge/${i.id}`, { method: 'DELETE' }))}>{t('common.delete')}</button>
                    </div>
                  </>
                ) : (
                  <span className="muted">{i.priceUah !== null ? `${i.priceUah} ${t('kb.uah')}` : ''} {i.durationMin ? `· ${i.durationMin} ${t('book.min')}` : ''} {i.text}</span>
                )}
              </div>
            );
          })
        )}
      </Card>
    </>
  );
}
