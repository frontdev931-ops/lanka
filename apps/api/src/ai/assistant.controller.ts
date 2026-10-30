import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../common/auth.guard';
import { Lang, ReqLang } from '../common/i18n';
import { AssistantService } from './assistant.service';

class TurnDto {
  @IsString() @MaxLength(600) q: string;
  @IsString() @MaxLength(600) a: string;
}
class AskDto {
  @IsString() @MinLength(3) @MaxLength(600) question: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => TurnDto) history: TurnDto[];
}

// Вопрос владельца свободным текстом: ответ приходит отчётом, который считает код
@Controller('assistant')
@UseGuards(AuthGuard)
@Roles(Role.OWNER, Role.MANAGER, Role.ADMIN, Role.ANALYST)
export class AssistantController {
  constructor(private assistant: AssistantService) {}

  @Post('ask')
  @HttpCode(200)
  ask(@CurrentUser() u: AuthUser, @ReqLang() lang: Lang, @Body() dto: AskDto) {
    return this.assistant.ask(u.clinicId, u.role, lang, dto.question, dto.history ?? []);
  }
}
