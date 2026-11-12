'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { LOCALES, Locale, useI18n } from '../lib/i18n';
import { LANDING_PATH } from '../lib/site';
import { LANDING, LandingText } from '../lib/landing-text';
import { Brand } from './Brand';
import { ChannelIcon } from './ChannelIcon';

type Mock = LandingText['mock'];

// Small drawings of real screens (not screenshots): made-up people, relative dates, and a visible "example" label, so nobody takes them for a clinic's data
function Frame({ label, title, icon, children }: { label: string; title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <figure className="mock" aria-label={`${label}: ${title}`}>
      <figcaption className="mock-head">
        <span className="mock-title">{icon}{title}</span>
        <span className="mock-label">{label}</span>
      </figcaption>
      {children}
    </figure>
  );
}

// The home page's counters
function MockToday({ m }: { m: Mock }) {
  return (
    <Frame label={m.example} title={m.today.title}>
      {m.today.rows.map(([k, v]) => (
        <div key={k} className="mock-row"><span>{k}</span><b className="mock-num">{v}</b></div>
      ))}
    </Frame>
  );
}

// The "No next appointment" report with its next actions
function MockReport({ m }: { m: Mock }) {
  const r = m.report;
  return (
    <Frame label={m.example} title={r.title}>
      <div className="mock-sub">{r.sub}</div>
      <div className="mock-table" role="table">
        <div className="mock-tr mock-th" role="row">{r.cols.map((c) => <span key={c} role="columnheader">{c}</span>)}</div>
        {r.rows.map((row) => (
          <div key={row[0]} className="mock-tr" role="row">{row.map((c, i) => <span key={i} role="cell">{c}</span>)}</div>
        ))}
      </div>
      <div className="mock-actions"><span className="mock-btn primary">{r.tasks}</span><span className="mock-btn">Excel</span><span className="mock-btn">PDF</span></div>
    </Frame>
  );
}

// A question to the manager's assistant and the report it builds
function MockAsk({ m }: { m: Mock }) {
  const a = m.ask;
  return (
    <Frame label={m.example} title={a.title}>
      <div className="mock-bubble out">{a.q}</div>
      <div className="mock-row"><span>{a.sub}</span><b className="mock-num">{a.value}</b></div>
      <div className="mock-sub">{a.rule}</div>
      <div className="mock-actions"><span className="mock-btn">Excel</span><span className="mock-btn">PDF</span></div>
    </Frame>
  );
}

// An incoming message, the reply with free times, and the request the front desk gets
function MockChat({ m }: { m: Mock }) {
  const c = m.chat;
  return (
    <Frame label={m.example} title="Instagram" icon={<ChannelIcon name="instagram" size={22} />}>
      <div className="mock-bubble in">{c.in}</div>
      <div className="mock-bubble out">{c.out}</div>
      <div className="mock-slots">{c.slots.map((s) => <span key={s} className="mock-slot">{s}</span>)}</div>
      <div className="mock-request">
        <div><b>{c.request}</b><div className="mock-sub">{c.requestSub}</div></div>
        <span className="mock-tag">{c.status}</span>
      </div>
      <div className="mock-actions"><span className="mock-btn primary">{c.confirm}</span><span className="mock-btn">{c.handoff}</span></div>
    </Frame>
  );
}

// A ready rule and what happened to its messages
function MockRule({ m }: { m: Mock }) {
  const r = m.rule;
  return (
    <Frame label={m.example} title={r.title}>
      <div className="mock-rule">
        {r.lines.map(([k, v]) => (
          <div key={k} className="mock-kv"><span>{k}</span><b>{v}</b></div>
        ))}
        <span className="mock-switch on" aria-hidden="true" />
      </div>
      <div className="mock-sub">{r.history}</div>
      {r.results.map(([who, what], i) => (
        <div key={who} className="mock-row"><span>{who}</span><span className={`mock-tag${i ? ' muted' : ''}`}>{what}</span></div>
      ))}
    </Frame>
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

// The public landing page: the business value first (hero, three value sections, what the owner sees in numbers), then how it works, channels, the demo,
// pricing, trust and questions. Every claim is bounded by what the product does (see the rules at the top of lib/landing-text.ts).
export default function Landing({ lang }: { lang: Locale }) {
  const { setLocale } = useI18n();
  const router = useRouter();
  // The cabinet opens in the language of the page the visitor chose
  useEffect(() => setLocale(lang), [lang, setLocale]);
  // An installed app (the home-screen icon) opens the workspace for a signed-in user; a visitor without a session stays on
  // the landing. The session cookie is httpOnly, so the check is a request to /auth/me.
  useEffect(() => {
    const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!installed) return;
    api('/auth/me').then(() => router.replace('/dashboard')).catch(() => undefined);
  }, [router]);
  const L = LANDING[lang];
  const visuals: Record<LandingText['sections'][number]['id'], React.ReactNode> = {
    followup: <MockReport m={L.mock} />,
    work: <MockAsk m={L.mock} />,
    inquiries: <MockChat m={L.mock} />,
  };

  return (
    <div className="land">
      <header className="land-head">
        <Link href={LANDING_PATH[lang]} className="brand land-brand"><Brand /></Link>
        <nav className="land-nav" aria-label="menu">
          <a href="#how">{L.nav.how}</a>
          <a href="#demo">{L.nav.demo}</a>
          <a href="#channels">{L.nav.channels}</a>
          <a href="#pricing">{L.nav.pricing}</a>
          <a href="#faq">{L.nav.faq}</a>
        </nav>
        <div className="land-head-right">
          <LandingLangs lang={lang} />
          <Link href="/login" className="btn btn-sm">{L.nav.login}</Link>
        </div>
      </header>

      <main>
        <section className="land-hero">
          <div className="land-hero-text">
            <p className="land-kicker">{L.hero.kicker}</p>
            <h1>{L.hero.title}</h1>
            <p>{L.hero.sub}</p>
            <ul className="land-ticks land-hero-points">{L.hero.points.map((p) => <li key={p}>{p}</li>)}</ul>
            <div className="land-cta">
              <Link href="/demo" className="btn btn-primary btn-lg">{L.hero.demo}</Link>
              <a href="#how" className="btn btn-lg">{L.hero.how}</a>
            </div>
            <p className="land-note">{L.hero.note}</p>
          </div>
          <div className="land-hero-art">
            <MockToday m={L.mock} />
          </div>
        </section>

        <section id="how" className="land-section">
          <h2>{L.value.title}</h2>
          <div className="land-grid three">
            {L.value.items.map((x) => (
              <a key={x.t} href={x.href} className="land-card land-link"><h3>{x.t}</h3><p>{x.d}</p></a>
            ))}
          </div>
        </section>

        {L.sections.map((s, i) => (
          <section key={s.id} id={s.id} className={`land-section land-feature${i % 2 ? ' flip' : ''}`}>
            <div>
              <p className="land-problem">{s.problem}</p>
              <h2>{s.title}</h2>
              <p>{s.text}</p>
              <ul>{s.points.map((p) => <li key={p}>{p}</li>)}</ul>
              <p className="land-human">{s.human}</p>
              {s.cta && <Link href={s.cta.href} className="btn">{s.cta.label}</Link>}
            </div>
            {visuals[s.id]}
          </section>
        ))}

        <section className="land-section land-soft">
          <h2>{L.money.title}</h2>
          <p className="land-sub">{L.money.text}</p>
          <div className="land-grid">
            {L.money.items.map((x) => (
              <div key={x.t} className="land-card"><h3>{x.t}</h3><p>{x.d}</p></div>
            ))}
          </div>
          <p className="land-note">{L.money.caveat}</p>
        </section>

        <section className="land-section land-feature">
          <div>
            <h2>{L.auto.title}</h2>
            <p>{L.auto.text}</p>
            <ul>{L.auto.points.map((p) => <li key={p}>{p}</li>)}</ul>
            <p className="land-human">{L.auto.channels}</p>
          </div>
          <MockRule m={L.mock} />
        </section>

        <section className="land-section">
          <h2>{L.cliniccards.title}</h2>
          <div className="land-grid">
            {L.cliniccards.items.map((x) => (
              <div key={x.t} className="land-card"><h3>{x.t}</h3><p>{x.d}</p></div>
            ))}
          </div>
        </section>

        <section id="channels" className="land-section">
          <h2>{L.channels.title}</h2>
          <p className="land-sub">{L.channels.sub}</p>
          <div className="land-grid">
            {L.channels.list.map((c) => (
              <div key={c.name} className="land-card land-channel">
                <div className="land-channel-head">
                  <span className="land-channel-icons">{c.icons.map((k) => <ChannelIcon key={k} name={k} />)}</span>
                  <b>{c.name}</b>
                </div>
                <p>{c.what}</p>
                {c.note && <p className="land-card-note">{c.note}</p>}
              </div>
            ))}
          </div>
        </section>

        <section id="demo" className="land-section land-demo">
          <h2>{L.demo.title}</h2>
          <p>{L.demo.text}</p>
          <ol className="land-steps">
            {L.demo.steps.map((s) => (
              <li key={s.t}><b>{s.t}</b><span>{s.d}</span></li>
            ))}
          </ol>
          <Link href="/demo" className="btn btn-primary btn-lg">{L.demo.cta}</Link>
          <p className="land-note">{L.demo.note}</p>
        </section>

        <section id="pricing" className="land-section">
          <h2>{L.pricing.title}</h2>
          <p className="land-sub">{L.pricing.sub}</p>
          <div className="land-grid two">
            {L.pricing.plans.map((p) => (
              <div key={p.name} className={`land-card plan${p.pro ? ' pro' : ''}`}>
                <h3>{p.name}</h3>
                <p>{p.lead}</p>
                <div className="land-price">{p.price} <span>{L.pricing.perMonth}</span></div>
                <ul>{p.lines.map((l) => <li key={l}>{l}</li>)}</ul>
                <Link href="/login?register=1" className={`btn${p.pro ? ' btn-primary' : ''}`}>{L.pricing.cta}</Link>
              </div>
            ))}
          </div>
          <div className="land-card" style={{ marginTop: 14 }}>
            <b>{L.pricing.setup}</b>
            <p>{L.pricing.setupText}</p>
          </div>
          <div className="land-card" style={{ marginTop: 14 }}>
            <b>{L.pricing.ai.title}</b>
            <p>{L.pricing.ai.text}</p>
            <p>{L.pricing.ai.out}</p>
            <p><b>{L.pricing.ai.pack}</b></p>
          </div>
          <p className="land-note">{L.pricing.noTrial}</p>
        </section>

        <section className="land-section">
          <h2>{L.steps.title}</h2>
          <ol className="land-steps">
            {L.steps.items.map((s) => (
              <li key={s.t}><b>{s.t}</b><span>{s.d}</span></li>
            ))}
          </ol>
        </section>

        <section className="land-section">
          <h2>{L.trust.title}</h2>
          <ul className="land-ticks">{L.trust.items.map((s) => <li key={s}>{s}</li>)}</ul>
        </section>

        <section id="faq" className="land-section">
          <h2>{L.faq.title}</h2>
          <div className="land-faq">
            {L.faq.items.map((f) => (
              <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>
            ))}
          </div>
        </section>

        <section className="land-section land-final">
          <h2>{L.final.title}</h2>
          <p>{L.final.text}</p>
          <div className="land-cta">
            <Link href="/demo" className="btn btn-primary btn-lg">{L.hero.demo}</Link>
            <Link href="/login?register=1" className="btn btn-lg">{L.hero.connect}</Link>
          </div>
        </section>
      </main>

      <footer className="land-foot">{L.footer} <a href="mailto:hello@lankaclinic.app">hello@lankaclinic.app</a> · <Link href="/terms">{L.nav.terms}</Link> · <Link href="/privacy">{L.nav.privacy}</Link></footer>
    </div>
  );
}
