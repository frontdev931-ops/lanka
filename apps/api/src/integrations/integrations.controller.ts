import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { SyncService } from './sync.service';
import { AuthService } from '../auth/auth.service';

class ConnectDto {
  @IsString() @MinLength(8) apiKey: string;
  // Сразу запустить первую загрузку данных (ответ не ждёт её окончания)
  @IsOptional() @IsBoolean() sync?: boolean;
}

@Controller('integrations/cliniccards')
@UseGuards(AuthGuard)
export class IntegrationsController {
  constructor(
    private sync: SyncService,
    private auth: AuthService,
  ) {}

  @Get()
  status(@CurrentUser() u: AuthUser) {
    return this.sync.status(u.clinicId);
  }

  @Put('key')
  @Roles(Role.OWNER)
  async connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectDto) {
    // Подключать данные клиники может только владелец с подтверждённой почтой
    await this.auth.assertEmailVerified(u.userId);
    await this.auth.assertTermsAccepted(u.clinicId);
    const status = await this.sync.connect(u.clinicId, u.userId, dto.apiKey);
    // Ошибка загрузки фиксируется в истории синхронизаций, здесь её не ждём
    if (dto.sync) void this.sync.run(u.clinicId, u.userId).catch(() => {});
    return status;
  }

  @Post('sync')
  @Roles(Role.OWNER, Role.MANAGER, Role.ADMIN)
  async run(@CurrentUser() u: AuthUser, @Query('background') background?: string) {
    // Из интерфейса запуск идёт в фоне: загрузка занимает минуты, запрос столько ждать не должен
    if (background === '1') {
      if (!(await this.sync.hasActiveRun(u.clinicId))) void this.sync.run(u.clinicId, u.userId).catch(() => {});
      return { started: true };
    }
    return this.sync.run(u.clinicId, u.userId);
  }

  @Get('runs')
  runs(@CurrentUser() u: AuthUser) {
    return this.sync.lastRuns(u.clinicId);
  }
}
