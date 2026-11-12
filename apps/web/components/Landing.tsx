'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { LOCALES, Locale, useI18n } from '../lib/i18n';
import { LANDING_PATH } from '../lib/site';
import { LANDING, LandingText, Shot } from '../lib/landing-text';
import { Brand } from './Brand';
import { ChannelIcon } from './ChannelIcon';
import { Icon } from './ui';

// The public contact address (footer, structured data, and the fallback when the call-back form cannot send)
const EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'hello@lankaclinic.app';
// The real app screens, taken on the demo clinic (made-up data, dates and phone numbers removed): their natural size keeps the layout from jumping
const SHOT_SIZE: Record<Shot, [number, number]> = { workspace: [1920, 960], periods: [1440, 527], now: [1440, 250], inbox: [1440, 340], report: [1440, 900], requests: [1440, 675] };
const shotSrc = (lang: Locale, s: Shot) => `/landing/${lang}/${s}.jpg`;

type Zoom = { src: string; alt: string } | null;

// An app screen that opens larger on click (a native dialog: Esc and the close button work, focus returns to the screen)
function Screen({ lang, shot, alt, label, enlarge, onZoom, className }: { lang: Locale; shot: Shot; alt: string; label: string; enlarge: string; onZoom: (z: Zoom) => void; className?: string }) {
  const [w, h] = SHOT_SIZE[shot];
  return (
    <figure className={`lp-screen${className ? ` ${className}` : ''}`}>
      <button type="button" className="lp-screen-btn" onClick={() => onZoom({ src: shotSrc(lang, shot), alt })} aria-label={`${enlarge}: ${alt}`}>
        <img src={shotSrc(lang, shot)} alt={alt} width={w} height={h} loading={shot === 'workspace' ? 'eager' : 'lazy'} decoding="async" />
        <span className="lp-zoom" aria-hidden="true"><Icon name="search" size={16} /></span>
      </button>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

// Tabs with the keyboard pattern of the app (arrows, Home, End; only the active tab is in the Tab order)
function Tabs<K extends string>({ id, label, items, active, onPick }: { id: string; label: string; items: { key: K; tab: string }[]; active: K; onPick: (k: K) => void }) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const keys = items.map((x) => x.key);
    const i = keys.indexOf(active);
    const next = e.key === 'ArrowRight' ? keys[(i + 1) % keys.length] : e.key === 'ArrowLeft' ? keys[(i - 1 + keys.length) % keys.length] : e.key === 'Home' ? keys[0] : e.key === 'End' ? keys[keys.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onPick(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className="lp-tabs" role="tablist" aria-label={label}>
      {items.map((x) => (
        <button key={x.key} id={`${id}-tab-${x.key}`} type="button" role="tab" aria-selected={active === x.key} aria-controls={`${id}-panel`} tabIndex={active === x.key ? 0 : -1} className={`lp-tab${active === x.key ? ' active' : ''}`} onClick={() => onPick(x.key)} onKeyDown={onKey}>
          {x.tab}
        </button>
      ))}
    </div>
  );
}

// The agent's conversation, one example, with each message marked by its stage; picking a stage highlights its messages
function AgentDemo({ L }: { L: LandingText }) {
  const A = L.agent;
  const [stage, setStage] = useState<number | null>(null);
  return (
    <div className="lp-agent-demo">
      <ol className="lp-stages" aria-label={A.eyebrow}>
        {A.stages.map((s, i) => (
          <li key={s.t}>
            <button type="button" className={`lp-stage${stage === i ? ' active' : ''}`} aria-pressed={stage === i} onClick={() => setStage(stage === i ? null : i)}>
              <span className="lp-stage-n">{i + 1}</span>
              <span><b>{s.t}</b><small>{s.d}</small></span>
            </button>
          </li>
        ))}
      </ol>
      <figure className="lp-phone" aria-label={`${L.ui.example}: ${A.title}`}>
        <figcaption className="lp-phone-head">
          <ChannelIcon name="instagram" size={26} />
          <b>Instagram</b>
          <span className="lp-badge">{L.ui.example}</span>
        </figcaption>
        <div className="lp-phone-body">
          {A.chat.map((m, i) => (
            <div key={i} className={`lp-msg ${m.from}${stage !== null && stage !== m.stage ? ' dim' : ''}`}>
              <span className="lp-msg-stage" aria-hidden="true">{m.stage + 1}</span>
              <div className="lp-bubble">
                {m.from === 'event' && <Icon name="calendar" size={16} />}
                <span>{m.text}</span>
                {m.slots && <span className="lp-slots">{m.slots.map((s, j) => <span key={s} className={`lp-slot${j === 0 ? ' picked' : ''}`}>{s}</span>)}</span>}
              </div>
            </div>
          ))}
        </div>
      </figure>
    </div>
  );
}

// The marketing view: a drawing (the demo clinic has no inquiry sources), marked as an example
function SourcesExample({ L }: { L: LandingText }) {
  const s = L.roles.sources;
  return (
    <figure className="lp-example">
      <figcaption><b>{s.title}</b><span className="lp-badge">{L.ui.example}</span></figcaption>
      <div className="lp-ex-table" role="table">
        <div className="lp-ex-row head" role="row">{s.cols.map((c) => <span key={c} role="columnheader">{c}</span>)}</div>
        {s.rows.map((r) => (
          <div key={r[0]} className="lp-ex-row" role="row">
            <span role="cell">{r[0]}</span>
            <span role="cell">{r[1]}</span>
            <span role="cell"><span className="lp-bar" style={{ width: `${(Number(r[2]) / Number(r[1])) * 100}%` }} />{r[2]}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

// The owner's Telegram: the weekly digest and a signal, as they arrive (the wording of digest.service.ts and insights.service.ts), marked as an example
function TelegramExample({ L }: { L: LandingText }) {
  const T = L.roles.telegram;
  return (
    <figure className="lp-example lp-tg">
      <figcaption><span className="lp-tg-head"><ChannelIcon name="telegram" size={24} /><b>{T.chat}</b></span><span className="lp-badge">{L.ui.example}</span></figcaption>
      <div className="lp-tg-msg">{T.digest.map((l, i) => (l ? <div key={i} className={i === 0 || i === 7 ? 'lp-tg-strong' : undefined}>{l}</div> : <div key={i} className="lp-tg-gap" />))}</div>
      <div className="lp-tg-msg lp-tg-signal">{T.signal.map((l, i) => <div key={i} className={i ? 'lp-tg-link' : undefined}>{l}</div>)}</div>
    </figure>
  );
}

// The manager's assistant: a question and the report it builds, marked as an example
function AskExample({ L }: { L: LandingText }) {
  const a = L.product.ask;
  return (
    <figure className="lp-example lp-ask">
      <figcaption><span className="lp-tg-head"><Icon name="sparkles" size={18} /><b>{a.title}</b></span><span className="lp-badge">{L.ui.example}</span></figcaption>
      <div className="lp-ask-q">{a.q}</div>
      <div className="lp-ex-table" role="table">
        <div className="lp-ex-row two head" role="row">{a.cols.map((c) => <span key={c} role="columnheader">{c}</span>)}</div>
        {a.rows.map((r) => <div key={r[0]} className="lp-ex-row two" role="row"><span role="cell">{r[0]}</span><span role="cell">{r[1]}</span></div>)}
      </div>
      <div className="lp-ask-foot"><span className="lp-small" style={{ margin: 0 }}>{a.rule}</span><span className="lp-ask-actions"><span className="lp-mini-btn primary">{a.save}</span><span className="lp-mini-btn">Excel</span></span></div>
    </figure>
  );
}

// The reminder rule and its history: a drawing (the demo's rule is off and has sent nothing), marked as an example
function RuleExample({ L }: { L: LandingText }) {
  const r = L.product.rule;
  return (
    <figure className="lp-example lp-rule">
      <figcaption><b>{r.title}</b><span className="lp-badge">{L.ui.example}</span></figcaption>
      <div className="lp-rule-on"><span className="lp-switch" aria-hidden="true" />{r.on}</div>
      <dl>{r.lines.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <blockquote>{r.text}</blockquote>
      <div className="lp-rule-hist"><b>{r.history}</b>{r.results.map(([who, what, tone]) => <div key={who}><span>{who}</span><span className={`lp-pill ${tone}`}>{what}</span></div>)}</div>
    </figure>
  );
}

// "Discuss a connection": a small call-back form in a dialog (POST /contact-requests: the phone, an optional name, the consent). The request reaches the
// service owner (/platform and an email); the demo link is offered while the visitor waits. A hidden trap field catches simple bots.
function ContactDialog({ lang, L, open, onClose }: { lang: Locale; L: LandingText; open: boolean; onClose: () => void }) {
  const C = L.contact;
  const ref = useRef<HTMLDialogElement>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [trap, setTrap] = useState('');
  const [state, setState] = useState<'form' | 'sending' | 'done' | 'error'>('form');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setState((s) => (s === 'done' ? 'done' : 'form'));
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);
  const digits = phone.replace(/\D/g, '');
  const ready = digits.length >= 9 && digits.length <= 15 && consent && state !== 'sending';
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setState('sending');
    try {
      await api('/contact-requests', { method: 'POST', body: JSON.stringify({ phone, name: name.trim() || undefined, lang, consent, website: trap || undefined }) });
      setState('done');
    } catch {
      setState('error');
    }
  }
  return (
    <dialog ref={ref} className="lp-contact" aria-labelledby="lp-contact-title" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button type="button" className="lp-contact-close" onClick={onClose} aria-label={C.close}><Icon name="close" size={20} /></button>
      <h2 id="lp-contact-title">{C.title}</h2>
      {state === 'done' ? (
        <div className="lp-contact-done" role="status">
          <p className="lp-contact-ok"><Icon name="check" size={22} />{C.done}</p>
          <p className="lp-small">{C.demoHint}</p>
          <Link href="/demo" className="btn btn-primary btn-lg">{C.demo}</Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="lp-small" style={{ marginTop: 0 }}>{C.text}</p>
          <label className="lp-field">
            <span>{C.phone}</span>
            <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+380 __ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} required />
          </label>
          <label className="lp-field">
            <span>{C.name}</span>
            <input className="input" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          {/* a field people do not see: a bot that fills it gets the usual answer, and nothing is saved */}
          <input className="lp-trap" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} name="website" />
          <label className="lp-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{C.consent} <Link href="/privacy" target="_blank">{C.privacy}</Link></span>
          </label>
          {state === 'error' && <p className="lp-contact-err" role="alert">{C.error} <a href={`mailto:${EMAIL}`}>{EMAIL}</a></p>}
          <button type="submit" className="btn btn-primary btn-lg" disabled={!ready}>{state === 'sending' ? C.sending : C.submit}</button>
          <p className="lp-small">{C.demoHint} <Link href="/demo">{C.demo} →</Link></p>
        </form>
      )}
    </dialog>
  );
}

// Real links, one address per language, so crawlers can follow them
function LandingLangs({ lang }: { lang: Locale }) {
  return (
    <div className="lang compact" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <Link key={l.code} href={LANDING_PATH[l.code]} hrefLang={l.code} lang={l.code} className={`lang-btn${lang === l.code ? ' active' : ''}`} title={l.label} aria-current={lang === l.code ? 'page' : undefined}>
          {l.code.toUpperCase()}
        </Link>
      ))}
    </div>
  );
}

// The public landing page in eight sections: hero, the patient agent, four roles, the product, integrations and individual setup, pricing,
// trust and questions, the closing call. What is standard, what depends on a channel, plan or activation, and what is individual work is said beside
// each claim (the rules are at the top of lib/landing-text.ts).
export default function Landing({ lang }: { lang: Locale }) {
  const { setLocale } = useI18n();
  const router = useRouter();
  // The cabinet opens in the language of the page the visitor chose
  useEffect(() => setLocale(lang), [lang, setLocale]);
  // An installed app (the home-screen icon) opens the workspace for a signed-in user; a visitor without a session stays on the landing
  useEffect(() => {
    const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!installed) return;
    api('/auth/me').then(() => router.replace('/dashboard')).catch(() => undefined);
  }, [router]);
  const L = LANDING[lang];
  const [menu, setMenu] = useState(false);
  const [role, setRole] = useState(L.roles.items[0].key);
  const [view, setView] = useState<LandingText['product']['tabs'][number]['key']>('reports');
  const [zoom, setZoom] = useState<Zoom>(null);
  const [contact, setContact] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (zoom && !d.open) d.showModal();
    if (!zoom && d.open) d.close();
  }, [zoom]);
  const R = L.roles.items.find((x) => x.key === role) ?? L.roles.items[0];
  const P = L.product.tabs.find((x) => x.key === view) ?? L.product.tabs[0];
  const nav: [string, string][] = [['#agent', L.nav.agent], ['#roles', L.nav.roles], ['#product', L.nav.product], ['#connect', L.nav.connect], ['#pricing', L.nav.pricing], ['#faq', L.nav.faq]];

  return (
    <div className="lp">
      <header className="lp-head">
        <Link href={LANDING_PATH[lang]} className="brand lp-brand"><Brand /></Link>
        <nav className={`lp-nav${menu ? ' open' : ''}`} id="lp-nav" aria-label={L.nav.menu}>
          {nav.map(([href, t]) => <a key={href} href={href} onClick={() => setMenu(false)}>{t}</a>)}
        </nav>
        <div className="lp-head-right">
          <LandingLangs lang={lang} />
          <Link href="/login" className="btn btn-sm lp-login">{L.nav.login}</Link>
          <button type="button" className="lp-burger" aria-expanded={menu} aria-controls="lp-nav" aria-label={L.nav.menu} onClick={() => setMenu(!menu)}>
            <Icon name={menu ? 'close' : 'menu'} size={22} />
          </button>
        </div>
      </header>

      <main>
        {/* 1. Hero: the business value and the workspace itself */}
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-text">
              <p className="lp-eyebrow">{L.hero.eyebrow}</p>
              <h1>{L.hero.title1}<span>{L.hero.title2}</span></h1>
              <p className="lp-lead">{L.hero.sub}</p>
              <div className="lp-cta">
                <Link href="/demo" className="btn btn-primary btn-lg">{L.hero.demo}</Link>
                <button type="button" className="btn btn-lg lp-btn-ghost" onClick={() => setContact(true)}>{L.hero.discuss}</button>
              </div>
              <p className="lp-integration"><ChannelIcon name="cliniccards" size={22} />{L.hero.integration}</p>
              <p className="lp-small">{L.hero.note}</p>
            </div>
            <div className="lp-hero-art">
              <Screen lang={lang} shot="workspace" alt={L.hero.shotAlt} label={L.ui.demoData} enlarge={L.ui.enlarge} onZoom={setZoom} className="lp-hero-shot" />
              <div className="lp-hero-chat" aria-hidden="true">
                <div className="lp-hero-chat-head"><ChannelIcon name="instagram" size={20} /><span className="lp-badge">{L.ui.example}</span></div>
                <div className="lp-bubble in">{L.hero.chat.in}</div>
                <div className="lp-bubble out">{L.hero.chat.out}<span className="lp-slots">{L.hero.chat.slots.map((s, j) => <span key={s} className={`lp-slot${j === 0 ? ' picked' : ''}`}>{s}</span>)}</span></div>
                <div className="lp-hero-req"><Icon name="calendar" size={16} />{L.hero.chat.request}</div>
              </div>
            </div>
          </div>
        </section>

        {/* 2. The patient agent */}
        <section id="agent" className="lp-section lp-dark">
          <div className="lp-wrap">
            <p className="lp-eyebrow">{L.agent.eyebrow}</p>
            <h2>{L.agent.title}</h2>
            <p className="lp-lead">{L.agent.value}</p>
            <AgentDemo L={L} />
            <p className="lp-adaptive"><Icon name="sparkles" size={18} />{L.agent.adaptive}</p>
            <div className="lp-facts">
              {L.agent.facts.map((f) => <div key={f.t}><b>{f.t}</b><p>{f.d}</p></div>)}
            </div>
          </div>
        </section>

        {/* 3. One product, four roles */}
        <section id="roles" className="lp-section">
          <div className="lp-wrap">
            <p className="lp-eyebrow">{L.roles.eyebrow}</p>
            <h2>{L.roles.title}</h2>
            <p className="lp-lead">{L.roles.lead}</p>
            <Tabs id="role" label={L.roles.title} items={L.roles.items} active={role} onPick={setRole} />
            <div className="lp-panel" role="tabpanel" id="role-panel" aria-labelledby={`role-tab-${R.key}`}>
              <div className="lp-panel-text">
                <p className="lp-question">{R.q}</p>
                <ul className="lp-checks">{R.points.map((p) => <li key={p}><Icon name="check" size={18} />{p}</li>)}</ul>
                {R.extra && <div className="lp-callout"><b><ChannelIcon name="telegram" size={20} />{R.extra.t}</b><p>{R.extra.d}</p></div>}
                {R.telegram && <p className="lp-hint">{L.roles.telegram.hint}</p>}
                {R.note && <p className="lp-small">{R.note}</p>}
              </div>
              {R.telegram ? <TelegramExample L={L} /> : R.shot ? <Screen lang={lang} shot={R.shot} alt={R.alt} label={L.ui.demoData} enlarge={L.ui.enlarge} onZoom={setZoom} /> : <SourcesExample L={L} />}
            </div>
            <p className="lp-small lp-access">{L.roles.access}</p>
          </div>
        </section>

        {/* 4. Product showcase */}
        <section id="product" className="lp-section lp-warm">
          <div className="lp-wrap">
            <p className="lp-eyebrow">{L.product.eyebrow}</p>
            <h2>{L.product.title}</h2>
            <Tabs id="view" label={L.product.title} items={L.product.tabs} active={view} onPick={setView} />
            <div className="lp-panel lp-panel-wide" role="tabpanel" id="view-panel" aria-labelledby={`view-tab-${P.key}`}>
              <div className="lp-panel-text">
                <h3>{P.title}</h3>
                <ul className="lp-checks">{P.points.map((p) => <li key={p}><Icon name="check" size={18} />{p}</li>)}</ul>
                <p className="lp-next"><b>{L.ui.next}:</b> {P.next}</p>
                {P.channels && (
                  <div className="lp-channels">
                    <span className="lp-channel-icons">{P.channels.map((c) => <ChannelIcon key={c} name={c} size={26} />)}</span>
                    {P.channelNote && <span className="lp-small">{P.channelNote}</span>}
                  </div>
                )}
              </div>
              {P.shot ? <Screen lang={lang} shot={P.shot} alt={P.alt} label={L.ui.demoData} enlarge={L.ui.enlarge} onZoom={setZoom} /> : P.key === 'assistant' ? <AskExample L={L} /> : <RuleExample L={L} />}
            </div>
          </div>
        </section>

        {/* 5. Integrations and individual setup */}
        <section id="connect" className="lp-section lp-dark">
          <div className="lp-wrap">
            <p className="lp-eyebrow">{L.connect.eyebrow}</p>
            <h2>{L.connect.title}</h2>
            <div className="lp-connect">
              <div>
                <h3>{L.connect.readyTitle}</h3>
                <ul className="lp-ready">
                  {L.connect.ready.map((c) => (
                    <li key={c.name}>
                      <span className="lp-channel-icons">{c.icons.map((k) => <ChannelIcon key={k} name={k} size={34} />)}</span>
                      <div><b>{c.name}</b><p>{c.what}</p>{c.note && <p className="lp-note">{c.note}</p>}</div>
                    </li>
                  ))}
                </ul>
                <div className="lp-onboarding">
                  <h3>{L.connect.onboarding.title}</h3>
                  <ul className="lp-checks">{L.connect.onboarding.items.map((x) => <li key={x}><Icon name="check" size={18} />{x}</li>)}</ul>
                  <p className="lp-note">{L.connect.onboarding.note}</p>
                </div>
                <div className="lp-support">
                  <b>{L.connect.support.t}</b>
                  <p>{L.connect.support.d}</p>
                  <div className="lp-support-actions">
                    <a href={`mailto:${EMAIL}`} className="lp-link-light"><Icon name="message" size={16} />{EMAIL}</a>
                    <button type="button" className="lp-link-light" onClick={() => setContact(true)}><Icon name="phone" size={16} />{L.connect.support.call}</button>
                  </div>
                </div>
              </div>
              <div className="lp-custom">
                <h3>{L.connect.customTitle}</h3>
                <p className="lp-small">{L.connect.journeyLabel}</p>
                <ol className="lp-journey">{L.connect.journey.map((j) => <li key={j}>{j}</li>)}</ol>
                <ul className="lp-custom-list">{L.connect.custom.map((c) => <li key={c.t}><b>{c.t}</b><span>{c.d}</span></li>)}</ul>
                <p className="lp-note">{L.connect.scope}</p>
                <button type="button" className="btn btn-lg lp-btn-light" onClick={() => setContact(true)}>{L.connect.discuss}</button>
              </div>
            </div>
          </div>
        </section>

        {/* 6. Pricing */}
        <section id="pricing" className="lp-section">
          <div className="lp-wrap">
            <h2>{L.pricing.title}</h2>
            <p className="lp-lead">{L.pricing.sub}</p>
            <div className="lp-plans">
              {L.pricing.plans.map((p) => (
                <div key={p.name} className="lp-plan">
                  <h3>{p.name}</h3>
                  <p className="lp-plan-lead">{p.lead}</p>
                  <div className="lp-price">{p.price} <span>{L.pricing.perMonth}</span></div>
                  <ul className="lp-checks">{p.lines.map((l) => <li key={l}><Icon name="check" size={18} />{l}</li>)}</ul>
                  <Link href="/login?register=1" className="btn btn-primary">{L.pricing.cta}</Link>
                </div>
              ))}
            </div>
            <div className="lp-extras">
              {[L.pricing.setup, L.pricing.pack, L.pricing.custom].map((x) => <div key={x.t}><b>{x.t}</b><p>{x.d}</p></div>)}
            </div>
            <details className="lp-details">
              <summary>{L.pricing.details.summary}</summary>
              {L.pricing.details.items.map((x) => <p key={x}>{x}</p>)}
            </details>
            <p className="lp-small">{L.pricing.noTrial}</p>
          </div>
        </section>

        {/* 7. Trust and questions */}
        <section id="faq" className="lp-section lp-warm">
          <div className="lp-wrap lp-trust-grid">
            <div>
              <h2>{L.trust.title}</h2>
              <ul className="lp-trust">
                {L.trust.items.map((x) => <li key={x.t}><span className="lp-trust-icon"><Icon name={x.icon} size={20} /></span><div><b>{x.t}</b><p>{x.d}</p></div></li>)}
              </ul>
            </div>
            <div>
              <h2>{L.faq.title}</h2>
              <div className="lp-faq">
                {L.faq.items.map((f) => <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>)}
              </div>
            </div>
          </div>
        </section>

        {/* 8. Closing call */}
        <section className="lp-section lp-final">
          <div className="lp-wrap">
            <h2>{L.final.title}</h2>
            <p className="lp-lead">{L.final.text}</p>
            <div className="lp-cta">
              <Link href="/demo" className="btn btn-primary btn-lg">{L.hero.demo}</Link>
              <button type="button" className="btn btn-lg lp-btn-light" onClick={() => setContact(true)}>{L.hero.discuss}</button>
            </div>
            <p className="lp-final-support"><Icon name="users" size={16} />{L.final.support} <a href={`mailto:${EMAIL}`}>{EMAIL}</a></p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <span>{L.footer}</span>
        <a href={`mailto:${EMAIL}`}>{EMAIL}</a>
        <Link href="/terms">{L.nav.terms}</Link>
        <Link href="/privacy">{L.nav.privacy}</Link>
      </footer>

      <ContactDialog lang={lang} L={L} open={contact} onClose={() => setContact(false)} />

      <dialog ref={dialog} className="lp-lightbox" aria-label={zoom?.alt} onClose={() => setZoom(null)} onClick={(e) => { if (e.target === e.currentTarget) setZoom(null); }}>
        {zoom && (
          <>
            <button type="button" className="lp-lightbox-close" onClick={() => setZoom(null)} aria-label={L.ui.close}><Icon name="close" size={22} /></button>
            <img src={zoom.src} alt={zoom.alt} />
          </>
        )}
      </dialog>
    </div>
  );
}
