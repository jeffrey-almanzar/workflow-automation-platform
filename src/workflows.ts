// Workflow definition. This code runs inside Temporal's "workflow sandbox":
// it must be deterministic (no direct I/O, no raw Date.now(), etc.).
// To do real work, it delegates to activities via proxyActivities.

import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
});

export async function exampleWorkflow(name = 'world'): Promise<string> {
  const result = await greet(name);
  return result;
}
