import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { readCookie, SESSION_COOKIE } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { Lang } from '../common/i18n';
import { MailService } from './mail.service';
import { mailText } from './mail-text';
import { RateLimitService } from './rate-limit.service';
import { hashToken, newToken } from './tokens';
import { TERMS_VERSION } from '../common/terms';
import { TwoFactorService } from './two-factor.service';
import { isPlatformAdmin } from '../service/platform.controller';
import { accessBlocked, billingEnforced, GRACE_DAYS } from '../service/plans';

const MIN = 60_000;
const HOUR = 60 * MIN;
const RESET_TTL = HOUR;
const VERIFY_TTL = 72 * HOUR;
// Неудачные входы: по почте (защита конкретного аккаунта) и по адресу (защита от перебора многих аккаунтов)
const LOGIN_MAX_BY_EMAIL = 10;
const LOGIN_MAX_BY_IP = 40;
const LOGIN_WINDOW = 15 * MIN;

export const MIN_PASSWORD = 10;

// Пароль не короче 10 символов и не равен почте: остальное (сложность) даёт длина, а не требования к символам
export function assertPasswordOk(password: string, email?: string) {
  if (password.length < MIN_PASSWORD || (email && password.toLowerCase() === email.toLowerCase())) throw new BadRequestException('weak_password');
}

// A valid bcrypt hash of a random string (cost 12) used only to spend the same time when the email is unknown
export const DUMMY_HASH = '$2a$12$hqaZLoFEtVJz.MpwPN4UJeLQNSnzw5hLdwjqHqFZ0tGo1aA6vfUmG';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private limits: RateLimitService,
    private mail: MailService,
    private twofa: TwoFactorService,
  ) {}

  async register(dto: { clinicName: string; name: string; email: string; password: string }, ip: string, lang: Lang) {
    // Не больше 5 регистраций в час с одного адреса: иначе базу забьют пустыми клиниками
    await this.limits.consume(`register:ip:${ip}`, 5, HOUR);
    const email = dto.email.toLowerCase();
    assertPasswordOk(dto.password, email);
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('email_taken');
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        passwordHash,
        memberships: {
          create: {
            role: Role.OWNER,
            clinic: { create: { name: dto.clinicName, termsVersion: TERMS_VERSION, termsAcceptedAt: new Date() } },
          },
        },
      },
      include: { memberships: true },
    });
    const m = user.memberships[0];
    await this.prisma.clinic.update({ where: { id: m.clinicId }, data: { termsAcceptedById: user.id } });
    await this.audit(m.clinicId, user.id, 'clinic.created');
    await this.prisma.auditLog.create({ data: { clinicId: m.clinicId, userId: user.id, action: 'terms.accepted', details: { version: TERMS_VERSION, ip } } });
    await this.sendVerification(user.id, email, lang);
    return this.token(user.id, m.clinicId, m.role);
  }

  // Если у пользователя несколько клиник и clinicId не указан, возвращаем список для выбора.
  async login(email: string, password: string, clinicId: string | undefined, ip: string, code?: string) {
    const key = `login:email:${email.toLowerCase()}`;
    const ipKey = `login:ip:${ip}`;
    await this.limits.assertBelow(key, LOGIN_MAX_BY_EMAIL, LOGIN_WINDOW);
    await this.limits.assertBelow(ipKey, LOGIN_MAX_BY_IP, LOGIN_WINDOW);
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { memberships: { include: { clinic: { select: { id: true, name: true } } } } },
    });
    // An unknown email costs the same time as a wrong password (compared with a fixed hash), so response time does not tell which emails exist
    const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordOk || !user.memberships.length) {
      await this.limits.hit(key, LOGIN_WINDOW);
      await this.limits.hit(ipKey, LOGIN_WINDOW);
      throw new UnauthorizedException('bad_credentials');
    }
    const twoFactor = !!user.totpEnabledAt;

    let m = clinicId ? user.memberships.find((x) => x.clinicId === clinicId) : undefined;
    if (clinicId && !m) throw new UnauthorizedException('no_clinic_access');
    if (!m) {
      // Выбор клиники и второй фактор спрашиваются вместе одним запросом: резервный код одноразовый, второй раз его не принять
      if (user.memberships.length > 1) return { clinics: user.memberships.map((x) => ({ id: x.clinic.id, name: x.clinic.name })), ...(twoFactor ? { twoFactorRequired: true } : {}) };
      m = user.memberships[0];
    }
    let method: string | undefined;
    if (twoFactor) {
      if (!code) return { twoFactorRequired: true as const };
      try {
        method = await this.twofa.verifyLogin(user.id, code);
      } catch (e) {
        await this.limits.hit(key, LOGIN_WINDOW);
        await this.limits.hit(ipKey, LOGIN_WINDOW);
        throw e;
      }
    }
    await this.limits.reset(key);
    await this.audit(m.clinicId, user.id, method === 'recovery' ? 'auth.login.recovery_code' : 'auth.login');
    return this.token(user.id, m.clinicId, m.role);
  }

  // Signing out closes this session for good: the token id is remembered until the token would have expired by itself
  async revoke(authorization: string | undefined, cookie: string | undefined) {
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7) : readCookie(cookie, SESSION_COOKIE);
    if (!raw) return;
    try {
      const p = await this.jwt.verifyAsync<{ jti?: string; exp?: number }>(raw);
      if (p.jti && p.exp) await this.prisma.revokedToken.upsert({ where: { jti: p.jti }, create: { jti: p.jti, expiresAt: new Date(p.exp * 1000) }, update: {} });
    } catch {
      // a token that does not verify is useless anyway
    }
    await this.prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }

  // The clinics a signed-in user belongs to, and switching between them without signing in again
  async clinics(userId: string) {
    const rows = await this.prisma.membership.findMany({ where: { userId }, include: { clinic: { select: { id: true, name: true } } }, orderBy: { clinic: { name: 'asc' } } });
    return rows.map((x) => ({ id: x.clinic.id, name: x.clinic.name, role: x.role }));
  }

  async switchClinic(userId: string, clinicId: string) {
    const m = await this.prisma.membership.findUnique({ where: { userId_clinicId: { userId, clinicId } } });
    if (!m) throw new UnauthorizedException('no_clinic_access');
    await this.audit(clinicId, userId, 'auth.switch_clinic');
    return this.token(userId, clinicId, m.role);
  }

  async me(userId: string, clinicId: string) {
    const m = await this.prisma.membership.findUnique({
      where: { userId_clinicId: { userId, clinicId } },
      include: { user: { select: { name: true, email: true, emailVerifiedAt: true, totpEnabledAt: true } }, clinic: { select: { name: true, logo: true, termsVersion: true, suspendedAt: true, require2fa: true, billingStatus: true, paidUntil: true, isDemo: true, plan: true } } },
    });
    if (!m) throw new UnauthorizedException();
    return {
      name: m.user.name,
      email: m.user.email,
      emailVerified: !!m.user.emailVerifiedAt,
      twoFactorEnabled: !!m.user.totpEnabledAt,
      // The clinic owner requires two-factor and this user has not set it up yet: the app sends them to settings
      twoFactorRequired: m.clinic.require2fa && !m.user.totpEnabledAt,
      suspended: !!m.clinic.suspendedAt,
      // billing.blocked: real data is closed until payment; the app sends the owner to the payment page
      billing: { status: m.clinic.billingStatus, plan: m.clinic.plan, paidUntil: m.clinic.paidUntil, graceDays: GRACE_DAYS, demo: m.clinic.isDemo, blocked: billingEnforced() && accessBlocked(m.clinic) },
      platformAdmin: await isPlatformAdmin(this.prisma, userId),
      role: m.role,
      clinicName: m.clinic.name,
      clinicLogo: m.clinic.logo,
      termsAccepted: m.clinic.termsVersion === TERMS_VERSION,
    };
  }

  // Сброс пароля. Ответ всегда одинаковый: он не должен выдавать, есть ли такой email в системе.
  async forgotPassword(email: string, ip: string, lang: Lang) {
    const e = email.toLowerCase();
    await this.limits.consume(`forgot:ip:${ip}`, 10, HOUR);
    await this.limits.consume(`forgot:email:${e}`, 3, HOUR);
    const user = await this.prisma.user.findUnique({ where: { email: e } });
    if (user) {
      const token = await this.issueToken(user.id, 'RESET', RESET_TTL);
      await this.mail.send({ to: e, ...mailText('reset', lang, `${this.webOrigin()}/reset/${token}`) });
    }
    return { ok: true };
  }

  async resetPassword(token: string, password: string, ip: string) {
    await this.limits.consume(`reset:ip:${ip}`, 20, HOUR);
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!row || row.type !== 'RESET' || row.usedAt || row.expiresAt < new Date()) throw new BadRequestException('bad_token');
    assertPasswordOk(password, row.user.email);
    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        // Все выданные ранее сессии перестают действовать: если пароль украли, вход злоумышленника закрывается
        data: { passwordHash, sessionsValidAfter: new Date(), emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() },
      }),
      this.prisma.authToken.updateMany({ where: { userId: row.userId, type: 'RESET', usedAt: null }, data: { usedAt: new Date() } }),
    ]);
    await this.limits.reset(`login:email:${row.user.email}`);
    const memberships = await this.prisma.membership.findMany({ where: { userId: row.userId }, select: { clinicId: true } });
    for (const m of memberships) await this.audit(m.clinicId, row.userId, 'auth.password_reset');
    return { ok: true };
  }

  async verifyEmail(token: string) {
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.type !== 'VERIFY' || row.expiresAt < new Date()) throw new BadRequestException('bad_token');
    // Повторное открытие ссылки не ошибка: почта уже подтверждена
    await this.prisma.$transaction([
      this.prisma.user.updateMany({ where: { id: row.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } }),
      this.prisma.authToken.update({ where: { id: row.id }, data: { usedAt: row.usedAt ?? new Date() } }),
    ]);
    return { ok: true };
  }

  async resendVerification(userId: string, lang: Lang) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return { ok: true };
    await this.limits.consume(`verify:user:${userId}`, 3, HOUR);
    await this.sendVerification(user.id, user.email, lang);
    return { ok: true };
  }

  // Для действий, которые открывают в приложение данные клиники (подключение ключа Cliniccards)
  async assertEmailVerified(userId: string) {
    if (process.env.REQUIRE_EMAIL_VERIFICATION === 'false') return;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) throw new ForbiddenException('email_not_verified');
  }

  // Подключать данные клиники можно только после принятия соглашения об обработке данных
  async assertTermsAccepted(clinicId: string) {
    const c = await this.prisma.clinic.findUnique({ where: { id: clinicId }, select: { termsVersion: true } });
    if (c?.termsVersion !== TERMS_VERSION) throw new ForbiddenException('terms_not_accepted');
  }

  private async sendVerification(userId: string, email: string, lang: Lang) {
    const token = await this.issueToken(userId, 'VERIFY', VERIFY_TTL);
    await this.mail.send({ to: email, ...mailText('verify', lang, `${this.webOrigin()}/verify/${token}`) });
  }

  // Новая ссылка отзывает старые неиспользованные того же типа
  private async issueToken(userId: string, type: 'RESET' | 'VERIFY', ttlMs: number) {
    const token = newToken();
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.authToken.create({ data: { userId, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) } }),
    ]);
    return token;
  }

  private webOrigin() {
    return (process.env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  private async token(userId: string, clinicId: string, role: Role) {
    return { accessToken: await this.jwt.signAsync({ sub: userId, clinicId, role }, { jwtid: randomUUID() }) };
  }

  private audit(clinicId: string, userId: string, action: string) {
    return this.prisma.auditLog.create({ data: { clinicId, userId, action } });
  }
}
