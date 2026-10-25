// Records workflow histories into test/histories/ for the replay test.
// Run with `npm run test:record-histories` when you intentionally ship a new
// workflow version, and keep the old files: they stand for workflows that may
// still be in flight in production, which the new code must be able to replay.

import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { contractSignedSignal, cancelOnboardingSignal, progressQuery } from '../src/shared';
import type { onboardingWorkflow } from '../src/workflows';
import { DAY, createTestEnv, eventually, mockActivities, newHire, runWithWorker } from './helpers';

const OUT_DIR = join(__dirname, 'histories');

async function main() {
  const { env, bundle } = await createTestEnv();
  mkdirSync(OUT_DIR, { recursive: true });
  const version = process.argv[2] ?? 'v1';

  const scenarios: Record<string, (taskQueue: string) => Promise<string>> = {
    // Reminder, escalation, signature, provisioning, start-date wait, welcome.
    'onboarding-completed': async (taskQueue) => {
      const hire = newHire((await env.currentTimeMs()) + 28 * DAY, { employeeId: 'R1' });
      const handle = await env.client.workflow.start<typeof onboardingWorkflow>('onboardingWorkflow', {
        taskQueue,
        workflowId: 'onboarding-R1',
        args: [hire],
      });
      await eventually(() => handle.query(progressQuery), (p) => p.contract.sentAt !== null);
      await env.sleep('8 days');
      await eventually(() => handle.query(progressQuery), (p) => p.contract.escalatedAt !== null);
      await handle.signal(contractSignedSignal);
      await handle.result();
      return historyToJSON(await handle.fetchHistory());
    },
    // Full saga rollback after provisioning.
    'onboarding-cancelled': async (taskQueue) => {
      const hire = newHire((await env.currentTimeMs()) + 28 * DAY, { employeeId: 'R2' });
      const handle = await env.client.workflow.start<typeof onboardingWorkflow>('onboardingWorkflow', {
        taskQueue,
        workflowId: 'onboarding-R2',
        args: [hire],
      });
      await handle.signal(contractSignedSignal);
      await eventually(() => handle.query(progressQuery), (p) => p.status === 'AWAITING_START_DATE');
      await handle.signal(cancelOnboardingSignal, 'Offer withdrawn');
      await handle.result();
      return historyToJSON(await handle.fetchHistory());
    },
  };

  for (const [name, scenario] of Object.entries(scenarios)) {
    const json = await runWithWorker(env, bundle, mockActivities().activities, scenario);
    const file = join(OUT_DIR, `${name}.${version}.json`);
    writeFileSync(file, json);
    console.log(`Recorded ${file}`);
  }
  await env.teardown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
