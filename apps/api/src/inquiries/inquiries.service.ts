import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FunnelService } from '../funnel/funnel.service';
import { normalizePhone } from '../common/phone';
import { matchInquiries } from './match';

export const CHANNELS = ['PHONE', 'INSTAGRAM', 'TELEGRAM', 'VIBER', 'GOOGLE', 'SITE', 'WALK_IN', 'RECOMMENDATION', 'OTHER'] as const;
export type Stage = 'NEW' | 'CARD' | 'BOOKED' | 'CAME' | 'RETURNING' | 'LOST';

@Injectable()
export class InquiriesService {
  constructor(
    private prisma: PrismaService,
    private funnel: FunnelService,
  ) {}

  async create(clinicId: string, userId: string, dto: { channel: string; phone?: string; name?: string; note?: string; occurredAt?: string }) {
    const phone = dto.phone?.trim() || undefined;
    const name = dto.name?.trim() || undefined;
    const note = dto.note?.trim() || undefined;
    if (!phone && !name && !note) throw new BadRequestException('inquiry_empty');
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    // Обращение «из будущего» бывает только от неправильной даты в форме
    if (occurredAt.getTime() > Date.now() + 3600_000) throw new BadRequestException('inquiry_future');
    const row = await this.prisma.inquiry.create({
      data: { clinicId, channel: dto.channel, phone, phoneNorm: normalizePhone(phone), name, note, occurredAt, createdById: userId },
    });
    await matchInquiries(this.prisma, clinicId);
    return this.prisma.inquiry.findUniqueOrThrow({ where: { id: row.id } });
  }

  async list(clinicId: string, filter: 'all' | 'new' | 'lost', page: number) {
    const pageSize = 50;
    const where = {
      clinicId,
      ...(filter === 'lost' ? { status: 'LOST' } : filter === 'new' ? { status: 'OPEN', patientId: null } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.inquiry.count({ where }),
      this.prisma.inquiry.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (Math.max(page, 1) - 1) * pageSize,
        take: pageSize,
        include: { patient: { select: { id: true, fullName: true } }, },
      }),
    ]);
    const stages = await this.funnel.stagesOf(clinicId, rows.map((r) => r.patientId).filter((x): x is string => !!x));
    return {
      total,
      page,
      pageSize,
      rows: rows.map((r) => {
        const s = r.patientId ? stages.get(r.patientId) : undefined;
        const stage: Stage = r.returning ? 'RETURNING' : s?.came ? 'CAME' : s?.booked ? 'BOOKED' : r.patientId ? 'CARD' : r.status === 'LOST' ? 'LOST' : 'NEW';
        return {
          id: r.id,
          occurredAt: r.occurredAt,
          channel: r.channel,
          phone: r.phone,
          name: r.name,
          note: r.note,
          utmSource: r.utmSource,
          utmCampaign: r.utmCampaign,
          landing: r.landing,
          status: r.status,
          stage,
          patient: r.patient,
        };
      }),
    };
  }

  async setStatus(clinicId: string, id: string, status: 'OPEN' | 'LOST') {
    const r = await this.prisma.inquiry.findFirst({ where: { id, clinicId }, select: { id: true } });
    if (!r) throw new NotFoundException('inquiry_not_found');
    return this.prisma.inquiry.update({ where: { id }, data: { status } });
  }

  async remove(clinicId: string, id: string) {
    const r = await this.prisma.inquiry.findFirst({ where: { id, clinicId }, select: { id: true } });
    if (!r) throw new NotFoundException('inquiry_not_found');
    await this.prisma.inquiry.delete({ where: { id } });
    return { ok: true };
  }
}
