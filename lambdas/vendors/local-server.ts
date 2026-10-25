// Local stand-in for the AWS Lambda Invoke API, used only by docker-compose.
// The Lambda Runtime Interface Emulator bundled in the base image handles one
// invocation at a time and crashes on concurrent ones, while real Lambda scales
// out to more instances. Parallel provisioning needs concurrency, so locally this
// server exposes the same Invoke endpoint and calls the same handler in-process.
// The AWS SDK in the worker talks to it unchanged.
//
// It also forks LOCAL_LAMBDA_PROCESSES processes sharing the port, the local
// stand-in for Lambda running more instances under load. A single Node process
// saturated one core and became the bottleneck in load tests.

import cluster from 'cluster';
import { createServer } from 'http';
import { handler } from './index';

const INVOKE_PATH = /^\/2015-03-31\/functions\/[^/]+\/invocations$/;
const PROCESSES = Number(process.env.LOCAL_LAMBDA_PROCESSES ?? 4);

if (cluster.isPrimary && PROCESSES > 1) {
  for (let i = 0; i < PROCESSES; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    console.error(`Lambda process ${worker.process.pid} exited (${code}); restarting`);
    cluster.fork();
  });
} else {
  serve();
}

function serve(): void {
  createServer(async (req, res) => {
    if (req.method !== 'POST' || !INVOKE_PATH.test(req.url ?? '')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const result = await handler(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      // Same contract as Lambda: HTTP 200, error flagged in a header and the payload.
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(JSON.stringify({ msg: 'invocation failed', error: error.message }));
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'X-Amz-Function-Error': 'Unhandled' })
        .end(JSON.stringify({ errorType: error.name, errorMessage: error.message }));
    }
  }).listen(8080, () => console.log(`Local Lambda Invoke API listening on :8080 (pid ${process.pid})`));
}
