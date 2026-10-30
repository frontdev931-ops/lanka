'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { LANDING } from '../lib/landing-text';
import LanguageSwitcher from './LanguageSwitcher';
import { Brand } from './Brand';

// Small drawings of the interface (not screenshots): they use made-up data and need no image files
function MockReport({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div className="mock" aria-hidden="true">
      <div className="mock-title">{title}</div>
      {rows.map((r) => (
        <div key={r[0]} className="mock-row">
          <b>{r[0]}</b>
          <span>{r[1]}</span>
          <span className="mock-tag">{r[2]}</span>
        </div>
      ))}
      <div className="mock-actions"><span className="mock-btn">Excel</span><span className="mock-btn">PDF</span></div>
    </div>
  );
}
function MockChat({ a, b, slots }: { a: string; b: string; slots: string[] }) {
  return (
    <div className="mock" aria-hidden="true">
      <div className="mock-bubble in">{a}</div>
      <div className="mock-bubble out">{b}</div>
      <div className="mock-slots">{slots.map((s) => <span key={s} className="mock-slot">{s}</span>)}</div>
    </div>
  );
}
function MockFunnel({ steps }: { steps: string[] }) {
  const widths = [100, 72, 58, 35];
  return (
    <div className="mock" aria-hidden="true">
      {steps.map((s, i) => (
        <div key={s} className="mock-bar-row"><span>{s}</span><span className="mock-bar" style={{ width: `${widths[i]}%` }} /></div>
      ))}
    </div>
  );
}
function MockRules({ rules }: { rules: string[] }) {
  return (
    <div className="mock" aria-hidden="true">
      {rules.map((r, i) => (
        <div key={r} className="mock-row"><b>{r}</b><span className={`mock-switch${i < 2 ? ' on' : ''}`} /></div>
      ))}
    </div>
  );
}

export default function Landing() {
  const { locale } = useI18n();
  const router = useRouter();
  // An installed app (the home-screen icon) opens the workspace for a signed-in user; a visitor without a session stays on
  // the landing. The session cookie is httpOnly, so the check is a request to /auth/me.
  useEffect(() => {
    const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!installed) return;
    api('/auth/me').then(() => router.replace('/dashboard')).catch(() => undefined);
  }, [router]);
  const L = LANDING[locale];
  const mocks: Record<string, React.ReactNode> = {
    reports: <MockReport title={L.mock.report} rows={L.mock.rows} />,
    ai: <MockChat a={L.mock.chatIn} b={L.mock.chatOut} slots={L.mock.slots} />,
    booking: <MockChat a={L.mock.chatIn} b={L.mock.chatOut} slots={L.mock.slots} />,
    auto: <MockRules rules={L.mock.rules} />,
    funnel: <MockFunnel steps={L.mock.funnel} />,
  };
  const live = L.integrations.list.filter((i) => i.live);
  const soon = L.integrations.list.filter((i) => !i.live);

  return (
    <div className="land">
      <header className="land-head">
        <Link href="/" className="brand land-brand"><Brand /></Link>
        <nav className="land-nav" aria-label="menu">
          <a href="#features">{L.nav.features}</a>
          <a href="#demo">{L.nav.demo}</a>
          <a href="#integrations">{L.nav.integrations}</a>
          <a href="#pricing">{L.nav.pricing}</a>
          <a href="#faq">{L.nav.faq}</a>
        </nav>
        <div className="land-head-right">
          <LanguageSwitcher compact />
          <Link href="/login" className="btn btn-sm">{L.nav.login}</Link>
        </div>
      </header>

      <section className="land-hero">
        <div className="land-hero-text">
          <h1>{L.hero.title}</h1>
          <p>{L.hero.sub}</p>
          <div className="land-cta">
            <Link href="/demo" className="btn btn-primary btn-lg">{L.hero.demo}</Link>
            <Link href="/login?register=1" className="btn btn-lg">{L.hero.connect}</Link>
          </div>
          <p className="land-note">{L.hero.note}</p>
        </div>
        <div className="land-hero-art">
          <MockChat a={L.mock.chatIn} b={L.mock.chatOut} slots={L.mock.slots} />
          <MockReport title={L.mock.report} rows={L.mock.rows} />
        </div>
      </section>

      <section className="land-section">
        <h2>{L.result.title}</h2>
        <div className="land-grid">
          {L.result.items.map((x) => (
            <div key={x.t} className="land-card"><h3>{x.t}</h3><p>{x.d}</p></div>
          ))}
        </div>
      </section>

      <section id="features" className="land-section">
        {L.features.map((f, i) => (
          <div key={f.id} className={`land-feature${i % 2 ? ' flip' : ''}`}>
            <div>
              <h2>{f.title}</h2>
              <p>{f.text}</p>
              <ul>{f.points.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
            {mocks[f.id]}
          </div>
        ))}
      </section>

      <section id="demo" className="land-section land-demo">
        <h2>{L.demo.title}</h2>
        <p>{L.demo.text}</p>
        <ol>{L.demo.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        <Link href="/demo" className="btn btn-primary btn-lg">{L.demo.cta}</Link>
      </section>

      <section id="integrations" className="land-section">
        <h2>{L.integrations.title}</h2>
        <p className="land-sub">{L.integrations.sub}</p>
        <h3 className="land-h3">{L.integrations.live}</h3>
        <div className="land-grid">
          {live.map((i) => (
            <div key={i.name} className="land-card"><b>{i.name}</b><p>{i.what}</p></div>
          ))}
        </div>
        <h3 className="land-h3">{L.integrations.soon}</h3>
        <div className="land-grid">
          {soon.map((i) => (
            <div key={i.name} className="land-card soon"><b>{i.name}</b><p>{i.what}</p></div>
          ))}
        </div>
      </section>

      <section id="pricing" className="land-section">
        <h2>{L.pricing.title}</h2>
        <p className="land-sub">{L.pricing.sub}</p>
        <div className="land-grid two">
          {L.pricing.plans.map((p) => (
            <div key={p.name} className={`land-card plan${p.pro ? ' pro' : ''}`}>
              <h3>{p.name}</h3>
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
        <h2>{L.security.title}</h2>
        <ul className="land-ticks">{L.security.items.map((s) => <li key={s}>{s}</li>)}</ul>
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

      <footer className="land-foot">{L.footer} <a href="mailto:hello@lankaclinic.app">hello@lankaclinic.app</a> · <Link href="/terms">{L.nav.terms}</Link> · <Link href="/privacy">{L.nav.privacy}</Link></footer>
    </div>
  );
}
