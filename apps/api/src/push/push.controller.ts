import { Body, Controller, Get, HttpCode, HttpException, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { PushService, pushLang } from './push.service';

class KeysDto {
  @IsString() @MaxLength(200) p256dh: string;
  @IsString() @MaxLength(100) auth: string;
}
class SubscribeDto {
  @IsString() @MaxLength(1000) endpoint: string;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => KeysDto) keys: KeysDto;
  @IsOptional() @IsIn(['uk', 'ru', 'en']) lang?: string;
}
class EndpointDto {
  @IsString() @MaxLength(1000) endpoint: string;
}
class ReleaseDto {
  @IsString() @MaxLength(1000) endpoint: string;
  // the opaque key of the person whose subscription it was
  @IsString() @MaxLength(64) u: string;
}
class DeviceDto {
  @IsOptional() @IsString() @MaxLength(1000) endpoint?: string;
}
class RenewDto {
  @IsString() @MaxLength(1000) oldEndpoint: string;
  @IsString() @MaxLength(1000) endpoint: string;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => KeysDto) keys: KeysDto;
}

// Push on the signed-in person's devices. Every call is about THIS device (its endpoint in the body) and this person; nothing here lists or
// changes another person's devices.
@Controller('push')
@UseGuards(AuthGuard)
export class PushController {
  constructor(private push: PushService) {}

  // the server keys only (whether Push is configured and the public key)
  @Get()
  status(@CurrentUser() u: AuthUser) {
    return this.push.device(u.userId);
  }

  @Post('device')
  @HttpCode(200)
  device(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    return this.push.device(u.userId, dto.endpoint);
  }

  @Post('subscribe')
  @HttpCode(200)
  subscribe(@CurrentUser() u: AuthUser, @Body() dto: SubscribeDto) {
    return this.push.subscribe(u.clinicId, u.userId, { endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth }, pushLang(dto.lang));
  }

  @Post('unsubscribe')
  @HttpCode(200)
  unsubscribe(@CurrentUser() u: AuthUser, @Body() dto: EndpointDto) {
    return this.push.unsubscribe(u.userId, dto.endpoint);
  }

  // the service worker reports a renewed subscription
  @Post('renew')
  @HttpCode(200)
  renew(@CurrentUser() u: AuthUser, @Body() dto: RenewDto) {
    return this.push.renew(u.userId, dto.oldEndpoint, { endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth });
  }

  // A test to THIS device of this person only
  @Post('test')
  @HttpCode(200)
  test(@CurrentUser() u: AuthUser, @Body() dto: EndpointDto) {
    return this.push.test(u.userId, dto.endpoint);
  }
}

// A sign-out that did not reach the server: the device (the page at its next start, or the service worker) removes its own subscription without
// a session. Only an https endpoint of this length is accepted; a few calls per minute per address.
@Controller('push')
export class PushReleaseController {
  private hits = new Map<string, { n: number; at: number }>();
  constructor(private push: PushService) {}

  @Post('release')
  @HttpCode(200)
  release(@Req() req: Request, @Body() dto: ReleaseDto) {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const h = this.hits.get(ip);
    const cur = h && now - h.at < 60_000 ? { n: h.n + 1, at: h.at } : { n: 1, at: now };
    this.hits.set(ip, cur);
    if (cur.n > 20) throw new HttpException('too_many_requests', 429);
    if (!/^https:\/\//.test(dto.endpoint)) return { ok: true };
    return this.push.release(dto.endpoint, dto.u);
  }
}
