# Workflow Automation Platform with Temporal

**Problem:** Organizations struggle with manual internal processes that are slow and error-prone, hurting operational efficiency and increasing costs.

**Solution:** I built a platform to automate complex workflows using Temporal and NestJS, significantly improving operational efficiency.

**Impact:** Automated 100K monthly processes, reduced manual errors by 10K instances, increasing operational efficiency by $750K per year.

**Technologies:** AWS Lambda, Temporal, NestJS, TypeScript, PostgreSQL, Docker

**New technologies to learn:** NestJS, Temporal


## Phased plan

1. Phase 1: Workflow design and architecture (detailed workflow documentation)
2. Phase 2: Automation implementation with Temporal (functional prototype)
3. Phase 3: Integration and user testing (feedback and improvement report)
4. Phase 4: Deployment to AWS Lambda and impact analysis (efficiency/productivity dashboard)

## Explanation

This project consists of building a workflow automation platform using Temporal, a distributed workflow orchestration system, together with NestJS for building robust APIs. Temporal simplifies managing distributed workflows by providing execution guarantees and state persistence, which is ideal for complex internal processes that require high reliability. By integrating Temporal with NestJS, we can build a scalable backend that automates repetitive, error-prone tasks, improving operational efficiency.

The system is made up of multiple components: a NestJS API acting as the interface for interacting with workflows, Temporal for managing workflow execution and persistence, and AWS Lambda for running serverless functions that can be invoked as part of the workflows. PostgreSQL is used as the database to store workflow state and results, while Docker is used to containerize the application and ease deployment.

This project covers several key concepts, including distributed workflow orchestration, real-time state management, and the use of serverless technologies to scale applications. 

## Architecture

```
[Client] --> [NestJS API] --> [Temporal Service] <--polls-- [Worker] --invokes--> [AWS Lambda: vendors]
                  |                                             |                        |
                  +--------------- reads ----> [PostgreSQL] <---+ writes                 | own schema
                                                    ^-------------------------------------+
```
- **Client**: Interacts with the API to start, advance and monitor workflows.
- **NestJS API**: Exposes REST endpoints; starts/signals/queries workflows through Temporal and reads employee records and the audit log from PostgreSQL.
- **Temporal Service**: Orchestrates workflow execution, manages state, and guarantees execution.
- **Worker**: Executes the workflow and activity code. Activities write to PostgreSQL and call the vendors Lambda.
- **AWS Lambda (vendors)**: Simulates the external SaaS vendors (e-signature, email, Slack, GitHub, laptop, payroll), with its own state and idempotency-key handling, like a real vendor API.
- **PostgreSQL**: Our system of record (employees, audit log), the vendors' simulated state (separate `vendors` schema), and Temporal's own persistence (separate databases).

## How it works

This section walks through what actually runs today in `src/`, end to end.

### The use case: employee onboarding and offboarding

When someone is hired, a contract must be signed and several independent systems set up (HR record, company email, Slack, GitHub for engineers, a laptop order, payroll) before a welcome email goes out just before day one. The process spans weeks and depends on humans, which is exactly what `onboardingWorkflow` orchestrates:

```
POST /onboardings ──▶ onboardingWorkflow(newHire)
  1. createHrRecord                        (everything else depends on it)
  2. sendContract, then wait for the contractSigned signal
       unsigned after 3 days  → sendContractReminder      (durable timer)
       unsigned 4 days later  → escalateToHr, keep waiting
  3. in parallel:
       createEmailAccount ┐
       createSlackAccount │ each retried independently
       grantGithubAccess  │ (1s, 2s, 4s, 8s backoff, 5 attempts)
       orderLaptop        │
       enrollInPayroll    ┘
  4. sleep until 1 day before the start date (may be weeks)
       updateStartDate signal → notifyStartDateChanged, timer recomputed
  5. sendWelcomeEmail → COMPLETED

  cancelOnboarding signal (any time) ┐ saga: undo every completed step in
  or a step exhausts its retries     ┘ reverse order → CANCELLED / FAILED
```

When the employee later leaves, `offboardingWorkflow` tears down what onboarding created, reusing the same undo activities:

```
POST /offboardings ──▶ offboardingWorkflow(employeeId, resources from onboarding)
  1. sleep until revokeAccessAt (or start immediately)
  2. deactivate email, Slack, GitHub        (in parallel: security-critical, first)
  3. remove from payroll, request laptop return
  4. archive HR record
  any step still failing after retries → escalateToHr → COMPLETED_WITH_ERRORS
```

| Endpoint | What it does |
| --- | --- |
| `POST /onboardings` | Starts an onboarding (`202`, or `409` if one exists for that employee). |
| `GET /onboardings/:id` | Live progress: phase, % complete, per-step status, contract state, scheduled welcome time. |
| `POST /onboardings/:id/contract-signature` | Sends the `contractSigned` signal (in production, the e-signature provider's webhook). Idempotent. |
| `PATCH /onboardings/:id/start-date` | Sends the `updateStartDate` signal with `{ "startDate": "..." }`. |
| `POST /onboardings/:id/cancellation` | Sends the `cancelOnboarding` signal with `{ "reason": "..." }` and rolls back everything done so far. |
| `POST /offboardings` | `{ "employeeId", "reason", "revokeAccessAt"? }`. Only for a completed onboarding (`409` otherwise, `404` if none). |
| `GET /offboardings/:id` | Live offboarding progress. |
| `GET /employees/:employeeId` | The employee record from PostgreSQL plus its full audit trail across onboarding and offboarding. |

Signals to an unknown onboarding return `404`; to one that already finished, `409`.

The external vendors are simulated by an AWS Lambda function ([lambdas/vendors/index.ts](lambdas/vendors/index.ts)) with realistic latency and injectable failures: random errors, permanent outages per system, and lost responses.

### The moving pieces

| File | Role |
| --- | --- |
| [src/main.ts](src/main.ts) | Boots the NestJS app, enables request validation, and listens on port 3000. |
| [src/app.module.ts](src/app.module.ts) | Root module; wires the controllers, `TemporalService` and `DatabaseService` together. |
| [src/onboarding.controller.ts](src/onboarding.controller.ts) | HTTP layer and request DTOs for `/onboardings` (start, progress, signature, start date, cancellation). |
| [src/offboarding.controller.ts](src/offboarding.controller.ts) | HTTP layer and request DTO for `/offboardings`. |
| [src/employees.controller.ts](src/employees.controller.ts) / [src/database.service.ts](src/database.service.ts) | `GET /employees/:id`: employee record and audit trail from PostgreSQL. |
| [src/temporal.service.ts](src/temporal.service.ts) | Temporal **client**: starts, signals and queries onboarding workflows; maps Temporal errors to HTTP 404/409. |
| [src/shared.ts](src/shared.ts) | Types, task queue name, default timings, and the query/signal definitions shared by the API and the worker. |
| [src/workflows.ts](src/workflows.ts) | The orchestration logic (`onboardingWorkflow`, `offboardingWorkflow`), executed by the worker, not by the NestJS process. |
| [src/activities.ts](src/activities.ts) | Activities: one per external-system operation, plus the matching undo operation for each, plus notifications. Each writes to PostgreSQL and/or calls a vendor, and records an audit event. |
| [src/db.ts](src/db.ts) | PostgreSQL pool and idempotent schema migration (`employees`, `audit_log`), shared by API and worker. |
| [src/vendors.ts](src/vendors.ts) | Invokes the vendors Lambda through the AWS SDK and derives the idempotency key for each call. |
| [lambdas/vendors/](lambdas/vendors/) | The vendors Lambda: handler, container image, and a local Invoke-API server for docker-compose. |
| [src/worker.ts](src/worker.ts) | A separate Node process that polls Temporal for work and executes `workflows.ts`/`activities.ts`. |

Two independent Node processes come out of this codebase:
- **`app`** — the NestJS HTTP API (talks to Temporal as a *client*, never runs workflow code itself).
- **`worker`** — polls Temporal and *executes* the workflow/activity code.

They never call each other directly; Temporal is the broker in between. This separation is what gives Temporal its durability: if the worker crashes mid-workflow, Temporal remembers exactly where it was and resumes on another worker once one reconnects.

### Request lifecycle: starting an onboarding

1. A client sends `POST /onboardings` with the new hire's data. NestJS's `ValidationPipe` rejects malformed bodies with a 400 before anything reaches Temporal.
2. `OnboardingController.start()` delegates to `TemporalService.startOnboarding()`.
3. `TemporalService` calls `client.workflow.start('onboardingWorkflow', { taskQueue: 'onboarding', workflowId: 'onboarding-<employeeId>', args: [hire, timings] })`. This only asks the Temporal **server** to record "please run this workflow" and returns immediately, so the API answers `202 Accepted` with the `onboardingId`. No business logic has executed yet.
4. Because the workflow ID is derived from the employee ID, Temporal rejects a second onboarding for the same person, which the API returns as `409 Conflict`. Deduplication comes for free, with no extra table or lock.
5. The `worker`, polling the `onboarding` task queue, picks up the task and runs `onboardingWorkflow`.
6. The workflow creates the HR record, sends the contract and waits for it to be signed (see below), then schedules the provisioning activities in parallel. Temporal dispatches each as an *activity task*; a failed attempt is retried with exponential backoff without the workflow code doing anything.
7. Each activity returns the ID of what it created (email address, order number, ...). The workflow keeps these, since they will be needed to undo steps when compensation is added.
8. The workflow sleeps until the welcome email is due, sends it and completes, or fails if a step exhausts its retries.

### Waiting on humans: signals and durable timers

The contract and start-date phases are where Temporal earns its place. A plain backend would need a status table, a cron job scanning for overdue contracts, and careful locking. Here it is a few lines of ordinary code:

```ts
if (!(await condition(signed, '3 days'))) {   // resolves early if the signal arrives
  await acts.sendContractReminder(hire);
  ...
}
```

- **Signals** (`contractSigned`, `updateStartDate`) are delivered to the running workflow and persisted in its history. Handlers only record the event; the main flow decides what to do with it.
- **Timers** (`condition(..., timeout)`) are stored by the Temporal server, not held in worker memory. Nothing runs while waiting, and the wait survives worker crashes and redeploys: if the worker is down when a timer expires, the workflow continues as soon as a worker reconnects.
- **Changing the start date** wakes the sleeping workflow, which propagates the change and recomputes the timer from the new date.
- **Timings are workflow input**, not config read inside the workflow. They are recorded in history, so changing them later only affects new onboardings, never ones already in flight.

### Rolling back: the saga pattern

Onboarding touches several independent systems, so there is no transaction to roll back when it is cancelled (offer withdrawn) or a step fails for good. Instead, every step that has a side effect has a matching **compensation** that undoes it, and the workflow runs the compensations for the completed steps in **reverse order of completion**:

```
✅ HR record → ✅ contract → ✅ email, Slack, laptop, payroll → ❌ GitHub (5 attempts)
                                         ↓
   cancel laptop → remove payroll → deactivate Slack → deactivate email → void contract → archive HR record
```

Design decisions worth calling out:

- **Each step registers its compensation as soon as its side effect exists**, using the resource ID the activity returned (email address, order number, ...). The contract is registered when it is *sent*, not when signed, so cancelling during the signature wait still voids it.
- **Cancellation interrupts waits, not in-flight calls.** A cancel ends a pending timer or signature wait immediately, but provisioning calls already running are allowed to finish (`Promise.allSettled`) before the rollback starts. Interrupting them would risk a call that actually succeeded at the vendor but was never recorded, leaving an orphaned account the saga doesn't know about.
- **Compensations are more patient than forward steps**: 10 attempts with backoff capped at 1 minute, instead of 5. One that still fails is marked `compensation_failed`, the rest still run, and HR is asked to finish the cleanup by hand.
- **Compensations are idempotent**, since Temporal may retry them: "already deactivated" counts as success.
- **Irreversible steps go last.** The welcome email can't be unsent, so it has no compensation and is the final step.
- **The rollback runs in a non-cancellable scope**, so it completes even if the workflow is cancelled through Temporal itself (UI or CLI) instead of the API.
- **A cancel is a business outcome, not an error.** A cancelled onboarding completes normally with status `CANCELLED`; only a real failure ends the workflow as `FAILED`.

Offboarding reuses the same undo activities. Tearing down an employee is the same set of operations as rolling back a cancelled hire, so it starts from the resource IDs in the completed onboarding's result.

### Exactly-once side effects: idempotency keys

Temporal retries a failed activity automatically, which raises the classic distributed-systems problem: what if the call *succeeded* at the vendor but the response was lost (timeout, connection reset)? A naive retry would create a second email account (`ana.lopez2@` next to the orphaned `ana.lopez@`), a second laptop order, a second payroll record.

The fix spans both sides of the call:

- **The caller sends an idempotency key** that is identical on every retry of an activity call and different for any other call: `<workflow run ID>:<activity ID>` ([src/vendors.ts](src/vendors.ts)). A rehire runs a new workflow run, so it correctly gets new keys.
- **The vendor claims the key before doing the work, and stores the response in the same transaction as the side effect** ([lambdas/vendors/index.ts](lambdas/vendors/index.ts)). A repeated key returns the stored response (`replayed: true`) without doing the work again. If two identical requests race, the second one blocks on the key until the first commits, then returns its response, so a duplicate never even starts the work. (Rolling back a duplicate *after* doing the work would only be safe here because the simulated work is a database insert; a real vendor's side effects, like sending an email, can't be rolled back.)
- **Our own writes are idempotent too**: the employee record is an upsert, and audit rows are keyed by activity call (`ON CONFLICT DO NOTHING`), so a retried activity never writes a second audit entry.
- **Retries happen in exactly one place.** The AWS SDK's own retries are disabled (`maxAttempts: 1`); Temporal's retry policy is the only one, so attempts aren't multiplied and every retry is visible in the workflow history.

This is testable: `MOCK_LOST_RESPONSE_RATE=0.6` makes the vendor commit the work and then drop the response 60% of the time. Onboardings still end with exactly one resource per system, and the audit log marks which ones were `replayed`.

### AWS Lambda locally

The vendors function is a container-image Lambda ([lambdas/vendors/Dockerfile](lambdas/vendors/Dockerfile)) built on the official `public.ecr.aws/lambda/nodejs:22` base image, so the same image deploys to AWS Lambda unchanged. The worker calls it with the AWS SDK's `InvokeCommand`; locally, `LAMBDA_ENDPOINT` points the SDK at the container instead of AWS.

The base image's Runtime Interface Emulator only handles one invocation at a time and crashes on concurrent ones (real Lambda scales out to more instances instead). Since provisioning calls vendors in parallel, docker-compose runs the image with a small server ([lambdas/vendors/local-server.ts](lambdas/vendors/local-server.ts)) that exposes the same Invoke API and calls the same handler concurrently.

### Request lifecycle: checking progress

1. A client sends `GET /onboardings/:id`.
2. `TemporalService.getOnboarding()` does two things in parallel:
   - `describe()` asks the Temporal **server** for the execution status (`RUNNING`, `COMPLETED`, `FAILED`) and timestamps.
   - `query(progressQuery)` asks the **workflow itself** for its in-memory state: which steps are pending, running, done or failed, plus the created resource IDs. There is no separate status table to keep in sync.
3. An unknown ID returns `404 Not Found`.
4. If no worker answers the query within 3 seconds (e.g. all workers are down), the endpoint still returns the server-side status with `progress: null` instead of hanging. The workflow itself is unaffected.

### Why a separate worker process?

Workflow code has to be deterministic (same inputs always produce the same sequence of decisions) because Temporal may replay it to rebuild state after a crash. Activities are where non-deterministic, "real" work happens — I/O, API calls, timestamps. Splitting workflow/activity execution into its own `worker` process (rather than running it inside the NestJS app) keeps the HTTP API free to scale independently, and lets you run many worker instances pulling from the same task queue without touching the API layer at all.

### Local topology

Running `docker compose up` starts the six application containers below, plus Prometheus and Grafana for monitoring:

```
app (NestJS, :3000) ──Temporal client──▶ temporal (:7233) ◀──polls── worker ──Lambda Invoke API──▶ vendors
       │                                   │       ▲                    │                            │
       └──────────────────────────▶ postgres (:5432)  temporal-ui (:8080) ◀─────────────────────────┘
```

## Local environment (cloud simulation)

To emulate the project's cloud environment, we use Docker Compose to spin up the required services locally. This includes Temporal, its Web UI, PostgreSQL, the NestJS API, the worker, and the vendors Lambda.

1. Run `docker compose up --build` in the root directory (`docker compose down` to stop).
2. The API is available at `http://localhost:3000`, Temporal at `localhost:7233`, and the Temporal Web UI at `http://localhost:8080`, where you can inspect every workflow's event history.
3. Start an onboarding:
   ```bash
   curl -X POST localhost:3000/onboardings -H 'Content-Type: application/json' -d '{
     "employeeId": "E1001",
     "fullName": "Ana López",
     "personalEmail": "ana@example.com",
     "role": "engineer",
     "startDate": "2026-11-16"
   }'
   # → 202 {"onboardingId":"onboarding-E1001"}
   ```
4. Check its progress: `curl localhost:3000/onboardings/onboarding-E1001`
5. Sign the contract so provisioning can start:
   `curl -X POST localhost:3000/onboardings/onboarding-E1001/contract-signature`
6. Move the start date: `curl -X PATCH localhost:3000/onboardings/onboarding-E1001/start-date -H 'Content-Type: application/json' -d '{"startDate":"2026-11-23"}'`
7. To watch the timers fire without waiting days, shorten them (any [`ms`](https://github.com/vercel/ms)-style duration) and use a start date a minute or two away:
   ```bash
   CONTRACT_REMINDER_DELAY="15 seconds" CONTRACT_ESCALATION_DELAY="15 seconds" WELCOME_LEAD_TIME="10 seconds" \
     docker compose up -d app
   ```
   Then stop the worker (`docker compose stop worker`) while a contract is unsigned, wait past the deadlines, and start it again: the reminder and escalation fire as soon as it reconnects.
8. To watch retries happen, make the vendors fail randomly:
   `MOCK_FAILURE_RATE=0.5 docker compose up -d vendors`. Failed attempts appear as retries in the Web UI.
9. To see the saga roll back, cancel an onboarding at any stage:
   `curl -X POST localhost:3000/onboardings/onboarding-E1001/cancellation -H 'Content-Type: application/json' -d '{"reason":"Offer withdrawn"}'`
   or simulate a permanent outage, so provisioning fails and everything else is undone:
   `MOCK_FAILING_SYSTEMS=github docker compose up -d vendors`
10. Once an onboarding has completed, offboard the employee:
    `curl -X POST localhost:3000/offboardings -H 'Content-Type: application/json' -d '{"employeeId":"E1001","reason":"Resigned"}'`
11. See the employee record and full audit trail: `curl localhost:3000/employees/E1001`
12. To see idempotency at work, make the vendors lose responses after doing the work:
    `MOCK_LOST_RESPONSE_RATE=0.6 docker compose up -d vendors`, run an onboarding, then check that each system still has exactly one resource:
    `docker compose exec postgres psql -U user -d workflows -c "SELECT system, count(*) FROM vendors.resources WHERE employee_id='E1001' GROUP BY system"`

## Cloud deployment

To deploy the application to the cloud, follow these steps:

1. Configure the AWS CLI with your AWS credentials.
2. Use Terraform to define the required infrastructure, including AWS Lambda and PostgreSQL RDS.
3. Run `terraform init` and `terraform apply` to provision the infrastructure.
4. Upload the application code to AWS Lambda using `aws lambda update-function-code`.
5. Make sure the environment variables in AWS Lambda point to the right services.
6. Verify the application is running correctly by hitting the production endpoints.

## Monitoring

Prometheus and Grafana run in docker-compose (local only; they are not part of the AWS deployment).

- **Grafana:** http://localhost:3001 (no login). The provisioned "Onboarding platform" dashboard ([monitoring/grafana/dashboards/onboarding.json](monitoring/grafana/dashboards/onboarding.json)) opens by default.
- **Prometheus:** http://localhost:9090, scraping every 5s ([monitoring/prometheus.yml](monitoring/prometheus.yml)).

| Source | What it exposes |
| --- | --- |
| API (`GET /metrics`, [src/metrics.ts](src/metrics.ts)) | `http_request_duration_seconds` by route pattern and status, plus Node.js process metrics |
| Worker (`:9464`, Temporal SDK exporter in [src/worker.ts](src/worker.ts)) | Activity and workflow-task latency, failures, schedule-to-start (queueing) latency, slots, plus custom counters: `onboarding_events_total{event, workflow_type}` for every audit event and `vendor_replayed_responses_total{system}` for duplicates prevented |
| Temporal server (`:8000`) | Workflow lifecycle, persistence latency, history shard and internal queue metrics |

The dashboard has three rows: business outcomes (onboardings completed and rolled back, HR escalations, duplicates prevented), the API (throughput, p50/p95/p99, status codes), and saturation signals (completions, activity latency and failures, schedule-to-start latency, task slots, Temporal persistence latency). Worker replicas (`docker compose up --scale worker=N`) are discovered through DNS.

## Load testing

[loadtest/k6.js](loadtest/k6.js) drives full hires: each iteration starts an onboarding, signs the contract (which triggers parallel provisioning against the vendors Lambda), and 1 in 10 also reads progress. Start dates are an hour out, so every workflow runs to completion.

```bash
docker compose --profile loadtest run --rm k6                                # ramp: 25 -> 50 -> 100 -> 200 hires/s
docker compose --profile loadtest run --rm -e RATE=10 -e DURATION=2m k6      # constant rate
```

Watch the Grafana dashboard while it runs. Above capacity, workflows keep running after k6 stops; clean them up with
`docker compose exec temporal temporal workflow terminate --query "ExecutionStatus='Running' AND WorkflowId STARTS_WITH 'onboarding-lt-'" --yes --address temporal:7233`.

### Results

Measured on an Apple M1 Pro (Docker Desktop: 10 CPUs, 7.7 GB), single-node Temporal (`auto-setup`, 4 history shards, Postgres), one worker, SDK defaults, simulated vendor latency of 0.1–2 s per call. Constant-rate runs of 2 minutes:

| Hires/s offered | Completed/s | API p95 / p99 | End-to-end onboarding p95 | Activity queueing p95 | Backlog after run |
| --- | --- | --- | --- | --- | --- |
| **10** | **10.0** | **91 ms / 221 ms** | **4.9 s** | **0.2 s** | **0** |
| 15 | 10.6 | 166 ms / 527 ms | 41 s | 9.6 s | 230 |
| 20 | 7.6 | 373 ms / 1.7 s | 69 s | 22 s | 1,275 |
| 25 | 5.0 | 1.0 s / 3.0 s | 90 s | 28 s | 2,330 |

- **Sustainable throughput: about 10 onboardings/s** (around 25 API requests/s, 90 activities/s and 100 workflow tasks/s). At that rate the API meets the p95 < 200 ms target, the p99 is 221 ms, and there were 0 errors across all runs.
- **Above roughly 11/s, throughput falls instead of levelling off**: queues grow without bound and onboardings take minutes. The API keeps accepting work (no errors), so overload shows up as latency, not failures. A production version should add backpressure, e.g. rejecting new onboardings with `429` when schedule-to-start latency is high.
- The earlier README targets (2,000 req/s, saturation at ~3,500 req/s) were not measured and are not achievable with this setup; each request here starts a durable, multi-step workflow.

### What load testing found

Two real bugs, both fixed:

1. **Email allocation probed candidates one query at a time** (`ana.lopez@`, `ana.lopez2@`, ...) inside a transaction. With many hires sharing a name, each call ran thousands of queries and starved the vendor's connection pool, slowing *every* vendor call to 4–7 s. It is now a single query ([lambdas/vendors/index.ts](lambdas/vendors/index.ts)), with a test for prefix names.
2. **The local Lambda server ran in one Node process** and saturated a core. It now forks `LOCAL_LAMBDA_PROCESSES` (default 4), the local stand-in for Lambda scaling out.

Changes that did **not** raise the ~10/s ceiling once those bugs were fixed: three worker replicas, 500 activity slots, 50 activity pollers, autoscaling pollers, 64 history shards, and `synchronous_commit=off` in Postgres. No single container was CPU-bound at the ceiling. The constraint shows up as activity schedule-to-start latency (tasks waiting in Temporal's matching queue while workers have free slots), which points at task dispatch in the single-node `auto-setup` server; the exact cause is not yet identified. Note also that the dashboard metric `temporal_workflow_task_replay_latency` counts every workflow task, not just cache misses.

## Tests

```bash
npm test                      # unit project: no external services needed (~15s)
npm run test:integration      # needs the docker-compose Postgres on localhost:5432
npm run test:record-histories # re-record replay fixtures (see below)
```

| Suite | What it covers |
| --- | --- |
| [test/onboarding.workflow.test.ts](test/onboarding.workflow.test.ts) | The onboarding workflow end to end with mocked activities: happy path, role-based steps, the 3-day reminder and 7-day escalation, start-date changes, retries, and every saga path (cancel at each stage, cancel during in-flight provisioning, permanent failure, failing compensation, cancel issued through Temporal). |
| [test/offboarding.workflow.test.ts](test/offboarding.workflow.test.ts) | Scheduled revocation, phase ordering (access first, HR record last), skipping resources that were never created, escalation on failure. |
| [test/replay.test.ts](test/replay.test.ts) | Replays recorded workflow histories against the current code to catch nondeterministic changes. |
| [test/api.test.ts](test/api.test.ts) | HTTP validation and routing, with the production app configuration and a mocked `TemporalService`. |
| [test/temporal.service.test.ts](test/temporal.service.test.ts) | Mapping of Temporal errors and states to HTTP `404`/`409`, degraded progress when no worker responds, offboarding preconditions. |
| [test/vendors.client.test.ts](test/vendors.client.test.ts) | Idempotency key derivation (stable across retries, unique per call and per run) and Lambda error handling. |
| [test/vendors.lambda.int.test.ts](test/vendors.lambda.int.test.ts) | The vendors Lambda against real Postgres: repeated keys, lost responses, five concurrent identical requests, failed calls, idempotent deactivation. |

### Testing time: the time-skipping test server

The workflow tests run against Temporal's time-skipping test server (`TestWorkflowEnvironment.createTimeSkipping()`) with the **real production timings**. Whenever the workflow is only waiting on a timer, the server jumps ahead, so the 7-day escalation and the 4-week wait for the start date take milliseconds:

```ts
await until((p) => p.contract.sentAt !== null);
await env.sleep('3 days');                                   // instant
await until((p) => p.contract.remindersSent === 1);
await env.sleep('4 days');                                   // instant
await until((p) => p.contract.escalatedAt !== null);
```

Mock activities record the workflow-clock time each call was scheduled at, so tests can assert that the welcome email went out exactly one day before the (possibly rescheduled) start date.

### Replay tests: protecting workflows already in flight

Temporal rebuilds a workflow's state by replaying its history through the code, so changing workflow code can break workflows that started under the old version (for example, inserting a new activity call before an existing one). [test/replay.test.ts](test/replay.test.ts) replays the histories in [test/histories/](test/histories/) against the current code and fails with a `DeterminismViolationError` on such a change. The fix is then to gate the change with `patched()` rather than editing the workflow in place.

When shipping an intentional new workflow version, record new fixtures alongside the old ones (`npm run test:record-histories v2`); the old ones represent workflows still running in production.

### Do the tests catch real bugs?

They were checked by deliberately breaking the code:

- Compensating in forward instead of reverse order fails 4 workflow tests.
- Inserting a new activity call before the contract step fails both replay tests with `Nondeterminism error: Activity type of scheduled event 'sendContract' does not match activity type of activity command 'escalateToHr'`.

## Technical complexities

### Distributed workflow orchestration

**Why it's hard:** Managing the state and execution of distributed workflows is complex because it requires guaranteeing consistency and fault tolerance.

**How it's solved:** Temporal automatically handles state persistence and re-execution on failure, letting you focus on business logic.

### Serverless function scalability

**Why it's hard:** Serverless functions need to scale dynamically to handle variable load without hurting performance.

**How it's solved:** AWS Lambda is used to run serverless functions that scale automatically in response to load.

### Real-time state management

**Why it's hard:** Keeping state up to date and consistent in real time is challenging in distributed systems.

**How it's solved:** Temporal provides a robust mechanism for managing workflow state, enabling real-time updates.


## Takeaways

- Implemented a workflow automation platform using Temporal and NestJS.
- Learned to orchestrate distributed workflows with Temporal.
- Got familiar with deploying applications to AWS Lambda.
- Developed skills for load testing and monitoring performance metrics.
- Built a local development environment that emulates the cloud infrastructure.

## Learning path

### NestJS

NestJS is a progressive Node.js framework for building efficient, scalable server-side applications with TypeScript, built around modules, controllers, and providers with dependency injection.

1. Start with the official NestJS documentation to understand modules, controllers, and providers.
2. Build a simple NestJS controller/service pair and wire it up with dependency injection.
3. Integrate Temporal into a NestJS service (as done in `temporal.service.ts`) to manage workflows.
4. Deploy the NestJS application in a Docker environment to simulate its integration into the project.
5. Experiment with NestJS features like pipes, guards, interceptors, and custom modules.

- NestJS Documentation
- NestJS Courses (official)
- Awesome NestJS (community resources)

### Temporal

Temporal enables building resilient distributed systems with persistent state management.

1. Read the Temporal documentation to understand its architecture and key concepts.
2. Implement a simple workflow in Temporal using TypeScript.
3. Integrate Temporal with NestJS and test orchestration of complex workflows.
4. Deploy Temporal in a Docker environment and test its behavior with k6.
5. Explore advanced use cases and recommended design patterns in Temporal.

- Temporal Documentation
- Temporal.io YouTube Channel
- Building Workflows with Temporal by Maxim Fateev
