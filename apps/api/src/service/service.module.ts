import { Global, Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { ContactController } from './contact.controller';
import { ServiceController } from './service.controller';
import { UsageService } from './usage.service';

@Global()
@Module({ controllers: [ServiceController, PlatformController, ContactController], providers: [UsageService], exports: [UsageService] })
export class ServiceModule {}
