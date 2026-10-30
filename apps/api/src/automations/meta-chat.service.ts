import { BadRequestException, Logger } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { decrypt, encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../service/plans';
import { InboundService } from './inbound.service';
import { IntakeService } from './intake.service';
import { GraphMessagingApi, MetaMessagingEvent, MetaWebhook } from './meta-graph.api';

// Checks the signature Meta puts on every webhook: HMAC-SHA256 of the raw body with the app secret
export function metaSignatureOk(raw: Buffer | undefined, header: string | undefined): boolean {
  if (!raw || !header?.startsWith('sha256=')) return false;
  const got = Buffer.from(header.slice(7), 'hex');
  // The Facebook app secret signs Messenger and WhatsApp; Instagram may have its own app secret
  return [process.env.META_APP_SECRET, process.env.META_INSTAGRAM_APP_SECRET].some((secret) => {
    if (!secret) return false;
    const want = createHmac('sha256', secret).update(raw).digest();
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

// Meta checks the webhook address once with a GET: we return the challenge if the verify token matches
export function metaVerify(mode?: string, token?: string, challenge?: string): string {
  const expected = process.env.META_VERIFY_TOKEN;
  if (mode !== 'subscribe' || !expected || token !== expected) throw new BadRequestException('bad_verify_token');
  return challenge ?? '';
}

export const metaServerReady = () => !!(process.env.META_APP_SECRET || process.env.META_INSTAGRAM_APP_SECRET) && !!process.env.META_VERIFY_TOKEN;

// Instagram Business Login has its own app id and secret in the Meta dashboard (Instagram > API setup); if they are not set the Facebook app's are used
export const instagramAppId = () => process.env.META_INSTAGRAM_APP_ID || process.env.META_APP_ID || '';
export const instagramAppSecret = () => process.env.META_INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || '';
// The older Instagram Login button works only with the Instagram app id and secret set on purpose (new Meta apps cannot use it)
export const metaOauthReady = () => !!process.env.META_INSTAGRAM_APP_ID && !!(process.env.META_INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET);
export const metaLoginReadyFlag = () => !!process.env.META_APP_ID && !!process.env.META_APP_SECRET && !!process.env.META_CONFIG_ID;

export function metaWebOrigin() {
  return (process.env.WEB_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
}

// The shared work of the channels on the Meta messaging platform (Instagram, Facebook Messenger): connect an account,
// accept signed webhooks into the durable inbox, hand each message to the common intake. A channel only says who it is.
export abstract class MetaChatService {
  protected readonly log = new Logger(this.constructor.name);
  protected abstract readonly channel: string;
  protected abstract readonly provider: Provider;
  // The object name Meta puts on this channel's webhooks
  protected abstract readonly webhookObject: string;
  protected abstract readonly tokenError: string;
  // Who the token belongs to: the id that appears as entry.id in webhooks, and a display name
  protected abstract identify(token: string): Promise<{ id: string; name: string | null }>;

  constructor(
    protected prisma: PrismaService,
    protected api: GraphMessagingApi,
    protected inbound: InboundService,
    protected intake: IntakeService,
  ) {}

  // Called from the subclass constructor (the channel names are known there)
  protected register() {
    this.inbound.register(this.channel, async (clinicId, payload) => {
      const { ownId, ev } = payload as { ownId: string; ev: MetaMessagingEvent };
      const i = await this.prisma.integration.findUnique({ where: this.where(clinicId) });
      if (!i?.apiKeyEnc) return;
      await this.handleEvent(clinicId, decrypt(i.apiKeyEnc), ownId, ev, (i.config ?? {}) as Record<string, unknown>);
    });
  }

  // The api that matches how the account was connected (Instagram Login or Facebook Login); a channel with one api returns it
  protected apiFor(_config?: Record<string, unknown>): GraphMessagingApi {
    return this.api;
  }

  protected where(clinicId: string) {
    return { clinicId_provider: { clinicId, provider: this.provider } };
  }

  async status(clinicId: string) {
    const i = await this.prisma.integration.findUnique({ where: this.where(clinicId) });
    const cfg = (i?.config ?? {}) as { name?: string; mode?: string; tokenProblem?: string | null };
    const linked = await this.prisma.patientChannel.count({ where: { clinicId, channel: this.channel, optedOutAt: null } });
    // The webhook works only when the service owner has registered the Meta app (secret and verify token on the server)
    return { connected: !!i?.apiKeyEnc, username: cfg.name ?? null, linkedPatients: linked, serverReady: metaServerReady(), oauthReady: metaOauthReady(), facebookLoginReady: metaLoginReadyFlag(), via: cfg.mode === 'FACEBOOK_LOGIN' ? 'facebook' : i?.apiKeyEnc ? 'token' : null, tokenProblem: cfg.tokenProblem ?? null };
  }

  async connect(clinicId: string, token: string, extra: Record<string, unknown> = {}) {
    const plan = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan;
    if (!hasFeature(plan, 'multi_channel')) throw new BadRequestException('plan_feature');
    let me: { id: string; name: string | null };
    try {
      me = await this.identify(token);
    } catch {
      throw new BadRequestException(this.tokenError);
    }
    if (!me.id) throw new BadRequestException(this.tokenError);
    // One account belongs to one clinic: otherwise messages of two clinics would mix
    const taken = await this.prisma.integration.findFirst({ where: { provider: this.provider, clinicId: { not: clinicId }, config: { path: ['ownId'], equals: me.id } }, select: { id: true } });
    if (taken) throw new BadRequestException('channel_account_taken');
    const config = { ...extra, ownId: me.id, name: me.name };
    await this.prisma.integration.upsert({
      where: this.where(clinicId),
      create: { clinicId, provider: this.provider, apiKeyEnc: encrypt(token), config },
      update: { apiKeyEnc: encrypt(token), config },
    });
    return this.status(clinicId);
  }

  // Connects an account whose token is already known to be right (the Facebook login checked it): the same rules as `connect`
  async attach(clinicId: string, d: { ownId: string; name: string | null; token: string; config: Record<string, unknown> }) {
    const plan = (await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { plan: true } })).plan;
    if (!hasFeature(plan, 'multi_channel')) throw new BadRequestException('plan_feature');
    const taken = await this.prisma.integration.findFirst({ where: { provider: this.provider, clinicId: { not: clinicId }, config: { path: ['ownId'], equals: d.ownId } }, select: { id: true } });
    if (taken) throw new BadRequestException('channel_account_taken');
    const config = { ...d.config, ownId: d.ownId, name: d.name };
    await this.prisma.integration.upsert({ where: this.where(clinicId), create: { clinicId, provider: this.provider, apiKeyEnc: encrypt(d.token), config }, update: { apiKeyEnc: encrypt(d.token), config } });
  }

  async disconnect(clinicId: string) {
    await this.prisma.integration.deleteMany({ where: { clinicId, provider: this.provider } });
    return { connected: false };
  }

  verify(mode?: string, token?: string, challenge?: string) {
    return metaVerify(mode, token, challenge);
  }

  // Events from Meta. Anything with a wrong signature is ignored; the answer is always quick, work errors are only logged.
  async handleWebhook(raw: Buffer | undefined, signature: string | undefined, body: MetaWebhook) {
    if (!metaSignatureOk(raw, signature) || body.object !== this.webhookObject) return;
    for (const entry of body.entry ?? []) {
      const i = await this.prisma.integration.findFirst({ where: { provider: this.provider, config: { path: ['ownId'], equals: entry.id } } });
      if (!i?.apiKeyEnc) continue;
      for (const ev of entry.messaging ?? []) {
        await this.inbound.receive(i.clinicId, this.channel, ev.message?.mid ? `${this.channel}:${ev.message.mid}` : null, { ownId: entry.id, ev });
      }
    }
  }

  protected async handleEvent(clinicId: string, token: string, ownId: string, ev: MetaMessagingEvent, cfg?: Record<string, unknown>) {
    const m = ev.message;
    const chatId = ev.sender?.id;
    // our own outgoing messages come back as echoes
    if (!m || m.is_echo || !chatId || chatId === ownId) return;
    await this.intake.handle(clinicId, {
      channel: this.channel,
      chatId,
      mid: m.mid ?? null,
      text: m.text ?? '',
      payload: m.quick_reply?.payload,
      profileName: async () => {
        const p = await this.apiFor(cfg).profile(token, chatId);
        return p.name || (p.username ? `@${p.username}` : null);
      },
    });
  }
}
