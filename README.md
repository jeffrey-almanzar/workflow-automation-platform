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
[Client] --> [NestJS API] --> [Temporal Service] --> [AWS Lambda]
                     |                  |
                  [PostgreSQL]        [Worker]
```
- **Client**: Interacts with the API to start and monitor workflows.
- **NestJS API**: Exposes REST endpoints to manage workflows; talks to the Temporal Service to start and monitor them.
- **Temporal Service**: Orchestrates workflow execution, manages state, and guarantees execution.
- **AWS Lambda**: Runs serverless functions as part of the workflows, enabling efficient scalability.
- **PostgreSQL**: Stores persistent workflow data and results.
- **Worker**: Executes the tasks defined in the workflows, interacting with the Temporal Service.

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

Signals to an unknown onboarding return `404`; to one that already finished, `409`.

The external systems are mocked for now ([src/activities.ts](src/activities.ts)), with realistic latency, optional random failures, and optional permanent outages per system.

### The moving pieces

| File | Role |
| --- | --- |
| [src/main.ts](src/main.ts) | Boots the NestJS app, enables request validation, and listens on port 3000. |
| [src/app.module.ts](src/app.module.ts) | Root module; wires `OnboardingController` and `TemporalService` together. |
| [src/onboarding.controller.ts](src/onboarding.controller.ts) | HTTP layer and request DTOs for `/onboardings` (start, progress, signature, start date, cancellation). |
| [src/offboarding.controller.ts](src/offboarding.controller.ts) | HTTP layer and request DTO for `/offboardings`. |
| [src/temporal.service.ts](src/temporal.service.ts) | Temporal **client**: starts, signals and queries onboarding workflows; maps Temporal errors to HTTP 404/409. |
| [src/shared.ts](src/shared.ts) | Types, task queue name, default timings, and the query/signal definitions shared by the API and the worker. |
| [src/workflows.ts](src/workflows.ts) | The orchestration logic (`onboardingWorkflow`, `offboardingWorkflow`), executed by the worker, not by the NestJS process. |
| [src/activities.ts](src/activities.ts) | Activities: one per external-system operation, plus the matching undo operation for each, plus notifications. |
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

Running `docker compose up` starts five containers that map directly onto the pieces above:

```
app (NestJS, :3000) ──Temporal client──▶ temporal (:7233) ◀──polls── worker
                                           │       ▲
                                  postgres (:5432)  temporal-ui (:8080)
```

## Local environment (cloud simulation)

To emulate the project's cloud environment, we use Docker Compose to spin up the required services locally. This includes Temporal, its Web UI, PostgreSQL, the NestJS API and the worker.

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
8. To watch retries happen, make the mocked systems fail randomly and restart the worker:
   `MOCK_FAILURE_RATE=0.5 docker compose up -d worker`. Failed attempts appear as retries in the Web UI.
9. To see the saga roll back, cancel an onboarding at any stage:
   `curl -X POST localhost:3000/onboardings/onboarding-E1001/cancellation -H 'Content-Type: application/json' -d '{"reason":"Offer withdrawn"}'`
   or simulate a permanent outage, so provisioning fails and everything else is undone:
   `MOCK_FAILING_SYSTEMS=GitHub docker compose up -d worker`
10. Once an onboarding has completed, offboard the employee:
    `curl -X POST localhost:3000/offboardings -H 'Content-Type: application/json' -d '{"employeeId":"E1001","reason":"Resigned"}'`

## Cloud deployment

To deploy the application to the cloud, follow these steps:

1. Configure the AWS CLI with your AWS credentials.
2. Use Terraform to define the required infrastructure, including AWS Lambda and PostgreSQL RDS.
3. Run `terraform init` and `terraform apply` to provision the infrastructure.
4. Upload the application code to AWS Lambda using `aws lambda update-function-code`.
5. Make sure the environment variables in AWS Lambda point to the right services.
6. Verify the application is running correctly by hitting the production endpoints.

## Load testing

We use k6, an open-source load testing tool, to run load tests.

1. Define a load test script in `loadtest/k6.js` with p95/p99 thresholds.
2. Run `k6 run loadtest/k6.js` to start the load test.
3. Configure Prometheus and Grafana to observe the load test results.
4. Monitor performance metrics and adjust infrastructure as needed.

## Target metrics

| Metric | Target | How to measure |
| --- | --- | --- |
| Target QPS / RPS | 2,000 sustained req/s | Measured with k6 and monitored with Prometheus. |
| p50 / p95 / p99 latency | p99 < 200ms | Latency metrics measured with k6 and visualized in Grafana. |
| Error rate | < 0.1% | Measured with k6 by observing http_req_failed. |
| Saturation point | Degradation starting around ~3,500 req/s | Observed during load testing with k6. |

## Tests (unit / integration)

To ensure code quality, we implement unit and integration tests.

Example unit test for `TemporalService`:
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TemporalService } from './temporal.service';

describe('TemporalService', () => {
  let service: TemporalService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TemporalService],
    }).compile();

    service = module.get<TemporalService>(TemporalService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should start a workflow', async () => {
    const workflowId = await service.startWorkflow();
    expect(workflowId).toBeDefined();
  });
});
```

For integration tests, it's recommended to use a test environment that emulates the full infrastructure.

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
