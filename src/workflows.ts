// Workflow definitions. This code runs inside Temporal's "workflow sandbox":
// it must be deterministic (no direct I/O, no raw Date.now(), etc.).
// To do real work, it delegates to activities via proxyActivities.
// (Date.now() / new Date() ARE safe here: the sandbox replaces them with the
// time recorded in history, so they return the same value on replay.)

import {
  ApplicationFailure,
  CancellationScope,
  condition,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';
import ms from 'ms';
import type * as activities from './activities';
import {
  Cancellation,
  ContractState,
  DEFAULT_TIMINGS,
  NewHire,
  OffboardingProgress,
  OffboardingRequest,
  OffboardingStatus,
  OffboardingStep,
  OnboardingProgress,
  OnboardingStatus,
  OnboardingTimings,
  StepName,
  StepStatus,
  cancelOnboardingSignal,
  contractSignedSignal,
  offboardingProgressQuery,
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

// Undo operations get far more patience than forward steps: giving up on an undo
// means leaving access or money behind. ~10 attempts over several minutes, after
// which a human is asked to finish the cleanup.
const undo = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 10,
  },
});

// Thrown internally when the cancel signal is noticed; never leaves the workflow.
class CancelRequested extends Error {}

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
  let cancellation: Cancellation | null = null;
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
  // Steps whose side effect happened, in the order they completed. The saga undoes them in reverse.
  const completed: StepName[] = [];

  // How to undo each step, given the resource ID it produced. The welcome email
  // has no entry: it can't be unsent, which is why it is the very last step.
  const compensations: Partial<Record<StepName, (resourceId: string) => Promise<void>>> = {
    hrRecord: (id) => undo.archiveHrRecord(hire.employeeId, id),
    contract: (id) => undo.voidContract(hire.employeeId, id),
    email: (id) => undo.deactivateEmailAccount(hire.employeeId, id),
    slack: (id) => undo.deactivateSlackAccount(hire.employeeId, id),
    github: (id) => undo.revokeGithubAccess(hire.employeeId, id),
    laptop: (id) => undo.cancelLaptopOrder(hire.employeeId, id),
    payroll: (id) => undo.removeFromPayroll(hire.employeeId, id),
  };

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
      cancellation,
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
  setHandler(cancelOnboardingSignal, (reason) => {
    cancellation ??= { requestedAt: new Date().toISOString(), reason };
  });

  // Cancellation is checked between phases rather than by interrupting in-flight
  // activities: a cancelled call that actually succeeded at the vendor would leave
  // an account the saga doesn't know about. Waits, however, end immediately.
  const checkpoint = () => {
    if (cancellation) throw new CancelRequested();
  };
  async function waitFor(predicate: () => boolean, timeout?: Duration): Promise<boolean> {
    const wake = () => predicate() || cancellation !== null;
    const satisfied = timeout === undefined ? (await condition(wake), true) : await condition(wake, timeout);
    checkpoint();
    return satisfied;
  }

  // `afterwards` runs once the side effect exists (and is registered for
  // compensation) but before the step counts as done, e.g. awaiting a signature.
  async function runStep(
    name: StepName,
    activity: () => Promise<string>,
    afterwards?: () => Promise<void>,
  ): Promise<void> {
    steps[name] = 'running';
    try {
      resources[name] = await activity();
      completed.push(name);
      await afterwards?.();
      steps[name] = 'done';
    } catch (err) {
      // If the side effect already happened, the saga will update this step's status.
      if (!completed.includes(name)) steps[name] = 'failed';
      throw err;
    }
  }

  async function compensate(): Promise<StepName[]> {
    const failures: StepName[] = [];
    for (const name of [...completed].reverse()) {
      const undoStep = compensations[name];
      if (!undoStep) continue;
      steps[name] = 'compensating';
      try {
        await undoStep(resources[name]!);
        steps[name] = 'compensated';
      } catch {
        // Keep going: one stuck undo must not block cleaning up everything else.
        steps[name] = 'compensation_failed';
        failures.push(name);
      }
    }
    return failures;
  }

  try {
    // Everything else depends on the employee existing in the HR system.
    await runStep('hrRecord', () => acts.createHrRecord(hire));
    checkpoint();

    // Nothing gets provisioned until the contract is signed. A pending
    // condition() costs nothing: no thread or poller is held while we wait.
    await runStep(
      'contract',
      () => acts.sendContract(hire),
      async () => {
        contract.sentAt = new Date().toISOString();
        const signed = () => contract.signedAt !== null;

        if (!(await waitFor(signed, t.contractReminderDelay))) {
          await acts.sendContractReminder(hire);
          contract.remindersSent++;

          if (!(await waitFor(signed, t.contractEscalationDelay))) {
            await acts.escalateToHr(hire.employeeId, 'Contract still unsigned after reminder');
            contract.escalatedAt = new Date().toISOString();
            await waitFor(signed); // HR follows up; keep waiting without a deadline
          }
        }
      },
    );
    checkpoint();

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

    // allSettled (not all) so every in-flight call finishes and is accounted for
    // before we decide to roll back. Otherwise a late success could go uncompensated.
    const results = await Promise.allSettled(provisioning.map(([name, fn]) => runStep(name, fn)));
    checkpoint();
    const failed = provisioning.filter((_, i) => results[i].status === 'rejected').map(([name]) => name);
    if (failed.length > 0) {
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
      if (!(await waitFor(() => startDateChanged, remaining))) break;
    }

    await runStep('welcome', () => acts.sendWelcomeEmail({ ...hire, startDate }, resources.email!));
    checkpoint();

    status = 'COMPLETED';
    return progress();
  } catch (err) {
    // Either path lands here: a cancel (our signal, or a cancel issued through
    // Temporal itself) or a step that exhausted its retries. Both run the saga.
    const cancelled = err instanceof CancelRequested || isCancellation(err);
    status = 'COMPENSATING';

    // nonCancellable: if the workflow itself was cancelled through Temporal, the
    // cleanup must still run to completion instead of being cancelled too.
    await CancellationScope.nonCancellable(async () => {
      const failures = await compensate();
      const cause = cancelled
        ? `Onboarding cancelled (${cancellation?.reason ?? 'cancelled through Temporal'})`
        : `Onboarding failed (${err instanceof Error ? err.message : String(err)})`;
      if (failures.length > 0) {
        await undo.escalateToHr(hire.employeeId, `${cause}. Manual cleanup needed for: ${failures.join(', ')}`);
      } else if (!cancelled) {
        await undo.escalateToHr(hire.employeeId, `${cause}. All completed steps were rolled back.`);
      }
    });

    if (cancelled) {
      status = 'CANCELLED';
      // A cancel through Temporal should show as Cancelled there; a business
      // cancel is a normal outcome, so the workflow completes with its final state.
      if (isCancellation(err)) throw err;
      return progress();
    }
    status = 'FAILED';
    throw err;
  }
}

// Offboarding reuses the onboarding's undo activities: tearing down an employee
// is the same set of operations as rolling back a cancelled hire.
export async function offboardingWorkflow(req: OffboardingRequest): Promise<OffboardingProgress> {
  const { employeeId, resources } = req;
  const revokeAccessAt = req.revokeAccessAt ?? new Date().toISOString();
  let status: OffboardingStatus = 'SCHEDULED';

  const actions: Record<OffboardingStep, (id: string) => Promise<void>> = {
    email: (id) => undo.deactivateEmailAccount(employeeId, id),
    slack: (id) => undo.deactivateSlackAccount(employeeId, id),
    github: (id) => undo.revokeGithubAccess(employeeId, id),
    payroll: (id) => undo.removeFromPayroll(employeeId, id),
    laptop: (id) => undo.requestLaptopReturn(employeeId, id),
    hrRecord: (id) => undo.archiveHrRecord(employeeId, id),
  };
  // Only tear down what onboarding actually created (e.g. no GitHub for sales).
  const steps: Partial<Record<OffboardingStep, StepStatus>> = {};
  for (const name of Object.keys(actions) as OffboardingStep[]) {
    if (resources[name]) steps[name] = 'pending';
  }

  setHandler(offboardingProgressQuery, () => ({ status, revokeAccessAt, steps: { ...steps } }));

  const failures: OffboardingStep[] = [];
  async function runPhase(names: OffboardingStep[]): Promise<void> {
    await Promise.all(
      names
        .filter((name) => steps[name])
        .map(async (name) => {
          steps[name] = 'running';
          try {
            await actions[name](resources[name]!);
            steps[name] = 'done';
          } catch {
            steps[name] = 'failed';
            failures.push(name);
          }
        }),
    );
  }

  const wait = Date.parse(revokeAccessAt) - Date.now();
  if (wait > 0) await sleep(wait);

  status = 'REVOKING_ACCESS';
  await runPhase(['email', 'slack', 'github']); // security-critical: cut access first, in parallel
  await runPhase(['payroll', 'laptop']);
  await runPhase(['hrRecord']); // archive last, once everything else is settled

  if (failures.length > 0) {
    // Lingering access is a security issue, so a human must finish the job.
    await undo.escalateToHr(
      employeeId,
      `Offboarding (${req.reason}) incomplete. Manual action needed for: ${failures.join(', ')}`,
    );
    status = 'COMPLETED_WITH_ERRORS';
  } else {
    status = 'COMPLETED';
  }
  return { status, revokeAccessAt, steps: { ...steps } };
}
