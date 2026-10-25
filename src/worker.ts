// Worker process: connects to Temporal, registers on a task queue, and
// executes the workflow/activity code whenever Temporal assigns it work.
// Runs as a separate process from the NestJS API (see docker-compose.yml, "worker" service).

import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { migrate } from './db';
import { TASK_QUEUE } from './shared';

async function run() {
  await migrate();

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });

  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: TASK_QUEUE,
  });

  console.log(`Worker listening on task queue "${TASK_QUEUE}"...`);
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
