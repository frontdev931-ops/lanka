import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { decrypt, encrypt } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from './rate-limit.service';
import { hashToken } from './tokens';
import { newRecoveryCode, newSecret, otpauthUrl, verifyTotp } from './totp';

const MIN = 60_000;
const ATTEMPTS = 6;
const RECOVERY_COUNT = 8;
const norm = (c: string) => c.trim().toUpperCase().replace(/\s/g, '');

@Injectable()
export class TwoFactorService {
  constructor(
    private prisma: PrismaService,
    private limits: RateLimitService,
  ) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true, recoveryHashes: true } });
    return { enabled: !!u.totpEnabledAt, recoveryLeft: u.totpEnabledAt ? ((u.recoveryHashes as string[] | null) ?? []).length : 0 };
  }

  // Шаг 1: секрет создаётся и сохраняется зашифрованным, но защита включится только после подтверждения кодом
  async setup(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, totpEnabledAt: true } });
    if (u.totpEnabledAt) throw new BadRequestException('twofa_already');
    const secret = newSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: encrypt(secret), totpLastStep: null } });
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }

  // Шаг 2: подтверждение кодом из приложения; резервные коды показываются один раз
  async enable(userId: string, code: string) {
    await this.limits.consume(`2fa:${userId}`, ATTEMPTS, 15 * MIN);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretEnc: true, totpEnabledAt: true } });
    if (u.totpEnabledAt) throw new BadRequestException('twofa_already');
    if (!u.totpSecretEnc) throw new BadRequestException('twofa_not_started');
    const step = verifyTotp(decrypt(u.totpSecretEnc), code.trim());
    if (step === null) throw new BadRequestException('twofa_bad_code');
    const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(), totpLastStep: step, recoveryHashes: codes.map((c) => hashToken(norm(c))) } });
    await this.limits.reset(`2fa:${userId}`);
    return { recoveryCodes: codes };
  }

  // Проверка второго фактора при входе: код из приложения или одноразовый резервный. Счётчик попыток общий с входом по почте.
  async verifyLogin(userId: string, input: string): Promise<'totp' | 'recovery'> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true, recoveryHashes: true } });
    if (!u.totpEnabledAt || !u.totpSecretEnc) return 'totp';
    const code = input.trim();
    if (/^\d{6}$/.test(code)) {
      const step = verifyTotp(decrypt(u.totpSecretEnc), code);
      // один и тот же шаг второй раз не принимается: подсмотренный код нельзя использовать повторно
      if (step !== null && (u.totpLastStep === null || step > u.totpLastStep)) {
        const r = await this.prisma.user.updateMany({ where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
        if (r.count) return 'totp';
      }
      throw new UnauthorizedException('twofa_bad_code');
    }
    const hashes = ((u.recoveryHashes as string[] | null) ?? []).slice();
    const h = hashToken(norm(code));
    const i = hashes.indexOf(h);
    if (i < 0) throw new UnauthorizedException('twofa_bad_code');
    hashes.splice(i, 1);
    // резервный код действует один раз
    const r = await this.prisma.user.updateMany({ where: { id: userId, recoveryHashes: { equals: u.recoveryHashes as never } }, data: { recoveryHashes: hashes } });
    if (!r.count) throw new UnauthorizedException('twofa_bad_code');
    return 'recovery';
  }

  async disable(userId: string, password: string, code: string) {
    await this.limits.consume(`2fa:${userId}`, ATTEMPTS, 15 * MIN);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, totpEnabledAt: true } });
    if (!u.totpEnabledAt) throw new BadRequestException('twofa_not_enabled');
    if (!(await bcrypt.compare(password, u.passwordHash))) throw new UnauthorizedException('bad_credentials');
    await this.verifyLogin(userId, code);
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryHashes: Prisma.DbNull } });
    await this.limits.reset(`2fa:${userId}`);
    return { ok: true };
  }

  // Новые резервные коды (старые перестают работать); нужен действующий код
  async regenerate(userId: string, code: string) {
    await this.limits.consume(`2fa:${userId}`, ATTEMPTS, 15 * MIN);
    await this.verifyLogin(userId, code);
    const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
    await this.prisma.user.update({ where: { id: userId }, data: { recoveryHashes: codes.map((c) => hashToken(norm(c))) } });
    return { recoveryCodes: codes };
  }
}
