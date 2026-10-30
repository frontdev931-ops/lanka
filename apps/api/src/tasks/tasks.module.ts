import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [ReportsModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
