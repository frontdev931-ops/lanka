import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { KbModule } from '../kb/kb.module';
import { ReportBuilderModule } from '../report-builder/report-builder.module';
import { ReportsModule } from '../reports/reports.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AiController } from './ai.controller';
import { AgentDraftService } from './agent-draft.service';
import { ChatAssistantService } from './chat-assistant.service';
import { AiService } from './ai.service';
import { LlmClient } from './llm.client';

@Module({
  imports: [ReportsModule, ReportBuilderModule, KbModule, BookingModule],
  controllers: [AiController, AssistantController],
  providers: [LlmClient, AiService, ChatAssistantService, AgentDraftService, AssistantService],
  exports: [AiService, ChatAssistantService, AgentDraftService, AssistantService],
})
export class AiModule {}
