// onboardingWorkflow against Temporal's time-skipping test server. Real default
// timings are used (3 days, 7 days, weeks until the start date); the server
// skips ahead whenever the workflow is only waiting on a timer.

import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { WorkflowBundleWithSourceMap } from '@temporalio/worker';
import {
  OnboardingProgress,
  cancelOnboardingSignal,
  contractSignedSignal,
  progressQuery,
  updateStartDateSignal,
} from '../src/shared';
import type { onboardingWorkflow } from '../src/workflows';
import { ActivityName, DAY, createTestEnv, eventually, mockActivities, newHire, runWithWorker } from './helpers';

jest.setTimeout(60_000);

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
  ({ env, bundle } = await createTestEnv());
});

afterAll(async () => {
  await env?.teardown();
});

const UNDO: Partial<Record<ActivityName, ActivityName>> = {
  createHrRecord: 'archiveHrRecord',
  sendContract: 'voidContract',
  createEmailAccount: 'deactivateEmailAccount',
  createSlackAccount: 'deactivateSlackAccount',
  grantGithubAccess: 'revokeGithubAccess',
  orderLaptop: 'cancelLaptopOrder',
  enrollInPayroll: 'removeFromPayroll',
};
const UNDO_NAMES = new Set(Object.values(UNDO));

async function start(taskQueue: string, startInDays = 28, overrides = {}) {
  const hire = newHire((await env.currentTimeMs()) + startInDays * DAY, overrides);
  const handle = await env.client.workflow.start<typeof onboardingWorkflow>('onboardingWorkflow', {
    taskQueue,
    workflowId: `onboarding-${hire.employeeId}`,
    args: [hire],
  });
  const progress = () => handle.query(progressQuery);
  const until = (check: (p: OnboardingProgress) => boolean) => eventually(progress, check);
  return { hire, handle, progress, until };
}

describe('onboardingWorkflow', () => {
  test('happy path: provisions everything and sends the welcome email one day before the start date', async () => {
    const mocks = mockActivities({ createEmailAccount: async () => 'ana.lopez@company.com' });

    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { hire, handle } = await start(taskQueue, 28);
      await handle.signal(contractSignedSignal);
      const result = await handle.result(); // skips the 4-week wait

      expect(result.status).toBe('COMPLETED');
      expect(Object.values(result.steps).every((s) => s === 'done')).toBe(true);
      expect(result.resources.email).toBe('ana.lopez@company.com');

      const names = mocks.names();
      expect(names.slice(0, 2)).toEqual(['createHrRecord', 'sendContract']);
      expect(names.slice(-2)).toEqual(['sendWelcomeEmail', 'activateEmployee']);
      expect(names).toEqual(
        expect.arrayContaining(['createEmailAccount', 'createSlackAccount', 'grantGithubAccess', 'orderLaptop', 'enrollInPayroll']),
      );
      expect(names).not.toContain('sendContractReminder');
      expect(names.filter((n) => UNDO_NAMES.has(n))).toEqual([]);

      const welcome = mocks.find('sendWelcomeEmail')!;
      expect(welcome.args[1]).toBe('ana.lopez@company.com');
      expect(Math.abs(welcome.scheduledAtMs - (Date.parse(hire.startDate) - DAY))).toBeLessThan(60_000);
    });
  });

  test('non-engineers get no GitHub access', async () => {
    const mocks = mockActivities();
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { handle } = await start(taskQueue, 7, { role: 'sales' });
      await handle.signal(contractSignedSignal);
      const result = await handle.result();
      expect(result.steps.github).toBeUndefined();
      expect(mocks.names()).not.toContain('grantGithubAccess');
    });
  });

  test('unsigned contract: reminder after 3 days, HR escalation after 7, provisioning only once signed', async () => {
    const mocks = mockActivities();
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { handle, until } = await start(taskQueue);
      await until((p) => p.contract.sentAt !== null);

      await env.sleep('3 days');
      const afterReminder = await until((p) => p.contract.remindersSent === 1);
      expect(afterReminder.contract.escalatedAt).toBeNull();

      await env.sleep('4 days');
      const afterEscalation = await until((p) => p.contract.escalatedAt !== null);
      expect(afterEscalation.status).toBe('AWAITING_CONTRACT');
      expect(mocks.find('escalateToHr')!.args[1]).toMatch(/unsigned/);
      expect(mocks.names()).not.toContain('createEmailAccount');

      await handle.signal(contractSignedSignal);
      const result = await handle.result();
      expect(result.status).toBe('COMPLETED');
      expect(result.contract.remindersSent).toBe(1);
    });
  });

  test('signing twice keeps the original signature time', async () => {
    const mocks = mockActivities();
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { handle, until } = await start(taskQueue);
      await handle.signal(contractSignedSignal);
      const first = (await until((p) => p.contract.signedAt !== null)).contract.signedAt;
      await env.sleep('1 hour');
      await handle.signal(contractSignedSignal);
      const result = await handle.result();
      expect(result.contract.signedAt).toBe(first);
    });
  });

  test('changing the start date reschedules the welcome email and notifies the laptop vendor', async () => {
    const mocks = mockActivities();
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { hire, handle, until } = await start(taskQueue, 28);
      await handle.signal(contractSignedSignal);
      await until((p) => p.status === 'AWAITING_START_DATE');

      const newStart = new Date(Date.parse(hire.startDate) + 14 * DAY).toISOString();
      await handle.signal(updateStartDateSignal, newStart);
      const result = await handle.result();

      expect(result.startDate).toBe(newStart);
      const notify = mocks.find('notifyStartDateChanged')!;
      expect(notify.args.slice(1)).toEqual([newStart, 'orderLaptop-result']);
      const welcome = mocks.find('sendWelcomeEmail')!;
      expect(Math.abs(welcome.scheduledAtMs - (Date.parse(newStart) - DAY))).toBeLessThan(60_000);
    });
  });

  test('transient failures are retried with backoff', async () => {
    let attempts = 0;
    const mocks = mockActivities({
      grantGithubAccess: async () => {
        if (++attempts < 3) throw new Error('GitHub is temporarily unavailable');
        return 'gh-invite-1';
      },
    });
    await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
      const { handle } = await start(taskQueue);
      await handle.signal(contractSignedSignal);
      const result = await handle.result();
      expect(result.status).toBe('COMPLETED');
      expect(attempts).toBe(3);
    });
  });

  describe('saga', () => {
    test('cancel while awaiting the signature: voids the contract, archives the HR record, nothing else', async () => {
      const mocks = mockActivities();
      await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
        const { handle, until } = await start(taskQueue);
        await until((p) => p.contract.sentAt !== null);
        await handle.signal(cancelOnboardingSignal, 'Accepted another offer');
        const result = await handle.result(); // a business cancel completes normally

        expect(result.status).toBe('CANCELLED');
        expect(result.cancellation?.reason).toBe('Accepted another offer');
        expect(result.steps).toMatchObject({ hrRecord: 'compensated', contract: 'compensated', email: 'pending' });
        expect(mocks.names().filter((n) => UNDO_NAMES.has(n))).toEqual(['voidContract', 'archiveHrRecord']);
        expect(mocks.names()).not.toContain('escalateToHr');
      });
    });

    test('cancel while awaiting the start date: undoes every step, in reverse order', async () => {
      const mocks = mockActivities();
      await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
        const { handle, until } = await start(taskQueue);
        await handle.signal(contractSignedSignal);
        await until((p) => p.status === 'AWAITING_START_DATE');
        await handle.signal(cancelOnboardingSignal, 'Offer withdrawn');
        const result = await handle.result();

        expect(result.status).toBe('CANCELLED');
        const forward = mocks.names().filter((n) => UNDO[n]);
        const undone = mocks.names().filter((n) => UNDO_NAMES.has(n));
        expect(new Set(undone)).toEqual(new Set(forward.map((n) => UNDO[n])));
        // The sequential steps came first, so they are undone last, in reverse.
        expect(undone.slice(-2)).toEqual(['voidContract', 'archiveHrRecord']);
        expect(mocks.names()).not.toContain('sendWelcomeEmail');
      });
    });

    test('cancel during provisioning: in-flight calls finish first, then are compensated too', async () => {
      let releaseEmail!: () => void;
      const emailGate = new Promise<void>((resolve) => (releaseEmail = resolve));
      const mocks = mockActivities({
        createEmailAccount: async () => {
          await emailGate;
          return 'ana.lopez@company.com';
        },
      });
      await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
        const { handle, until } = await start(taskQueue);
        await handle.signal(contractSignedSignal);
        await until((p) => p.steps.email === 'running' && p.steps.slack === 'done');

        await handle.signal(cancelOnboardingSignal, 'Duplicate hire record');
        releaseEmail(); // the vendor call that was in flight succeeds after the cancel
        const result = await handle.result();

        expect(result.status).toBe('CANCELLED');
        expect(result.steps.email).toBe('compensated');
        expect(mocks.find('deactivateEmailAccount')!.args).toEqual([expect.any(String), 'ana.lopez@company.com']);
      });
    });

    test('a step that exhausts its retries rolls back everything else and escalates', async () => {
      const mocks = mockActivities({
        grantGithubAccess: async () => {
          throw ApplicationFailure.nonRetryable('GitHub org is suspended');
        },
      });
      await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
        const { handle, progress } = await start(taskQueue);
        await handle.signal(contractSignedSignal);

        const error = await handle.result().catch((err) => err);
        expect(error).toBeInstanceOf(WorkflowFailedError);
        expect(error.cause.message).toBe('Provisioning failed for: github');

        const final = await progress();
        expect(final.status).toBe('FAILED');
        expect(final.steps.github).toBe('failed');
        expect(final.steps.email).toBe('compensated');
        expect(mocks.names()).not.toContain('revokeGithubAccess');
        expect(mocks.find('escalateToHr')!.args[1]).toMatch(/All completed steps were rolled back/);
      });
    });

    test('a compensation that keeps failing is escalated, and the rest still run', async () => {
      const mocks = mockActivities({
        deactivateSlackAccount: async () => {
          throw ApplicationFailure.nonRetryable('Slack admin API down');
        },
      });
      await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
        const { handle, until } = await start(taskQueue);
        await handle.signal(contractSignedSignal);
        await until((p) => p.status === 'AWAITING_START_DATE');
        await handle.signal(cancelOnboardingSignal, 'Offer withdrawn');
        const result = await handle.result();

        expect(result.status).toBe('CANCELLED');
        expect(result.steps.slack).toBe('compensation_failed');
        expect(result.steps.hrRecord).toBe('compensated');
        expect(mocks.find('escalateToHr')!.args[1]).toMatch(/Manual cleanup needed for: slack/);
      });
    });

    test('a cancel issued through Temporal still runs the full rollback', async () => {
      const mocks = mockActivities();
      await runWithWorker(env, bundle, mocks.activities, async (taskQueue) => {
        const { handle, until, progress } = await start(taskQueue);
        await until((p) => p.contract.sentAt !== null);
        await handle.cancel();

        const error = await handle.result().catch((err) => err);
        expect(error).toBeInstanceOf(WorkflowFailedError);
        expect(error.cause).toBeInstanceOf(CancelledFailure);
        expect((await progress()).status).toBe('CANCELLED');
        expect(mocks.names().filter((n) => UNDO_NAMES.has(n))).toEqual(['voidContract', 'archiveHrRecord']);
      });
    });
  });
});
