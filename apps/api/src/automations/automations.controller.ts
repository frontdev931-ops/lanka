import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Headers, HttpException, Param, Patch, Post, Query, Req, Res, UseGuards, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, Max, Min, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ChatAssistantService } from '../ai/chat-assistant.service';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from './chat.service';
import { StaffNotifierService } from './staff-notifier.service';
import { CampaignsService } from './campaigns.service';
import { ResultsService } from './results.service';
import { ReviewsService } from './reviews.service';
import { DigestService } from './digest.service';
import { RequestsService } from './requests.service';
import { OutboxService } from './outbox.service';
import { PlannerService } from './planner.service';
import { SCENARIOS, scenario } from './scenarios';
import { TelegramService } from './telegram.service';
import type { TgUpdate } from './telegram.api';
import { InboundService } from './inbound.service';
import { InstagramService } from './instagram.service';
import type { IgWebhook } from './instagram.api';
import { metaWebOrigin } from './meta-chat.service';

const READERS = [Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST];
const OPERATORS = [Role.OWNER, Role.MANAGER, Role.ADMIN];
const MANAGERS = [Role.OWNER, Role.MANAGER];
const PLACEHOLDERS = new Set(['name', 'clinic', 'date', 'time', 'months']);

class RuleDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(600) text?: string;
}
class SettingsDto {
  @IsOptional() @IsBoolean() autoSendService?: boolean;
  @IsOptional() @IsBoolean() sendingEnabled?: boolean;
  @IsOptional() @IsBoolean() assumeConsent?: boolean;
}
class TokenDto {
  @IsString() @MinLength(20) @MaxLength(2000) token: string;
}

function igOAuthPage(code: string) {
  return `${metaWebOrigin()}/automations?ig=${code}`;
}

function igOAuthQuery(e: unknown): string {
  if (!(e instanceof HttpException)) return 'fail';
  const r = e.getResponse();
  const key = typeof r === 'string' ? r : r && typeof r === 'object' && 'message' in r ? String((r as { message: unknown }).message) : '';
  if (key === 'instagram_oauth_denied') return 'denied';
  if (key === 'channel_account_taken' || key === 'instagram_taken') return 'taken';
  if (key === 'plan_feature') return 'plan';
  if (key === 'demo_restricted') return 'demo';
  if (key === 'instagram_oauth_not_ready') return 'off';
  return 'fail';
}
class IdsDto {
  @IsOptional() @IsArray() @IsString({ each: true }) ids?: string[];
  @IsOptional() @IsBoolean() all?: boolean;
}

@Controller('automations')
@UseGuards(AuthGuard)
export class AutomationsController {
  constructor(
    private prisma: PrismaService,
    private planner: PlannerService,
    private outbox: OutboxService,
    private telegram: TelegramService,
    private instagram: InstagramService,
    private staff: StaffNotifierService,
  ) {}

  @Get()
  @Roles(...READERS)
  async overview(@CurrentUser() u: AuthUser) {
    const [rules, clinic, telegram, instagram, queue] = await Promise.all([
      this.planner.rules(u.clinicId),
      this.prisma.clinic.findUniqueOrThrow({ where: { id: u.clinicId }, select: { autoSendService: true, sendingEnabled: true, assumeConsent: true } }),
      this.telegram.status(u.clinicId),
      this.instagram.status(u.clinicId),
      this.outbox.list(u.clinicId, 'PENDING_APPROVAL', 1),
    ]);
    return { rules, settings: { autoSendService: clinic.autoSendService, sendingEnabled: clinic.sendingEnabled, assumeConsent: clinic.assumeConsent }, telegram, instagram, queue: queue.counts };
  }

  @Patch('settings')
  @Roles(...MANAGERS)
  async settings(@CurrentUser() u: AuthUser, @Body() dto: SettingsDto) {
    const data = { ...(dto.autoSendService !== undefined ? { autoSendService: dto.autoSendService } : {}), ...(dto.sendingEnabled !== undefined ? { sendingEnabled: dto.sendingEnabled } : {}), ...(dto.assumeConsent !== undefined ? { assumeConsent: dto.assumeConsent } : {}) };
    if (!Object.keys(data).length) throw new BadRequestException('nothing_to_change');
    const c = await this.prisma.clinic.update({ where: { id: u.clinicId }, data, select: { autoSendService: true, sendingEnabled: true, assumeConsent: true } });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'automation.settings', details: data } });
    return c;
  }

  @Patch('rules/:key')
  @Roles(...MANAGERS)
  async rule(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: RuleDto) {
    const sc = scenario(key);
    if (!sc) throw new BadRequestException('bad_scenario');
    const current = (await this.planner.rules(u.clinicId)).find((r) => r.key === key)!;
    const params = { ...current.params };
    if (dto.params) {
      if (key === 'visit-reminder' && dto.params.hoursBefore !== undefined) {
        const h = dto.params.hoursBefore;
        if (!Array.isArray(h) || !h.length || h.length > 3 || !h.every((x) => Number.isInteger(x) && x >= 1 && x <= 72)) throw new BadRequestException('bad_params');
        params.hoursBefore = [...new Set(h as number[])].sort((a, b) => b - a);
      }
      if (key === 'visit-reminder' && dto.params.confirmButtons !== undefined) {
        if (typeof dto.params.confirmButtons !== 'boolean') throw new BadRequestException('bad_params');
        params.confirmButtons = dto.params.confirmButtons;
      }
      if ((key === 'continue-treatment' || key === 'lapsed') && dto.params.days !== undefined) {
        const d = dto.params.days;
        if (!Number.isInteger(d) || (d as number) < 7 || (d as number) > 1095) throw new BadRequestException('bad_params');
        params.days = d;
      }
      if (key === 'hygiene-recall' && dto.params.months !== undefined) {
        const m = dto.params.months;
        if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 24) throw new BadRequestException('bad_params');
        params.months = m;
      }
    }
    if (dto.text !== undefined) {
      const unknown = [...dto.text.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).filter((x) => !PLACEHOLDERS.has(x));
      if (unknown.length) throw new BadRequestException('bad_template');
    }
    await this.prisma.automationRule.upsert({
      where: { clinicId_key: { clinicId: u.clinicId, key } },
      create: { clinicId: u.clinicId, key, enabled: dto.enabled ?? false, params: params as object, templates: { text: dto.text ?? sc.defaultText } },
      update: { ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}), params: params as object, ...(dto.text !== undefined ? { templates: { text: dto.text } } : {}) },
    });
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'automation.rule', details: { key, enabled: dto.enabled ?? null } } });
    return (await this.planner.rules(u.clinicId)).find((r) => r.key === key);
  }

  // Предпросмотр: сколько сообщений и кому появится в очереди, ничего не создавая (в том числе для выключенных сценариев)
  @Get('preview')
  @Roles(...READERS)
  preview(@CurrentUser() u: AuthUser) {
    return this.planner.plan(u.clinicId, { dryRun: true, includeDisabled: true });
  }

  @Post('run')
  @Roles(...OPERATORS)
  run(@CurrentUser() u: AuthUser) {
    return this.planner.plan(u.clinicId, { dryRun: false });
  }

  @Post('telegram')
  @Roles(...MANAGERS)
  async connect(@CurrentUser() u: AuthUser, @Body() dto: TokenDto) {
    const r = await this.telegram.connect(u.clinicId, dto.token.trim());
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'telegram.connected' } });
    return r;
  }

  @Delete('telegram')
  @Roles(...MANAGERS)
  async disconnect(@CurrentUser() u: AuthUser) {
    const r = await this.telegram.disconnect(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'telegram.disconnected' } });
    return r;
  }

  // The clinic owner is sent to Instagram; Meta returns them to /instagram/oauth/callback
  @Get('instagram/oauth')
  @Roles(...MANAGERS)
  async startInstagramOAuth(@CurrentUser() u: AuthUser, @Res() res: Response) {
    try {
      res.redirect(await this.instagram.oauthStartUrl(u.clinicId, u.userId));
    } catch (e) {
      res.redirect(igOAuthPage(igOAuthQuery(e)));
    }
  }

  @Post('instagram')
  @Roles(...MANAGERS)
  async connectInstagram(@CurrentUser() u: AuthUser, @Body() dto: TokenDto) {
    const r = await this.instagram.connect(u.clinicId, dto.token.trim());
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'instagram.connected' } });
    return r;
  }

  @Delete('instagram')
  @Roles(...MANAGERS)
  async disconnectInstagram(@CurrentUser() u: AuthUser) {
    const r = await this.instagram.disconnect(u.clinicId);
    await this.prisma.auditLog.create({ data: { clinicId: u.clinicId, userId: u.userId, action: 'instagram.disconnected' } });
    return r;
  }

  // Служебный чат: код для привязки, проверка и отключение
  @Post('telegram/staff-chat')
  @Roles(...MANAGERS)
  staffChatCode(@CurrentUser() u: AuthUser) {
    return this.staff.begin(u.clinicId);
  }

  @Post('telegram/staff-chat/test')
  @Roles(...MANAGERS)
  @HttpCode(200)
  async staffChatTest(@CurrentUser() u: AuthUser) {
    return { sent: await this.staff.notify(u.clinicId, 'Тестове повідомлення: службовий чат підключено.') };
  }

  @Delete('telegram/staff-chat')
  @Roles(...MANAGERS)
  async staffChatClear(@CurrentUser() u: AuthUser) {
    await this.staff.clear(u.clinicId);
    return { ok: true };
  }

  @Get('telegram/link')
  @Roles(...READERS)
  generalLink(@CurrentUser() u: AuthUser) {
    return this.telegram.generalLink(u.clinicId);
  }

  @Post('patients/:id/telegram-link')
  @Roles(...OPERATORS)
  patientLink(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.telegram.patientLink(u.clinicId, id);
  }
}

@Controller('messages')
@UseGuards(AuthGuard)
export class MessagesController {
  constructor(
    private outbox: OutboxService,
    private results: ResultsService,
  ) {}

  // Результат сообщений: что было с пациентами после отправки (для воронки)
  @Get('results')
  @Roles(...READERS)
  resultsOf(@CurrentUser() u: AuthUser, @Query('months') months?: string) {
    const m = Math.min(24, Math.max(1, Number.parseInt(months ?? '3', 10) || 3));
    return this.results.results(u.clinicId, m);
  }

  @Get()
  @Roles(...READERS)
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('page') page?: string) {
    const s = ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status ?? '') ? (status as string) : 'ALL';
    return this.outbox.list(u.clinicId, s, Number.parseInt(page ?? '1', 10) || 1);
  }

  @Post('approve')
  @Roles(...OPERATORS)
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Body() dto: IdsDto) {
    if (!dto.all && !dto.ids?.length) throw new BadRequestException('nothing_selected');
    return this.outbox.approve(u.clinicId, u.userId, dto);
  }

  @Post('cancel')
  @Roles(...OPERATORS)
  @HttpCode(200)
  cancel(@CurrentUser() u: AuthUser, @Body() dto: IdsDto) {
    if (!dto.ids?.length) throw new BadRequestException('nothing_selected');
    return this.outbox.cancel(u.clinicId, dto.ids);
  }
}

class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(2000) text: string;
}
class LinkDto {
  @IsString() patientId: string;
}

class CampaignDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsString() @MinLength(10) @MaxLength(600) text: string;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
}

@Controller('campaigns')
@UseGuards(AuthGuard)
export class CampaignsController {
  constructor(private campaigns: CampaignsService) {}

  @Get()
  @Roles(...READERS)
  list(@CurrentUser() u: AuthUser) {
    return this.campaigns.list(u.clinicId);
  }

  @Post()
  @Roles(...MANAGERS)
  create(@CurrentUser() u: AuthUser, @Body() dto: CampaignDto) {
    return this.campaigns.create(u.clinicId, u.userId, { name: dto.name, text: dto.text, filters: dto.filters ?? {} });
  }

  @Get(':id/preview')
  @Roles(...READERS)
  preview(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.campaigns.audience(u.clinicId, id, false);
  }

  // Создаёт сообщения в очереди «ждёт подтверждения»; отправляются только после подтверждения сотрудником и при включённой отправке
  @Post(':id/queue')
  @Roles(...MANAGERS)
  @HttpCode(200)
  queue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.campaigns.audience(u.clinicId, id, true);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.campaigns.remove(u.clinicId, id);
  }
}

class ReviewSettingsDto {
  @IsOptional() @IsString() @MaxLength(300) reviewUrl?: string;
}

// Отзывы и качество: оценки пациентов после визита (собирает бот)
@Controller('reviews')
@UseGuards(AuthGuard)
export class ReviewsController {
  constructor(private reviews: ReviewsService) {}

  @Get()
  @Roles(...READERS)
  async summary(@CurrentUser() u: AuthUser, @Query('months') months?: string) {
    const m = Math.min(24, Math.max(1, Number.parseInt(months ?? '3', 10) || 3));
    return { ...(await this.reviews.summary(u.clinicId, m)), settings: await this.reviews.settings(u.clinicId) };
  }

  @Patch('settings')
  @Roles(...MANAGERS)
  setSettings(@CurrentUser() u: AuthUser, @Body() dto: ReviewSettingsDto) {
    return this.reviews.setReviewUrl(u.clinicId, dto.reviewUrl ?? null);
  }
}

class DigestDto {
  @IsOptional() @IsIn(['OFF', 'DAILY', 'WEEKLY']) frequency?: string;
  @IsOptional() @IsInt() @Min(0) @Max(23) hour?: number;
  @IsOptional() @IsInt() @Min(1) @Max(7) weekday?: number;
}

// Дайджест руководителю в Telegram: настройки, привязка получателей ссылкой, пробная отправка
@Controller('digest')
@UseGuards(AuthGuard)
@Roles(...MANAGERS)
export class DigestController {
  constructor(private digest: DigestService) {}

  @Get()
  get(@CurrentUser() u: AuthUser) {
    return this.digest.settings(u.clinicId);
  }

  @Patch()
  async update(@CurrentUser() u: AuthUser, @Body() dto: DigestDto) {
    return this.digest.update(u.clinicId, dto);
  }

  @Post('link')
  link(@CurrentUser() u: AuthUser) {
    return this.digest.link(u.clinicId, u.userId);
  }

  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() u: AuthUser) {
    const s = await this.digest.settings(u.clinicId);
    return { sent: await this.digest.send(u.clinicId, s.frequency === 'DAILY' ? 'DAILY' : 'WEEKLY') };
  }

  @Delete('recipients/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.digest.remove(u.clinicId, id);
  }
}

class RequestStatusDto {
  @IsIn(['NEW', 'DONE', 'DISMISSED']) status: string;
}

@Controller('requests')
@UseGuards(AuthGuard)
export class RequestsController {
  constructor(private requests: RequestsService) {}

  @Get()
  @Roles(...READERS)
  list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    return this.requests.list(u.clinicId, ['NEW', 'DONE', 'DISMISSED'].includes(status ?? '') ? (status as string) : 'ALL');
  }

  @Patch(':id')
  @Roles(...OPERATORS)
  setStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RequestStatusDto) {
    return this.requests.setStatus(u.clinicId, u.userId, id, dto.status);
  }
}

@Controller('conversations')
@UseGuards(AuthGuard)
export class ConversationsController {
  constructor(
    private chat: ChatService,
    private assistant: ChatAssistantService,
  ) {}

  @Get()
  @Roles(...READERS)
  list(@CurrentUser() u: AuthUser) {
    return this.chat.conversations(u.clinicId);
  }

  @Get(':channel/:chatId')
  @Roles(...OPERATORS)
  thread(@CurrentUser() u: AuthUser, @Param('channel') channel: string, @Param('chatId') chatId: string) {
    return this.chat.thread(u.clinicId, channel, chatId);
  }

  @Post(':channel/:chatId/reply')
  @Roles(...OPERATORS)
  @HttpCode(200)
  reply(@CurrentUser() u: AuthUser, @Param('channel') channel: string, @Param('chatId') chatId: string, @Body() dto: ReplyDto) {
    return this.chat.reply(u.clinicId, u.userId, channel, chatId, dto.text.trim());
  }

  // Черновик ответа от ИИ: только текст для сотрудника, ничего не отправляется
  @Post(':channel/:chatId/draft')
  @Roles(...OPERATORS)
  @HttpCode(200)
  draft(@CurrentUser() u: AuthUser, @Param('channel') channel: string, @Param('chatId') chatId: string) {
    return this.assistant.draft(u.clinicId, channel, chatId);
  }

  @Post(':channel/:chatId/link')
  @Roles(...OPERATORS)
  @HttpCode(200)
  link(@CurrentUser() u: AuthUser, @Param('channel') channel: string, @Param('chatId') chatId: string, @Body() dto: LinkDto) {
    return this.chat.link(u.clinicId, channel, chatId, dto.patientId);
  }
}

// Вебхук Telegram (в продакшене). Без входа: подлинность проверяется секретом в адресе и в заголовке.
@Controller('telegram')
export class TelegramWebhookController {
  constructor(private telegram: TelegramService) {}

  @Post('webhook/:secret')
  @HttpCode(200)
  async webhook(@Param('secret') secret: string, @Headers('x-telegram-bot-api-secret-token') header: string | undefined, @Body() update: TgUpdate) {
    await this.telegram.handleWebhook(secret, header, update).catch(() => undefined);
    return { ok: true };
  }
}

// Incoming messenger events that failed or are being retried; the owner sees them and can retry. Texts of patients are not shown here.
@Controller('integration-events')
@UseGuards(AuthGuard)
export class IntegrationEventsController {
  constructor(private inbound: InboundService) {}

  @Get()
  @Roles(...MANAGERS)
  overview(@CurrentUser() u: AuthUser) {
    return this.inbound.overview(u.clinicId);
  }

  @Post(':id/retry')
  @Roles(...MANAGERS)
  @HttpCode(200)
  async retry(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    if (!(await this.inbound.retry(u.clinicId, id))) throw new BadRequestException('event_not_found');
    return { ok: true };
  }
}

// Instagram webhook from Meta. No sign-in: the HMAC signature of the raw body proves the sender; the GET is Meta's one-time address check.
@Controller('instagram')
export class InstagramWebhookController {
  constructor(private instagram: InstagramService) {}

  @Get('oauth/callback')
  async oauthCallback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    try {
      await this.instagram.oauthFinish(code, state, error);
      res.redirect(igOAuthPage('ok'));
    } catch (e) {
      res.redirect(igOAuthPage(igOAuthQuery(e)));
    }
  }

  @Get('webhook')
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.instagram.verify(mode, token, challenge);
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: IgWebhook) {
    await this.instagram.handleWebhook(req.rawBody, signature, body).catch(() => undefined);
    return { ok: true };
  }
}

export const SCENARIO_KEYS = SCENARIOS.map((s) => s.key);
