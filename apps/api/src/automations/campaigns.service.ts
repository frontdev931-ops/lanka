import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MARKETING_GAP_DAYS, PlannerService } from './planner.service';
import { marketingAllowed } from './consent';
import { render } from './scenarios';
import { PrismaService } from '../prisma/prisma.service';

const DAY = 86_400_000;
const CLOSED_BAD = ['CANCELLED', 'DID_NOT_COME', 'MOVED'];
export const PLACEHOLDERS = new Set(['name', 'clinic', 'date', 'time', 'months']);

export interface CampaignFilters {
  // давно не были: от N месяцев и/или до N месяцев с последнего визита
  monthsSinceVisitMin?: number;
  monthsSinceVisitMax?: number;
  // только тем, у кого нет будущей записи
  noFutureVisit?: boolean;
}

export interface AudienceReport {
  matched: number; // подходит по фильтрам
  noConsent: number; // нет согласия на рекламные сообщения
  paused: number; // отказался или на паузе
  noChannel: number; // не подключён к Telegram
  tooSoon: number; // маркетинговое сообщение уже было недавно
  toQueue: number;
  sample: { patient: string; text: string }[];
}

// Своя рассылка (например, акция). Это всегда маркетинг: согласие пациента обязательно, подтверждение сотрудником обязательно.
@Injectable()
export class CampaignsService {
  constructor(
    private prisma: PrismaService,
    private planner: PlannerService,
  ) {}

  list(clinicId: string) {
    return this.prisma.campaign.findMany({ where: { clinicId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  private clean(f: CampaignFilters): CampaignFilters {
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const min = num(f.monthsSinceVisitMin);
    const max = num(f.monthsSinceVisitMax);
    for (const v of [min, max]) if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 120)) throw new BadRequestException('bad_filters');
    if (min !== undefined && max !== undefined && min > max) throw new BadRequestException('bad_filters');
    return { ...(min !== undefined ? { monthsSinceVisitMin: min } : {}), ...(max !== undefined ? { monthsSinceVisitMax: max } : {}), ...(f.noFutureVisit ? { noFutureVisit: true } : {}) };
  }

  async create(clinicId: string, userId: string, d: { name: string; text: string; filters: CampaignFilters }) {
    const unknown = [...d.text.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).filter((x) => !PLACEHOLDERS.has(x));
    if (unknown.length) throw new BadRequestException('bad_template');
    return this.prisma.campaign.create({ data: { clinicId, name: d.name.trim(), text: d.text.trim(), filters: this.clean(d.filters ?? {}) as object, createdById: userId } });
  }

  async remove(clinicId: string, id: string) {
    const r = await this.prisma.campaign.deleteMany({ where: { id, clinicId, status: 'DRAFT' } });
    if (!r.count) throw new NotFoundException('campaign_not_found');
    return { ok: true };
  }

  // Считает аудиторию (и при commit создаёт сообщения в очереди «ждёт подтверждения»)
  async audience(clinicId: string, id: string, commit: boolean, now = new Date()): Promise<AudienceReport> {
    const c = await this.prisma.campaign.findFirst({ where: { id, clinicId } });
    if (!c) throw new NotFoundException('campaign_not_found');
    if (commit && c.status !== 'DRAFT') throw new BadRequestException('campaign_already_queued');
    const f = c.filters as CampaignFilters;
    const clinic = await this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true, assumeConsent: true } });
    const month = 30.4 * DAY;
    const patients = await this.prisma.patient.findMany({
      where: {
        clinicId,
        removedAt: null,
        ...(f.monthsSinceVisitMin !== undefined || f.monthsSinceVisitMax !== undefined
          ? {
              lastVisitAt: {
                not: null,
                ...(f.monthsSinceVisitMin !== undefined ? { lte: new Date(now.getTime() - f.monthsSinceVisitMin * month) } : {}),
                ...(f.monthsSinceVisitMax !== undefined ? { gte: new Date(now.getTime() - f.monthsSinceVisitMax * month) } : {}),
              },
            }
          : {}),
        ...(f.noFutureVisit ? { visits: { none: { status: { notIn: CLOSED_BAD }, startsAt: { gt: now } } } } : {}),
      },
      select: { id: true, fullName: true, consent: true, automationPaused: true, channels: { where: { channel: 'TELEGRAM', optedOutAt: null }, select: { id: true } } },
    });
    const r: AudienceReport = { matched: patients.length, noConsent: 0, paused: 0, noChannel: 0, tooSoon: 0, toQueue: 0, sample: [] };
    const recent = await this.planner.recentlyContacted(clinicId, patients.map((p) => p.id), now);
    const rows: { clinicId: string; patientId: string; ruleKey: string; channel: string; text: string; status: string; scheduledFor: Date; expiresAt: Date; dedupeKey: string }[] = [];
    for (const p of patients) {
      if (p.automationPaused || p.consent === 'WITHDRAWN') r.paused++;
      else if (!marketingAllowed(p.consent, clinic.assumeConsent)) r.noConsent++;
      else if (!p.channels.length) r.noChannel++;
      else if (recent.has(p.id)) r.tooSoon++;
      else {
        r.toQueue++;
        const text = render(c.text, { fullName: p.fullName, clinic: clinic.name });
        if (r.sample.length < 3) r.sample.push({ patient: p.fullName, text });
        rows.push({ clinicId, patientId: p.id, ruleKey: `campaign:${c.id}`, channel: 'TELEGRAM', text, status: 'PENDING_APPROVAL', scheduledFor: now, expiresAt: new Date(now.getTime() + 7 * DAY), dedupeKey: `campaign:${c.id}:${p.id}` });
      }
    }
    if (commit) {
      if (rows.length) await this.prisma.outboundMessage.createMany({ data: rows, skipDuplicates: true });
      await this.prisma.campaign.update({ where: { id: c.id }, data: { status: 'QUEUED', queuedAt: now, queuedCount: rows.length } });
    }
    return r;
  }
}
