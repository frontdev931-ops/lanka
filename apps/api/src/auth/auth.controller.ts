import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Equals, IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, SESSION_COOKIE, SESSION_MAX_AGE_MS } from '../common/auth.guard';
import { langFromHeader } from '../common/i18n';
import { AuthService, MIN_PASSWORD } from './auth.service';
import { TwoFactorService } from './two-factor.service';

class RegisterDto {
  @IsString() @MinLength(2) @MaxLength(120) clinicName: string;
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsEmail() @MaxLength(200) email: string;
  @IsString() @MinLength(MIN_PASSWORD) @MaxLength(200) password: string;
  // Владелец принимает соглашение об обработке данных от имени клиники
  @IsBoolean() @Equals(true) acceptTerms: boolean;
}

class LoginDto {
  @IsEmail() email: string;
  @IsString() @MaxLength(200) password: string;
  @IsOptional() @IsString() clinicId?: string;
  // Код из приложения-аутентификатора или резервный код (если включён двухфакторный вход)
  @IsOptional() @IsString() @MaxLength(32) code?: string;
}

class CodeDto {
  @IsString() @MaxLength(32) code: string;
}

class DisableDto extends CodeDto {
  @IsString() @MaxLength(200) password: string;
}

class SwitchDto {
  @IsString() @MaxLength(60) clinicId: string;
}

class ForgotDto {
  @IsEmail() email: string;
}

class ResetDto {
  @IsString() @MaxLength(200) token: string;
  @IsString() @MinLength(MIN_PASSWORD) @MaxLength(200) password: string;
}

class TokenDto {
  @IsString() @MaxLength(200) token: string;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // скрипты страницы токен не читают
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';
const langOf = (req: Request) => langFromHeader(req.headers['accept-language']);

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private twofa: TwoFactorService,
  ) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.register(dto, ipOf(req), langOf(req));
    setSessionCookie(res, r.accessToken);
    return r;
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() u: AuthUser) {
    return this.auth.me(u.userId, u.clinicId);
  }

  @Get('clinics')
  @UseGuards(AuthGuard)
  clinics(@CurrentUser() u: AuthUser) {
    return this.auth.clinics(u.userId);
  }

  @Post('switch')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async switch(@CurrentUser() u: AuthUser, @Body() dto: SwitchDto, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.switchClinic(u.userId, dto.clinicId);
    setSessionCookie(res, r.accessToken);
    return r;
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto.email, dto.password, dto.clinicId, ipOf(req), dto.code);
    if ('accessToken' in r) setSessionCookie(res, r.accessToken);
    return r;
  }

  // Двухфакторный вход (TOTP)
  @Get('2fa')
  @UseGuards(AuthGuard)
  twoFactorStatus(@CurrentUser() u: AuthUser) {
    return this.twofa.status(u.userId);
  }

  @Post('2fa/setup')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  twoFactorSetup(@CurrentUser() u: AuthUser) {
    return this.twofa.setup(u.userId);
  }

  @Post('2fa/enable')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  twoFactorEnable(@CurrentUser() u: AuthUser, @Body() dto: CodeDto) {
    return this.twofa.enable(u.userId, dto.code);
  }

  @Post('2fa/disable')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  twoFactorDisable(@CurrentUser() u: AuthUser, @Body() dto: DisableDto) {
    return this.twofa.disable(u.userId, dto.password, dto.code);
  }

  @Post('2fa/recovery-codes')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  twoFactorRecovery(@CurrentUser() u: AuthUser, @Body() dto: CodeDto) {
    return this.twofa.regenerate(u.userId, dto.code);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    await this.auth.revoke(req.headers.authorization, req.headers.cookie);
    return { ok: true };
  }

  @Post('forgot-password')
  @HttpCode(200)
  forgot(@Body() dto: ForgotDto, @Req() req: Request) {
    return this.auth.forgotPassword(dto.email, ipOf(req), langOf(req));
  }

  @Post('reset-password')
  @HttpCode(200)
  reset(@Body() dto: ResetDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return this.auth.resetPassword(dto.token, dto.password, ipOf(req));
  }

  @Post('verify-email')
  @HttpCode(200)
  verify(@Body() dto: TokenDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  resend(@CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.auth.resendVerification(u.userId, langOf(req));
  }
}
