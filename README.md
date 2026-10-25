# Employee Onboarding Platform on Temporal

A backend that automates employee onboarding and offboarding across several external systems (HR, e-signature, email, Slack, GitHub, laptop vendor, payroll). Built with **Temporal**, **NestJS** and **TypeScript**, with the external vendors running as an **AWS Lambda**, deployed to AWS with **Terraform**.

The point of the project is the hard parts of backend work that a simple CRUD app never touches: processes that wait weeks for a human, steps that fail halfway through, retries that must not create duplicates, and code changes that must not break work already in progress.

**Stack:** TypeScript · Node.js 22 · NestJS · Temporal (TypeScript SDK) · PostgreSQL · AWS Lambda, EC2, ECR, IAM, SSM · Terraform · Docker · Prometheus · Grafana · k6 · Jest

## At a glance

| | |
| --- | --- |
| **What it does** | Runs each onboarding as a durable workflow: creates the HR record, waits for the contract signature (with a 3-day reminder and a 7-day HR escalation), provisions five systems in parallel, waits until the day before the start date, then sends the welcome email. Offboarding tears it all down. |
| **Failure handling** | Any step can fail or the hire can be cancelled at any point; everything already done is undone in reverse order (saga pattern). Proven with tests and with the worker killed mid-process. |
| **No duplicates** | Every external call carries an idempotency key. With the simulated vendor deliberately dropping 60% of its responses, each system still ends up with exactly one account per hire. |
| **Tests** | 50 tests across 7 suites. Workflow tests run the real 3-day and 4-week timers in milliseconds; replay tests catch code changes that would break in-flight workflows. |
| **Measured performance** | 10 onboardings/s sustained locally with p95 API latency of 91 ms and zero errors; the load test also found and fixed two real bugs. Results, including what didn't work, are below. |
| **Deployed** | One `terraform apply` builds the images, creates the AWS infrastructure (EC2, Lambda, ECR, least-privilege IAM, budget alerts) and starts the stack. |

## Contents

- [The problem](#the-problem)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [How a hire flows through the system](#how-a-hire-flows-through-the-system)
- [Engineering decisions](#engineering-decisions)
- [Testing](#testing)
- [Performance and load testing](#performance-and-load-testing)
- [Observability](#observability)
- [Deployment on AWS](#deployment-on-aws)
- [Limitations and next steps](#limitations-and-next-steps)
- [Repository map](#repository-map)

Maintainer notes (how to run, operate and explain the project): [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md).

## The problem

Onboarding a new employee touches many systems owned by different teams, spans weeks, and depends on people (the hire signs a contract, the start date moves, an offer gets withdrawn). In practice it runs on spreadsheets and tickets, so steps get missed: people start without a laptop or login, and people who never joined (or have left) keep access to company systems.

Automating it is harder than it looks:

- **It waits on humans for days or weeks.** A normal request/response backend would need status tables, cron jobs scanning for overdue work, and locking.
- **It spans systems with no shared transaction.** If payroll enrollment fails after the email account and laptop order succeeded, there is no `ROLLBACK`.
- **Calls fail in ambiguous ways.** A timeout doesn't say whether the account was created, and a blind retry can create a second one.
- **The process changes while instances are running.** Editing the code must not corrupt an onboarding that started last week.

This project addresses each of these explicitly. The vendors are simulated (an AWS Lambda with its own database, realistic latency and injectable failures), so every failure mode can be reproduced on demand.

## Quick start

Requires Docker.

```bash
docker compose up -d --build

# Start an onboarding (start date 2 hours out, so it completes right after provisioning)
START=$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ)   # macOS; on Linux: date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ
curl -X POST localhost:3000/onboardings -H 'Content-Type: application/json' \
  -d "{\"employeeId\":\"E1\",\"fullName\":\"Ana López\",\"personalEmail\":\"ana@example.com\",\"role\":\"engineer\",\"startDate\":\"$START\"}"

curl -X POST localhost:3000/onboardings/onboarding-E1/contract-signature   # the hire signs
curl localhost:3000/onboardings/onboarding-E1                              # live progress
curl localhost:3000/employees/E1                                           # record + audit trail
```

| Local URL | What |
| --- | --- |
| http://localhost:3000 | API |
| http://localhost:8080 | Temporal UI: every workflow's full event history |
| http://localhost:3001 | Grafana dashboard (no login) |
| http://localhost:9090 | Prometheus |

To see failures and recovery (worker crashes, vendor outages, lost responses, cancellations), follow the scenarios in [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md#demo-scenarios).

## Architecture

```
[Client] ──HTTP──▶ [NestJS API] ──start / signal / query──▶ [Temporal Server] ◀──polls── [Worker]
                        │                                          │                       │
                        │ reads                                    │ persists              ├─ writes ──▶ [PostgreSQL]
                        ▼                                          ▼                       │              ▲
                   [PostgreSQL] ◀───────────────────────── (separate DBs) ─────────────────┘              │
                                                                                           └─ invokes ─▶ [Lambda "vendors"]
                                                                                                      (own schema, idempotency)
```

| Component | Role |
| --- | --- |
| **NestJS API** | REST endpoints. Talks to Temporal as a client only: starts workflows, sends signals, reads state. Never runs workflow code. |
| **Temporal server** | Stores every workflow's state and history, schedules timers and retries, dispatches tasks to workers. |
| **Worker** | A separate Node process that executes the workflow and activity code. If it crashes, Temporal resumes the work on the next worker that connects. |
| **Vendors Lambda** | Simulates the six external SaaS systems, with its own state and idempotency-key handling like a real vendor API. The same container image runs locally and on AWS Lambda. |
| **PostgreSQL** | Our system of record (employees, audit log), the vendors' simulated data (separate schema), and Temporal's persistence (separate databases). |

The API and worker are separate processes on purpose: workflow code must be deterministic (Temporal replays it to rebuild state), and the two scale independently.

## How a hire flows through the system

```
POST /onboardings ──▶ onboardingWorkflow
  1. createHrRecord
  2. sendContract → wait for the "contractSigned" signal
       unsigned after 3 days → reminder            (durable timer)
       unsigned 4 days later → escalate to HR, keep waiting
  3. in parallel: email, Slack, GitHub (engineers only), laptop order, payroll
       each retried independently with exponential backoff
  4. sleep until 1 day before the start date (may be weeks)
       "updateStartDate" signal → notify laptop vendor, recompute the timer
  5. welcome email → employee ACTIVE

  "cancelOnboarding" signal, or a step failing for good, at any point:
  → undo every completed step in reverse order → CANCELLED / FAILED
```

Offboarding (`POST /offboardings`) waits until the requested time, cuts access first (email, Slack, GitHub in parallel), then payroll and laptop return, and archives the HR record last. Anything that still fails after retries is escalated to HR rather than silently left behind.

### API

| Endpoint | Behavior |
| --- | --- |
| `POST /onboardings` | Starts an onboarding. `202` with the ID, `409` if one is already running for that employee, `400` on invalid input. |
| `GET /onboardings/:id` | Live progress: phase, % complete, each step's status, contract state, created resource IDs. |
| `POST /onboardings/:id/contract-signature` | Signal: contract signed (in production, the e-signature provider's webhook). Safe to send twice. |
| `PATCH /onboardings/:id/start-date` | Signal: new start date; the waiting workflow reschedules itself. |
| `POST /onboardings/:id/cancellation` | Signal: cancel with a reason; triggers the rollback. |
| `POST /offboardings` · `GET /offboardings/:id` | Start (only for a completed onboarding) and track an offboarding. |
| `GET /employees/:id` | Employee record and full audit trail from PostgreSQL. |
| `GET /health` · `GET /metrics` | Liveness check · Prometheus metrics. |

Signals to an unknown workflow return `404`; to one that has already finished, `409`.

## Engineering decisions

### Waiting on people: signals and durable timers

The contract and start-date waits are ordinary code, not cron jobs or status polling:

```ts
if (!(await condition(signed, '3 days'))) {   // returns early if the signal arrives
  await acts.sendContractReminder(hire);
  ...
}
```

- Timers are stored by the Temporal server, not held in memory. Nothing runs while waiting, and a wait survives crashes and deploys: with the worker stopped past both deadlines, the reminder and escalation fired as soon as it restarted.
- Signal handlers only record the event; the main flow decides what to do. A start-date change wakes the sleeping workflow, which recomputes the timer.
- Timings are passed as workflow input rather than read from config inside the workflow. They are recorded in history, so changing the config never alters onboardings already running.

### Undoing work across systems: the saga pattern

There is no transaction spanning Slack, payroll and a laptop vendor. Every step with a side effect has a matching undo, registered as soon as the side effect exists, and on cancellation or permanent failure the workflow runs the undos in reverse order of completion.

```
✅ HR record → ✅ contract → ✅ email, Slack, laptop, payroll → ❌ GitHub (5 attempts)
                                        ↓
  cancel laptop → remove payroll → deactivate Slack → deactivate email → void contract → archive HR record
```

Decisions that matter:

- **A cancel interrupts waits immediately, but lets in-flight calls finish.** Interrupting a call that actually succeeded at the vendor would leave an account the rollback doesn't know about. Calls in progress complete (`Promise.allSettled`), then everything that succeeded is undone. A test sends the cancel while a vendor call is blocked mid-flight and checks that the resulting account is still cleaned up.
- **Undos are more persistent than forward steps** (10 attempts, backoff capped at 1 minute, versus 5). One that still fails doesn't block the others; it is flagged and escalated to HR for manual cleanup.
- **Irreversible steps go last.** The welcome email can't be unsent, so it is the final step.
- **The rollback runs in a non-cancellable scope**, so it completes even if an operator cancels the workflow directly in Temporal.
- **A cancellation is a business outcome, not an error**: the workflow completes with status `CANCELLED`; only real failures end as `FAILED`.

Offboarding reuses the same undo operations, starting from the resource IDs the onboarding recorded.

### Retries without duplicates: idempotency keys

Temporal retries failed calls automatically, which raises the classic problem: what if the call succeeded but the response was lost? A naive retry creates `ana.lopez2@company.com` next to an orphaned `ana.lopez@`.

- **The caller sends a key that is the same on every retry of a call and different for every other call** (`<workflow run ID>:<activity ID>`). A rehire is a new workflow run, so it correctly gets new keys.
- **The vendor claims the key before doing the work, and stores the response in the same database transaction as the work.** A repeated key gets the stored response back. Two identical requests arriving together: the second waits on the key until the first commits, then returns its result, so a duplicate never even starts the work.
- **Our own writes are idempotent too**: employee records are upserts, and audit entries are keyed per call.
- **Retries happen in exactly one place.** The AWS SDK's built-in retries are disabled so Temporal's policy is the only one, and every attempt is visible in the workflow history.

Verified by making the vendor drop 60% of its responses after doing the work: 5 responses lost, 5 retries answered from the stored result, exactly one resource per system.

### Duplicate requests and degraded reads

- **Duplicate submissions are rejected by Temporal itself**: the workflow ID is derived from the employee ID, so a second onboarding for the same person returns `409` with no extra table or lock.
- **Progress is read from the workflow's own state** (a Temporal query), so there is no status table to keep in sync. If no worker answers within 3 seconds, the endpoint returns the server-side status instead of hanging.

### Changing code safely: workflow versioning

Temporal rebuilds a workflow's state by replaying its history through the current code. A change like adding a step before an existing one would break every onboarding already in progress. Recorded histories are replayed against the code in CI-style tests; such a change fails them with a determinism error, signalling that it needs Temporal's `patched()` versioning instead of an in-place edit.

### Local and cloud from the same artifacts

The vendors Lambda is a container image built on AWS's official Lambda base image. Locally the worker reaches it through the same AWS SDK call, pointed at a local endpoint; on AWS the endpoint is unset and the SDK calls real Lambda. AWS's local Lambda emulator handles only one invocation at a time (and crashes on concurrent ones), so locally the image runs a small server exposing the same Invoke API, forked into several processes the way Lambda scales out.

## Testing

```bash
npm test                   # 42 unit and workflow tests, no external services (~15s)
npm run test:integration   # 8 tests against the docker-compose Postgres
```

| Suite | What it proves |
| --- | --- |
| Onboarding workflow (12) | Happy path, role-based steps, reminder and escalation timers, start-date changes, retries, and every rollback path: cancel at each stage, cancel during an in-flight call, permanent failure, failing undo, cancel issued through Temporal. |
| Offboarding workflow (3) | Scheduled revocation, phase ordering, skipping resources never created, escalation on failure. |
| Replay (2 histories) | Recorded histories still replay against the current code. |
| API (11) | Validation and routing with the production app configuration. |
| Temporal service (10) | Temporal errors and states mapped to `404`/`409`; degraded progress when no worker responds. |
| Vendor client (3) | Idempotency keys stable across retries, unique per call and per run; Lambda errors surface as retryable failures. |
| Vendor Lambda, integration (8) | Against real Postgres: repeated keys, lost responses, five simultaneous identical requests, same-name address allocation, idempotent deactivation. |

- **Time skipping:** workflow tests run against Temporal's test server with the real production timings; it jumps ahead whenever the workflow is only waiting, so the 7-day escalation and 4-week start-date wait take milliseconds. Tests assert *when* things happen on the workflow clock (e.g. the welcome email exactly one day before a rescheduled start date).
- **The tests were checked by breaking the code on purpose:** undoing steps in forward order fails 4 tests; inserting a new activity call fails both replay tests with Temporal's nondeterminism error.

## Performance and load testing

[k6](loadtest/k6.js) drives full hires (start, sign, sometimes read progress), so every request triggers the whole workflow including parallel vendor calls. Measured locally on an Apple M1 Pro (Docker Desktop, 10 CPUs), single-node Temporal with Postgres, one worker, simulated vendor latency of 0.1–2 s per call, 2-minute constant-rate runs:

| Hires/s offered | Completed/s | API p95 / p99 | Onboarding end-to-end p95 | Backlog after run |
| --- | --- | --- | --- | --- |
| **10** | **10.0** | **91 ms / 221 ms** | **4.9 s** | **0** |
| 15 | 10.6 | 166 ms / 527 ms | 41 s | 230 |
| 20 | 7.6 | 373 ms / 1.7 s | 69 s | 1,275 |
| 25 | 5.0 | 1.0 s / 3.0 s | 90 s | 2,330 |

- **About 10 onboardings/s sustained** (roughly 25 API requests/s, 90 vendor calls/s and 100 workflow tasks/s) with zero errors across all runs.
- **Past ~11/s, throughput drops instead of levelling off.** The API keeps accepting work, so overload shows up as growing queues rather than errors. A production version needs backpressure (e.g. `429` when queueing latency is high).

**What load testing found:**

1. **A real bug in the vendor:** email addresses were allocated by checking candidates one query at a time inside a transaction. With many hires sharing a name, each call ran thousands of queries, starved the connection pool and slowed *every* vendor call to 4–7 s. Replaced with a single query, with tests.
2. **A limitation of the local setup:** the local Lambda stand-in ran in one process and pinned a core; it now forks several, like Lambda scaling out.
3. **An unresolved ceiling:** once those were fixed, none of 3 workers, 500 activity slots, 50 pollers, 64 history shards or disabling Postgres disk flushes raised the ~10/s limit, and no container was CPU-bound. The data points at task dispatch inside the single-node Temporal server; the exact cause is not identified yet. The investigation, including the hypotheses that turned out wrong, is in [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md#load-test-investigation).

## Observability

Prometheus and Grafana run locally alongside the stack, with a provisioned dashboard ([monitoring/](monitoring/)):

- **Business outcomes:** onboardings completed and rolled back, HR escalations, duplicates prevented by idempotency.
- **API:** throughput by route, p50/p95/p99 latency, responses by status.
- **Saturation signals:** workflow completions, activity latency and failures by type, queueing (schedule-to-start) latency, worker slots, Temporal persistence latency.

Metrics come from the API (`prom-client`), the worker (Temporal SDK exporter plus custom counters for every audit event and every replayed vendor response) and the Temporal server. Every action is also written to an audit log in PostgreSQL, exposed at `GET /employees/:id`.

## Deployment on AWS

Everything is in [infra/](infra/) (Terraform). One `terraform apply` builds and pushes both images, creates the infrastructure and boots the stack.

```
              your IP only, :3000
Internet ──────────────────────────▶ EC2 t4g.small (docker compose)
                                       ├─ API, worker      (image from ECR)
                                       ├─ Temporal (+ UI, reachable only through SSM)
                                       ├─ worker ── lambda:InvokeFunction ──▶ Lambda "vendors" (in the VPC)
                                       └─ PostgreSQL ◀── :5432 from the Lambda's security group only
```

| Concern | Choice |
| --- | --- |
| Compute | One EC2 instance (ARM, 2 GB) running the same containers as locally. The Temporal server and worker are long-running processes, so they don't fit Lambda; the vendor calls do. |
| Security | API open only to the deployer's IP. No SSH port: shell access and the Temporal UI go through SSM Session Manager. IMDSv2 required. IAM roles grant only what is used (invoke one Lambda, read one parameter, pull images). Database password generated by Terraform, stored encrypted in SSM Parameter Store, never in user data or git. |
| Cost | About $17/month. Two budget alerts by email: any charge not covered by credits, and forecast usage above $25/month. `terraform destroy` removes everything. |
| Updates | `terraform apply` rebuilds only images whose sources changed and updates the Lambda; `infra/scripts/redeploy.sh` rolls the new images onto the host through SSM without replacing it or its data. |

Step-by-step instructions are in [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md#deploying-to-aws).

## Limitations and next steps

Deliberate scope limits for a portfolio project, and what a production version would add:

- **Single-node, self-hosted Temporal on one EC2 instance.** Production would use Temporal Cloud or a multi-node cluster with a managed database (RDS), and run API and workers on ECS or Kubernetes behind a load balancer.
- **No authentication on the API**; access is restricted by IP. Production needs authentication and authorization (e.g. who may cancel an onboarding).
- **No backpressure.** Overload becomes latency rather than a `429`.
- **The throughput ceiling is not explained yet** (see the load testing section).
- **Vendors are simulated.** Real integrations would add webhooks (e.g. the e-signature provider calling the signature endpoint), API credentials in Secrets Manager, and vendor rate limits.
- **No CI pipeline yet.** The tests are ready to run in one (unit tests need nothing external).

## Repository map

| Path | Contents |
| --- | --- |
| [src/workflows.ts](src/workflows.ts) | `onboardingWorkflow` and `offboardingWorkflow`: the orchestration, saga and timers |
| [src/activities.ts](src/activities.ts) | One activity per external operation plus its undo; database writes and audit events |
| [src/vendors.ts](src/vendors.ts) | Lambda client and idempotency-key derivation |
| [src/temporal.service.ts](src/temporal.service.ts) | Temporal client: start, signal, query; maps Temporal errors to HTTP |
| [src/*.controller.ts](src/) | REST endpoints and request validation |
| [src/worker.ts](src/worker.ts) | Worker process and metrics exporter |
| [lambdas/vendors/](lambdas/vendors/) | The vendors Lambda: handler, container image, local Invoke-API server |
| [test/](test/) | Workflow, replay, API and integration tests; recorded histories |
| [infra/](infra/) | Terraform for AWS |
| [monitoring/](monitoring/) | Prometheus config and Grafana dashboard |
| [loadtest/k6.js](loadtest/k6.js) | Load test |
| [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md) | Maintainer notes: running, operating, explaining the project |
