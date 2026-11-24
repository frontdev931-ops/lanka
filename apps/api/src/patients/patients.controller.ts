import { Body, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ContactConsent, Prisma, Role, TaskResult } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { clinicDate } from '../common/clinic-time';
import { clinicMoneyCurrency, effectiveCurrency } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';

const WRITERS = [Role.OWNER, Role.MANAGER, Role.ADMIN];
// the same roles as the sections these come from: chats and requests (Messages), inquiries and ratings
const CHAT_ROLES: Role[] = [Role.OWNER, Role.MANAGER, Role.ADMIN];
const READERS: Role[] = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];
// a visit still ahead (not closed, cancelled or moved)
const UPCOMING = ['PLANNED', 'CONFIRMED', 'NOT_CONFIRMED', 'BOOKING'];
const PAGE = 25;
// full years between a birth date and today (clinic time), null when unknown or implausible
export function ageOf(birth: Date | null, now = new Date()): number | null {
  if (!birth) return null;
  const [y, m, d] = clinicDate(now).split('-').map(Number);
  const by = birth.getUTCFullYear(), bm = birth.getUTCMonth() + 1, bd = birth.getUTCDate();
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return age >= 0 && age < 130 ? age : null;
}
export const CHANNELS = ['PHONE', 'MESSENGER', 'SMS', 'EMAIL', 'VISIT', 'OTHER'];

class ContactDto {
  @IsIn(CHANNELS) channel: string;
  @IsOptional() @IsEnum(TaskResult) outcome?: TaskResult;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsDateString() contactedAt?: string;
}

class ConsentDto {
  @IsOptional() @IsEnum(ContactConsent) consent?: ContactConsent;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() automationPaused?: boolean;
}

@Controller('patients')
@UseGuards(AuthGuard)
export class PatientsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(
    @CurrentUser() u: AuthUser,
    @Query('search') search = '',
    @Query('source') source?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
  ) {
    const pageSize = 50;
    const s = search.trim();
    const where: Prisma.PatientWhereInput = {
      clinicId: u.clinicId,
      removedAt: null,
      ...(source ? { source: source === '__none' ? null : source } : {}),
      ...(s
        ? { OR: [{ fullName: { contains: s, mode: 'insensitive' } }, { phone: { contains: s.replace(/[^\d+]/g, '') || s } }] }
        : {}),
    };
    const [total, rows, sources] = await Promise.all([
      this.prisma.patient.count({ where }),
      this.prisma.patient.findMany({
        where,
        orderBy: { fullName: 'asc' },
        skip: (Math.max(page, 1) - 1) * pageSize,
        take: pageSize,
        select: { id: true, fullName: true, phone: true, source: true, lastVisitAt: true, balanceIssued: true, balancePaid: true, balanceCurrency: true, consent: true, automationPaused: true },
      }),
      this.prisma.patient.groupBy({ by: ['source'], where: { clinicId: u.clinicId, removedAt: null } }),
    ]);
    return {
      total,
      page,
      pageSize,
      sources: sources.map((x) => x.source).filter(Boolean),
      // Debt = billed − paid. The doctor works with treatment, not with patients' money: the debt is not given to them
      // debtCurrency: the stamp of the card's balance (null = currency not confirmed; common/money.ts)
      rows: rows.map(({ balanceIssued, balancePaid, balanceCurrency, ...rest }) => {
        if (u.role === Role.DOCTOR) return rest;
        const debt = Math.round((Number(balanceIssued ?? 0) - Number(balancePaid ?? 0)) * 100) / 100;
        return { ...rest, debt: debt > 0 ? debt : 0, debtCurrency: balanceCurrency };
      }),
    };
  }

  @Get(':id')
  async one(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    // A view of a patient card is written to the audit log (not more than once per 10 minutes for the same person and patient)
    const recent = await this.prisma.auditLog.findFirst({ where: { clinicId: u.clinicId, userId: u.userId, action: 'patient.viewed', details: { path: ['patientId'], equals: id }, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } }, select: { id: true } });
    if (!recent) await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'patient.viewed', details: { patientId: id } } });
    const p = await this.prisma.patient.findFirst({
      where: { id, clinicId: u.clinicId },
      include: {
        // the latest few for the overview; the whole history is paged by GET :id/visits
        visits: { orderBy: { startsAt: 'desc' }, take: 5 },
        // The connected messenger and the latest messages to the patient (the mailing log)
        channels: { select: { channel: true, username: true, linkedAt: true, optedOutAt: true } },
        outbox: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, ruleKey: true, status: true, text: true, scheduledFor: true, sentAt: true, error: true } },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { assignee: { select: { id: true, name: true } } },
        },
        contacts: {
          orderBy: { contactedAt: 'desc' },
          take: 50,
          include: { user: { select: { name: true } } },
        },
      },
    });
    if (!p) throw new NotFoundException('patient_not_found');
    // the card's summary (2026-11-24): the nearest visit, the counts behind the tabs, the age and when Cliniccards was last loaded
    const now = new Date();
    const money = u.role !== Role.DOCTOR;
    const chats = CHAT_ROLES.includes(u.role);
    const [nextVisit, visitCount, planCount, payCount, invCount, requestCount, inquiryCount, integ] = await Promise.all([
      this.prisma.visit.findFirst({ where: { clinicId: u.clinicId, patientId: id, startsAt: { gte: now }, status: { in: UPCOMING } }, orderBy: { startsAt: 'asc' }, select: { startsAt: true, endsAt: true, status: true, doctorName: true, serviceName: true } }),
      this.prisma.visit.count({ where: { clinicId: u.clinicId, patientId: id } }),
      this.prisma.planItem.count({ where: { clinicId: u.clinicId, patientId: id } }),
      money ? this.prisma.payment.count({ where: { clinicId: u.clinicId, patientId: id } }) : 0,
      money ? this.prisma.invoice.count({ where: { clinicId: u.clinicId, patientId: id } }) : 0,
      chats ? this.prisma.bookingRequest.count({ where: { clinicId: u.clinicId, patientId: id } }) : 0,
      READERS.includes(u.role) ? this.prisma.inquiry.count({ where: { clinicId: u.clinicId, patientId: id } }) : 0,
      this.prisma.integration.findUnique({ where: { clinicId_provider: { clinicId: u.clinicId, provider: 'CLINICCARDS' } }, select: { lastSyncAt: true } }),
    ]);
    const summary = {
      age: ageOf(p.birthDate, now),
      nextVisit,
      lastSyncAt: integ?.lastSyncAt ?? null,
      counts: { visits: visitCount, plan: planCount, ...(money ? { finance: payCount + invCount } : {}), ...(chats ? { requests: requestCount, chats: p.channels.length } : {}), ...(READERS.includes(u.role) ? { inquiries: inquiryCount } : {}) },
      access: { money, chats, lanka: READERS.includes(u.role), write: (WRITERS as Role[]).includes(u.role) },
    };
    if (u.role === Role.DOCTOR) {
      const { balanceIssued: _a, balancePaid: _b, balanceCurrency: _e, visits, outbox: _d, ...rest } = p;
      return { ...rest, ...summary, visits: visits.map(({ amount: _c, ...v }) => v) };
    }
    return { ...p, ...summary };
  }

  // The visit history, newest first, a page at a time (the doctor gets no amounts)
  @Get(':id/visits')
  async visits(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1) {
    await this.mustFind(u.clinicId, id);
    const where = { clinicId: u.clinicId, patientId: id };
    const [total, rows] = await Promise.all([
      this.prisma.visit.count({ where }),
      this.prisma.visit.findMany({ where, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], skip: (Math.max(page, 1) - 1) * PAGE, take: PAGE, select: { id: true, startsAt: true, endsAt: true, status: true, doctorName: true, serviceName: true, amount: true, patientConfirmedAt: true } }),
    ]);
    return { total, page, pageSize: PAGE, rows: u.role === Role.DOCTOR ? rows.map(({ amount: _a, ...v }) => v) : rows };
  }

  // Treatment plans and the work done (Cliniccards plan items, grouped by plan). Plan totals and prices are money: not for the doctor.
  @Get(':id/treatment')
  async treatment(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.mustFind(u.clinicId, id);
    const LIMIT = 500;
    const items = await this.prisma.planItem.findMany({ where: { clinicId: u.clinicId, patientId: id }, orderBy: [{ createdAtExt: 'desc' }, { id: 'asc' }], take: LIMIT + 1 });
    const money = u.role !== Role.DOCTOR;
    const planIds = [...new Set(items.map((i) => i.planId))];
    const doctorIds = [...new Set(items.map((i) => i.doneByDoctorId).filter(Boolean) as string[])];
    const [plans, doctors] = await Promise.all([
      money && planIds.length ? this.prisma.treatmentPlan.findMany({ where: { clinicId: u.clinicId, externalId: { in: planIds } } }) : [],
      doctorIds.length ? this.prisma.doctor.findMany({ where: { clinicId: u.clinicId, externalId: { in: doctorIds } }, select: { externalId: true, lastName: true, firstName: true } }) : [],
    ]);
    const docName = new Map(doctors.map((d) => [d.externalId, `${d.lastName} ${d.firstName}`.trim()]));
    const planOf = new Map(plans.map((pl) => [pl.externalId, pl]));
    const groups = planIds.map((planId) => {
      const own = items.slice(0, LIMIT).filter((i) => i.planId === planId);
      const pl = planOf.get(planId);
      return {
        planId,
        createdAt: pl?.createdAtExt ?? own[own.length - 1]?.createdAtExt ?? null,
        ...(money && pl ? { total: pl.total, totalDone: pl.totalDone, currency: pl.currency } : {}),
        items: own.map((i) => ({
          id: i.id, name: i.name, groupName: i.groupName, status: i.status, createdAt: i.createdAtExt, doneAt: i.markedDoneAt,
          doctor: i.doneByDoctorId ? docName.get(i.doneByDoctorId) ?? null : null,
          ...(money ? { price: i.price } : {}),
        })),
      };
    });
    return { plans: groups, truncated: items.length > LIMIT };
  }

  // Bills (acts of completed work) and payments of the patient, newest first, a page at a time, with the card's balance. Not for the doctor.
  @Get(':id/finance')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST)
  async finance(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1) {
    const p = await this.prisma.patient.findFirst({ where: { id, clinicId: u.clinicId }, select: { balanceIssued: true, balancePaid: true, balanceCurrency: true } });
    if (!p) throw new NotFoundException('patient_not_found');
    const clinicCur = await clinicMoneyCurrency(this.prisma, u.clinicId);
    const where = { clinicId: u.clinicId, patientId: id };
    // both lists are small per patient; merged by date and paged here
    const [inv, pay] = await Promise.all([
      this.prisma.invoice.findMany({ where, orderBy: { issuedAt: 'desc' }, take: 2000, select: { id: true, issuedAt: true, amount: true, currency: true, issuerName: true } }),
      this.prisma.payment.findMany({ where, orderBy: { paidAt: 'desc' }, take: 2000, select: { id: true, paidAt: true, amount: true, currency: true, type: true } }),
    ]);
    const all = [
      ...inv.map((x) => ({ id: x.id, kind: 'invoice' as const, date: x.issuedAt, amount: x.amount, currency: effectiveCurrency(x.currency, clinicCur), by: x.issuerName ?? null })),
      ...pay.map((x) => ({ id: x.id, kind: 'payment' as const, date: x.paidAt, amount: x.amount, currency: effectiveCurrency(x.currency, clinicCur), by: x.type ?? null })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime() || a.id.localeCompare(b.id));
    const issued = Number(p.balanceIssued ?? 0), paid = Number(p.balancePaid ?? 0);
    return {
      // the card's balance as Cliniccards keeps it (issued − paid); null when Cliniccards sent no balance
      balance: p.balanceIssued === null && p.balancePaid === null ? null : { issued, paid, debt: Math.max(0, Math.round((issued - paid) * 100) / 100), currency: p.balanceCurrency ?? null },
      total: all.length,
      page,
      pageSize: PAGE,
      rows: all.slice((Math.max(page, 1) - 1) * PAGE, Math.max(page, 1) * PAGE),
    };
  }

  // What LANKA itself knows about the patient, only where the link is by an identifier (a linked messenger chat, a request or an inquiry tied to
  // this card), never by a name: chats and requests for the roles of Messages, inquiries and ratings for the readers
  @Get(':id/lanka')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST)
  async lanka(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.mustFind(u.clinicId, id);
    const chats = CHAT_ROLES.includes(u.role);
    const [links, requests, inquiries, reviews] = await Promise.all([
      chats ? this.prisma.patientChannel.findMany({ where: { clinicId: u.clinicId, patientId: id }, select: { channel: true, externalId: true, username: true, linkedAt: true, optedOutAt: true } }) : [],
      chats ? this.prisma.bookingRequest.findMany({ where: { clinicId: u.clinicId, patientId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, kind: true, status: true, summary: true, channel: true, createdAt: true } }) : [],
      this.prisma.inquiry.findMany({ where: { clinicId: u.clinicId, patientId: id }, orderBy: { occurredAt: 'desc' }, take: 20, select: { id: true, channel: true, occurredAt: true, status: true } }),
      this.prisma.review.findMany({ where: { clinicId: u.clinicId, patientId: id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, rating: true, createdAt: true } }),
    ]);
    const conversations = await Promise.all(
      links.map(async (l) => {
        const last = await this.prisma.chatMessage.findFirst({ where: { clinicId: u.clinicId, channel: l.channel, chatId: l.externalId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, direction: true } });
        return { channel: l.channel, chatId: l.externalId, username: l.username, linkedAt: l.linkedAt, optedOutAt: l.optedOutAt, lastAt: last?.createdAt ?? null, lastIn: last ? last.direction === 'IN' : null };
      }),
    );
    return { access: { chats }, conversations, requests, inquiries, reviews };
  }

  private async mustFind(clinicId: string, id: string) {
    const p = await this.prisma.patient.findFirst({ where: { id, clinicId }, select: { id: true } });
    if (!p) throw new NotFoundException('patient_not_found');
  }

  // A manual record of a contact with the patient (a call, a message, a visit)
  @Post(':id/contacts')
  @Roles(...WRITERS)
  async addContact(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ContactDto) {
    await this.mustFind(u.clinicId, id);
    const log = await this.prisma.contactLog.create({
      data: {
        clinicId: u.clinicId,
        patientId: id,
        userId: u.userId,
        channel: dto.channel,
        outcome: dto.outcome,
        note: dto.note?.trim() || undefined,
        source: 'MANUAL',
        contactedAt: dto.contactedAt ? new Date(dto.contactedAt) : new Date(),
      },
      include: { user: { select: { name: true } } },
    });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'patient.contact_added', details: { patientId: id } } });
    return log;
  }

  // Consent to communication and pause of automations for the patient. Sync does not change these fields.
  @Patch(':id/consent')
  @Roles(...WRITERS)
  async consent(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ConsentDto) {
    await this.mustFind(u.clinicId, id);
    const changed = dto.consent !== undefined || dto.note !== undefined;
    const p = await this.prisma.patient.update({
      where: { id },
      data: {
        consent: dto.consent,
        consentNote: dto.note,
        consentUpdatedAt: changed ? new Date() : undefined,
        automationPaused: dto.automationPaused,
      },
      select: { id: true, consent: true, consentNote: true, consentUpdatedAt: true, automationPaused: true },
    });
    await this.prisma.auditLog.create({
      data: { clinicId: u.clinicId, userId: u.userId, action: 'patient.consent', details: { patientId: id, consent: dto.consent, automationPaused: dto.automationPaused } },
    });
    return p;
  }
}
