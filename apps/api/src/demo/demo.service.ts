import { BadRequestException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { RateLimitService } from '../auth/rate-limit.service';
import { TERMS_VERSION } from '../common/terms';
import { SyncService } from '../integrations/sync.service';
import { stampCurrency } from '../integrations/currency-stamp';
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
        // the made-up amounts are hryvnias by definition (synthetic data, not a real clinic's statement)
        sourceCurrency: 'UAH',
        sourceCurrencyStatedAt: new Date(),
        planCurrency: 'UAH',
        planCurrencyStatedAt: new Date(),
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
    await this.seedJourney(clinic.id);
    // the seeded payments get the demo's currency like loaded ones
    await stampCurrency(this.prisma, clinic.id);
    return { accessToken: await this.jwt.signAsync({ sub: user.id, clinicId: clinic.id, role: 'OWNER', iatMs: Date.now() }), clinicId: clinic.id };
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
    const visited = await this.prisma.visit.findMany({ where: { clinicId, status: 'VISITED' }, orderBy: { startsAt: 'desc' }, take: 18, select: { id: true, patientId: true, doctorName: true } });
    await this.prisma.review.createMany({
      data: visited.map((v, i) => ({ clinicId, patientId: v.patientId, visitId: v.id, rating: i === 3 ? 2 : i % 5 === 4 ? 3 : i % 3 ? 5 : 4, doctorName: v.doctorName, comment: i === 3 ? 'Довго чекали на прийом.' : null })),
    });
  }

  // The patient's path, so that the funnel, the payback page and the message history show the product on data instead of empty tables:
  // inquiries by source (some became cards, appointments and visits, some were lost), messages that were followed by appointments and payments,
  // and a switched-on visit reminder with its history. Everything is ROWS in the demo copy's own tables: the pages count them with the same code as
  // for a real clinic, nothing is drawn by hand. Only for a demo copy (isDemo), never for a real clinic. Every row has a stable key, so a repeat adds
  // nothing. Nothing is sent: these are records of the past (SENT, CANCELLED), the scheduler has nothing to deliver from them, and a send for a demo
  // copy is only simulated anyway (MessengerService.send).
  async seedJourney(clinicId: string) {
    const clinic = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { isDemo: true } });
    if (!clinic?.isDemo) throw new BadRequestException('demo_only');
    const all = await this.prisma.patient.findMany({ where: { clinicId, externalId: { startsWith: 'demo-p-' } }, select: { id: true, externalId: true, fullName: true, phone: true, phoneNorm: true } });
    const byNo = new Map(all.map((p) => [Number(p.externalId.slice(7)), p]));
    const pick = (n: number) => byNo.get(n);

    // New people who are still on the way: three with a first appointment ahead, two with a card only
    const fresh = [
      { n: 1, name: 'Гриценко Марта', planned: true },
      { n: 2, name: 'Стельмах Юрій', planned: true },
      { n: 3, name: 'Вакуленко Ніна', planned: true },
      { n: 4, name: 'Дорошенко Лев', planned: false },
      { n: 5, name: 'Кириленко Зоя', planned: false },
    ];
    for (const f of fresh) {
      const externalId = `demo-seed-p-${f.n}`;
      const phone = `+38050000${String(3000 + f.n)}`;
      const p = await this.prisma.patient.upsert({
        where: { clinicId_externalId: { clinicId, externalId } },
        update: {},
        create: { clinicId, externalId, fullName: f.name, phone, phoneNorm: phone.slice(1), source: ['Instagram', 'Сайт', 'Google'][f.n % 3], createdAtExt: ago((f.n + 1) * DAY), balanceIssued: 0, balancePaid: 0 },
        select: { id: true, externalId: true, fullName: true, phone: true, phoneNorm: true },
      });
      byNo.set(1000 + f.n, p);
      if (f.planned)
        await this.prisma.visit.createMany({
          skipDuplicates: true,
          data: [{ clinicId, patientId: p.id, externalId: `demo-seed-v-first-${f.n}`, doctorName: 'Іваненко Олег', serviceName: 'Консультація', bookedAt: ago(f.n * DAY), startsAt: new Date(Date.now() + (f.n + 1) * DAY), status: 'PLANNED' }],
        });
    }

    // Inquiries of the last two months. who: the number of a made-up patient (1000+ are the new people above), null = nobody's card yet
    const tagged = { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'implant-kyiv', landing: '/implantatsiya' };
    const plan: { ch: string; who: number | null; returning?: boolean; lost?: boolean; tags?: boolean }[] = [
      { ch: 'INSTAGRAM', who: 2 }, { ch: 'SITE', who: 3, tags: true }, { ch: 'GOOGLE', who: 4 }, { ch: 'PHONE', who: 5 }, { ch: 'INSTAGRAM', who: 6 }, { ch: 'RECOMMENDATION', who: 7 },
      { ch: 'SITE', who: 9, tags: true }, { ch: 'INSTAGRAM', who: 10 }, { ch: 'TELEGRAM', who: 11 }, { ch: 'PHONE', who: 13 }, { ch: 'GOOGLE', who: 14 },
      { ch: 'INSTAGRAM', who: 1001 }, { ch: 'SITE', who: 1002, tags: true }, { ch: 'PHONE', who: 1003 }, { ch: 'INSTAGRAM', who: 1004 }, { ch: 'GOOGLE', who: 1005 },
      { ch: 'RECOMMENDATION', who: 30, returning: true }, { ch: 'PHONE', who: 31, returning: true },
      { ch: 'INSTAGRAM', who: null }, { ch: 'SITE', who: null, tags: true }, { ch: 'PHONE', who: null }, { ch: 'WALK_IN', who: null },
      { ch: 'INSTAGRAM', who: null, lost: true }, { ch: 'GOOGLE', who: null, lost: true },
    ];
    await this.prisma.inquiry.createMany({
      skipDuplicates: true,
      data: plan.map((q, i) => {
        const p = q.who ? pick(q.who) ?? byNo.get(q.who) : undefined;
        const phone = p?.phone ?? `+38050000${String(4000 + i)}`;
        return {
          clinicId,
          externalId: `demo-seed-inq-${i + 1}`,
          channel: q.ch,
          occurredAt: ago((i * 2 + 1) * DAY + 5 * HOUR),
          name: p?.fullName ?? `Звернення ${i + 1}`,
          phone,
          phoneNorm: phone.slice(1),
          status: q.lost ? 'LOST' : 'OPEN',
          patientId: p?.id ?? null,
          returning: !!q.returning,
          ...(q.tags ? tagged : {}),
        };
      }),
    });

    // "We miss you" messages of the last weeks. Five of the eight people booked afterwards: three have already come and paid, two are still ahead.
    const text = 'Вітаємо! Ви давно не були в нас. Запрошуємо на профілактичний огляд — підберемо зручний час.';
    const back = [40, 41, 42, 43, 44, 45, 46, 47].map((n) => pick(n)).filter((p): p is NonNullable<typeof p> => !!p);
    const reminders: { patientId: string; visitId: string; at: Date; status: 'SENT' | 'CANCELLED' }[] = [];
    for (const [i, p] of back.entries()) {
      const sentAt = ago((25 - i * 2) * DAY);
      await this.prisma.outboundMessage.createMany({
        skipDuplicates: true,
        data: [{ clinicId, patientId: p.id, ruleKey: 'lapsed', channel: 'TELEGRAM', text, status: 'SENT', scheduledFor: sentAt, sentAt, dedupeKey: `demo-seed:lapsed:${p.externalId}` }],
      });
      if (i >= 5) continue;
      const came = i < 3;
      const bookedAt = new Date(sentAt.getTime() + (i + 1) * DAY);
      const startsAt = came ? new Date(bookedAt.getTime() + 4 * DAY) : new Date(Date.now() + (i + 2) * DAY);
      const v = await this.prisma.visit.upsert({
        where: { clinicId_externalId: { clinicId, externalId: `demo-seed-v-back-${i + 1}` } },
        update: {},
        create: { clinicId, patientId: p.id, externalId: `demo-seed-v-back-${i + 1}`, doctorName: 'Іваненко Олег', serviceName: 'Професійна гігієна', bookedAt, startsAt, status: came ? 'VISITED' : 'PLANNED', amount: came ? 1200 + i * 300 : null },
        select: { id: true },
      });
      if (came) {
        await this.prisma.payment.createMany({ skipDuplicates: true, data: [{ clinicId, patientId: p.id, externalId: `demo-seed-pay-${i + 1}`, paidAt: startsAt, amount: 1200 + i * 300, type: 'CARD' }] });
        reminders.push({ patientId: p.id, visitId: v.id, at: new Date(startsAt.getTime() - DAY), status: 'SENT' });
      }
    }

    // The visit reminder: switched on, with a history of what was sent and what was cancelled and why
    await this.prisma.automationRule.upsert({ where: { clinicId_key: { clinicId, key: 'visit-reminder' } }, update: {}, create: { clinicId, key: 'visit-reminder', enabled: true } });
    const past = await this.prisma.visit.findMany({ where: { clinicId, externalId: { in: [1, 2, 3, 4, 5].map((n) => `demo-v-${n}-done`) } }, orderBy: { startsAt: 'desc' }, select: { id: true, patientId: true, startsAt: true, status: true } });
    for (const v of past) reminders.push({ patientId: v.patientId, visitId: v.id, at: new Date(v.startsAt.getTime() - DAY), status: v.status === 'VISITED' ? 'SENT' : 'CANCELLED' });
    await this.prisma.outboundMessage.createMany({
      skipDuplicates: true,
      data: reminders.map((r) => ({
        clinicId,
        patientId: r.patientId,
        visitId: r.visitId,
        ruleKey: 'visit-reminder',
        channel: 'TELEGRAM',
        text: 'Вітаємо! Нагадуємо про ваш візит завтра. Чекаємо на вас.',
        status: r.status,
        scheduledFor: r.at,
        sentAt: r.status === 'SENT' ? r.at : null,
        error: r.status === 'CANCELLED' ? 'Час запису змінено або запис скасовано' : null,
        dedupeKey: `demo-seed:reminder:${r.visitId}`,
      })),
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
