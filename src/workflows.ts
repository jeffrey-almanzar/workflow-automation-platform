// Workflow definition. This code runs inside Temporal's "workflow sandbox":
// it must be deterministic (no direct I/O, no raw Date.now(), etc.).
// To do real work, it delegates to activities via proxyActivities.

import { ApplicationFailure, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './activities';
import {
  NewHire,
  OnboardingProgress,
  OnboardingStatus,
  StepName,
  StepStatus,
  progressQuery,
} from './shared';

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  // Transient failures (vendor down, timeouts) are retried with exponential
  // backoff: 1s, 2s, 4s, 8s. After 5 attempts the step is marked as failed.
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

export async function onboardingWorkflow(hire: NewHire): Promise<OnboardingProgress> {
  // Workflow state lives in plain variables. Temporal rebuilds it by replaying
  // history, so it survives worker crashes without being stored anywhere else.
  let status: OnboardingStatus = 'PROVISIONING';
  const steps: Partial<Record<StepName, StepStatus>> = {
    hrRecord: 'pending',
    email: 'pending',
    slack: 'pending',
    laptop: 'pending',
    payroll: 'pending',
  };
  if (hire.role === 'engineer') steps.github = 'pending';
  const resources: Partial<Record<StepName, string>> = {};

  const progress = (): OnboardingProgress => {
    const all = Object.values(steps);
    const done = all.filter((s) => s === 'done').length;
    return {
      status,
      percentComplete: Math.round((done / all.length) * 100),
      steps: { ...steps },
      resources: { ...resources },
    };
  };
  setHandler(progressQuery, progress);

  async function runStep(name: StepName, activity: () => Promise<string>): Promise<void> {
    steps[name] = 'running';
    try {
      resources[name] = await activity();
      steps[name] = 'done';
    } catch (err) {
      steps[name] = 'failed';
      throw err;
    }
  }

  try {
    // Everything else depends on the employee existing in the HR system.
    await runStep('hrRecord', () => acts.createHrRecord(hire));

    // The remaining systems are independent, so they are provisioned in parallel.
    const provisioning: [StepName, () => Promise<string>][] = [
      ['email', () => acts.createEmailAccount(hire)],
      ['slack', () => acts.createSlackAccount(hire)],
      ['laptop', () => acts.orderLaptop(hire)],
      ['payroll', () => acts.enrollInPayroll(hire)],
    ];
    if (hire.role === 'engineer') {
      provisioning.push(['github', () => acts.grantGithubAccess(hire)]);
    }

    // allSettled (not all) so one failing system doesn't abandon the others mid-flight.
    const results = await Promise.allSettled(provisioning.map(([name, fn]) => runStep(name, fn)));
    const failed = provisioning.filter((_, i) => results[i].status === 'rejected').map(([name]) => name);
    if (failed.length > 0) {
      // TODO(increment 3): compensate the steps that succeeded (saga).
      throw ApplicationFailure.nonRetryable(
        `Provisioning failed for: ${failed.join(', ')}`,
        'ProvisioningFailed',
      );
    }

    status = 'COMPLETED';
    return progress();
  } catch (err) {
    status = 'FAILED';
    throw err;
  }
}
