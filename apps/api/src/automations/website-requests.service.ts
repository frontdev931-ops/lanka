import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MailService } from '../auth/mail.service';
import { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { LeadFormConfig } from './lead-form-config';
import { WebChatService } from './webchat.service';

export const websiteRequestState = { id: true, websiteOrigin: true, createdAt: true, installedAt: true, handledAt: true } as const;
type WebsiteRequestState = Prisma.ContactRequestGetPayload<{ select: typeof websiteRequestState }>;

@Injectable()
export class WebsiteRequestsService {
  constructor(private prisma: PrismaService, private mail: MailService) {}

  async request(user: AuthUser, website: string, language: string) {
    const url = URL.canParse(website) ? new URL(website) : null;
    const origin = url && !url.username && !url.password ? WebChatService.normalizeOrigin(website) : null;
    if (!origin) throw new BadRequestException('bad_widget_origin');
    const where = { clinicId: user.clinicId, handledAt: null };
    const existing = await this.prisma.contactRequest.findFirst({ where, select: websiteRequestState });
    if (existing) return existing;
    const { email } = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { email: true } });
    let row: WebsiteRequestState;
    try {
      row = await this.prisma.contactRequest.create({
        data: { clinicId: user.clinicId, email, lang: language, websiteOrigin: origin }, select: websiteRequestState,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.contactRequest.findFirstOrThrow({ where: { clinicId: user.clinicId }, orderBy: { createdAt: 'desc' }, select: websiteRequestState });
      }
      throw e;
    }

    const recipients = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const platform = `${(process.env.WEB_ORIGIN ?? '').replace(/\/$/, '')}/platform#platform-website`;
    void Promise.allSettled(recipients.map(async (to) => this.mail.send({
      to, subject: 'LANKA: запит на підключення форм сайту', text: `Новий запит у розділі підключень сайту.\n\n${platform}`,
    })));
    return row;
  }

  openRequests() {
    return this.prisma.contactRequest.findMany({
      where: { clinicId: { not: null }, handledAt: null }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { ...websiteRequestState, clinicId: true, email: true, clinic: { select: { name: true } } },
    });
  }

  async matchingReceipt(clinicId: string, request: WebsiteRequestState, config: LeadFormConfig | null) {
    // Receipts predating the request or coming from another site do not verify this installation.
    const configuredForm = config && new URL(config.page).origin === request.websiteOrigin ? config : null;
    return this.prisma.inquiry.findFirst({
      where: {
        clinicId, via: 'WEBSITE_FORM', createdAt: { gte: request.createdAt },
        landing: configuredForm ? configuredForm.page : { startsWith: `${request.websiteOrigin}/` },
        ...(configuredForm ? { formId: configuredForm.formId } : {}),
      }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
  }

  async record(clinicId: string, requestId: string, action: 'installed' | 'complete', config: LeadFormConfig | null) {
    const where = { id: requestId, clinicId };
    const request = await this.prisma.contactRequest.findFirst({ where, select: websiteRequestState });
    if (!request) throw new NotFoundException();
    if (request.handledAt) return;
    if (action === 'installed') {
      await this.prisma.contactRequest.updateMany({ where: { ...where, handledAt: null, installedAt: null }, data: { installedAt: new Date() } });
      return;
    }
    if (!request.installedAt || !(await this.matchingReceipt(clinicId, request, config))) throw new ConflictException('website_receipt_required');
    await this.prisma.contactRequest.updateMany({ where: { ...where, handledAt: null }, data: { handledAt: new Date() } });
  }
}
