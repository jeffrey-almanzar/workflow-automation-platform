// Worker process: connects to Temporal, registers on a task queue, and
// executes the workflow/activity code whenever Temporal assigns it work.
// Runs as a separate process from the NestJS API (see docker-compose.yml, "worker" service).

import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { migrate } from './db';
import { TASK_QUEUE } from './shared';

async function run() {
  // Must run before any connection is created. Exposes the SDK's metrics
  // (activity latency, failures, task-queue lag, ...) plus our custom counters.
  Runtime.install({
    telemetryOptions: {
      metrics: {
        prometheus: {
          bindAddress: process.env.METRICS_BIND_ADDRESS ?? '0.0.0.0:9464',
          countersTotalSuffix: true,
          // The default buckets (50ms, 100ms, 500ms, 1s, ...) are too coarse for useful percentiles.
          histogramBucketOverrides: Object.fromEntries(
            [
              'activity_execution_latency',
              'activity_schedule_to_start_latency',
              'workflow_task_schedule_to_start_latency',
              'workflow_task_execution_latency',
            ].map((name) => [name, [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]]),
          ),
        },
      },
    },
  });
  await migrate();

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal:7233',
  });

  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: TASK_QUEUE,
    // Cached workflows are kept in memory between tasks. Cap it on small hosts
    // (e.g. a 1 GB instance); the default scales with available heap.
    ...(process.env.WORKER_MAX_CACHED_WORKFLOWS && {
      maxCachedWorkflows: Number(process.env.WORKER_MAX_CACHED_WORKFLOWS),
    }),
  });

  console.log(`Worker listening on task queue "${TASK_QUEUE}"...`);
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
