import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { decrypt, encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { graphVersion, MetaLoginApi } from '../automations/meta-login.api';
import { metaWebOrigin } from '../automations/meta-chat.service';
import { AdAccountInfo, InsightRow, MetaAdsApi, MetaAdsError } from './meta-ads.api';

// Meta ad analytics, stage 1 (2026-11-24). Read only, the ads_read permission only, through its own Facebook Login for Business
// configuration (META_ADS_CONFIG_ID): the Instagram/Messenger login, its configuration and its App Review are not touched.
//
// What is counted and how:
//  - spend, impressions and link clicks are stored per campaign and day (the ad account's own days) and added up for a period;
//  - reach is asked from Meta for the WHOLE period (account and each campaign) and never added from days or campaigns;
//  - results are three separate kinds that are never added together, each with its own cost = spend / count (never an average of daily costs);
//    a kind Meta did not report for the period is "not reported" (null), not zero; with zero results the cost is not shown;
//  - Meta may recount past days: every refresh reads the last RECENT_DAYS again and REPLACES the stored rows of the days it read;
//  - the amounts stay in the ad account's currency, nothing is converted.
const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 15 * 60_000;
export const MAX_PERIOD_DAYS = 93;
const RECENT_DAYS = 28;
// one refresh per clinic at a time, and not more often than this
const REFRESH_GAP_MS = 2 * 60_000;
const CLAIM_MS = 5 * 60_000;
// The attribution windows asked for explicitly (and shown with the numbers): a click within 7 days or a view within 1 day
export const ATTRIBUTION = ['7d_click', '1d_view'];

// Result kinds and the Meta action types they read. "verified": confirmed by Meta's documentation; the others are the documented names that still
// must be checked against the first live answer of a real ad account (shown in the workspace as such). Overlapping types (e.g. the plain "lead",
// which also contains website leads) are never read, so nothing is counted twice.
export const RESULT_TYPES = {
  leadForm: { actionType: 'onsite_conversion.lead_grouped', verified: false },
  messaging: { actionType: 'onsite_conversion.messaging_conversation_started_7d', verified: false },
  website: { actionType: 'offsite_conversion.fb_pixel_lead', verified: true },
} as const;
type ResultKind = keyof typeof RESULT_TYPES;
const KINDS = Object.keys(RESULT_TYPES) as ResultKind[];

export const metaAdsReady = () => !!process.env.META_APP_ID && !!process.env.META_APP_SECRET && !!process.env.META_ADS_CONFIG_ID;
export const metaAdsRedirectUri = () => `${metaWebOrigin()}/backend/meta-ads/oauth/callback`;

// The state of the login is signed with its own key: a state of the Instagram login is never accepted here, and the other way round
const sign = (payload: string) => createHmac('sha256', `${process.env.JWT_SECRET ?? ''}:meta-ads`).update(payload).digest('base64url');
function signState(clinicId: string, userId: string) {
  const payload = Buffer.from(JSON.stringify({ clinicId, userId, exp: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readState(state: string | undefined) {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig) throw new BadRequestException('meta_ads_failed');
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('meta_ads_failed');
  const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { clinicId?: string; userId?: string; exp?: number };
  if (!d.clinicId || !d.userId || !d.exp || d.exp < Date.now()) throw new BadRequestException('meta_ads_failed');
  return { clinicId: d.clinicId, userId: d.userId };
}

// ---------- the ad account's days ----------
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// today in the ad account's time zone
export function todayIn(tz: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
// the moment a day of the ad account begins (its midnight), as a UTC instant
export function dayStartUtc(day: string, tz: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}
// a period the user picked: valid days, in order, not longer than MAX_PERIOD_DAYS
export function checkPeriod(since: string, until: string) {
  if (!DAY_RE.test(since) || !DAY_RE.test(until) || since > until) throw new BadRequestException('bad_period');
  if ((Date.parse(until) - Date.parse(since)) / 86_400_000 + 1 > MAX_PERIOD_DAYS) throw new BadRequestException('bad_period');
}

const num = (v?: string) => (v === undefined || v === null || v === '' ? null : Number(v));
// The count of one action type in a row; absent = not reported (null)
const actionCount = (row: InsightRow, type: string) => {
  const a = row.actions?.find((x) => x.action_type === type);
  return a ? Number(a.value) : null;
};

@Injectable()
export class MetaAdsService {
  private readonly log = new Logger(MetaAdsService.name);

  constructor(
    private prisma: PrismaService,
    private login: MetaLoginApi,
    private api: MetaAdsApi,
  ) {}

  // ---------- connection ----------

  // What the workspace shows: is the platform set up, is an account connected and in what state (never the token)
  async status(clinicId: string, role: string) {
    const [link, leads] = await Promise.all([
      this.prisma.adAccountLink.findUnique({ where: { clinicId } }),
      this.leadsConnected(clinicId),
    ]);
    const expired = !!link && (link.status === 'EXPIRED' || (!!link.tokenExpiresAt && link.tokenExpiresAt < new Date()));
    return {
      platformReady: metaAdsReady(),
      canManage: role === 'OWNER',
      leadAdsConnected: leads,
      account: link
        ? { accountId: link.accountId, name: link.name, currency: link.currency, timezoneName: link.timezoneName, state: expired ? 'EXPIRED' : link.status, connectedAt: link.connectedAt, lastSuccessAt: link.lastSuccessAt, lastAttemptAt: link.lastAttemptAt, lastError: link.lastError }
        : null,
      attribution: ATTRIBUTION,
      resultTypes: RESULT_TYPES,
    };
  }

  // Facebook's dialog with the ads configuration (config_id decides what is asked: ads_read only)
  async startUrl(clinicId: string, userId: string) {
    if (!metaAdsReady()) throw new BadRequestException('meta_ads_not_ready');
    const c = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { isDemo: true } });
    if (c.isDemo) throw new ForbiddenException('demo_restricted');
    const q = new URLSearchParams({ client_id: process.env.META_APP_ID!, redirect_uri: metaAdsRedirectUri(), state: signState(clinicId, userId), config_id: process.env.META_ADS_CONFIG_ID!, response_type: 'code', override_default_response_type: 'true' });
    return { url: `https://www.facebook.com/${graphVersion()}/dialog/oauth?${q}` };
  }

  // Back from Facebook: only the owner of the clinic in the signed state; the token must carry ads_read; the accounts are offered for a choice
  async finish(code: string | undefined, state: string | undefined, error?: string): Promise<{ kind: 'connected' } | { kind: 'select'; sessionId: string }> {
    if (error === 'access_denied') throw new BadRequestException('meta_ads_denied');
    if (error || !code) throw new BadRequestException('meta_ads_failed');
    const { clinicId, userId } = readState(state);
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId, clinicId } }, select: { role: true, clinic: { select: { isDemo: true } } } });
    if (!m || m.role !== 'OWNER') throw new ForbiddenException();
    if (m.clinic.isDemo) throw new ForbiddenException('demo_restricted');
    const tok = await this.login.exchangeCode(code.replace(/#_+$/, ''), metaAdsRedirectUri()).catch(() => {
      throw new BadRequestException('meta_ads_failed');
    });
    const info = await this.login.debugToken(tok.accessToken).catch(() => null);
    if (!info?.isValid) throw new BadRequestException('meta_ads_failed');
    if (!info.scopes.includes('ads_read')) throw new BadRequestException('meta_ads_no_permission');
    const accounts = await this.api.adAccounts(tok.accessToken).catch((e: MetaAdsError) => {
      throw new BadRequestException(e.kind === 'no_permission' ? 'meta_ads_no_permission' : 'meta_ads_failed');
    });
    if (!accounts.length) throw new BadRequestException('meta_ads_no_accounts');
    const expiresAt = info.expiresAt ?? (tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : null);
    await this.prisma.adConnectSession.deleteMany({ where: { clinicId, OR: [{ userId }, { expiresAt: { lt: new Date() } }] } });
    const s = await this.prisma.adConnectSession.create({ data: { clinicId, userId, tokenEnc: encrypt(tok.accessToken), tokenExpiresAt: expiresAt ? new Date(expiresAt) : null, accounts: accounts as unknown as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    if (accounts.length === 1) {
      await this.select(clinicId, userId, s.id, accounts[0].accountId);
      return { kind: 'connected' };
    }
    return { kind: 'select', sessionId: s.id };
  }

  async pending(clinicId: string, userId: string, sessionId: string) {
    const s = await this.prisma.adConnectSession.findFirst({ where: { id: sessionId, clinicId, userId, expiresAt: { gt: new Date() } } });
    if (!s) throw new NotFoundException('meta_ads_session_expired');
    return { accounts: (s.accounts as unknown as AdAccountInfo[]).map(({ accountId, name, currency, timezoneName, status }) => ({ accountId, name, currency, timezoneName, status })) };
  }

  // One ad account per clinic. Another account replaces the previous one and its stored figures (they belong to that account).
  async select(clinicId: string, userId: string, sessionId: string, accountId: string) {
    const s = await this.prisma.adConnectSession.findFirst({ where: { id: sessionId, clinicId, userId, expiresAt: { gt: new Date() } } });
    if (!s) throw new NotFoundException('meta_ads_session_expired');
    const acc = (s.accounts as unknown as AdAccountInfo[]).find((a) => a.accountId === accountId);
    if (!acc) throw new BadRequestException('meta_ads_bad_account');
    const prev = await this.prisma.adAccountLink.findUnique({ where: { clinicId }, select: { accountId: true } });
    const data = { accountId: acc.accountId, name: acc.name.slice(0, 200), currency: acc.currency, timezoneName: acc.timezoneName, tokenEnc: s.tokenEnc, tokenExpiresAt: s.tokenExpiresAt, connectedById: userId, connectedAt: new Date(), status: 'ACTIVE', lastError: null, lastAttemptAt: null, lastSuccessAt: null, refreshClaimAt: null };
    await this.prisma.$transaction([
      ...(prev && prev.accountId !== acc.accountId ? [this.prisma.adInsightDay.deleteMany({ where: { clinicId } }), this.prisma.adPeriodReach.deleteMany({ where: { clinicId } })] : []),
      this.prisma.adAccountLink.upsert({ where: { clinicId }, create: { clinicId, ...data }, update: data }),
      this.prisma.adConnectSession.deleteMany({ where: { clinicId } }),
      this.prisma.auditLog.create({ data: { clinicId, userId, action: 'meta_ads.connected', details: { accountId: acc.accountId } } }),
    ]);
    return { ok: true };
  }

  // The owner disconnects: the token and the stored figures of the account are removed
  async disconnect(clinicId: string, userId: string) {
    await this.prisma.$transaction([
      this.prisma.adAccountLink.deleteMany({ where: { clinicId } }),
      this.prisma.adInsightDay.deleteMany({ where: { clinicId } }),
      this.prisma.adPeriodReach.deleteMany({ where: { clinicId } }),
      this.prisma.adConnectSession.deleteMany({ where: { clinicId } }),
      this.prisma.auditLog.create({ data: { clinicId, userId, action: 'meta_ads.disconnected', details: {} } }),
    ]);
    return { ok: true };
  }

  // ---------- refresh ----------

  // Reads the period and the last RECENT_DAYS again (Meta may recount them), replaces the stored rows of those days, and asks the period's reach.
  // Not more than one refresh per clinic at a time and per REFRESH_GAP_MS. A failure keeps the last good figures and is recorded.
  async refresh(clinicId: string, since: string, until: string, now = new Date()) {
    checkPeriod(since, until);
    const link = await this.prisma.adAccountLink.findUnique({ where: { clinicId } });
    if (!link) throw new BadRequestException('meta_ads_not_connected');
    const claimed = await this.prisma.adAccountLink.updateMany({
      where: { clinicId, OR: [{ refreshClaimAt: null }, { refreshClaimAt: { lt: new Date(now.getTime() - CLAIM_MS) } }], AND: [{ OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(now.getTime() - REFRESH_GAP_MS) } }] }] },
      data: { refreshClaimAt: now, lastAttemptAt: now },
    });
    if (!claimed.count) throw new HttpException('meta_ads_too_soon', HttpStatus.TOO_MANY_REQUESTS);
    let token: string;
    try {
      token = decrypt(link.tokenEnc);
    } catch {
      await this.prisma.adAccountLink.update({ where: { clinicId }, data: { refreshClaimAt: null, status: 'EXPIRED', lastError: 'expired' } });
      throw new BadRequestException('meta_ads_expired');
    }
    try {
      const acc = await this.api.account(token, link.accountId);
      const today = todayIn(acc.timezoneName, now);
      const recentFrom = addDays(today, -(RECENT_DAYS - 1));
      // the two ranges to read: the period, and the recent days; one request when they touch
      const ranges: [string, string][] = until < addDays(recentFrom, -1) ? [[since, until], [recentFrom, today]] : [[since < recentFrom ? since : recentFrom, until > today ? until : today]];
      const fields = 'campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions';
      const daily: { range: [string, string]; rows: InsightRow[] }[] = [];
      for (const r of ranges) {
        daily.push({ range: r, rows: await this.api.insights(token, link.accountId, { level: 'campaign', time_increment: '1', time_range: JSON.stringify({ since: r[0], until: r[1] }), fields, action_attribution_windows: JSON.stringify(ATTRIBUTION) }) });
      }
      // the reach of the whole period: account and campaigns (unique people of the period, as Meta counts them)
      const range = JSON.stringify({ since, until });
      const [accReach, campReach] = await Promise.all([
        this.api.insights(token, link.accountId, { level: 'account', time_range: range, fields: 'reach' }),
        this.api.insights(token, link.accountId, { level: 'campaign', time_range: range, fields: 'campaign_id,reach' }),
      ]);
      const fetchedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.adAccountLink.update({ where: { clinicId }, data: { name: acc.name.slice(0, 200), currency: acc.currency, timezoneName: acc.timezoneName } }),
        // the days read are replaced as a whole: a recount, a campaign that disappeared from a day and a repeated refresh leave no duplicates
        ...daily.flatMap((d) => [
          this.prisma.adInsightDay.deleteMany({ where: { clinicId, accountId: link.accountId, day: { gte: d.range[0], lte: d.range[1] } } }),
          this.prisma.adInsightDay.createMany({
            data: d.rows
              .filter((r) => r.campaign_id && r.date_start)
              .map((r) => ({
                clinicId, accountId: link.accountId, campaignId: r.campaign_id!, campaignName: (r.campaign_name ?? r.campaign_id!).slice(0, 300), day: r.date_start!,
                spend: new Prisma.Decimal(r.spend ?? '0'), impressions: Number(r.impressions ?? 0), linkClicks: num(r.inline_link_clicks),
                leadForm: actionCount(r, RESULT_TYPES.leadForm.actionType), messaging: actionCount(r, RESULT_TYPES.messaging.actionType), website: actionCount(r, RESULT_TYPES.website.actionType), fetchedAt,
              })),
            skipDuplicates: true,
          }),
        ]),
        this.prisma.adPeriodReach.deleteMany({ where: { clinicId, accountId: link.accountId, since, until } }),
        // the account row is written even with no delivery (reach 0): it marks the period as loaded
        this.prisma.adPeriodReach.createMany({
          data: [
            { clinicId, accountId: link.accountId, since, until, campaignId: '', reach: Number(accReach[0]?.reach ?? 0), fetchedAt },
            ...campReach.filter((r) => r.campaign_id).map((r) => ({ clinicId, accountId: link.accountId, since, until, campaignId: r.campaign_id!, reach: Number(r.reach ?? 0), fetchedAt })),
          ],
          skipDuplicates: true,
        }),
        this.prisma.adAccountLink.update({ where: { clinicId }, data: { refreshClaimAt: null, lastSuccessAt: fetchedAt, lastError: null, status: 'ACTIVE' } }),
      ]);
      return this.report(clinicId, since, until);
    } catch (e) {
      const kind = e instanceof MetaAdsError ? e.kind : 'meta_error';
      if (!(e instanceof MetaAdsError)) this.log.warn(`Meta ads refresh: ${(e as Error).message}`);
      await this.prisma.adAccountLink.update({ where: { clinicId }, data: { refreshClaimAt: null, lastError: kind, ...(kind === 'expired' ? { status: 'EXPIRED' } : kind === 'no_permission' ? { status: 'NO_PERMISSION' } : {}) } });
      throw new BadRequestException(`meta_ads_${kind}`);
    }
  }

  // ---------- the report ----------

  private async leadsConnected(clinicId: string) {
    const rows = await this.prisma.integration.findMany({ where: { clinicId, provider: { in: ['MESSENGER', 'INSTAGRAM'] } }, select: { config: true } });
    return rows.some((r) => (r.config as { leadsSubscribed?: boolean } | null)?.leadsSubscribed === true);
  }

  // The stored figures of a period (no request to Meta). "loaded": the period was refreshed at least once (its reach row exists).
  async report(clinicId: string, since: string, until: string) {
    checkPeriod(since, until);
    const link = await this.prisma.adAccountLink.findUnique({ where: { clinicId } });
    if (!link) return { state: 'not_connected' as const };
    const [days, reach, leadsOn] = await Promise.all([
      this.prisma.adInsightDay.findMany({ where: { clinicId, accountId: link.accountId, day: { gte: since, lte: until } }, orderBy: { day: 'asc' } }),
      this.prisma.adPeriodReach.findMany({ where: { clinicId, accountId: link.accountId, since, until } }),
      this.leadsConnected(clinicId),
    ]);
    const accountReach = reach.find((r) => r.campaignId === '');
    // sums of additive figures; a result kind not reported on any row stays null (not zero)
    const total = (rows: typeof days) => {
      const spend = rows.reduce((s, r) => s + Number(r.spend), 0);
      const clicks = rows.some((r) => r.linkClicks !== null) ? rows.reduce((s, r) => s + (r.linkClicks ?? 0), 0) : null;
      const results = Object.fromEntries(
        KINDS.map((k) => {
          const reported = rows.filter((r) => r[k] !== null);
          const count = reported.length ? reported.reduce((s, r) => s + (r[k] ?? 0), 0) : null;
          // the cost of a result: the spend of the period divided by the count of the period; not shown with no (or zero) results
          return [k, { count, cost: count ? Math.round((spend / count) * 100) / 100 : null }];
        }),
      );
      return { spend: Math.round(spend * 100) / 100, impressions: rows.reduce((s, r) => s + r.impressions, 0), linkClicks: clicks, results };
    };
    const byCampaign = new Map<string, typeof days>();
    for (const d of days) byCampaign.set(d.campaignId, [...(byCampaign.get(d.campaignId) ?? []), d]);
    const campaigns = [...byCampaign.entries()]
      .map(([id, rows]) => ({ campaignId: id, name: rows[rows.length - 1].campaignName, ...total(rows), reach: accountReach ? reach.find((r) => r.campaignId === id)?.reach ?? null : null }))
      .sort((a, b) => b.spend - a.spend);

    // LANKA's own fact: Lead Ads leads received in LANKA in this period (the ad account's days), by campaign id; null when lead forms are not connected
    let received: { total: number; byCampaign: Record<string, number> } | null = null;
    if (leadsOn) {
      const from = dayStartUtc(since, link.timezoneName);
      const to = dayStartUtc(addDays(until, 1), link.timezoneName);
      const leads = await this.prisma.inquiry.findMany({ where: { clinicId, via: 'META_LEAD_ADS', createdAt: { gte: from, lt: to } }, select: { sourceDetails: true } });
      const by: Record<string, number> = {};
      for (const l of leads) {
        const c = (l.sourceDetails as { campaignId?: string | null } | null)?.campaignId;
        if (c) by[c] = (by[c] ?? 0) + 1;
      }
      received = { total: leads.length, byCampaign: by };
    }
    return {
      state: accountReach ? ('loaded' as const) : ('not_loaded' as const),
      account: { name: link.name, accountId: link.accountId, currency: link.currency, timezoneName: link.timezoneName, status: link.status },
      period: { since, until },
      updatedAt: accountReach?.fetchedAt ?? null,
      lastError: link.lastError,
      lastAttemptAt: link.lastAttemptAt,
      totals: { ...total(days), reach: accountReach?.reach ?? null },
      campaigns,
      received,
      attribution: ATTRIBUTION,
      resultTypes: RESULT_TYPES,
    };
  }
}
