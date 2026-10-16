// Service that talks to Temporal to start and monitor workflows.

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Connection, WorkflowClient } from '@temporalio/client';

@Injectable()
export class TemporalService implements OnModuleInit {
  private client: WorkflowClient;

  async onModuleInit() {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    });
    this.client = new WorkflowClient({ connection });
  }

  async startWorkflow() {
    const handle = await this.client.start('exampleWorkflow', {
      taskQueue: 'exampleTaskQueue',
      workflowId: `workflow-${Date.now()}`,
      args: [],
    });
    return handle.workflowId;
  }

  async getWorkflowStatus(id: string) {
    const handle = this.client.getHandle(id);
    return handle.describe();
  }
}
