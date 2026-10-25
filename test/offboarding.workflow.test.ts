// offboardingWorkflow against Temporal's time-skipping test server.

import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type { OffboardingRequest } from '../src/shared';
import type { offboardingWorkflow } from '../src/workflows';
import { DAY, createTestEnv, mockActivities, runWithWorker } from './helpers';

jest.setTimeout(60_000);

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  ({ env, bundle } = await createTestEnv());
});

afterAll(async () => {
  await env?.teardown();
});

const ENGINEER_RESOURCES = {
  hrRecord: 'hr-E1',
  contract: 'envelope-1',
  email: 'ana.lopez@company.com',
  slack: 'U-1',
  github: 'gh-invite-1',
  laptop: 'order-1',
  payroll: 'payroll-1',
};

function run(taskQueue: string, request: Partial<OffboardingRequest> = {}) {
  return env.client.workflow.execute<typeof offboardingWorkflow>('offboardingWorkflow', {
    taskQueue,
    workflowId: `offboarding-${Math.random()}`,
    args: [{ employeeId: 'E1', reason: 'Resigned', resources: ENGINEER_RESOURCES, ...request }],
  });
}

describe('offboardingWorkflow', () => {
  test('waits until revokeAccessAt, cuts access first, archives the HR record last', async () => {
    const mocks = mockActivities();
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const revokeAt = (await env.currentTimeMs()) + 14 * DAY;
      const result = await run(taskQueue, { revokeAccessAt: new Date(revokeAt).toISOString() });

      expect(result.status).toBe('COMPLETED');
      expect(Object.values(result.steps).every((s) => s === 'done')).toBe(true);
      expect(Math.min(...mocks.calls.map((c) => c.scheduledAtMs))).toBeGreaterThanOrEqual(revokeAt);

      const names = mocks.names();
      const access = ['deactivateEmailAccount', 'deactivateSlackAccount', 'revokeGithubAccess'] as const;
      expect(new Set(names.slice(0, 3))).toEqual(new Set(access));
      expect(new Set(names.slice(3, 5))).toEqual(new Set(['removeFromPayroll', 'requestLaptopReturn']));
      expect(names[5]).toBe('archiveHrRecord');
      // The signed contract is kept on record, not voided.
      expect(names).not.toContain('voidContract');
      expect(mocks.find('deactivateEmailAccount')!.args).toEqual(['E1', 'ana.lopez@company.com']);
    });
  });

  test('only tears down what onboarding created', async () => {
    const mocks = mockActivities();
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { github: _github, ...salesResources } = ENGINEER_RESOURCES;
      const result = await run(taskQueue, { resources: salesResources });
      expect(result.steps.github).toBeUndefined();
      expect(mocks.names()).not.toContain('revokeGithubAccess');
    });
  });

  test('a step that keeps failing is escalated; everything else still completes', async () => {
    const mocks = mockActivities({
      deactivateSlackAccount: async () => {
        throw ApplicationFailure.nonRetryable('Slack admin API down');
      },
    });
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const result = await run(taskQueue);
      expect(result.status).toBe('COMPLETED_WITH_ERRORS');
      expect(result.steps.slack).toBe('failed');
      expect(result.steps.hrRecord).toBe('done');
      expect(mocks.find('escalateToHr')!.args[1]).toMatch(/Manual action needed for: slack/);
    });
  });
});
