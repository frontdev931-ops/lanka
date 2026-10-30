import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboundService } from './inbound.service';
import { IntakeService } from './intake.service';
import { MetaChatService } from './meta-chat.service';
import { FacebookApi } from './meta-graph.api';

// Facebook Messenger of the clinic's page
@Injectable()
export class FacebookService extends MetaChatService {
  protected readonly channel = 'MESSENGER';
  protected readonly provider = Provider.MESSENGER;
  protected readonly webhookObject = 'page';
  protected readonly tokenError = 'bad_facebook_token';

  constructor(prisma: PrismaService, protected api: FacebookApi, inbound: InboundService, intake: IntakeService) {
    super(prisma, api, inbound, intake);
    this.register();
  }

  protected async identify(token: string) {
    const me = await this.api.me(token);
    return { id: String(me.id ?? ''), name: me.name ?? null };
  }
}
