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

### The moving pieces

| File | Role |
| --- | --- |
| [src/main.ts](src/main.ts) | Boots the NestJS app and starts listening on port 3000. |
| [src/app.module.ts](src/app.module.ts) | Root module; wires `WorkflowController` and `TemporalService` together. |
| [src/workflow.controller.ts](src/workflow.controller.ts) | HTTP layer: `POST /workflow/start` and `GET /workflow/:id/status`. |
| [src/temporal.service.ts](src/temporal.service.ts) | Temporal **client**: opens a connection to the Temporal server and asks it to start/describe workflows. |
| [src/workflows.ts](src/workflows.ts) | The actual workflow logic (`exampleWorkflow`), executed by the worker, not by the NestJS process. |
| [src/activities.ts](src/activities.ts) | Activities — the "do real work" steps a workflow calls out to (here, a simple `greet`). |
| [src/worker.ts](src/worker.ts) | A separate Node process that polls Temporal for work and executes `workflows.ts`/`activities.ts`. |

Two independent Node processes come out of this codebase:
- **`app`** — the NestJS HTTP API (talks to Temporal as a *client*, never runs workflow code itself).
- **`worker`** — polls Temporal and *executes* the workflow/activity code.

They never call each other directly; Temporal is the broker in between. This separation is what gives Temporal its durability: if the worker crashes mid-workflow, Temporal remembers exactly where it was and resumes on another worker once one reconnects.

### Request lifecycle: starting a workflow

1. A client sends `POST /workflow/start`.
2. `WorkflowController.startWorkflow()` delegates to `TemporalService.startWorkflow()`.
3. `TemporalService` calls `client.start('exampleWorkflow', { taskQueue: 'exampleTaskQueue', workflowId, args })` on its `WorkflowClient`. This is a request to the Temporal **server** — it just records "please run this workflow" and returns immediately with a `workflowId`. No business logic has executed yet.
4. Temporal places a workflow task on the `exampleTaskQueue`.
5. The `worker` process, which has been polling that same task queue since startup, picks up the task and runs `exampleWorkflow(name)` from `workflows.ts`.
6. Inside the workflow, `proxyActivities` schedules the `greet` activity. Temporal dispatches that as an *activity task*, also on `exampleTaskQueue`, which the same worker executes.
7. `greet` runs and returns a string; the workflow returns that string as its result; the worker reports completion back to Temporal.
8. The NestJS API never has to do anything else here — all of this happens asynchronously, driven by the worker and the Temporal server.

### Request lifecycle: checking status

1. A client sends `GET /workflow/:id/status`.
2. `WorkflowController.getStatus()` delegates to `TemporalService.getWorkflowStatus(id)`.
3. `TemporalService` calls `client.getHandle(id).describe()`, which asks the Temporal server for that workflow's current execution state (`RUNNING`, `COMPLETED`, `FAILED`, etc.) plus metadata like start time and history length.
4. Temporal answers from its own persisted state (backed by PostgreSQL) — it doesn't need to contact the worker to answer this.

### Why a separate worker process?

Workflow code has to be deterministic (same inputs always produce the same sequence of decisions) because Temporal may replay it to rebuild state after a crash. Activities are where non-deterministic, "real" work happens — I/O, API calls, timestamps. Splitting workflow/activity execution into its own `worker` process (rather than running it inside the NestJS app) keeps the HTTP API free to scale independently, and lets you run many worker instances pulling from the same task queue without touching the API layer at all.

### Local topology

Running `docker compose up` starts four containers that map directly onto the pieces above:

```
app (NestJS, :3000) ──Temporal client──▶ temporal (:7233) ◀──polls── worker
                                              │
                                         postgres (:5432)
```

## Local environment (cloud simulation)

To emulate the project's cloud environment, we use Docker Compose to spin up the required services locally. This includes Temporal, PostgreSQL, and the NestJS application.

1. We emulate Temporal and PostgreSQL using Docker Compose.
2. Run `docker compose up` in the root directory to start the services (`docker compose down` to stop them).
3. The NestJS app will be available at `http://localhost:3000` and Temporal at `localhost:7233`.
4. Make sure environment variables point to these local endpoints to test the application.
5. Verify everything works by hitting `http://localhost:3000/workflow/start` to kick off a workflow.

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
