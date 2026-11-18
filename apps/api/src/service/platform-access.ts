import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

export const PLATFORM_OWNER_EMAIL = 'hello@lankaclinic.app';

async function platformOwner(prisma: PrismaService, userId: string) {
  const pinnedId = process.env.PLATFORM_OWNER_USER_ID?.trim();
  if (!pinnedId || userId !== pinnedId) return null;
  const admins = (process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase());
  if (!admins.includes(PLATFORM_OWNER_EMAIL)) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, totpEnabledAt: true } });
  return user?.emailVerifiedAt && user.email.toLowerCase() === PLATFORM_OWNER_EMAIL ? user : null;
}

export async function isPlatformAdmin(prisma: PrismaService, userId: string): Promise<boolean> {
  return !!(await platformOwner(prisma, userId));
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const owner = user && await platformOwner(this.prisma, user.userId);
    if (!owner) throw new ForbiddenException();
    const require2fa = process.env.PLATFORM_REQUIRE_2FA === 'true' || (process.env.NODE_ENV === 'production' && process.env.PLATFORM_REQUIRE_2FA !== 'false');
    if (require2fa && !owner.totpEnabledAt) throw new ForbiddenException('platform_2fa_required');
    return true;
  }
}
