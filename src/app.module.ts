// Root NestJS module that wires up the controllers and services.

import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { TemporalService } from './temporal.service';

@Module({
  imports: [],
  controllers: [WorkflowController],
  providers: [TemporalService],
})
export class AppModule {}
