// Workflow definition. This code runs inside Temporal's "workflow sandbox":
// it must be deterministic (no direct I/O, no raw Date.now(), etc.).
// To do real work, it delegates to activities via proxyActivities.
// (Date.now() / new Date() ARE safe here: the sandbox replaces them with the
// time recorded in history, so they return the same value on replay.)

import { ApplicationFailure, condition, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';
import ms from 'ms';
import type * as activities from './activities';
import {
  ContractState,
  DEFAULT_TIMINGS,
  NewHire,
  OnboardingProgress,
  OnboardingStatus,
  OnboardingTimings,
  StepName,
  StepStatus,
  contractSignedSignal,
  progressQuery,
  updateStartDateSignal,
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

export async function onboardingWorkflow(
  hire: NewHire,
  timings: Partial<OnboardingTimings> = {},
): Promise<OnboardingProgress> {
  const t: OnboardingTimings = { ...DEFAULT_TIMINGS, ...timings };

  // Workflow state lives in plain variables. Temporal rebuilds it by replaying
  // history, so it survives worker crashes without being stored anywhere else.
  let status: OnboardingStatus = 'AWAITING_CONTRACT';
  let startDate = hire.startDate;
  let startDateChanged = false;
  const contract: ContractState = { sentAt: null, signedAt: null, remindersSent: 0, escalatedAt: null };
  const steps: Partial<Record<StepName, StepStatus>> = {
    hrRecord: 'pending',
    contract: 'pending',
    email: 'pending',
    slack: 'pending',
    laptop: 'pending',
    payroll: 'pending',
  };
  if (hire.role === 'engineer') steps.github = 'pending';
  steps.welcome = 'pending';
  const resources: Partial<Record<StepName, string>> = {};

  const toMs = (d: Duration) => (typeof d === 'number' ? d : ms(d));
  const welcomeEmailAt = () => new Date(Date.parse(startDate) - toMs(t.welcomeLeadTime));

  const progress = (): OnboardingProgress => {
    const all = Object.values(steps);
    const done = all.filter((s) => s === 'done').length;
    return {
      status,
      percentComplete: Math.round((done / all.length) * 100),
      startDate,
      welcomeEmailAt: welcomeEmailAt().toISOString(),
      contract: { ...contract },
      steps: { ...steps },
      resources: { ...resources },
    };
  };

  // Handlers only record the event; the main flow below decides what to do with it.
  setHandler(progressQuery, progress);
  setHandler(contractSignedSignal, () => {
    // Idempotent: signing twice keeps the original timestamp.
    contract.signedAt ??= new Date().toISOString();
  });
  setHandler(updateStartDateSignal, (newStartDate) => {
    if (newStartDate === startDate) return;
    startDate = newStartDate;
    startDateChanged = true;
  });

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

    // Nothing gets provisioned until the contract is signed. A pending
    // condition() costs nothing: no thread or poller is held while we wait.
    await runStep('contract', async () => {
      const envelopeId = await acts.sendContract(hire);
      contract.sentAt = new Date().toISOString();
      const signed = () => contract.signedAt !== null;

      if (!(await condition(signed, t.contractReminderDelay))) {
        await acts.sendContractReminder(hire);
        contract.remindersSent++;

        if (!(await condition(signed, t.contractEscalationDelay))) {
          await acts.escalateToHr(hire, 'Contract still unsigned after reminder');
          contract.escalatedAt = new Date().toISOString();
          await condition(signed); // HR follows up; keep waiting without a deadline
        }
      }
      return envelopeId;
    });

    // The remaining systems are independent, so they are provisioned in parallel.
    status = 'PROVISIONING';
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

    // Sleep until the welcome email is due. The wait may be weeks long; if the
    // start date changes meanwhile, the timer is recomputed from the new date.
    status = 'AWAITING_START_DATE';
    for (;;) {
      if (startDateChanged) {
        startDateChanged = false;
        await acts.notifyStartDateChanged(hire, startDate);
      }
      const remaining = welcomeEmailAt().getTime() - Date.now();
      if (remaining <= 0) break;
      if (!(await condition(() => startDateChanged, remaining))) break;
    }

    await runStep('welcome', () => acts.sendWelcomeEmail({ ...hire, startDate }, resources.email!));

    status = 'COMPLETED';
    return progress();
  } catch (err) {
    status = 'FAILED';
    throw err;
  }
}
