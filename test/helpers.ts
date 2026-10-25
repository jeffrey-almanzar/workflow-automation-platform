// Shared helpers for workflow tests: a time-skipping Temporal environment, a
// pre-built workflow bundle, and recording mock activities.

import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker, WorkflowBundleWithSourceMap, bundleWorkflowCode } from '@temporalio/worker';
import { randomUUID } from 'crypto';
import * as realActivities from '../src/activities';
import type { NewHire } from '../src/shared';

export const DAY = 24 * 60 * 60 * 1000;

export type Activities = typeof realActivities;
export type ActivityName = keyof Activities;
type Impl = (...args: any[]) => Promise<unknown>;

export interface Call {
  name: ActivityName;
  args: unknown[];
  // Workflow-clock time the attempt was scheduled at. With time skipping this is
  // the "virtual" time (e.g. 4 weeks later), not the wall clock.
  scheduledAtMs: number;
}

try {
  Runtime.install({
    logger: new DefaultLogger('ERROR'),
    telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } },
  });
} catch {
  // Already installed by another test file in this process.
}

export async function createTestEnv(): Promise<{ env: TestWorkflowEnvironment; bundle: WorkflowBundleWithSourceMap }> {
  // The bundle is built once per file; each test then gets a fresh worker with its own mocks.
  const [env, bundle] = await Promise.all([
    TestWorkflowEnvironment.createTimeSkipping(),
    bundleWorkflowCode({ workflowsPath: require.resolve('../src/workflows'), logger: new DefaultLogger('ERROR') }),
  ]);
  return { env, bundle };
}

// Every activity is mocked: each call is recorded, then delegated to an override
// or answered with a placeholder ID. The list of names comes from the real module,
// so a new activity can't be forgotten here.
export function mockActivities(overrides: Partial<Record<ActivityName, Impl>> = {}) {
  const calls: Call[] = [];
  const impl: Record<string, Impl> = {};
  for (const name of Object.keys(realActivities) as ActivityName[]) {
    impl[name] = async (...args: unknown[]) => {
      calls.push({ name, args, scheduledAtMs: Context.current().info.currentAttemptScheduledTimestampMs });
      const override = overrides[name];
      return override ? override(...args) : `${name}-result`;
    };
  }
  return {
    activities: impl as unknown as Activities,
    calls,
    names: () => calls.map((call) => call.name),
    find: (name: ActivityName) => calls.find((call) => call.name === name),
  };
}

export async function runWithWorker<T>(
  env: TestWorkflowEnvironment,
  bundle: WorkflowBundleWithSourceMap,
  activities: Activities,
  fn: (taskQueue: string) => Promise<T>,
): Promise<T> {
  // A unique task queue per test keeps tests from picking up each other's work.
  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities });
  return worker.runUntil(fn(taskQueue));
}

// Polls (in real time) until the assertion passes. Used to wait for the workflow
// to reach a state before sending a signal or skipping time.
export async function eventually<T>(fn: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function newHire(startDateMs: number, overrides: Partial<NewHire> = {}): NewHire {
  return {
    employeeId: `E-${randomUUID().slice(0, 8)}`,
    fullName: 'Ana López',
    personalEmail: 'ana@example.com',
    role: 'engineer',
    startDate: new Date(startDateMs).toISOString(),
    ...overrides,
  };
}
