'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Key, useI18n } from '../lib/i18n';
import { fmtDateTime } from '../lib/ui';
import { Alert, Badge, Card } from './ui';
import { useConfirm } from './ConfirmDialog';

interface Cur {
  code: string | null;
  statedAt: string | null;
  planCode: string | null;
  planStatedAt: string | null;
  options: string[];
}
type Scope = 'finance' | 'plans';

// Settings → General: the currency of the clinic's Cliniccards amounts (PUT /integrations/cliniccards/currency, owner only). Cliniccards sends amounts
// without a currency, so LANKA never guesses it. Two statements, each optional and separate (a clinic may keep some treatment plans in another
// currency): payments, invoices and patient balances; and treatment-plan totals. A scope not stated stays "currency not confirmed". A change asks what
// happened: the clinic changed its accounting currency (only amounts loaded from now on) or the earlier statement was a mistake (that scope is
// relabelled). Both are written to the activity log on the server.
export function CurrencyCard({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const [st, setSt] = useState<Cur | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ currency?: Cur }>('/integrations/cliniccards')
      .then((s) => setSt(s.currency ?? null))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  if (!st) return error ? <Alert tone="error">{error}</Alert> : null;
  return (
    <Card title={t('cur.title')}>
      <p className="rule" style={{ marginTop: 0 }}>{t('cur.intro')}</p>
      <Section scope="finance" code={st.code} statedAt={st.statedAt} options={st.options} canEdit={canEdit} onSaved={setSt} />
      <Section scope="plans" code={st.planCode} statedAt={st.planStatedAt} options={st.options} canEdit={canEdit} onSaved={setSt} />
      <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>{t('cur.unconverted')}</p>
      {!canEdit && <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>{t('cur.ownerOnly')}</p>}
    </Card>
  );
}

function Section({ scope, code, statedAt, options, canEdit, onSaved }: { scope: Scope; code: string | null; statedAt: string | null; options: string[]; canEdit: boolean; onSaved: (c: Cur) => void }) {
  const { t } = useI18n();
  const { ask, dialog } = useConfirm();
  const [pick, setPick] = useState(code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const what = t(`cur.scope.${scope}` as Key);

  const save = async (correct: boolean) => {
    if (!(await ask(t(`cur.confirm.${scope}` as Key, { c: pick }), { title: what, confirmLabel: t('cur.save') }))) return;
    setBusy(true);
    setError('');
    try {
      const s = await api<{ currency: Cur }>('/integrations/cliniccards/currency', { method: 'PUT', body: JSON.stringify({ currency: pick, correct, scope }) });
      onSaved(s.currency);
      setChanging(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rule-card" style={{ marginBottom: 12 }}>
      {dialog}
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <b>{what}</b>
        <Badge tone={code ? 'green' : 'amber'}>{code ?? t('money.unknownShort')}</Badge>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '4px 0' }}>{t(`cur.hint.${scope}` as Key)}</p>
      <p style={{ margin: '4px 0' }}>{code ? t('cur.current', { c: code, d: fmtDateTime(statedAt) }) : t('cur.none')}</p>
      {error && <Alert tone="error">{error}</Alert>}
      {canEdit && (
        <>
          <div className="toolbar">
            <label className="field" style={{ margin: 0 }}>
              <span>{t('cur.label')}</span>
              <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
                {!code && <option value="">—</option>}
                {options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>
            {!code ? (
              <button type="button" className="btn btn-primary" disabled={busy || !pick} onClick={() => save(false)}>{t('cur.save')}</button>
            ) : (
              <button type="button" className="btn" disabled={busy || !pick || pick === code} onClick={() => setChanging(true)}>{t('cur.changeTitle')}</button>
            )}
          </div>
          {changing && code && pick !== code && (
            <div style={{ marginTop: 10 }}>
              <p style={{ marginTop: 0 }}>{t('cur.change', { old: code })}</p>
              <div className="toolbar">
                <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>{t('cur.changeNew')}</button>
                <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>{t('cur.changeFix')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
