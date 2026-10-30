import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDefined, IsObject, IsString, MaxLength, ValidateNested } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser } from '../common/auth.guard';
import { PushService } from './push.service';

class KeysDto {
  @IsString() @MaxLength(200) p256dh: string;
  @IsString() @MaxLength(100) auth: string;
}
class SubscribeDto {
  @IsString() @MaxLength(1000) endpoint: string;
  @IsDefined() @IsObject() @ValidateNested() @Type(() => KeysDto) keys: KeysDto;
}
class EndpointDto {
  @IsString() @MaxLength(1000) endpoint: string;
}

@Controller('push')
@UseGuards(AuthGuard)
export class PushController {
  constructor(private push: PushService) {}

  @Get()
  status(@CurrentUser() u: AuthUser) {
    return this.push.status(u.userId);
  }

  @Post('subscribe')
  @HttpCode(200)
  subscribe(@CurrentUser() u: AuthUser, @Body() dto: SubscribeDto) {
    return this.push.subscribe(u.clinicId, u.userId, { endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth });
  }

  @Post('unsubscribe')
  @HttpCode(200)
  unsubscribe(@CurrentUser() u: AuthUser, @Body() dto: EndpointDto) {
    return this.push.unsubscribe(u.userId, dto.endpoint);
  }

  // A test message to this user's own devices
  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() u: AuthUser) {
    return { sent: await this.push.notify(u.clinicId, { title: 'LANKA', body: 'Сповіщення працюють', url: '/dashboard', tag: 'test' }, u.userId) };
  }
}
