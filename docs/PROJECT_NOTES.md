# Project notes

Maintainer notes for coming back to this project: how to explain it, run it, operate it, and what was learned along the way. The public overview is the [README](../README.md).

- [Explaining the project](#explaining-the-project)
- [Running locally](#running-locally)
- [Demo scenarios](#demo-scenarios)
- [Configuration reference](#configuration-reference)
- [Tests](#tests)
- [Load testing](#load-testing)
- [Load test investigation](#load-test-investigation)
- [Deploying to AWS](#deploying-to-aws)
- [Gotchas and lessons](#gotchas-and-lessons)
- [How the project evolved](#how-the-project-evolved)

## Explaining the project

### In 30 seconds

> I built an employee onboarding system on Temporal. Onboarding spans weeks, waits on people, and touches six external systems, so it's a good test of the hard parts of backend work. It survives crashes mid-process, undoes everything if a hire is cancelled or a system fails for good, and never creates duplicate accounts when calls are retried. It has 50 tests, including ones that fast-forward through the real 7-day and 4-week timers, I load-tested it and fixed what that found, and it's deployed to AWS with Terraform.

### In 2 minutes

1. **The problem:** onboarding is a long-running, multi-system process. It waits for a contract signature, provisions email, Slack, GitHub, a laptop and payroll, then waits until the start date. Doing that with a normal backend means status tables, cron jobs and hand-written retry logic.
2. **The approach:** each onboarding is a Temporal workflow. Waits are durable timers and signals, so a 4-week wait is one line of code and survives restarts. Each external call is an activity that Temporal retries with backoff.
3. **Failure handling:** every step has an undo. If the hire is cancelled or a step fails for good, completed steps are undone in reverse order (saga). Cancels interrupt waits but let in-flight calls finish, so nothing that succeeded escapes the rollback.
4. **Correctness under retries:** every external call carries an idempotency key; the vendor stores the key with the result in the same transaction, so a retry after a lost response gets the original result instead of a second account. I proved it by making the vendor drop 60% of its responses.
5. **Evidence:** 50 tests, including time-skipping workflow tests and replay tests that catch changes which would break running workflows; a load test that measured 10 onboardings/s sustained and found a real bug; Prometheus/Grafana dashboards; Terraform deployment to AWS with least-privilege IAM.

### Questions to be ready for

**Why Temporal instead of a queue plus a database and cron jobs?**
That design works, but you end up rebuilding Temporal: a status table per process, cron jobs finding overdue items, retry bookkeeping, locking so two cron runs don't process the same row, and recovery code for crashes mid-step. With Temporal the process is ordinary code, state and timers are persisted by the server, and retries are policy. The trade-off is operating Temporal itself and the determinism rules for workflow code.

**What is a saga, and why not a distributed transaction?**
A saga is a sequence of local steps where each has a compensating action, run in reverse if a later step fails. Distributed transactions (two-phase commit) need every participant to support them and hold locks across systems; SaaS APIs like Slack or payroll don't. This is an orchestrated saga (one workflow coordinates the steps) as opposed to choreography (services reacting to each other's events); orchestration keeps the whole process readable in one place and easy to observe.

**What happens if the worker crashes in the middle?**
Nothing is lost. The workflow's state is its event history on the Temporal server. When a worker comes back, Temporal replays the history to rebuild the state and continues; timers that expired while it was down fire immediately. I demonstrated this by stopping the worker past both contract deadlines.

**How do you prevent duplicate accounts when retrying?**
Idempotency keys on both sides: the caller derives a key that is stable across retries (`workflow run ID:activity ID`); the vendor claims the key before doing the work and stores the response in the same transaction. A retry gets the stored response. SDK-level retries are disabled so Temporal is the only retry layer.

**What does "deterministic" mean for workflow code, and how do you change it safely?**
Workflow code must make the same decisions when replayed from history: no direct I/O, randomness or wall-clock reads (Temporal's sandbox provides replay-safe `Date.now()`). Changing the order of steps breaks running workflows. I record histories and replay them in tests; a breaking change fails with a nondeterminism error, and the fix is `patched()` versioning.

**How did you test multi-day timers?**
Temporal's time-skipping test server: when the workflow is only waiting on a timer, it jumps ahead. The tests use real production timings, and mock activities record the workflow-clock time of each call, so I can assert the welcome email went out exactly one day before a rescheduled start date.

**What did load testing show?**
About 10 onboardings/s sustained on my laptop with p95 API latency of 91 ms. It found a real bug: the vendor allocated email addresses with one query per candidate inside a transaction, which starved its connection pool with many same-name hires. After fixing it, the ceiling didn't move with more workers, slots, pollers or shards; the data points at task dispatch in the single-node Temporal server, and I haven't pinned the cause. I'd add backpressure (a `429` when queueing latency rises) because overload currently shows up as growing queues.

**Why run the worker on EC2 and not Lambda?**
The worker and the Temporal server are long-running processes that hold connections and poll continuously; Lambda's model (short, stateless invocations) doesn't fit. The vendor calls do fit Lambda, so that's what runs there.

**What would you change for production?**
Temporal Cloud or a multi-node cluster, managed Postgres, API and workers on ECS behind a load balancer, authentication on the API, backpressure, secrets in Secrets Manager, a CI pipeline, and remote Terraform state.

**What was the hardest part?**
Good candidates: getting the cancel/compensation semantics right (the in-flight-call race), or the load-test investigation, where several plausible hypotheses turned out wrong and only measuring one variable at a time got to real answers.

## Running locally

```bash
docker compose up -d --build        # API :3000, Temporal UI :8080, Grafana :3001, Prometheus :9090
docker compose down                 # stop (add -v to also delete the data volumes)
```

The real timers are days long. For demos, shorten them (any [`ms`](https://github.com/vercel/ms) duration) and use a start date a minute away:

```bash
CONTRACT_REMINDER_DELAY="20 seconds" CONTRACT_ESCALATION_DELAY="20 seconds" WELCOME_LEAD_TIME="10 seconds" \
  docker compose up -d app
docker compose up -d app            # back to the real timers (3 days / 7 days / 1 day before start)
```

Useful checks:

```bash
curl localhost:3000/onboardings/onboarding-E1 | python3 -m json.tool
curl localhost:3000/employees/E1 | python3 -m json.tool
docker compose exec postgres psql -U user -d workflows \
  -c "SELECT employee_id, system, resource_id, status FROM vendors.resources WHERE employee_id='E1' ORDER BY system;"
```

## Demo scenarios

Use a new `employeeId` for each. Reset the vendor after each failure experiment with `docker compose up -d vendors`.

| Scenario | How | What to show |
| --- | --- | --- |
| Happy path | Start, sign, wait | Phases in `GET /onboardings/:id`; employee `ACTIVE` with an audit trail of real vendor IDs |
| Worker crash | Start (don't sign), `docker compose stop worker`, wait past the demo deadlines, `docker compose start worker` | Reminder and escalation fire as soon as the worker is back |
| Start date change | `PATCH /onboardings/:id/start-date` while waiting | Welcome email goes out at the new time |
| Cancel at any stage | `POST /onboardings/:id/cancellation` with `{"reason":"..."}` | Completed steps `compensated`, in reverse order; employee `ARCHIVED` |
| Cancel during provisioning | Cancel right after signing | In-flight calls finish, then are undone too |
| Vendor outage | `MOCK_FAILING_SYSTEMS=github docker compose up -d vendors`, then onboard an engineer | 5 attempts with backoff in the Temporal UI, everything else rolled back, `FAILED`, HR escalation in the audit log |
| Lost responses | `MOCK_LOST_RESPONSE_RATE=0.6 docker compose up -d vendors` | Completes anyway; `"replayed": true` in the audit log; exactly one resource per system |
| Duplicate submit | Same `POST /onboardings` twice | `409` |
| Offboarding | `POST /offboardings` for a completed hire | Access cut first, HR record archived last |
| Cancel through Temporal | `docker compose exec temporal temporal workflow cancel --workflow-id onboarding-X --address temporal:7233` | Rollback still runs to completion |

Keep the Temporal UI (http://localhost:8080) and Grafana (http://localhost:3001) open while demoing.

## Configuration reference

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `CONTRACT_REMINDER_DELAY`, `CONTRACT_ESCALATION_DELAY`, `WELCOME_LEAD_TIME` | app | 3 days, 4 days, 1 day | Timer overrides; invalid values stop the API at boot |
| `DATABASE_URL`, `TEMPORAL_ADDRESS` | app, worker | compose values | Connections |
| `LAMBDA_ENDPOINT` | worker | `http://vendors:8080` locally; unset on AWS | Points the AWS SDK at the local Lambda |
| `VENDOR_FUNCTION_NAME`, `AWS_REGION` | worker | `function`, `us-east-1` locally | Which Lambda to invoke |
| `WORKER_MAX_CACHED_WORKFLOWS` | worker | SDK default (from heap size) | Bounds worker memory on small hosts (200 on AWS) |
| `METRICS_BIND_ADDRESS` | worker | `0.0.0.0:9464` | Prometheus exporter |
| `MOCK_FAILURE_RATE` | vendors | 0 | Probability a call fails before doing any work |
| `MOCK_FAILING_SYSTEMS` | vendors | empty | Systems that always fail, e.g. `github,slack` |
| `MOCK_LOST_RESPONSE_RATE` | vendors | 0 | Probability the work is committed but the response is lost |
| `MOCK_LATENCY_SCALE` | vendors | 1 | Multiplier on simulated latency (0 in integration tests) |
| `LOCAL_LAMBDA_PROCESSES` | vendors (local) | 4 | Processes in the local Invoke-API server |
| `PG_POOL_MAX` | vendors | 2 (10 locally) | Connection pool per process |
| `TEMPORAL_HISTORY_SHARDS`, `TEMPORAL_DB` | temporal (local) | 4, `temporal` | Shard count is fixed per database, so a new count needs a new database name |

## Tests

```bash
npm test                              # unit + workflow + replay (no services needed)
npm run test:integration              # vendor Lambda against the compose Postgres on localhost:5432
npm run test:record-histories v2      # record new replay fixtures after an intentional workflow change
```

When changing workflow code: if the replay test fails, the change would break onboardings already running. Either gate it with `patched()` or, if no old workflows can exist, record new fixtures, keeping the old ones for as long as such workflows may be running.

## Load testing

```bash
docker compose --profile loadtest run --rm -e RATE=10 -e DURATION=2m k6   # constant rate
docker compose --profile loadtest run --rm k6                              # ramp 25 -> 200 hires/s
```

Above capacity, workflows keep running after k6 stops. Clean up:

```bash
docker compose exec temporal temporal workflow terminate \
  --query "ExecutionStatus='Running' AND WorkflowId STARTS_WITH 'onboarding-lt-'" --yes --address temporal:7233
docker compose exec postgres psql -U user -d workflows -c \
  "DELETE FROM audit_log WHERE employee_id LIKE 'lt-%'; DELETE FROM employees WHERE employee_id LIKE 'lt-%'; DELETE FROM vendors.resources WHERE employee_id LIKE 'lt-%';"
```

Compare runs at a constant rate, change one thing at a time, and start each from a clean state; a backlog left by the previous run invalidates the next measurement.

## Load test investigation

The first ramp test peaked at about 6 completions/s with 0 errors but multi-second latency. What was tried, in order, and what each showed:

| Hypothesis | Change | Result |
| --- | --- | --- |
| Not enough pollers (activity slots looked idle) | Autoscaling pollers | No improvement; reverted |
| Worker cache thrashing (high "replay" metric) | 3 worker replicas | No improvement. Later found the replay metric counts every workflow task, so this reading was wrong |
| Too few history shards (shard semaphore waits up to ~1 s) | 64 shards on a new database | No improvement |
| Single-process local Lambda (one core pinned) | Fork 4 processes | Vendor CPU spread out; completions unchanged |
| **Vendor calls taking 4–7 s** | Read activity latency per type | **Root cause of the slowness:** every load-test hire had the same name, and email allocation probed addresses one query at a time inside a transaction, starving the connection pool. Fixed with a single query; load test now uses unique names |
| Postgres commit latency | `synchronous_commit=off` (temporarily) | Small gain only; restored |
| Activity slots (Little's law predicted a ~12/s ceiling) | 500 slots | Small gain; prediction mostly wrong |
| Activity task delivery | 500 slots + 50 pollers | No improvement |
| Shards again, cleanly (the first test was contaminated by the email bug) | 64 shards | No improvement |

Conclusions:

- Measured, after fixes: ~10 onboardings/s sustained; throughput degrades above ~11/s.
- Every experiment before the email fix was contaminated by it; findings from that period don't count.
- The remaining ceiling appears as activity schedule-to-start latency (tasks waiting in Temporal's matching service while workers have free slots), with no component CPU-bound. Next things to try: Temporal's dynamic config for matching (task queue partitions, forwarder settings), a non-`auto-setup` server configuration, and profiling the server.
- Lesson: change one variable at a time against a clean baseline, and check what a metric actually counts before building an explanation on it.

## Deploying to AWS

### Account constraints

- The AWS account belongs to an organization whose policy only allows **us-east-2**. Calls in other regions fail with "explicit deny in a service control policy", even for an administrator.
- The account is on the AWS Free plan: usage is paid from credits (check with `aws freetier get-account-plan-state --region us-east-2`), and the plan has an expiry date.
- The CLI's default region may differ; pass `--region us-east-2` when using the AWS CLI directly.

### Prerequisites

```bash
brew tap hashicorp/tap && brew install hashicorp/tap/terraform awscli   # terraform is not in homebrew-core
brew install --cask session-manager-plugin
aws configure                       # access key of an IAM user, never the root account
aws sts get-caller-identity
```

### Deploy, update, destroy

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # set alert_email
terraform init
terraform apply                                # builds images, creates ~26 resources, boots the stack
curl "$(terraform output -raw api_url)/health" # {"status":"ok"} a few minutes after apply

# after code changes
terraform apply && ./scripts/redeploy.sh

terraform destroy                              # removes everything, including the database
```

### Operating it

| Need | Command |
| --- | --- |
| Shell on the host | `$(terraform output -raw shell)`, or EC2 console → Connect → Session Manager |
| Temporal UI | `$(terraform output -raw temporal_ui_tunnel)`, then http://localhost:8088 |
| First-boot log | in a shell: `sudo tail -f /var/log/cloud-init-output.log` |
| Containers and logs | `cd /opt/onboarding && sudo docker compose ps` / `sudo docker compose logs --tail 50 worker` |
| Database | `sudo docker compose exec postgres psql -U onboarding -d workflows` |
| Lambda logs | CloudWatch log group `/aws/lambda/onboarding-vendors` |
| Failure injection | Lambda console → Configuration → Environment variables (`MOCK_*`); the next `terraform apply` removes them |

- The console must be set to **US East (Ohio)** to see the resources. Tag Editor with `Project = onboarding` lists them all.
- **The API only accepts your IP.** If your IP changes, run `terraform apply` to update the rule.
- **`terraform.tfstate` exists only on this machine** (git-ignored; it contains the generated DB password). Back it up. Without it, Terraform can't manage or destroy the resources, and they'd have to be deleted by hand. Production would keep state in S3 with locking.
- Cost is about $17/month from credits. Budget alerts email you for any charge credits don't cover, and when forecast monthly usage exceeds $25. Destroy when not demoing.

## Diagrams and screenshots

**Diagrams** are [D2](https://d2lang.com) sources in [docs/diagrams/](diagrams/). After editing one, run `npm run docs:diagrams` (needs `brew install d2`). The SVGs switch between light and dark with the viewer's theme, and AWS icons are embedded, because GitHub blocks external images inside SVGs. Layout gotcha: the ELK layout engine ignores `direction` inside containers, which is why the saga diagram uses a two-column grid.

**Screenshots** in [docs/images/](images/):

- **Temporal UI and Grafana:** captured with a headless browser (Playwright) against the local stack, after seeding data:
  1. Point Temporal at a clean database so the workflow list isn't cluttered: `TEMPORAL_DB=temporal_demo` plus the demo timers.
  2. Run the [demo scenarios](#demo-scenarios), then a short k6 run at 5/s with `MOCK_FAILURE_RATE=0.05 MOCK_LOST_RESPONSE_RATE=0.05` for Grafana.
  3. With demo timers, k6 hires (start date one hour out) wait for the welcome email. Release them with a batch signal: `temporal workflow signal --query "ExecutionStatus='Running' AND WorkflowId STARTS_WITH 'onboarding-lt-'" --name updateStartDate --input '"<now>"' --yes`.
  4. In the Temporal UI, the **Compact** event history view reads better than the timeline when the steps are close together in time.
- **AWS console:** taken by hand. Before publishing, crop out the browser bar and console header (account ID, account alias, bookmarks) and blur public IPs.

## Gotchas and lessons

| Symptom | Cause and fix |
| --- | --- |
| `TypeError: type must be a Type` from Temporal's history JSON helpers | npm installed three copies of `protobufjs@8` because grpc's `protobufjs@7` took the root slot; Temporal checks `instanceof` across copies. Fixed by adding `protobufjs@8.8.1` as a direct dependency |
| AWS Lambda emulator segfaults (`ReserveFailed: AlreadyReserved`) | The Runtime Interface Emulator handles one invocation at a time. Locally the image runs `local-server.js`, which serves the same Invoke API concurrently |
| `terraform apply`: "The specified item already exists in the keychain" | Two image builds ran `docker login` to the same registry at once. Builds are now sequential (`depends_on`) |
| Lambda rejects the image manifest | buildx attaches provenance by default, producing a manifest list. Build with `--provenance=false` |
| Containers on EC2 can't get AWS credentials | IMDSv2's default hop limit of 1 doesn't reach containers. Set `http_put_response_hop_limit = 2` |
| Changing Temporal's history shard count fails | It is fixed when the database is created; use a new database |
| First event of a new metric missing in Grafana stats | Prometheus `rate()`/`increase()` don't count the first sample of a new series; irrelevant under real traffic |
| `temporal_workflow_task_replay_latency` looks alarming | It is recorded for every workflow task, not only cache misses |
| Simultaneous identical vendor requests | Claim the idempotency key before doing the work, so the duplicate waits instead of performing it (the earlier order was safe only because the simulated work could be rolled back) |
| AWS SDK warns about Node 20 | Node 20 is end-of-life; images use Node 22 |

## How the project evolved

The repository started as a "hello world" Temporal workflow with an aspirational README. It was rebuilt in increments, each running end to end before the next:

1. **Core flow:** onboarding workflow, parallel provisioning with retries, progress query, deduplication through the workflow ID.
2. **Human steps:** contract signature signal, reminder and escalation timers, start-date wait and rescheduling; verified across a worker crash.
3. **Saga:** cancellation, compensation in reverse order, offboarding reusing the undo activities.
4. **Real systems:** PostgreSQL record and audit log, vendors as an AWS Lambda container, idempotency keys, lost-response testing.
5. **Tests:** time-skipping workflow tests, replay tests, API and integration tests; checked by breaking the code deliberately.
6. **Observability and load testing:** Prometheus, Grafana dashboard, k6; two bugs found and fixed; ceiling measured.
7. **Deployment:** Terraform for EC2, Lambda, ECR, IAM and budgets.

Earlier README claims of business impact (processes automated per month, cost savings) and throughput targets (2,000 req/s) were removed: they were never measured. Use the measured numbers and demonstrated behavior instead.
