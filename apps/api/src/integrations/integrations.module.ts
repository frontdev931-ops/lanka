import { Module } from '@nestjs/common';
import { AutoSyncService } from './auto-sync.service';
import { IntegrationsController } from './integrations.controller';
import { SettingsImportService } from './settings-import.service';
import { SyncService } from './sync.service';

@Module({
  controllers: [IntegrationsController],
  providers: [SyncService, AutoSyncService, SettingsImportService],
  exports: [SyncService, SettingsImportService],
})
export class IntegrationsModule {}
