import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';

@Module({ imports: [IntegrationsModule], controllers: [KbController], providers: [KbService], exports: [KbService] })
export class KbModule {}
