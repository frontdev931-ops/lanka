import { Module } from '@nestjs/common';
import { FunnelModule } from '../funnel/funnel.module';
import { InquiriesController } from './inquiries.controller';
import { InquiriesService } from './inquiries.service';

@Module({ imports: [FunnelModule], controllers: [InquiriesController], providers: [InquiriesService] })
export class InquiriesModule {}
