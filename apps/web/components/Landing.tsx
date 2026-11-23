'use client';

import { Inter_Tight, Onest } from 'next/font/google';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { LOCALES, Locale, useI18n } from '../lib/i18n';
import { LANDING, LandingText } from '../lib/landing-text';
import { LANDING_PATH } from '../lib/site';
import { ChannelIcon } from './ChannelIcon';
import { OwnerDetails } from './OwnerDetails';
import { Icon } from './ui';

// The landing's own type: a tight display face for headings and a Cyrillic-first text face (self-hosted by Next, no request to Google at runtime)
const display = Inter_Tight({ subsets: ['latin', 'cyrillic'], weight: ['600', '700', '800'], variable: '--lp-display', display: 'swap' });
const text = Onest({ subsets: ['latin', 'cyrillic'], weight: ['400', '500', '600', '700'], variable: '--lp-text', display: 'swap' });

// The public contact address (footer and the fallback when the call-back form cannot send)
const EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'hello@lankaclinic.app';

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// The LANKA mark: a gradient tile with the letter
function Mark({ size = 34 }: { size?: number }) {
  return <span className="lp-mark" style={{ width: size, height: size, fontSize: size * 0.53 }} aria-hidden="true">L</span>;
}

function Logo() {
  return (
    <span className="lp-logo">
      <Mark />
      <span>LANKA</span>
    </span>
  );
}

// "Call me back" (POST /contact-requests: the phone, an optional name, the consent). The request reaches the service owner (/platform and an email);
// the demo is offered while the visitor waits. A hidden trap field catches simple bots. Used inline (the closing section) and in a dialog.
function ContactForm({ lang, L, dark, title }: { lang: Locale; L: LandingText; dark?: boolean; title?: string }) {
  const C = L.contact;
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [trap, setTrap] = useState('');
  const [state, setState] = useState<'form' | 'sending' | 'done' | 'error'>('form');
  const digits = phone.replace(/\D/g, '');
  const ready = digits.length >= 9 && digits.length <= 15 && consent && state !== 'sending';
  async function submit(e: FormEvent) {
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
  if (state === 'done')
    return (
      <div className={`lp-form${dark ? ' dark' : ''}`} role="status">
        <p className="lp-form-ok"><Icon name="check" size={22} />{C.done}</p>
        <p className="lp-form-small">{C.demoHint}</p>
        <Link href="/demo" className="lp-btn lp-btn-mint">{C.demo}</Link>
      </div>
    );
  return (
    <form className={`lp-form${dark ? ' dark' : ''}`} onSubmit={submit} noValidate>
      {title && <b className="lp-form-title">{title}</b>}
      <label className="lp-field">
        <span>{C.phone}</span>
        <input type="tel" inputMode="tel" autoComplete="tel" placeholder="+380 __ ___ __ __" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} required />
      </label>
      <label className="lp-field">
        <span>{C.name}</span>
        <input type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      {/* a field people do not see: a bot that fills it gets the usual answer, and nothing is saved */}
      <input className="lp-trap" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} name="website" />
      <label className="lp-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{C.consent} <Link href="/privacy" target="_blank">{C.privacy}</Link></span>
      </label>
      {state === 'error' && <p className="lp-form-err" role="alert">{C.error} <a href={`mailto:${EMAIL}`}>{EMAIL}</a></p>}
      <button type="submit" className="lp-btn lp-btn-white" disabled={!ready}>{state === 'sending' ? C.sending : C.submit}</button>
    </form>
  );
}

function ContactDialog({ lang, L, open, onClose }: { lang: Locale; L: LandingText; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="lp-dialog" aria-labelledby="lp-dialog-title" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button type="button" className="lp-dialog-close" onClick={onClose} aria-label={L.contact.close}><Icon name="close" size={20} /></button>
      <h2 id="lp-dialog-title">{L.contact.title}</h2>
      <p className="lp-form-small">{L.contact.text}</p>
      {open && <ContactForm lang={lang} L={L} />}
    </dialog>
  );
}

// Real links, one address per language, so crawlers can follow them
function LandingLangs({ lang }: { lang: Locale }) {
  return (
    <div className="lp-langs" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <Link key={l.code} href={LANDING_PATH[l.code]} hrefLang={l.code} lang={l.code} className={lang === l.code ? 'active' : undefined} title={l.label} aria-current={lang === l.code ? 'page' : undefined}>
          {l.code.toUpperCase()}
        </Link>
      ))}
    </div>
  );
}

const Sparkle = ({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
);

// The hero's Instagram conversation answered by the AI (a drawing with made-up data)
function InstagramChat({ L }: { L: LandingText }) {
  const c = L.hero.chat;
  return (
    <div className="lp-ig" aria-label={`Instagram · ${L.ui.example}`} role="img">
      <div className="lp-ig-head">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        <span className="lp-ig-ring"><span>ОК</span></span>
        <div className="lp-ig-who"><b>{c.handle}</b><small>{c.status}</small></div>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m23 7-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>
      </div>
      <div className="lp-ig-body">
        <div className="lp-ig-time">{c.time}</div>
        <div className="lp-ig-in lp-in" style={{ animationDelay: '1.2s' }}><span className="lp-ig-ava" /><span>{c.in1}</span></div>
        <div className="lp-ig-out lp-in" style={{ animationDelay: '2s' }}>{c.out1}</div>
        <div className="lp-ig-in lp-in" style={{ animationDelay: '2.8s' }}><span className="lp-ig-ava" /><span>{c.in2}</span></div>
        <div className="lp-ig-out lp-in" style={{ animationDelay: '3.5s' }}>{c.out2}</div>
        <div className="lp-ig-slots lp-in" style={{ animationDelay: '3.8s' }}>{c.slots.map((s) => <span key={s}>{s}</span>)}</div>
        <div className="lp-ig-ai lp-in" style={{ animationDelay: '4s' }}><Sparkle size={12} />{c.ai}</div>
        <div className="lp-ig-in lp-in" style={{ animationDelay: '4.4s' }}><span className="lp-ig-ava" /><span className="lp-typing"><i /><i /><i /></span></div>
      </div>
      <div className="lp-ig-input"><span className="lp-ig-cam" /><span>{c.input}</span></div>
    </div>
  );
}

// The public landing page: hero with the app preview, where patients get lost, all channels in one place, the AI sales funnel, the team and the
// owner's Telegram, the launch, pricing (monthly or yearly), security, questions and the closing form. Claims follow lib/landing-text.ts.
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
  const H = L.hero;
  const P = L.pricing;
  const [menu, setMenu] = useState(false);
  const [contact, setContact] = useState(false);
  const [yearly, setYearly] = useState(false);
  const nav: [string, string][] = [['#product', L.nav.product], ['#ai', L.nav.ai], ['#launch', L.nav.launch], ['#pricing', L.nav.pricing], ['#faq', L.nav.faq]];
  const strip = [...L.strip.items, ...L.strip.items];
  const starColor = ['#8B7BFF', '#2DE0A7', '#FF8A5B'];
  const cell = (v: string, strong?: boolean) => (v === '✓' ? <span className="lp-yes">✓</span> : v === '—' ? <span className="lp-no">—</span> : <span className={strong ? 'lp-strong' : undefined}>{v}</span>);

  return (
    <div className={`lp ${display.variable} ${text.variable}`}>
      {/* ---------- hero ---------- */}
      <section className="lp-hero">
        <div className="lp-glow" style={{ width: 620, height: 620, background: '#2DE0A7', opacity: 0.2, top: 120, left: -160 }} />
        <div className="lp-glow" style={{ width: 560, height: 560, background: '#8B7BFF', opacity: 0.3, top: 40, right: -120, animationDelay: '-6s' }} />
        <div className="lp-glow" style={{ width: 360, height: 360, background: '#FF8A5B', opacity: 0.16, top: 520, left: '45%', animationDelay: '-11s' }} />
        <div className="lp-dots" />
        <div className="lp-wrap lp-rel">
          <header className="lp-head">
            <Link href={LANDING_PATH[lang]} className="lp-home" aria-label="LANKA"><Logo /></Link>
            <nav className={`lp-nav${menu ? ' open' : ''}`} id="lp-nav" aria-label={L.nav.menu}>
              {nav.map(([href, t]) => <a key={href} href={href} onClick={() => setMenu(false)}>{t}</a>)}
            </nav>
            <div className="lp-head-right">
              <LandingLangs lang={lang} />
              <Link href="/login" className="lp-login">{L.nav.login}</Link>
              <Link href="/demo" className="lp-btn lp-btn-mint lp-btn-sm lp-shine lp-head-demo">{L.nav.demo}</Link>
              <button type="button" className="lp-burger" aria-expanded={menu} aria-controls="lp-nav" aria-label={L.nav.menu} onClick={() => setMenu(!menu)}>
                <Icon name={menu ? 'close' : 'menu'} size={22} />
              </button>
            </div>
          </header>

          <div className="lp-hero-text">
            <p className="lp-pill lp-in"><span>{H.badgeNew}</span>{H.badge}</p>
            <h1 className="lp-in" style={{ animationDelay: '.1s' }}>{H.title1}<br /><span className="lp-grad">{H.title2}</span></h1>
            <p className="lp-hero-sub lp-in" style={{ animationDelay: '.25s' }}>{H.sub}</p>
            <div className="lp-cta lp-in" style={{ animationDelay: '.4s' }}>
              <Link href="/demo" className="lp-btn lp-btn-mint lp-btn-lg lp-shine">{H.demo}</Link>
              <button type="button" className="lp-btn lp-btn-ghost lp-btn-lg" onClick={() => setContact(true)}>{H.discuss}</button>
            </div>
          </div>

          {/* the app preview (made-up demo data): the dashboard and an Instagram conversation answered by the AI */}
          <div className="lp-preview lp-in" style={{ animationDelay: '.6s' }}>
            <div className="lp-browser">
              <div className="lp-browser-bar" aria-hidden="true"><i /><i /><i /><span>{H.appUrl}</span></div>
              <div className="lp-app">
                <div className="lp-app-main">
                  <div className="lp-stats">
                    {H.stats.map((s) => (
                      <div key={s.label} className="lp-stat"><small>{s.label}</small><b className={s.tone === 'warn' ? 'warn' : undefined}>{s.value}</b><span className={s.tone}>{s.delta}</span></div>
                    ))}
                  </div>
                  <div className="lp-now">
                    <div className="lp-now-head"><b>{H.nowTitle}</b><small>{H.nowUpdated}</small></div>
                    {H.now.map((n, i) => (
                      <div key={n.text} className={`lp-now-row${i === 0 ? ' lp-loop' : ''}`}><i className={`dot-${n.tone}`} /><span>{n.text}</span><em className={`tag-${n.tone}`}>{n.tag}</em></div>
                    ))}
                  </div>
                </div>
                <InstagramChat L={L} />
              </div>
            </div>
            <div className="lp-float lp-float-req" aria-hidden="true">
              <span className="lp-float-icon"><Icon name="calendar" size={20} /></span>
              <div><b>{H.floatReq.t}</b><small>{H.floatReq.d}</small></div>
            </div>
            <div className="lp-float lp-float-signal" aria-hidden="true">{H.floatSignal}</div>
          </div>
        </div>
      </section>

      <main>
        {/* ---------- channels strip ---------- */}
        <section className="lp-strip">
          <div className="lp-wrap lp-strip-in">
            <span>{L.strip.label}</span>
            <div className="lp-marquee-box">
              <div className="lp-marquee">
                {strip.map((x, i) => (
                  <span key={i} aria-hidden={i >= L.strip.items.length || undefined}>{x}<em style={{ color: starColor[i % 3] }}>✦</em></span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- 01 where patients get lost ---------- */}
        <section className="lp-section">
          <div className="lp-wrap">
            <div className="lp-sec-head lp-reveal">
              <div>
                <p className="lp-eyebrow coral">{L.problem.eyebrow}</p>
                <h2>{L.problem.title1} <span className="coral">{L.problem.title2}</span></h2>
              </div>
              <p className="lp-sec-lead">{L.problem.lead}</p>
            </div>
            <div className="lp-pairs">
              {L.problem.rows.map((r) => (
                <div key={r.when} className="lp-pair lp-reveal">
                  <div className="lp-loss"><b className="lp-when">{r.when}</b><div><b>{r.loss}</b><span className="lp-strike">{r.lossD}</span></div></div>
                  <div className="lp-fix">
                    <span className={`lp-fix-icon ${r.icon}`}>{r.icon === 'ai' ? <Sparkle size={22} color="#fff" /> : r.icon === 'back' ? <Icon name="refresh" size={22} /> : <Icon name="alert" size={22} />}</span>
                    <div><b>{r.fixT}</b><span>{r.fixD}</span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- 02 all channels in one place ---------- */}
        <section id="product" className="lp-section lp-section-top0">
          <div className="lp-wrap">
            <div className="lp-sec-head stack lp-reveal">
              <p className="lp-eyebrow">{L.product.eyebrow}</p>
              <h2>{L.product.title1} <span className="green">{L.product.title2}</span></h2>
              <p className="lp-sec-lead wide">{L.product.lead}</p>
            </div>
            <div className="lp-hub lp-dark-card lp-reveal">
              <div className="lp-glow" style={{ width: 420, height: 420, background: '#8B7BFF', opacity: 0.25, top: -160, left: '38%' }} />
              <div className="lp-hub-row">
                <div className="lp-hub-sources">
                  {L.product.hub.sources.map((s, i) => (
                    <div key={s.key} className="lp-hub-src">
                      <span className="lp-hub-chip">{s.key === 'web' ? <span className="lp-web-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></svg></span> : <ChannelIcon name={s.key} size={26} />}{s.name}</span>
                      <span className="lp-flow" style={{ animationDelay: `${-i * 0.5}s` }} />
                    </div>
                  ))}
                </div>
                <div className="lp-hub-core"><span className="lp-hub-mark lp-pulse">L</span><small>{L.product.hub.center}</small></div>
                <span className="lp-flow lp-hub-out" />
                <div className="lp-feed">
                  <div className="lp-feed-head"><b>{L.product.hub.feedTitle}</b><small>{L.ui.demoData}</small></div>
                  {L.product.hub.feed.map((f, i) => <div key={f.text} className={`lp-feed-row${i === 0 ? ' lp-loop' : ''}`}><span>{f.text}</span><em className={`tag-${f.tone}`}>{f.ch}</em></div>)}
                </div>
              </div>
              <ul className="lp-hub-points">{L.product.hub.points.map((p) => <li key={p}>✓ {p}</li>)}</ul>
            </div>

            <div className="lp-bento">
              <article className="lp-card lp-soft lp-span lp-reveal">
                <div className="lp-card-text"><h3>{L.product.inbox.t}</h3><p>{L.product.inbox.d}</p></div>
                <div className="lp-inbox">
                  {L.product.inbox.rows.map((r, i) => (
                    <div key={r.name} className={`lp-inbox-row${i === 0 ? ' lp-loop' : ''}`}><span className={`lp-ava tag-${r.tone}`}>{r.ini}</span><div><b>{r.name}</b><small>{r.text}</small></div><em className={`tag-${r.tone}`}>{r.tag}</em></div>
                  ))}
                </div>
              </article>
              <article className="lp-card lp-dark-card lp-reveal">
                <div className="lp-glow" style={{ width: 260, height: 260, background: '#8B7BFF', opacity: 0.35, top: -80, right: -60 }} />
                <div className="lp-rel">
                  <h3>{L.product.assistant.t}</h3>
                  <div className="lp-ask"><span className="lp-typer">{L.product.assistant.q}</span></div>
                  <div className="lp-bars">
                    {L.product.assistant.rows.map(([n, v], i) => (
                      <div key={n}><span>{n}</span><i style={{ maxWidth: v * 30, animationDelay: `${3.2 + i * 0.2}s` }} /><b>{v}</b></div>
                    ))}
                  </div>
                  <small className="lp-muted-dark">{L.product.assistant.note}</small>
                </div>
              </article>
              <article className="lp-card lp-line-card lp-reveal">
                <h3>{L.product.report.t}</h3>
                <p>{L.product.report.d}</p>
                <div className="lp-mini-table" role="table">
                  <div role="row" className="head"><span role="columnheader">{L.product.report.cols[0]}</span><span role="columnheader">{L.product.report.cols[1]}</span></div>
                  {L.product.report.rows.map(([a, b]) => <div role="row" key={a}><span role="cell">{a}</span><span role="cell">{b}</span></div>)}
                </div>
                <span className="lp-chip-dark">{L.product.report.btn}</span>
              </article>
              <article className="lp-card lp-soft lp-reveal">
                <h3>{L.product.remind.t}</h3>
                <p>{L.product.remind.d}</p>
                <div className="lp-rules">
                  {L.product.remind.rules.map((r, i) => <div key={r}><b>{r}</b><span className={`lp-toggle${i === 0 ? ' anim' : ''}`}><i /></span></div>)}
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ---------- 03 the AI sales funnel ---------- */}
        <section id="ai" className="lp-band-wrap">
          <div className="lp-band lp-reveal">
            <div className="lp-glow" style={{ width: 520, height: 520, background: '#8B7BFF', opacity: 0.32, top: -180, left: -120 }} />
            <div className="lp-glow" style={{ width: 380, height: 380, background: '#2DE0A7', opacity: 0.16, bottom: -140, right: 80, animationDelay: '-8s' }} />
            <div className="lp-rel">
              <p className="lp-eyebrow violet">{L.ai.eyebrow}</p>
              <h2>{L.ai.title1} <span className="lp-grad">{L.ai.title2}</span></h2>
              <p className="lp-band-lead">{L.ai.lead}</p>
              <div className="lp-funnel">
                <ol>
                  {L.ai.stages.map((s, i) => (
                    <li key={s.t}>
                      <div className="lp-chev-box"><div className={`lp-chev c${i}`}>{String(i + 1).padStart(2, '0')}</div></div>
                      <b>{s.t}</b><span>{s.d}</span>
                    </li>
                  ))}
                </ol>
                <span className="lp-runner" aria-hidden="true" />
              </div>
              <ul className="lp-notes">{L.ai.notes.map((n) => <li key={n}>✦ {n}</li>)}</ul>
              <div className="lp-modes">
                {L.ai.modes.map((m) => <div key={m.t} className={`lp-mode${m.accent ? ' accent' : ''}`}><small>{m.k}</small><b>{m.t}</b><span>{m.d}</span></div>)}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- demo call ---------- */}
        <section className="lp-section lp-mid-wrap">
          <div className="lp-wrap">
            <div className="lp-mid lp-reveal">
              <h2>{L.mid.title1} <span className="green">{L.mid.title2}</span></h2>
              <Link href="/demo" className="lp-btn lp-btn-ink lp-btn-lg lp-shine">{L.mid.cta}</Link>
            </div>
          </div>
        </section>

        {/* ---------- 04 team and the owner's Telegram ---------- */}
        <section id="team" className="lp-section lp-section-top0">
          <div className="lp-wrap">
            <div className="lp-sec-head stack lp-reveal">
              <p className="lp-eyebrow">{L.team.eyebrow}</p>
              <h2>{L.team.title}</h2>
            </div>
            <div className="lp-roles">
              {L.team.roles.map((r) => <article key={r.t} className="lp-card lp-line-card lp-reveal"><h3>{r.t}</h3><p className="green strong">{r.q}</p><p>{r.d}</p></article>)}
            </div>
            <div className="lp-owner lp-reveal">
              <div className="lp-owner-text">
                <p className="lp-eyebrow coral">{L.team.owner.eyebrow}</p>
                <h3>{L.team.owner.title}</h3>
                <p>{L.team.owner.text}</p>
                <div className="lp-chips">{L.team.owner.chips.map((c) => <span key={c}>{c}</span>)}</div>
              </div>
              <div className="lp-owner-art">
                <div className="lp-tg lp-floaty" role="img" aria-label={`Telegram · ${L.ui.example}`}>
                  <div className="lp-tg-head"><ChannelIcon name="telegram" size={38} /><div><b>{L.team.owner.chat}</b><small>{L.team.owner.chatSub}</small></div><span className="lp-badge">{L.ui.example}</span></div>
                  <div className="lp-tg-msg lp-in" style={{ animationDelay: '.3s' }}><b>{L.team.owner.digestT}</b>{L.team.owner.digest.map((d) => <span key={d}>{d}</span>)}<span className="green strong">{L.team.owner.aiLine}</span></div>
                  <div className="lp-tg-msg signal lp-in" style={{ animationDelay: '1.1s' }}><b><i className="lp-pulse-coral" />{L.team.owner.signalT}</b><span>{L.team.owner.signal}</span><span className="strong">{L.team.owner.open}</span></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- 05 launch ---------- */}
        <section id="launch" className="lp-section lp-section-top0">
          <div className="lp-wrap">
            <div className="lp-sec-head lp-reveal">
              <div>
                <p className="lp-eyebrow">{L.launch.eyebrow}</p>
                <h2>{L.launch.title1} <span className="green">{L.launch.title2}</span></h2>
              </div>
              <p className="lp-sec-lead">{L.launch.lead}</p>
            </div>
            <div className="lp-steps">
              <span className="lp-flow lp-steps-line" />
              <ol>
                {L.launch.steps.map((s, i) => <li key={s.t} className="lp-reveal"><span className={`lp-step-n s${i}`}>{i + 1}</span><b>{s.t}</b><span>{s.d}</span></li>)}
              </ol>
            </div>
          </div>
        </section>

        {/* ---------- 06 pricing ---------- */}
        <section id="pricing" className="lp-section lp-section-top0">
          <div className="lp-wrap">
            <div className="lp-sec-head lp-reveal">
              <div>
                <p className="lp-eyebrow">{P.eyebrow}</p>
                <h2>{P.title}</h2>
                <p className="lp-sec-lead wide">{P.sub}</p>
              </div>
              <div className="lp-term">
                <div className="lp-seg" role="group" aria-label={`${P.monthly} / ${P.yearly}`}>
                  <button type="button" aria-pressed={!yearly} className={!yearly ? 'on' : undefined} onClick={() => setYearly(false)}>{P.monthly}</button>
                  <button type="button" aria-pressed={yearly} className={yearly ? 'on' : undefined} onClick={() => setYearly(true)}>{P.yearly} <em>{P.yearBadge}</em></button>
                </div>
                <span>{P.yearNote}</span>
              </div>
            </div>
            <div className="lp-plans">
              {P.plans.map((p, i) => {
                const pro = i === 1;
                return (
                  <article key={p.name} className={`lp-plan lp-reveal${pro ? ' pro' : ''}`}>
                    {pro && <span className="lp-plan-best">{P.best}</span>}
                    <h3>{p.name}</h3>
                    <p className="lp-plan-lead">{p.lead}</p>
                    {yearly ? (
                      <>
                        <div className="lp-price"><b>{p.year}</b><span>{P.perYear}</span></div>
                        <p className="lp-price-note"><s>{p.full}</s><em className="lp-save">{fill(P.save, { save: p.save })}</em><span>{fill(P.approx, { sum: p.perMonthYear })}</span></p>
                      </>
                    ) : (
                      <>
                        <div className="lp-price"><b>{p.price}</b><span>{P.perMonth}</span></div>
                        <p className="lp-price-note">{fill(P.orYear, { sum: p.year })} <strong>{fill(P.save, { save: p.save })}</strong></p>
                      </>
                    )}
                    <div className="lp-plan-ai">
                      <div><b><Sparkle size={15} /> {p.aiT}</b><em>{p.aiTag}</em></div>
                      <p>{p.aiD}</p>
                      <small>{p.aiMeta}</small>
                    </div>
                    <p className="lp-plan-also">{p.alsoT}</p>
                    <ul>{p.lines.slice(1).map((l) => <li key={l}><span>✓</span>{l}</li>)}</ul>
                    <button type="button" className={`lp-btn ${pro ? 'lp-btn-mint lp-shine' : 'lp-btn-outline'}`} onClick={() => setContact(true)}>{p.cta}</button>
                  </article>
                );
              })}
            </div>
            <div className="lp-compare lp-reveal">
              <table>
                <caption>{P.compareT}</caption>
                <thead><tr><th scope="col">{P.compareCols[0]}</th><th scope="col">{P.compareCols[1]}</th><th scope="col" className="pro">{P.compareCols[2]}</th></tr></thead>
                <tbody>{P.compare.map((r) => <tr key={r.label}><th scope="row">{r.label}</th><td>{cell(r.start)}</td><td>{cell(r.pro, r.strong)}</td></tr>)}</tbody>
              </table>
              <p>{P.pack}</p>
            </div>
            <div className="lp-launch-note lp-reveal"><b>{P.launchT}</b><span>{P.launchD}</span></div>
            <div className="lp-network lp-reveal"><span><b>{P.network.name}</b> {P.network.d}</span><button type="button" className="lp-link" onClick={() => setContact(true)}>{P.network.cta}</button></div>
          </div>
        </section>

        {/* ---------- 07 security ---------- */}
        <section className="lp-section lp-section-top0">
          <div className="lp-wrap lp-split">
            <div className="lp-reveal">
              <p className="lp-eyebrow">{L.trust.eyebrow}</p>
              <h2 className="lp-h2-sm">{L.trust.title}</h2>
            </div>
            <div className="lp-trust">{L.trust.items.map((x) => <div key={x.t} className="lp-reveal"><b>{x.t}</b><span>{x.d}</span></div>)}</div>
          </div>
        </section>

        {/* ---------- 08 questions ---------- */}
        <section id="faq" className="lp-section lp-section-top0">
          <div className="lp-wrap lp-split">
            <div className="lp-reveal">
              <p className="lp-eyebrow">{L.faq.eyebrow}</p>
              <h2 className="lp-h2-sm">{L.faq.title}</h2>
              <p className="lp-muted">{L.faq.more} <button type="button" className="lp-link" onClick={() => setContact(true)}>{L.faq.moreLink}</button></p>
            </div>
            <div className="lp-faq">{L.faq.items.map((f, i) => <details key={f.q} open={i === 0}><summary>{f.q}</summary><p>{f.a}</p></details>)}</div>
          </div>
        </section>

        {/* ---------- closing ---------- */}
        <section id="contact" className="lp-band-wrap lp-final-wrap">
          <div className="lp-band lp-final lp-reveal">
            <div className="lp-glow" style={{ width: 460, height: 460, background: '#FF8A5B', opacity: 0.22, top: -160, right: 120 }} />
            <div className="lp-glow" style={{ width: 460, height: 460, background: '#8B7BFF', opacity: 0.28, bottom: -200, left: -60, animationDelay: '-7s' }} />
            <div className="lp-dots" />
            <div className="lp-final-row">
              <div>
                <h2>{L.final.title1} <span className="lp-grad">{L.final.title2}</span></h2>
                <p className="lp-band-lead">{L.final.text}</p>
                <Link href="/demo" className="lp-btn lp-btn-mint lp-btn-lg lp-shine">{L.final.demo}</Link>
              </div>
              <ContactForm lang={lang} L={L} dark title={L.final.formT} />
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot lp-wrap">
        <div className="lp-foot-brand">
          <Link href={LANDING_PATH[lang]} className="lp-home dark" aria-label="LANKA"><Logo /></Link>
          <p>{L.footer.tagline}</p>
        </div>
        <nav aria-label={L.footer.product}><b>{L.footer.product}</b><a href="#product">{L.footer.features}</a><a href="#ai">{L.nav.ai}</a><a href="#pricing">{L.nav.pricing}</a><a href="#launch">{L.nav.launch}</a></nav>
        <nav aria-label={L.footer.clients}><b>{L.footer.clients}</b><Link href="/login">{L.nav.login}</Link><Link href="/demo">{L.contact.demo}</Link><a href="#faq">{L.nav.faq}</a><a href={`mailto:${EMAIL}`}>{L.footer.contact}</a></nav>
        <nav aria-label={L.footer.docs}><b>{L.footer.docs}</b><Link href="/terms">{L.nav.terms}</Link><Link href="/privacy">{L.nav.privacy}</Link></nav>
        <OwnerDetails lang={lang} className="lp-legal" />
        <div className="lp-foot-bottom"><span>{L.footer.copyright}</span><a href={`mailto:${EMAIL}`}>{EMAIL}</a><LandingLangs lang={lang} /></div>
      </footer>

      <ContactDialog lang={lang} L={L} open={contact} onClose={() => setContact(false)} />
    </div>
  );
}
