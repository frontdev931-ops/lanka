import { Global, Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { ServiceController } from './service.controller';
import { UsageService } from './usage.service';

@Global()
@Module({ controllers: [ServiceController, PlatformController], providers: [UsageService], exports: [UsageService] })
export class ServiceModule {}
