// Worker process: connects to Temporal, registers on a task queue, and
// executes the workflow/activity code whenever Temporal assigns it work.
// Runs as a separate process from the NestJS API (see docker-compose.yml, "worker" service).

import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });

  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: 'exampleTaskQueue',
  });

  console.log('Worker listening on task queue "exampleTaskQueue"...');
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
