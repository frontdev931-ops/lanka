import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MailService } from '../auth/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const view = { id: true, createdAt: true, handledAt: true } as const;

// "Do you have several clinics?": a clinic owner asks to discuss connecting another clinic. The request is stored first (one open request per
// clinic, kept by a partial unique index even under concurrent clicks), then the service owner is mailed; a failed mail never loses it.
// Nothing is created, attached or charged here: the service owner handles the request by hand in /platform.
@Injectable()
export class ClinicRequestsService {
  private readonly log = new Logger(ClinicRequestsService.name);
  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  // What the billing screen shows: the open request and, for a branch of a network, whether this person may manage that network
  async state(clinicId: string, userId: string) {
    const [open, clinic] = await Promise.all([
      this.prisma.additionalClinicRequest.findFirst({ where: { clinicId, handledAt: null }, select: view }),
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { networkId: true } }),
    ]);
    // managing a network is the network owner's right (NetworkService.assertOwner); a membership in a branch alone grants nothing
    const owner = clinic.networkId
      ? await this.prisma.networkMember.findUnique({ where: { networkId_userId: { networkId: clinic.networkId, userId } }, select: { role: true, network: { select: { id: true, name: true } } } })
      : null;
    return { request: open, network: owner?.role === 'OWNER' ? { ...owner.network, canManage: true } : null };
  }

  async request(clinicId: string, userId: string, comment?: string) {
    const existing = await this.prisma.additionalClinicRequest.findFirst({ where: { clinicId, handledAt: null }, select: view });
    if (existing) return { request: existing, created: false };
    const [user, clinic] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true } }),
      this.prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { name: true } }),
    ]);
    let row: Prisma.AdditionalClinicRequestGetPayload<{ select: typeof view }>;
    try {
      row = await this.prisma.additionalClinicRequest.create({
        data: { clinicId, userId, email: user.email, name: user.name, comment: comment?.trim().slice(0, 1000) || null }, select: view,
      });
    } catch (e) {
      // a concurrent click created it first
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { request: await this.prisma.additionalClinicRequest.findFirstOrThrow({ where: { clinicId, handledAt: null }, select: view }), created: false };
      }
      throw e;
    }
    await this.prisma.auditLog.create({ data: { clinicId, userId, action: 'billing.additional_clinic_request', details: { requestId: row.id } } });
    const recipients = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const link = `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/platform#platform-clinic-requests`;
    void Promise.allSettled(recipients.map((to) => this.mail.send({
      to, subject: 'LANKA: запит на підключення ще однієї клініки', text: `Клініка «${clinic.name}» хоче обговорити підключення ще однієї клініки.\n\n${link}`,
    }))).then((r) => r.some((x) => x.status === 'rejected') && this.log.warn('Additional clinic request: a notification failed, the request is kept'));
    return { request: row, created: true };
  }

  // The service owner's list: open first, then the latest handled ones
  list() {
    return this.prisma.additionalClinicRequest.findMany({
      orderBy: [{ handledAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }], take: 100,
      select: { id: true, clinicId: true, email: true, name: true, comment: true, createdAt: true, handledAt: true, clinic: { select: { name: true } } },
    });
  }

  async mark(id: string, handled: boolean, by: string) {
    try {
      const r = await this.prisma.additionalClinicRequest.updateMany({ where: { id }, data: handled ? { handledAt: new Date(), handledBy: by } : { handledAt: null, handledBy: null } });
      if (!r.count) throw new NotFoundException();
    } catch (e) {
      // reopening while the clinic already has a newer open request
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('clinic_request_open');
      throw e;
    }
    return { ok: true };
  }
}
