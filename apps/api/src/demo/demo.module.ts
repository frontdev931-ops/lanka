import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

@Module({ imports: [IntegrationsModule], controllers: [DemoController], providers: [DemoService], exports: [DemoService] })
export class DemoModule {}
