import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { MailService } from '../auth/mail.service';
import { decrypt, encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { FacebookService } from './facebook.service';
import { InstagramService } from './instagram.service';
import { graphVersion, MetaLoginApi, PageInfo } from './meta-login.api';
import { metaWebOrigin } from './meta-chat.service';

const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 15 * 60_000;
const DAY = 86_400_000;
// A token that ends is reported this long before it does
const WARN_BEFORE_MS = 7 * DAY;
export const FB_MODE = 'FACEBOOK_LOGIN';

export const metaLoginRedirectUri = () => `${metaWebOrigin()}/backend/meta/oauth/callback`;
export const metaLoginReady = () => !!process.env.META_APP_ID && !!process.env.META_APP_SECRET && !!process.env.META_CONFIG_ID;

const stateSecret = () => `${process.env.JWT_SECRET ?? ''}:meta-login`;
const sign = (payload: string) => createHmac('sha256', stateSecret()).update(payload).digest('base64url');

function signState(clinicId: string, userId: string) {
  const payload = Buffer.from(JSON.stringify({ clinicId, userId, exp: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readState(state: string | undefined): { clinicId: string; userId: string } {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig) throw new BadRequestException('meta_oauth_failed');
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('meta_oauth_failed');
  let d: { clinicId?: string; userId?: string; exp?: number };
  try {
    d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('meta_oauth_failed');
  }
  if (!d.clinicId || !d.userId || !d.exp || d.exp < Date.now()) throw new BadRequestException('meta_oauth_failed');
  return { clinicId: d.clinicId, userId: d.userId };
}

export type ConnectResult = { page: string; instagram: string | null; messenger: boolean; leads: boolean };
export type LoginResult = { kind: 'connected'; result: ConnectResult } | { kind: 'select'; sessionId: string };

// What the permissions of the token allow. Each channel needs its own permission and none of them depends on another:
// Messenger needs pages_messaging, Instagram messages need instagram_manage_messages, lead forms need leads_retrieval.
export function allowed(scopes: string[]) {
  const has = (s: string) => scopes.includes(s);
  return { messenger: has('pages_messaging'), instagram: has('instagram_manage_messages'), leads: has('leads_retrieval') };
}

// Connecting the clinic's Facebook page and the Instagram account attached to it with Facebook Login for Business: the clinic's owner
// signs in to Facebook with our configuration (Configuration ID), picks the page and the Instagram account in Meta's own dialog, and
// comes back with a code. The code becomes a token; the page token is taken from it and stored encrypted.
//
// Token life: the configuration uses the "System-user access token" kind, which does not expire, so nothing is refreshed on a
// schedule. Instead the token is checked once a day (is it still valid, does it have an end date): a token that was revoked or one
// that has an end date (a differently configured login) is reported to the owner before it stops working, never silently renewed.
@Injectable()
export class MetaLoginService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(MetaLoginService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private api: MetaLoginApi,
    private instagram: InstagramService,
    private facebook: FacebookService,
    private mail: MailService,
  ) {}

  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.checkTokens().catch((e) => this.log.warn(`Meta token check: ${(e as Error).message}`)), 6 * 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // The address of Facebook's dialog for our configuration. `config_id` replaces a list of permissions: what is asked is set in the configuration.
  async startUrl(clinicId: string, userId: string): Promise<string> {
    if (!metaLoginReady()) throw new BadRequestException('meta_oauth_not_ready');
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, isDemo: true } });
    if (clinic.isDemo) throw new ForbiddenException('demo_restricted');
    if (!hasFeature(clinic.plan, 'multi_channel')) throw new BadRequestException('plan_feature');
    const q = new URLSearchParams({
      client_id: process.env.META_APP_ID!,
      redirect_uri: metaLoginRedirectUri(),
      state: signState(clinicId, userId),
      config_id: process.env.META_CONFIG_ID!,
      response_type: 'code',
      override_default_response_type: 'true',
    });
    return `https://www.facebook.com/${graphVersion()}/dialog/oauth?${q}`;
  }

  // The person comes back. The clinic is taken only from the signed state, and the role is checked again.
  async finish(code: string | undefined, state: string | undefined, error?: string): Promise<LoginResult> {
    if (error === 'access_denied') throw new BadRequestException('meta_oauth_denied');
    if (error || !code) throw new BadRequestException('meta_oauth_failed');
    const { clinicId, userId } = readState(state);
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId, clinicId } }, select: { role: true, clinic: { select: { isDemo: true } } } });
    if (!m || (m.role !== 'OWNER' && m.role !== 'MANAGER')) throw new ForbiddenException();
    if (m.clinic.isDemo) throw new ForbiddenException('demo_restricted');

    const tok = await this.api.exchangeCode(code.replace(/#_+$/, ''), metaLoginRedirectUri()).catch(() => {
      throw new BadRequestException('meta_oauth_failed');
    });
    const info = await this.api.debugToken(tok.accessToken).catch(() => null);
    if (!info?.isValid) throw new BadRequestException('meta_oauth_failed');
    let pages = await this.api.accounts(tok.accessToken).catch(() => [] as PageInfo[]);
    // The person limited the dialog to some pages: only those
    if (info.pageIds.length) pages = pages.filter((p) => info.pageIds.includes(p.id));
    if (!pages.length) throw new BadRequestException('meta_no_pages');

    await this.prisma.metaConnectSession.deleteMany({ where: { clinicId, OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
    const session = await this.prisma.metaConnectSession.create({
      data: { clinicId, userId, tokenEnc: encrypt(tok.accessToken), tokenInfo: { type: info.type, scopes: info.scopes, expiresAt: info.expiresAt ?? (tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : null) }, pages: pages.map((p) => ({ id: p.id, name: p.name, igId: p.igId, igUsername: p.igUsername })), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    // One page: no question to ask
    if (pages.length === 1) {
      return { kind: 'connected', result: await this.connect(clinicId, userId, session.id, pages[0].id) };
    }
    return { kind: 'select', sessionId: session.id };
  }

  // The pages offered for the choice (never a token)
  async pending(clinicId: string, sessionId: string) {
    const s = await this.prisma.metaConnectSession.findFirst({ where: { id: sessionId, clinicId, expiresAt: { gt: new Date() } } });
    if (!s) throw new NotFoundException('meta_session_expired');
    return { id: s.id, pages: s.pages as { id: string; name: string; igId: string | null; igUsername: string | null }[] };
  }

  // The clinic chose a page: its token is taken and what the permissions allow is connected: the page for Messenger (pages_messaging),
  // the Instagram account attached to it (instagram_manage_messages), the lead forms (leads_retrieval). A missing permission leaves
  // that part out and never breaks the others.
  async connect(clinicId: string, userId: string, sessionId: string, pageId: string): Promise<ConnectResult> {
    const s = await this.prisma.metaConnectSession.findFirst({ where: { id: sessionId, clinicId, userId, expiresAt: { gt: new Date() } } });
    if (!s) throw new NotFoundException('meta_session_expired');
    const page = (s.pages as { id: string; name: string; igId: string | null; igUsername: string | null }[]).find((p) => p.id === pageId);
    if (!page) throw new BadRequestException('meta_no_pages');
    const tokenInfo = s.tokenInfo as { type: string; scopes?: string[]; expiresAt: number | null };
    const can = allowed(tokenInfo.scopes ?? []);
    const wantInstagram = !!page.igId && can.instagram;
    if (!can.messenger && !wantInstagram) throw new BadRequestException('meta_no_permissions');
    let pageToken: string;
    try {
      pageToken = await this.api.pageToken(decrypt(s.tokenEnc), pageId);
    } catch {
      throw new BadRequestException('meta_oauth_failed');
    }
    const extra = { mode: FB_MODE, pageId, tokenType: tokenInfo.type, ...(tokenInfo.expiresAt ? { tokenExpiresAt: tokenInfo.expiresAt } : {}), connectedById: userId };
    // Both channels are checked for conflicts before anything is written, so a conflict on one does not leave the other half-connected
    if (can.messenger) await this.facebook.attach(clinicId, { ownId: page.id, name: page.name, token: pageToken, config: extra });
    if (wantInstagram) await this.instagram.attach(clinicId, { ownId: page.igId!, name: page.igUsername, token: pageToken, config: { ...extra, igUsername: page.igUsername } });
    // Subscription. With pages_messaging it is required (Messenger would be deaf without it). Without it the subscription is still
    // tried for Instagram, but a refusal is only noted: Instagram messages also depend on the app-level webhook setting in the Meta dashboard.
    const base = can.messenger ? 'messages,messaging_postbacks' : 'messages';
    let subscribeWarning: string | undefined;
    try {
      await this.api.subscribe(pageToken, pageId, base);
    } catch (e) {
      if (can.messenger) throw new BadRequestException(e instanceof Error && /permission/i.test(e.message) ? 'meta_subscribe_denied' : 'meta_subscribe_failed');
      subscribeWarning = (e as Error).message.slice(0, 160);
      this.log.warn(`Page ${pageId}: not subscribed (${subscribeWarning})`);
    }
    // Lead forms only with their own permission, and a failure there must not undo the connection
    if (can.leads) await this.api.subscribe(pageToken, pageId, `${base},leadgen`).catch((e) => this.log.warn(`Lead forms not subscribed: ${(e as Error).message}`));
    if (subscribeWarning) {
      for (const row of await this.prisma.integration.findMany({ where: { clinicId, provider: { in: [Provider.MESSENGER, Provider.INSTAGRAM] }, config: { path: ['pageId'], equals: pageId } } })) {
        await this.prisma.integration.update({ where: { id: row.id }, data: { config: { ...(row.config as object), subscribeWarning } } });
      }
    }
    await this.prisma.metaConnectSession.delete({ where: { id: s.id } });
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'meta.connected', details: { pageId, messenger: can.messenger, instagram: wantInstagram, leads: can.leads, tokenType: tokenInfo.type, expires: tokenInfo.expiresAt ? new Date(tokenInfo.expiresAt).toISOString() : 'never' } } });
    return { page: page.name, instagram: wantInstagram ? page.igUsername : null, messenger: can.messenger, leads: can.leads };
  }

  // Once in a few hours: is each token of a Facebook-login connection still valid, and does it end soon? A problem is written to the
  // connection (the page shows it) and the owner is told once.
  async checkTokens(now = Date.now()) {
    const rows = await this.prisma.integration.findMany({ where: { provider: { in: [Provider.INSTAGRAM, Provider.MESSENGER] }, apiKeyEnc: { not: null } }, select: { id: true, clinicId: true, provider: true, apiKeyEnc: true, config: true } });
    // One letter per clinic: its page and its Instagram account usually share the same token
    const news = new Map<string, { problem: 'invalid' | 'expiring'; expiresAt: number | null }>();
    for (const row of rows) {
      const cfg = (row.config ?? {}) as { mode?: string; tokenProblem?: string | null; tokenExpiresAt?: number };
      if (cfg.mode !== FB_MODE) continue;
      const info = await this.api.debugToken(decrypt(row.apiKeyEnc!)).catch(() => null);
      if (!info) continue; // Meta did not answer: ask again later
      const problem = !info.isValid ? 'invalid' : info.expiresAt && info.expiresAt - now < WARN_BEFORE_MS ? 'expiring' : undefined;
      if ((problem ?? null) === (cfg.tokenProblem ?? null)) continue;
      await this.prisma.integration.update({ where: { id: row.id }, data: { config: { ...cfg, tokenProblem: problem ?? null, ...(info.expiresAt ? { tokenExpiresAt: info.expiresAt } : {}) } } });
      await this.prisma.auditLog.create({ data: { clinicId: row.clinicId, action: problem ? 'meta.token_problem' : 'meta.token_ok', details: { provider: row.provider, problem: problem ?? null } } });
      if (problem && !news.has(row.clinicId)) news.set(row.clinicId, { problem, expiresAt: info.expiresAt });
    }
    for (const [clinicId, n] of news) {
      const owner = await this.prisma.membership.findFirst({ where: { clinicId, role: 'OWNER' }, select: { user: { select: { email: true } } } });
      if (!owner) continue;
      await this.mail.send({
        to: owner.user.email,
        subject: 'LANKA: потрібно заново підключити Facebook / Instagram',
        text: n.problem === 'invalid' ? 'Доступ до Facebook або Instagram клініки відкликано або він перестав діяти, тому повідомлення з цього каналу не надходять. Підключіть канал знову на сторінці «Автоматизації».' : `Доступ до Facebook або Instagram клініки закінчується ${new Date(n.expiresAt!).toISOString().slice(0, 10)}. Підключіть канал знову на сторінці «Автоматизації», щоб повідомлення не припинилися.`,
      });
    }
  }
}
