import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { TERMS_VERSION } from '../common/terms';
import { SyncService } from '../integrations/sync.service';
import { PrismaService } from '../prisma/prisma.service';

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const DEMO_EMAIL_DOMAIN = '@demo.lankaclinic.app';
// How long a visitor's copy lives, and how many copies may exist at once
const TTL_MS = 6 * HOUR;
const MAX_ACTIVE = Number(process.env.DEMO_MAX_ACTIVE ?? 300);

const ago = (ms: number) => new Date(Date.now() - ms);

// A visitor's own copy of a made-up clinic. It has its own data, never touches real systems and is deleted after a few hours.
@Injectable()
export class DemoService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(DemoService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private sync: SyncService,
    private jwt: JwtService,
    private limits: RateLimitService,
  ) {}

  onApplicationBootstrap() {
    if (!Number(process.env.AUTOMATIONS_TICK_SECONDS ?? 60)) return;
    this.timer = setInterval(() => void this.purge().catch((e) => this.log.warn(`Demo purge: ${(e as Error).message}`)), 15 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async start(ip: string): Promise<{ accessToken: string; clinicId: string }> {
    await this.limits.consume(`demo:ip:${ip}`, 5, HOUR);
    if ((await this.prisma.clinic.count({ where: { isDemo: true, demoExpiresAt: { gt: new Date() } } })) >= MAX_ACTIVE) throw new ServiceUnavailableException('demo_busy');

    const clinic = await this.prisma.clinic.create({
      data: {
        name: 'Демо-клініка «Усмішка»',
        isDemo: true,
        demoExpiresAt: new Date(Date.now() + TTL_MS),
        billingStatus: 'ACTIVE',
        plan: 'PRO',
        termsVersion: TERMS_VERSION,
        termsAcceptedAt: new Date(),
        // Messages are simulated for demo clinics (nothing leaves the server); the AI is on with a small allowance
        sendingEnabled: true,
        aiEnabled: true,
        aiAssistantEnabled: true,
        aiMonthlyLimit: 15,
      },
    });
    const user = await this.prisma.user.create({
      data: {
        // an address in a domain nobody can receive mail on; there is no password, the visitor gets a session directly
        email: `demo-${randomBytes(8).toString('hex')}${DEMO_EMAIL_DOMAIN}`,
        name: 'Гість демо',
        passwordHash: '!',
        emailVerifiedAt: new Date(),
        memberships: { create: { clinicId: clinic.id, role: 'OWNER' } },
      },
    });
    // The same pipeline as a real clinic: the sync reads the made-up connector (no Cliniccards key), then the chats and the rest are added
    await this.sync.run(clinic.id, null);
    await this.seedMessaging(clinic.id);
    await this.seedKnowledge(clinic.id);
    return { accessToken: await this.jwt.signAsync({ sub: user.id, clinicId: clinic.id, role: 'OWNER' }), clinicId: clinic.id };
  }

  // Conversations, requests, inquiries and ratings, so that the inbox, quality and funnel pages are not empty
  private async seedMessaging(clinicId: string) {
    const people = await this.prisma.patient.findMany({ where: { clinicId }, orderBy: { externalId: 'asc' }, take: 6, select: { id: true, fullName: true } });
    const chats = [
      { id: 'demo-chat-1', p: people[0], in: ['Добрий день! Хочу записатися на професійну чистку, коли є вільні вікна?'], kind: 'BOOKING', summary: 'Хоче професійну чистку, питає про вільні вікна.' },
      { id: 'demo-chat-2', p: people[1], in: ['Можна перенести мій візит на наступний тиждень?'], kind: 'RESCHEDULE', summary: 'Просить перенести найближчий візит на наступний тиждень.' },
      { id: 'demo-chat-3', p: null, in: ['Доброго дня, скільки коштує встановлення імпланта?'], kind: 'HANDOFF', summary: 'Питання про вартість імплантації передано людині.' },
    ];
    for (const c of chats) {
      await this.prisma.chatMessage.create({ data: { clinicId, patientId: c.p?.id ?? null, channel: 'TELEGRAM', chatId: c.id, contactName: c.p?.fullName ?? 'Нова людина', direction: 'IN', text: c.in[0], createdAt: ago(2 * HOUR) } });
      await this.prisma.bookingRequest.create({ data: { clinicId, patientId: c.p?.id ?? null, channel: 'TELEGRAM', chatId: c.id, contactName: c.p?.fullName ?? 'Нова людина', kind: c.kind, summary: c.summary } });
    }
    const channels = ['INSTAGRAM', 'PHONE', 'SITE', 'GOOGLE', 'RECOMMENDATION', 'WALK_IN'];
    await this.prisma.inquiry.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({ clinicId, channel: channels[i % channels.length], occurredAt: ago((i + 1) * 30 * HOUR), name: `Звернення ${i + 1}`, phone: `+3805000${String(2000 + i)}`, phoneNorm: `3805000${String(2000 + i)}`, status: i % 6 === 5 ? 'LOST' : 'OPEN' })),
    });
    const visited = await this.prisma.visit.findMany({ where: { clinicId, status: 'VISITED' }, orderBy: { startsAt: 'desc' }, take: 18, select: { id: true, patientId: true, doctorName: true } });
    await this.prisma.review.createMany({
      data: visited.map((v, i) => ({ clinicId, patientId: v.patientId, visitId: v.id, rating: i === 3 ? 2 : i % 5 === 4 ? 3 : i % 3 ? 5 : 4, doctorName: v.doctorName, comment: i === 3 ? 'Довго чекали на прийом.' : null })),
    });
  }

  // A small approved knowledge base, so the AI in the demo can answer about services and prices
  private async seedKnowledge(clinicId: string) {
    const now = new Date();
    const items = [
      { kind: 'SERVICE', title: 'Професійна гігієна', durationMin: 60, priceUah: 1200, text: 'За дві години до візиту краще не їсти.' },
      { kind: 'SERVICE', title: 'Консультація', durationMin: 30, priceUah: 400, text: '' },
      { kind: 'SERVICE', title: 'Лікування карієсу', durationMin: 60, priceUah: null, text: '' },
      { kind: 'DOCTOR', title: 'Іваненко Олег', durationMin: null, priceUah: null, text: 'Лікар-терапевт.' },
      { kind: 'LOCATION', title: 'Адреса', durationMin: null, priceUah: null, text: 'м. Київ, вул. Прикладна, 1 (вигадана адреса для демо).' },
      { kind: 'FAQ', title: 'Чи можна оплатити карткою?', durationMin: null, priceUah: null, text: 'Так, приймаємо готівку та картки.' },
    ];
    await this.prisma.kbItem.createMany({ data: items.map((i) => ({ clinicId, ...i, approvedAt: now, reviewedAt: now })) });
  }

  // Deletes expired copies with everything in them (cascade) and their made-up users
  async purge(now = new Date()) {
    const r = await this.prisma.clinic.deleteMany({ where: { isDemo: true, demoExpiresAt: { lt: now } } });
    await this.prisma.user.deleteMany({ where: { email: { endsWith: DEMO_EMAIL_DOMAIN }, memberships: { none: {} } } });
    return r.count;
  }
}
