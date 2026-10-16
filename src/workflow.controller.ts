// Controller exposing endpoints to start and monitor workflows.

import { Controller, Post, Get, Param } from '@nestjs/common';
import { TemporalService } from './temporal.service';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly temporalService: TemporalService) {}

  @Post('start')
  startWorkflow() {
    return this.temporalService.startWorkflow();
  }

  @Get(':id/status')
  getStatus(@Param('id') id: string) {
    return this.temporalService.getWorkflowStatus(id);
  }
}
