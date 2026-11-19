'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/ui';
import { Key, useI18n } from '../lib/i18n';
import { LANDING } from '../lib/landing-text';
import { UsageMeters } from './PlanCard';
import { Alert, Badge, Card, Empty, Loading } from './ui';
import { BillingPaymentStatus, type BillingCheckout, type PaymentState } from './BillingPaymentStatus';

interface Overview {
  configured: boolean;
  // a branch of a network is paid by its network
  network?: { id: string; name: string } | null;
  pendingPaymentId: string | null;
  // null for a new clinic: its first paid month starts on the launch day
  nextPeriod: { from: string; to: string } | null;
  nextPeriodAnnual: { from: string; to: string } | null;
  monthStartsAtLaunch: boolean;
  launch: { state: 'NONE' | 'DONE' } | { state: 'PENDING' | 'REVIEW'; plan: string; paidAt: string | null; months?: number };
  renewal: { plan: string; priceUah: number; date: string | null } | null;
  plan: string;
  status: 'AWAITING_PAYMENT' | 'LAUNCH_PENDING' | 'ACTIVE' | 'PAST_DUE' | 'LAPSED';
  paidUntil: string | null;
  graceUntil: string | null;
  plans: { key: string; priceUah: number; listPriceUah: number; launchUah: number | null; totalUah: number; annualUah: number; annualSavingUah: number; annualTotalUah: number; viaSupport: { monthly: boolean; annual: boolean }; limits: { users: number; messagesPerMonth: number; aiRepliesPerMonth: number }; features: string[] }[];
  setupPaid: boolean;
  pack: { replies: number; priceUah: number; bought: number; cap: number; periodFrom: string; periodTo: string | null };
  ai: { included: number; used: number; purchased: number; remaining: number };
  payments: { id: string; kind: string; plan: string | null; amountMinor: number; setupMinor: number; months: number | null; status: PaymentState; createdAt: string; paidAt: string | null; refundedMinor: number }[];
}
// One feature list for both plan cards, in the same order. `gate` is the server's plan feature (apps/api/src/service/plans.ts, checked where
// the feature is used); null = available on every plan (no plan gate in the code). Availability is read from each plan's `features` sent by
// the server, so the cards follow the real gates. `note`: a condition outside the plan (a channel to connect, an owner's switch).
const COMPARE: { group: string; rows: { key: string; gate: string | null; note?: boolean }[] }[] = [
  { group: 'reports', rows: [{ key: 'reports', gate: null }, { key: 'export', gate: null }, { key: 'scheduled', gate: null }, { key: 'funnel', gate: null }] },
  {
    group: 'patients',
    rows: [
      { key: 'forms', gate: null }, { key: 'telegram', gate: null, note: true }, { key: 'requests', gate: null }, { key: 'reminders', gate: null },
      { key: 'campaigns', gate: null }, { key: 'rules', gate: null }, { key: 'meta', gate: 'multi_channel', note: true }, { key: 'leadads', gate: 'multi_channel', note: true },
    ],
  },
  { group: 'ai', rows: [{ key: 'drafts', gate: null }, { key: 'agent', gate: 'patient_agent', note: true }, { key: 'assistant', gate: 'ai_assistant' }] },
  { group: 'management', rows: [{ key: 'weekly', gate: null }, { key: 'daily', gate: 'daily_digest' }, { key: 'signals', gate: 'advanced_analytics' }] },
];
// rows of one column of the full comparison: the header, each group heading and feature (the columns share them through a subgrid)
const CARD_ROWS = 1 + COMPARE.reduce((n, g) => n + 1 + g.rows.length, 0);
const SELLABLE_KEYS = ['START', 'PRO'];

// Settings → "Payment" (the former /billing page): the plan, the first payment (connection + first month), renewal and the payment history.
// One compact card for AI replies: how many are left this period and the button to buy a pack (POST /billing/ai-pack; only the owner pays, canBuy).
export function BillingSettings({ canBuy = false }: { canBuy?: boolean } = {}) {
  const { t, locale } = useI18n();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  // the billing term shown and bought: 1 = monthly, 12 = one annual payment (the server prices it; the toggle never changes an open invoice)
  const [term, setTerm] = useState<1 | 12>(1);
  // a subscribed clinic: its summary first; the plan choice and the renewal open on demand
  const [screen, setScreen] = useState<'summary' | 'plans'>('summary');
  const [renewing, setRenewing] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  // "Do you have several clinics?": the open request and the network link (only for the network's owner)
  const [more, setMore] = useState<{ request: { id: string; createdAt: string } | null; network: { id: string; name: string; canManage: boolean } | null } | null>(null);
  const [comment, setComment] = useState('');
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => api<Overview>('/billing').then(setO).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    setPaymentId(new URLSearchParams(window.location.search).get('payment'));
    void load();
    api<NonNullable<typeof more>>('/billing/additional-clinic').then(setMore).catch(() => setMore(null));
  }, [load]);

  async function askAnotherClinic() {
    setAsking(true);
    setError('');
    try {
      const r = await api<{ request: { id: string; createdAt: string } }>('/billing/additional-clinic', { method: 'POST', body: JSON.stringify({ comment: comment.trim() || undefined }) });
      setMore((m) => ({ network: m?.network ?? null, request: r.request }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  }

  async function go(path: string, body?: object, quotedMinor?: number) {
    setBusy(true);
    setError('');
    try {
      const payment = await api<BillingCheckout>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      setPaymentId(payment.id);
      if (quotedMinor !== undefined && payment.amountMinor !== quotedMinor) {
        setError(t('billing.quoteChanged'));
        void load();
      } else if (payment.url) window.location.assign(payment.url);
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  if (!o) return error ? <Alert tone="error">{error}</Alert> : <Loading />;
  if (o.network)
    return (
      <Alert tone="info">
        {t('billing.byNetwork', { name: o.network.name })}{' '}
        {/* managing the network is the network owner's right; a branch membership alone does not give it */}
        {more?.network?.canManage && <a href="/network">{t('billing.more.manage')}</a>}
      </Alert>
    );
  const tracked = paymentId ?? o.pendingPaymentId;
  const active = o.status === 'ACTIVE' || o.status === 'PAST_DUE';
  const money = (minor: number) => `${(minor / 100).toLocaleString()} ${t('billing.uah')}`;
  const uah = (n: number) => n.toLocaleString();
  const planName = (k: string) => (k === 'PRO' ? t('billing.pro') : k === 'START' ? t('billing.start') : k);
  const pending = o.launch.state === 'PENDING' || o.launch.state === 'REVIEW' ? o.launch : null;
  // public presentation shared with the landing page (names, one positioning line, the short benefits); prices come from the server
  const pub = LANDING[locale].pricing.plans;
  const pubOf = (k: string) => (k === 'START' ? pub[0] : k === 'PRO' ? pub[1] : null);
  // the screens: a subscribed clinic (active, past due or lapsed, with a renewal price) sees its summary; a new clinic chooses a plan
  const subscribed = !!o.renewal && !pending;
  const current = o.plans.find((p) => p.key === o.plan) ?? null;
  const view = !subscribed ? 'plans' : screen;
  const yearly = term === 12;
  const chosen = choice ? o.plans.find((p) => p.key === choice) ?? null : null;

  // one order summary for the chosen plan and term: subscription, the launch when it applies, the total and the dates it covers
  const orderSummary = (p: Overview['plans'][number]) => {
    const total = yearly ? p.annualTotalUah : p.totalUah;
    const period = yearly ? o.nextPeriodAnnual : o.nextPeriod;
    const viaSupport = yearly ? p.viaSupport.annual : p.viaSupport.monthly;
    return (
      <div className="order-summary" aria-live="polite">
        <div className="pc-group" style={{ marginTop: 0 }}>{t('billing.order.title')}</div>
        <dl className="order-lines">
          <dt>{t('billing.order.plan')}</dt><dd>{planName(p.key)} · {yearly ? t('billing.termYear') : t('billing.termMonth')}</dd>
          <dt>{t('billing.order.subscription')}</dt><dd>{yearly ? `${uah(p.annualUah)} ${t('billing.uah')}` : `${uah(p.priceUah)} ${t('billing.uah')}`}</dd>
          {p.launchUah != null && (<><dt>{t('billing.order.launch')}</dt><dd>{uah(p.launchUah)} {t('billing.uah')}</dd></>)}
          <dt><strong>{t('billing.order.total')}</strong></dt><dd><strong>{uah(total)} {t('billing.uah')}</strong></dd>
          <dt>{t('billing.order.period')}</dt>
          <dd>{period ? `${fmtDate(period.from)} — ${fmtDate(period.to)}` : o.monthStartsAtLaunch ? t('billing.order.atLaunch') : '—'}</dd>
        </dl>
        {!period && o.monthStartsAtLaunch && <p className="muted" style={{ fontSize: 13, margin: '0 0 4px' }}>{yearly ? t('billing.launchStartsAnnual') : t('billing.launchStarts')}</p>}
        {yearly && <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>{t('billing.order.noAuto')}</p>}
        {!canBuy ? (
          <p className="muted" style={{ fontSize: 13 }}>{t('billing.order.ownerOnly')}</p>
        ) : viaSupport ? (
          <p className="muted" style={{ fontSize: 13 }}>{t('billing.viaSupport')}</p>
        ) : (
          <button className="btn btn-primary" disabled={busy || !o.configured} onClick={() => go('/billing/checkout', { plan: p.key, months: term }, total * 100)}>
            {t('billing.order.pay', { sum: uah(total) })}
          </button>
        )}
      </div>
    );
  };

  const termToggle = (
    <div className="toolbar seg-term" role="group" aria-label={t('billing.term.label')}>
      <button type="button" className={`btn${term === 1 ? ' btn-primary' : ''}`} aria-pressed={term === 1} onClick={() => setTerm(1)}>{t('billing.term.monthly')}</button>
      <button type="button" className={`btn${term === 12 ? ' btn-primary' : ''}`} aria-pressed={term === 12} onClick={() => setTerm(12)}>{t('billing.term.annual')}</button>
    </div>
  );

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {!o.configured && <Alert tone="warn">{t('billing.notConfigured')}</Alert>}
      {tracked && <BillingPaymentStatus key={tracked} path={`/billing/payments/${encodeURIComponent(tracked)}`} onSettled={load} />}
      {o.status === 'AWAITING_PAYMENT' && !pending && <Alert tone="info">{t('billing.awaiting')}</Alert>}
      {/* the launch payment was partly refunded before the start: no new purchase until support resolves it */}
      {pending?.state === 'REVIEW' && <Alert tone="warn">{t('billing.launchReview')}</Alert>}
      {o.status === 'LAPSED' && <Alert tone="warn">{t('billing.lapsed')}</Alert>}
      {o.status === 'PAST_DUE' && <Alert tone="warn">{t('billing.pastDue', { date: o.graceUntil ? fmtDate(o.graceUntil) : '' })}</Alert>}

      {/* paid, the launch is being prepared: not active yet, nothing to buy */}
      {pending?.state === 'PENDING' && (
        <Card title={t('billing.sub.title')} actions={<Badge tone="amber">{t('billing.launchPendingBadge')}</Badge>}>
          <p style={{ marginTop: 0 }}><strong>{planName(pending.plan)}</strong> · {'months' in pending && pending.months === 12 ? t('billing.termYear') : t('billing.termMonth')}</p>
          <p className="rule">{t('billing.launchPending', { plan: planName(pending.plan) })}</p>
        </Card>
      )}

      {/* a subscribed clinic: the summary; renewal and the change of plan open on demand */}
      {subscribed && view === 'summary' && (
        <Card title={t('billing.sub.title')} actions={o.status === 'ACTIVE' && o.paidUntil ? <Badge tone="green">{t('billing.active', { date: fmtDate(o.paidUntil) })}</Badge> : undefined}>
          <div className="sub-head">
            <div>
              <div className="stat-value" style={{ margin: 0 }}>{planName(o.plan)}</div>
              <div className="muted">{pubOf(o.plan)?.lead ?? ''}</div>
            </div>
            <div className="sub-price">
              <div className="muted" style={{ fontSize: 13 }}>{t('billing.sub.renewal')}</div>
              <b>{uah(o.renewal!.priceUah)} {t('billing.perMonth')}</b>
            </div>
          </div>
          <UsageMeters />
          {renewing && current && SELLABLE_KEYS.includes(current.key) ? (
            <div className="renew-panel">
              {termToggle}
              {orderSummary(current)}
              <button type="button" className="btn btn-link" onClick={() => setRenewing(false)}>{t('common.cancel')}</button>
            </div>
          ) : (
            <div className="toolbar" style={{ marginTop: 12 }}>
              {canBuy && current && SELLABLE_KEYS.includes(current.key) && <button className="btn btn-primary" onClick={() => setRenewing(true)}>{t('billing.sub.renew')}</button>}
              <button className="btn" onClick={() => { setScreen('plans'); setChoice(null); }}>{t('billing.sub.change')}</button>
            </div>
          )}
          {!canBuy && <p className="muted" style={{ fontSize: 13 }}>{t('billing.order.ownerOnly')}</p>}
        </Card>
      )}

      {/* choosing a plan: a new clinic, or a subscribed one that asked to change it */}
      {!pending && view === 'plans' && (
        <Card title={subscribed ? t('billing.sub.changeTitle') : t('billing.plansTitle')}>
          {subscribed && <button type="button" className="btn btn-link back-link" onClick={() => { setScreen('summary'); setChoice(null); }}>← {t('billing.sub.back')}</button>}
          {termToggle}
          <div className="plan-pick">
            {o.plans.map((p) => {
              const pp = pubOf(p.key);
              return (
                <section key={p.key} className={`rule-card plan-option${choice === p.key ? ' plan-current' : ''}`} aria-label={planName(p.key)}>
                  <b>{planName(p.key)}</b>
                  <div className="muted">{pp?.lead}</div>
                  {yearly ? (
                    <>
                      <div className="stat-value">{uah(p.annualUah)} {t('billing.perYear')}</div>
                      <div className="muted" style={{ fontSize: 13 }}>{t('billing.annualEquiv', { sum: uah(Math.round(p.annualUah / 12)) })} · {t('billing.annualSaving', { sum: uah(p.annualSavingUah) })}</div>
                    </>
                  ) : (
                    <div className="stat-value">{uah(p.priceUah)} {t('billing.perMonth')}</div>
                  )}
                  {p.priceUah !== p.listPriceUah && <div className="muted" style={{ fontSize: 13 }}>{t('billing.yourPrice', { sum: uah(p.listPriceUah) })}</div>}
                  <ul className="pick-benefits">{(pp?.lines ?? []).map((l) => <li key={l}>{l}</li>)}</ul>
                  <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>{t('billing.pick.limits', { users: p.limits.users, messages: uah(p.limits.messagesPerMonth), ai: uah(p.limits.aiRepliesPerMonth) })}</p>
                  <button type="button" className={`btn${choice === p.key ? ' btn-primary' : ''}`} aria-pressed={choice === p.key} onClick={() => setChoice(p.key)}>
                    {choice === p.key ? t('billing.pick.chosen') : t('billing.pick.choose')}
                  </button>
                </section>
              );
            })}
          </div>
          {chosen && orderSummary(chosen)}
          {o.monthStartsAtLaunch && (
            <div className="rule">
              <p style={{ marginTop: 0 }}><strong>{t('billing.launchTitle')}</strong></p>
              <p>{t('billing.launchWhatStart')}</p>
              <p>{t('billing.launchWhatPro')}</p>
              <p className="muted" style={{ fontSize: 13 }}>{t('billing.launchOther')}</p>
            </div>
          )}
          {/* the complete comparison, collapsed: one list in the same order for both plans, from the server's plan gates */}
          <details className="more-details compare-all">
            <summary>{t('billing.cmp.all')}</summary>
            <div className="plan-compare" style={{ ['--card-rows' as string]: CARD_ROWS }}>
              {o.plans.map((p) => {
                const has = (gate: string | null) => !gate || p.features.includes(gate);
                return (
                  <section key={p.key} className="rule-card plan-col" aria-label={planName(p.key)}>
                    <div><b>{planName(p.key)}</b></div>
                    {COMPARE.flatMap((g) => [
                      <div key={`g-${g.group}`} className="pc-group">{t(`billing.cmp.g.${g.group}` as Key)}</div>,
                      ...g.rows.map((r) => {
                        const yes = has(r.gate);
                        return (
                          <div key={`f-${r.key}`} className={`pc-row${yes ? '' : ' pc-no'}`}>
                            <span className="pc-mark" aria-hidden="true">{yes ? '✓' : '−'}</span>
                            <span>
                              <span className="sr-only">{yes ? t('billing.cmp.yes') : t('billing.cmp.no')}: </span>
                              {t(`billing.cmp.${r.key}` as Key)}
                              {yes && r.note && <span className="pc-note">{t(`billing.cmp.${r.key}.note` as Key)}</span>}
                              {!yes && <span className="pc-note">{t('billing.cmp.inPro')}</span>}
                            </span>
                          </div>
                        );
                      }),
                    ])}
                  </section>
                );
              })}
            </div>
          </details>
          <p className="muted" style={{ fontSize: 13 }}>{t('billing.secure')}</p>
        </Card>
      )}

      {/* another clinic: a request for the service owner, handled by hand (nothing is created or charged here) */}
      <Card title={t('billing.more.title')}>
        <p className="rule" style={{ marginTop: 0 }}>{t('billing.more.text')}</p>
        {more?.request ? (
          <p><Badge tone="green">{t('billing.more.sent')}</Badge> <span className="muted">{fmtDate(more.request.createdAt)}. {t('billing.more.sentHint')}</span></p>
        ) : canBuy ? (
          <div className="toolbar">
            <input className="input grow" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} placeholder={t('billing.more.comment')} aria-label={t('billing.more.comment')} />
            <button className="btn btn-primary" disabled={asking || !more} onClick={askAnotherClinic}>{t('billing.more.cta')}</button>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>{t('billing.more.ownerOnly')}</p>
        )}
      </Card>

      {/* only the offer: how many replies are used is on the plan card above (one place for the meter) */}
      <Card title={t('billing.aiTitle')}>
        {o.ai.purchased > 0 && <p className="rule" style={{ marginTop: 0 }}>{t('billing.aiBought', { n: o.ai.purchased.toLocaleString() })}</p>}
        <p className="rule">{t('billing.packOffer', { n: o.pack.replies.toLocaleString(), sum: o.pack.priceUah.toLocaleString() })}</p>
        {o.pack.periodTo && <p>{t('billing.period', { from: fmtDate(o.pack.periodFrom), to: fmtDate(o.pack.periodTo) })}</p>}
        {canBuy ? (
          <div className="toolbar">
            <button className="btn btn-primary" disabled={busy || !o.configured || !active || o.pack.bought >= o.pack.cap} onClick={() => go('/billing/ai-pack')}>
              {t('billing.pay')}
            </button>
            {o.pack.bought >= o.pack.cap && <span className="muted">{t('billing.packCap', { n: o.pack.cap })}</span>}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>{t('billing.packOwner')}</p>
        )}
      </Card>

      <Card flush title={t('billing.history')}>
        {o.payments.length === 0 ? (
          <Empty title={t('billing.noPayments')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('billing.colDate')}</th>
                  <th>{t('billing.colWhat')}</th>
                  <th>{t('billing.colSum')}</th>
                  <th>{t('billing.colStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {o.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paidAt ?? p.createdAt)}</td>
                    <td>{p.kind === 'AI_PACK' ? t('billing.kindPack') : t('billing.kindPlan', { plan: planName(p.plan ?? '') })}{p.kind === 'SUBSCRIPTION' && <span className="cell-sub"> · {p.months === 12 ? t('billing.termYear') : t('billing.termMonth')}</span>}{p.setupMinor > 0 && <span className="cell-sub"> · {t('billing.withLaunch')}</span>}</td>
                    <td>{money(p.amountMinor)}</td>
                    <td>
                      <Badge tone={p.status === 'PAID' ? 'green' : p.status === 'PENDING' ? 'amber' : 'red'}>{t(`billing.st.${p.status}`)}</Badge>
                      {p.status === 'PAID' && p.refundedMinor > 0 && <span> · {t('billing.refundedSum', { sum: (p.refundedMinor / 100).toLocaleString() })}</span>}
                      {p.status === 'PENDING' && <button className="btn btn-sm" onClick={() => setPaymentId(p.id)}>{t('billing.refreshPayment')}</button>}
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
