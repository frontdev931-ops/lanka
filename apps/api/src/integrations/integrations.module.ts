import { Module } from '@nestjs/common';
import { AutoSyncService } from './auto-sync.service';
import { IntegrationsController } from './integrations.controller';
import { SyncService } from './sync.service';

@Module({
  controllers: [IntegrationsController],
  providers: [SyncService, AutoSyncService],
  exports: [SyncService],
})
export class IntegrationsModule {}
