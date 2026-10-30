import { Module } from '@nestjs/common';
import { KbModule } from '../kb/kb.module';
import { ReportBuilderModule } from '../report-builder/report-builder.module';
import { ReportsModule } from '../reports/reports.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AiController } from './ai.controller';
import { ChatAssistantService } from './chat-assistant.service';
import { AiService } from './ai.service';
import { LlmClient } from './llm.client';

@Module({
  imports: [ReportsModule, ReportBuilderModule, KbModule],
  controllers: [AiController, AssistantController],
  providers: [LlmClient, AiService, ChatAssistantService, AssistantService],
  exports: [AiService, ChatAssistantService],
})
export class AiModule {}
