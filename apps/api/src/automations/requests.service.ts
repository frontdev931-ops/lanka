import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { StaffNotifierService } from './staff-notifier.service';

export type RequestKind = 'BOOKING' | 'RESCHEDULE' | 'CANCEL' | 'HANDOFF' | 'REVIEW';

@Injectable()
export class RequestsService {
  constructor(
    private prisma: PrismaService,
    private staff: StaffNotifierService,
    private push: PushService,
  ) {}

  // Одна открытая заявка на чат и вид: новое сообщение обновляет её, а не плодит дубли
  // notifyUpdate: сообщить сотрудникам и об обновлении существующей заявки (например, пациент выбрал время). Новая заявка сообщается всегда.
  async upsert(clinicId: string, d: { channel: string; chatId: string; patientId: string | null; contactName?: string | null; kind: RequestKind; summary: string }, notifyUpdate = false) {
    const open = await this.prisma.bookingRequest.findFirst({ where: { clinicId, channel: d.channel, chatId: d.chatId, kind: d.kind, status: 'NEW' } });
    const row = open
      ? await this.prisma.bookingRequest.update({ where: { id: open.id }, data: { summary: d.summary.slice(0, 500), patientId: d.patientId ?? open.patientId } })
      : await this.prisma.bookingRequest.create({ data: { clinicId, channel: d.channel, chatId: d.chatId, patientId: d.patientId, contactName: d.contactName ?? null, kind: d.kind, summary: d.summary.slice(0, 500) } });
    if (!open || notifyUpdate) await this.notify(clinicId, row.id, !open);
    return row;
  }

  private async notify(clinicId: string, id: string, created: boolean) {
    const r = await this.prisma.bookingRequest.findUnique({ where: { id }, include: { patient: { select: { fullName: true, phone: true } } } });
    if (!r) return;
    const who = r.patient ? `${r.patient.fullName}${r.patient.phone ? `, ${r.patient.phone}` : ''}` : (r.contactName ?? 'Невідомий');
    const kind = { BOOKING: 'Запис', RESCHEDULE: 'Перенесення', CANCEL: 'Скасування', HANDOFF: 'Потрібна відповідь людини', REVIEW: 'Низька оцінка візиту' }[r.kind] ?? r.kind;
    const link = `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/inbox`;
    // The phone notification carries no names: only the kind of request
    await this.push.notify(clinicId, { title: created ? 'Нова заявка' : 'Оновлення заявки', body: kind, url: '/inbox', tag: `request-${r.id}` }).catch(() => undefined);
    await this.staff.notify(clinicId, `${created ? 'Нова заявка' : 'Оновлення заявки'}: ${kind}\n${who}\n${r.summary}\n\nВідкрити: ${link}`);
  }

  async openFor(clinicId: string, channel: string, chatId: string) {
    return this.prisma.bookingRequest.findFirst({ where: { clinicId, channel, chatId, status: 'NEW', kind: { in: ['BOOKING', 'RESCHEDULE', 'CANCEL'] } }, orderBy: { createdAt: 'desc' } });
  }

  async list(clinicId: string, status: string) {
    const where = { clinicId, ...(status !== 'ALL' ? { status } : {}) };
    const [rows, newCount] = await Promise.all([
      this.prisma.bookingRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { patient: { select: { id: true, fullName: true, phone: true } } } }),
      this.prisma.bookingRequest.count({ where: { clinicId, status: 'NEW' } }),
    ]);
    return { newCount, rows };
  }

  async setStatus(clinicId: string, userId: string, id: string, status: string) {
    const r = await this.prisma.bookingRequest.updateMany({ where: { id, clinicId }, data: { status, handledById: status === 'NEW' ? null : userId, handledAt: status === 'NEW' ? null : new Date() } });
    if (!r.count) throw new NotFoundException('request_not_found');
    return { ok: true };
  }
}
