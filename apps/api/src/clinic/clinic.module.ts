import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ClinicController } from './clinic.controller';

@Module({ imports: [IntegrationsModule], controllers: [ClinicController] })
export class ClinicModule {}
