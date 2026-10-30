import { BadRequestException, ForbiddenException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { decrypt, encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { InboundService } from './inbound.service';
import { InstagramApi } from './instagram.api';
import { FacebookApi } from './meta-graph.api';
import { IntakeService } from './intake.service';
import { MetaChatService, instagramAppId, metaOauthReady, metaWebOrigin } from './meta-chat.service';

const IG_SCOPES = 'instagram_business_basic,instagram_business_manage_messages';
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_BEFORE_MS = 14 * 86_400_000;

export function instagramOAuthRedirectUri() {
  return `${metaWebOrigin()}/backend/instagram/oauth/callback`;
}

function stateSecret() {
  return `${process.env.JWT_SECRET ?? ''}:instagram-oauth`;
}

function signState(clinicId: string, userId: string) {
  const payload = Buffer.from(JSON.stringify({ clinicId, userId, exp: Date.now() + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readState(state: string | undefined): { clinicId: string; userId: string } {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig) throw new BadRequestException('instagram_oauth_failed');
  const want = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException('instagram_oauth_failed');
  let data: { clinicId?: string; userId?: string; exp?: number };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { clinicId?: string; userId?: string; exp?: number };
  } catch {
    throw new BadRequestException('instagram_oauth_failed');
  }
  if (!data.clinicId || !data.userId || !data.exp || data.exp < Date.now()) throw new BadRequestException('instagram_oauth_failed');
  return { clinicId: data.clinicId, userId: data.userId };
}

// Instagram Direct of the clinic's business account
@Injectable()
export class InstagramService extends MetaChatService implements OnApplicationBootstrap, OnModuleDestroy {
  protected readonly log = new Logger(InstagramService.name);
  protected readonly channel = 'INSTAGRAM';
  protected readonly provider = Provider.INSTAGRAM;
  protected readonly webhookObject = 'instagram';
  protected readonly tokenError = 'bad_instagram_token';
  private timer?: NodeJS.Timeout;

  constructor(prisma: PrismaService, protected api: InstagramApi, inbound: InboundService, intake: IntakeService, private fbApi: FacebookApi) {
    super(prisma, api, inbound, intake);
    this.register();
  }

  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.refreshDue().catch((e) => this.log.warn(`Instagram refresh: ${(e as Error).message}`)), 3_600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // An account connected through Facebook Login talks to graph.facebook.com with the page token; the older one to graph.instagram.com
  protected apiFor(config?: Record<string, unknown>) {
    return config?.mode === 'FACEBOOK_LOGIN' ? this.fbApi : this.api;
  }

  protected async identify(token: string) {
    const me = await this.api.me(token);
    return { id: String(me.user_id ?? me.id ?? ''), name: me.username ?? null };
  }

  // Clinic owner clicks "Connect Instagram": we send them to Meta with a signed clinic id in state
  async oauthStartUrl(clinicId: string, userId: string) {
    if (!metaOauthReady()) throw new BadRequestException('instagram_oauth_not_ready');
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true, isDemo: true } });
    if (clinic.isDemo) throw new ForbiddenException('demo_restricted');
    if (!hasFeature(clinic.plan, 'multi_channel')) throw new BadRequestException('plan_feature');
    const appId = instagramAppId();
    const redirect = instagramOAuthRedirectUri();
    const q = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: IG_SCOPES,
      state: signState(clinicId, userId),
      enable_fb_login: '0',
      force_reauth: 'true',
    });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  }

  // Meta sends the person back here. Clinic id comes only from the signed state, never from the query.
  async oauthFinish(code: string | undefined, state: string | undefined, error?: string) {
    if (error === 'access_denied') throw new BadRequestException('instagram_oauth_denied');
    if (error || !code) throw new BadRequestException('instagram_oauth_failed');
    const { clinicId, userId } = readState(state);
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId, clinicId } }, select: { role: true, clinic: { select: { isDemo: true } } } });
    if (!m || (m.role !== 'OWNER' && m.role !== 'MANAGER')) throw new ForbiddenException();
    if (m.clinic.isDemo) throw new ForbiddenException('demo_restricted');
    const clean = code.replace(/#_+$/, '');
    const short = await this.api.exchangeCode(clean, instagramOAuthRedirectUri()).catch(() => {
      throw new BadRequestException('instagram_oauth_failed');
    });
    const long = await this.api.exchangeLongLived(short.access_token).catch(() => null);
    const token = long?.access_token ?? short.access_token;
    const expiresAt = long?.expires_in ? Date.now() + long.expires_in * 1000 : undefined;
    const status = await this.connect(clinicId, token, expiresAt ? { expiresAt } : {});
    await this.api.subscribeApps(token).catch((e) => this.log.warn(`Instagram subscribe: ${(e as Error).message}`));
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'instagram.connected' } });
    return status;
  }

  async refreshDue(now = Date.now()) {
    const rows = await this.prisma.integration.findMany({ where: { provider: Provider.INSTAGRAM }, select: { id: true, clinicId: true, apiKeyEnc: true, config: true } });
    for (const row of rows) {
      if (!row.apiKeyEnc) continue;
      const cfg = (row.config ?? {}) as { expiresAt?: number; mode?: string };
      // A token of a Facebook-login connection is not refreshed here: it is checked by MetaLoginService and reported, never renewed silently
      if (cfg.mode === 'FACEBOOK_LOGIN') continue;
      if (!cfg.expiresAt || cfg.expiresAt - now > REFRESH_BEFORE_MS) continue;
      try {
        const next = await this.api.refreshLongLived(decrypt(row.apiKeyEnc));
        const expiresAt = next.expires_in ? now + next.expires_in * 1000 : cfg.expiresAt;
        await this.prisma.integration.update({
          where: { id: row.id },
          data: { apiKeyEnc: encrypt(next.access_token), config: { ...cfg, expiresAt } },
        });
      } catch (e) {
        this.log.warn(`Instagram token for clinic ${row.clinicId}: ${(e as Error).message}`);
      }
    }
  }
}
