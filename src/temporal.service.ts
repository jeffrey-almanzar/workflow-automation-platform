// Service that talks to Temporal to start, signal and monitor onboarding/offboarding workflows.

import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import type { QueryDefinition } from '@temporalio/common';
import ms, { type StringValue } from 'ms';
import {
  NewHire,
  OnboardingTimings,
  TASK_QUEUE,
  cancelOnboardingSignal,
  contractSignedSignal,
  offboardingProgressQuery,
  progressQuery,
  updateStartDateSignal,
} from './shared';
import type { offboardingWorkflow, onboardingWorkflow } from './workflows';

const QUERY_TIMEOUT_MS = 3000;

// Optional overrides (e.g. "30 seconds") so the human-step timers can be
// demoed locally without waiting days. Unset values fall back to DEFAULT_TIMINGS.
function timingsFromEnv(): Partial<OnboardingTimings> {
  const timings: Partial<OnboardingTimings> = {};
  const env = {
    contractReminderDelay: process.env.CONTRACT_REMINDER_DELAY,
    contractEscalationDelay: process.env.CONTRACT_ESCALATION_DELAY,
    welcomeLeadTime: process.env.WELCOME_LEAD_TIME,
  };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    // Fail at boot rather than starting workflows that would crash on a bad timer.
    if (!Number.isFinite(ms(value as StringValue))) {
      throw new Error(`Invalid duration for ${key}: "${value}" (expected e.g. "30 seconds", "3 days")`);
    }
    timings[key as keyof OnboardingTimings] = value as StringValue;
  }
  return timings;
}

@Injectable()
export class TemporalService implements OnModuleInit {
  private client!: Client;
  private readonly timings = timingsFromEnv();

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
        args: [hire, this.timings],
      });
      return handle.workflowId;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        throw new ConflictException(`Onboarding already exists for employee ${hire.employeeId}`);
      }
      throw err;
    }
  }

  getOnboarding(workflowId: string) {
    return this.getState('onboarding', workflowId, progressQuery);
  }

  signContract(workflowId: string): Promise<void> {
    return this.signal(workflowId, (handle) => handle.signal(contractSignedSignal));
  }

  updateStartDate(workflowId: string, startDate: string): Promise<void> {
    return this.signal(workflowId, (handle) => handle.signal(updateStartDateSignal, startDate));
  }

  cancelOnboarding(workflowId: string, reason: string): Promise<void> {
    return this.signal(workflowId, (handle) => handle.signal(cancelOnboardingSignal, reason));
  }

  async startOffboarding(employeeId: string, reason: string, revokeAccessAt?: string): Promise<string> {
    // Offboarding tears down exactly what onboarding created, so it starts from
    // the finished onboarding's result (its resource IDs).
    const onboarding = this.client.workflow.getHandle<typeof onboardingWorkflow>(`onboarding-${employeeId}`);
    const description = await onboarding.describe().catch((err) => {
      if (err instanceof WorkflowNotFoundError) {
        throw new NotFoundException(`No onboarding found for employee ${employeeId}`);
      }
      throw err;
    });
    const result = description.status.name === 'COMPLETED' ? await onboarding.result() : null;
    if (result?.status !== 'COMPLETED') {
      throw new ConflictException(
        `Onboarding for ${employeeId} is ${result?.status ?? description.status.name}; ` +
          'only completed onboardings can be offboarded (cancel an in-progress one instead)',
      );
    }

    const workflowId = `offboarding-${employeeId}`;
    try {
      await this.client.workflow.start<typeof offboardingWorkflow>('offboardingWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [{ employeeId, reason, revokeAccessAt, resources: result.resources }],
      });
      return workflowId;
    } catch (err) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        throw new ConflictException(`Offboarding already in progress for employee ${employeeId}`);
      }
      throw err;
    }
  }

  getOffboarding(workflowId: string) {
    return this.getState('offboarding', workflowId, offboardingProgressQuery);
  }

  private async getState<T>(kind: 'onboarding' | 'offboarding', workflowId: string, query: QueryDefinition<T>) {
    const handle = this.client.workflow.getHandle(workflowId);
    try {
      // describe() comes from the Temporal server; the query is answered by the
      // workflow's own in-memory state, which requires a worker to be running.
      const description = await handle.describe();
      const summary = {
        [`${kind}Id`]: workflowId,
        workflowStatus: description.status.name,
        startedAt: description.startTime,
        closedAt: description.closeTime ?? null,
      };
      try {
        const progress = await this.client.withDeadline(Date.now() + QUERY_TIMEOUT_MS, () =>
          handle.query(query),
        );
        return { ...summary, ...progress };
      } catch {
        // No worker answered (e.g. all workers down or redeploying). The workflow is
        // safe in Temporal; degrade to the server-side status instead of hanging.
        return { ...summary, progress: null, warning: 'Detailed progress unavailable: no worker responded' };
      }
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        throw new NotFoundException(`${kind === 'onboarding' ? 'Onboarding' : 'Offboarding'} ${workflowId} not found`);
      }
      throw err;
    }
  }

  private async signal(
    workflowId: string,
    send: (handle: ReturnType<Client['workflow']['getHandle']>) => Promise<void>,
  ): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    try {
      await send(handle);
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
      // Temporal reports "not found" both for unknown IDs and for workflows that
      // already finished; describe() tells the two apart.
      const exists = await handle.describe().then(
        () => true,
        () => false,
      );
      if (exists) throw new ConflictException(`Onboarding ${workflowId} has already finished`);
      throw new NotFoundException(`Onboarding ${workflowId} not found`);
    }
  }
}
