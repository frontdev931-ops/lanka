import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ReportsModule } from '../reports/reports.module';
import { AutoReplyService } from './auto-reply.service';
import { AutomationScheduler } from './automation.scheduler';
import { AutomationsController, ConversationsController, MessagesController, RequestsController, CampaignsController, DigestController, ReviewsController, TelegramWebhookController, InstagramWebhookController, IntegrationEventsController } from './automations.controller';
import { ChatService } from './chat.service';
import { OutboxService } from './outbox.service';
import { StaffNotifierService } from './staff-notifier.service';
import { ReviewsService } from './reviews.service';
import { DigestService } from './digest.service';
import { CampaignsService } from './campaigns.service';
import { ResultsService } from './results.service';
import { RequestsService } from './requests.service';
import { PlannerService } from './planner.service';
import { InboundService } from './inbound.service';
import { ChannelsController, MessengerWebhookController, MetaLoginPublicController, WhatsAppWebhookController } from './channels.controller';
import { MetaLoginApi } from './meta-login.api';
import { MetaLoginService } from './meta-login.service';
import { FacebookAdapter } from './facebook.adapter';
import { FacebookService } from './facebook.service';
import { IntakeService } from './intake.service';
import { FacebookApi } from './meta-graph.api';
import { NoViberProvider, ViberProvider } from './viber.provider';
import { ViberAdapter } from './viber.adapter';
import { ViberService } from './viber.service';
import { WebAdapter } from './web.adapter';
import { WebChatPublicController, WebChatSettingsController } from './webchat.controller';
import { WebChatService } from './webchat.service';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { WhatsAppApi } from './whatsapp.api';
import { WhatsAppService } from './whatsapp.service';
import { MetaComplianceController, MetaComplianceService } from './meta-compliance';
import { LeadsPublicController, LeadsSettingsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { CustomAutomationsController } from './custom-automations.controller';
import { CustomAutomationsService } from './custom-automations.service';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';
import { InstagramAdapter } from './instagram.adapter';
import { InstagramApi } from './instagram.api';
import { TelegramAdapter } from './telegram.adapter';
import { InstagramService } from './instagram.service';
import { MessengerService } from './messenger.service';
import { TelegramApi } from './telegram.api';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AiModule, ReportsModule],
  controllers: [AutomationsController, ConversationsController, MessagesController, RequestsController, CampaignsController, DigestController, ReviewsController, TelegramWebhookController, InstagramWebhookController, IntegrationEventsController, ChannelsController, MessengerWebhookController, WhatsAppWebhookController, WebChatSettingsController, WebChatPublicController, WaitlistController, CustomAutomationsController, MetaComplianceController, LeadsSettingsController, LeadsPublicController, MetaLoginPublicController],
  providers: [MetaLoginApi, MetaLoginService, LeadsService, MetaComplianceService, CustomAutomationsService, WaitlistService, FacebookApi, FacebookAdapter, FacebookService, WhatsAppApi, WhatsAppAdapter, WhatsAppService, { provide: ViberProvider, useClass: NoViberProvider }, ViberService, ViberAdapter, WebAdapter, WebChatService, IntakeService, TelegramApi, TelegramService, InstagramApi, InstagramAdapter, TelegramAdapter, InstagramService, MessengerService, InboundService, PlannerService, OutboxService, ChatService, AutoReplyService, RequestsService, StaffNotifierService, CampaignsService, ResultsService, DigestService, ReviewsService, AutomationScheduler],
  exports: [TelegramService, OutboxService, PlannerService, StaffNotifierService, WaitlistService, CustomAutomationsService],
})
export class AutomationsModule {}
