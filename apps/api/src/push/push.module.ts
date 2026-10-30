import { Global, Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushSender, PushService } from './push.service';

@Global()
@Module({ controllers: [PushController], providers: [PushSender, PushService], exports: [PushService] })
export class PushModule {}
