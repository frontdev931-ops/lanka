import { Module } from '@nestjs/common';
import { ClinicController } from './clinic.controller';

@Module({ controllers: [ClinicController] })
export class ClinicModule {}
