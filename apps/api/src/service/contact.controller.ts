import { BadRequestException, Body, Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Equals, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MailService } from '../auth/mail.service';
import { RateLimitService } from '../auth/rate-limit.service';
import { PrismaService } from '../prisma/prisma.service';

class ContactDto {
  @IsString() @MaxLength(40) phone: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsIn(['uk', 'ru', 'en']) lang?: string;
  // the visitor ticked the consent to be contacted (the link to the privacy policy is beside it)
  @Equals(true) consent: boolean;
  // a trap field hidden from people: a bot that fills it gets the usual answer and nothing is saved
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

const HOUR = 3600_000;

// The "we will call you back" form of the public landing page. No sign-in. The request is saved for the service owner (/platform) and mailed to
// the addresses of PLATFORM_ADMIN_EMAILS; the phone is never written to the server log.
@Controller('contact-requests')
export class ContactController {
  private readonly log = new Logger(ContactController.name);

  constructor(
    private prisma: PrismaService,
    private limits: RateLimitService,
    private mail: MailService,
  ) {}

  @Post()
  @HttpCode(200)
  async create(@Body() dto: ContactDto, @Req() req: Request) {
    await this.limits.consume(`contact:ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, 5, HOUR);
    if (dto.website) return { ok: true };
    const digits = dto.phone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) throw new BadRequestException('bad_phone');
    const phone = (dto.phone.trim().startsWith('+') ? '+' : '') + digits;
    const name = dto.name?.trim() || null;
    const row = await this.prisma.contactRequest.create({ data: { phone, name, lang: dto.lang ?? 'uk' } });
    const to = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const origin = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
    for (const addr of to) {
      await this.mail.send({ to: addr, subject: 'LANKA: нова заявка з сайту', text: `Просять зв’язатися.\n\nТелефон: ${phone}\nІм’я: ${name ?? '—'}\nМова сторінки: ${row.lang}\n\nУсі заявки: ${origin}/platform` });
    }
    if (!to.length) this.log.warn('A contact request was saved, but PLATFORM_ADMIN_EMAILS is empty: nobody was mailed');
    return { ok: true };
  }
}
