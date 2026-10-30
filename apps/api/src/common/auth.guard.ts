import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { accessBlocked, billingEnforced } from '../service/plans';

export interface AuthUser {
  userId: string;
  clinicId: string;
  role: Role;
}

export const SESSION_COOKIE = 'stomat_session';
export const SESSION_MAX_AGE_MS = 12 * 3600_000;

export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

// Все запросы к данным клиники берут clinicId только из токена, не из параметров запроса.
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEMO_BLOCKED = ['/integrations', '/automations/telegram', '/automations/instagram', '/automations/messenger', '/automations/whatsapp', '/automations/viber', '/automations/webchat', '/automations/leads', '/automations/meta', '/billing', '/team', '/imports', '/service/security', '/platform', '/auth/2fa', '/push'];

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    // Браузер авторизуется httpOnly-cookie (скрипты страницы токен не видят), внешние клиенты и тесты — заголовком
    const token = bearer ?? readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();

    // Защита от подделки запросов с чужих сайтов: действие по cookie допускается только с нашего сайта
    if (!bearer && !SAFE_METHODS.has(req.method)) {
      const origin: string | undefined = req.headers.origin;
      const allowed = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
      if (origin && origin !== allowed) throw new ForbiddenException();
    }

    let payload: { sub: string; clinicId: string; iat?: number; jti?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }
    // A token the person signed out of is refused even though it has not expired yet
    if (payload.jti && (await this.prisma.revokedToken.findUnique({ where: { jti: payload.jti }, select: { jti: true } }))) throw new UnauthorizedException();
    // Членство и роль берём из базы на каждый запрос: уволенный сотрудник теряет доступ сразу,
    // а не когда истечёт токен; смена роли тоже действует сразу. После сброса пароля старые токены недействительны.
    const m = await this.prisma.membership.findUnique({
      where: { userId_clinicId: { userId: payload.sub, clinicId: payload.clinicId } },
      select: { role: true, clinic: { select: { suspendedAt: true, require2fa: true, billingStatus: true, paidUntil: true, isDemo: true, demoExpiresAt: true } }, user: { select: { sessionsValidAfter: true, totpEnabledAt: true } } },
    });
    if (!m) throw new UnauthorizedException();
    const after = m.user.sessionsValidAfter;
    if (after && (payload.iat ?? 0) < Math.floor(after.getTime() / 1000)) throw new UnauthorizedException();
    req.user = { userId: payload.sub, clinicId: payload.clinicId, role: m.role } as AuthUser;
    // A demo copy ends after a few hours; a demo cannot connect real systems, change the team, billing or upload files
    if (m.clinic.isDemo) {
      if (m.clinic.demoExpiresAt && m.clinic.demoExpiresAt < new Date()) throw new UnauthorizedException('demo_expired');
      const p: string = String(req.originalUrl ?? req.url).split('?')[0];
      if (!SAFE_METHODS.has(req.method) && DEMO_BLOCKED.some((x) => p.startsWith(x))) throw new ForbiddenException('demo_restricted');
    }
    // A suspended clinic can only ask who it is and sign out; with the owner's "require two-factor" rule, a user without
    // two-factor can only reach the sign-in/security endpoints until they turn it on
    const path: string = String(req.originalUrl ?? req.url).split('?')[0];
    const authOnly = path.startsWith('/auth/');
    if (m.clinic.suspendedAt && !(authOnly || path.startsWith('/platform/'))) throw new ForbiddenException('clinic_suspended');
    // Before the first payment (and after the grace days) only sign-in, the payment page and the plan page are open; data is kept
    if (billingEnforced() && accessBlocked(m.clinic) && !(authOnly || path.startsWith('/billing') || path.startsWith('/service/'))) throw new ForbiddenException('payment_required');
    if (m.clinic.require2fa && !m.user.totpEnabledAt && !authOnly) throw new ForbiddenException('twofa_required');
    // Ограничение ролей читается и с метода, и с контроллера целиком (метод главнее)
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(req.user.role)) throw new ForbiddenException();
    return true;
  }
}
