import { Global, Module } from '@nestjs/common';
import { PushController, PushReleaseController } from './push.controller';
import { PushSender, PushService } from './push.service';

@Global()
@Module({ controllers: [PushController, PushReleaseController], providers: [PushSender, PushService], exports: [PushService] })
export class PushModule {}
