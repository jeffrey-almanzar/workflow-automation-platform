// Service that talks to Temporal to start and monitor workflows.

import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { NewHire, TASK_QUEUE, progressQuery } from './shared';
import type { onboardingWorkflow } from './workflows';

@Injectable()
export class TemporalService implements OnModuleInit {
  private client!: Client;

  async onModuleInit() {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
    });
    this.client = new Client({ connection });
  }

  async startOnboarding(hire: NewHire): Promise<string> {
    // The workflow ID is derived from the employee ID, so Temporal itself rejects
    // a second onboarding for the same person (e.g. a double-clicked submit).
    const workflowId = `onboarding-${hire.employeeId}`;
    try {
      const handle = await this.client.workflow.start<typeof onboardingWorkflow>('onboardingWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [hire],
      });
      return handle.workflowId;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        throw new ConflictException(`Onboarding already exists for employee ${hire.employeeId}`);
      }
      throw err;
    }
  }

  async getOnboarding(workflowId: string) {
    const handle = this.client.workflow.getHandle(workflowId);
    try {
      // describe() comes from the Temporal server; the query is answered by the
      // workflow's own in-memory state (via a worker).
      const [description, progress] = await Promise.all([handle.describe(), handle.query(progressQuery)]);
      return {
        onboardingId: workflowId,
        workflowStatus: description.status.name,
        startedAt: description.startTime,
        closedAt: description.closeTime ?? null,
        ...progress,
      };
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        throw new NotFoundException(`Onboarding ${workflowId} not found`);
      }
      throw err;
    }
  }
}
