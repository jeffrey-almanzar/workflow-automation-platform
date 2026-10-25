// Load test: each iteration is a full hire. It starts an onboarding, signs the
// contract (which triggers parallel provisioning against the vendors), and
// sometimes reads progress. The start date is an hour out, so the welcome email
// is due immediately and every workflow runs to completion.
//
// The arrival rate steps up (25 -> 50 -> 100 -> 200 hires/s) to find the saturation
// point. Watch Grafana (http://localhost:3001) while it runs.
//
//   docker compose --profile loadtest run --rm k6
//
// Note: at rates above what the worker can complete, workflows queue up in
// Temporal and keep running after k6 finishes.

import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

// RATE=50 runs a constant rate instead of the ramp, for before/after comparisons:
//   docker compose --profile loadtest run --rm -e RATE=50 -e DURATION=2m k6
const constant = __ENV.RATE && {
  executor: 'constant-arrival-rate',
  rate: Number(__ENV.RATE),
  timeUnit: '1s',
  duration: __ENV.DURATION || '2m',
  preAllocatedVUs: 100,
  maxVUs: 1000,
};

export const options = {
  scenarios: {
    hires: constant || {
      executor: 'ramping-arrival-rate',
      timeUnit: '1s',
      startRate: 5,
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { target: 25, duration: '30s' },
        { target: 25, duration: '1m' },
        { target: 50, duration: '30s' },
        { target: 50, duration: '1m' },
        { target: 100, duration: '30s' },
        { target: 100, duration: '1m' },
        { target: 200, duration: '30s' },
        { target: 200, duration: '1m' },
      ],
    },
  },
  // Targets from the README. They are allowed to fail: the point is to measure.
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<300'],
    http_req_failed: ['rate<0.001'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const employeeId = `lt-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Date.now()}`;
  const startDate = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

  const start = http.post(
    `${BASE_URL}/onboardings`,
    JSON.stringify({
      employeeId,
      // Unique per hire (letters only, since emails are derived from the name), like
      // real hires. A single shared name made every hire compete for one address.
      fullName: `Load ${employeeId.replace(/\d/g, (d) => 'abcdefghij'[d]).replace(/[^a-z]/g, '')}`,
      personalEmail: `${employeeId}@example.com`,
      role: ['engineer', 'sales', 'operations'][exec.vu.iterationInScenario % 3],
      startDate,
    }),
    { ...JSON_HEADERS, tags: { name: 'POST /onboardings' } },
  );
  check(start, { 'start: 202': (r) => r.status === 202 });
  if (start.status !== 202) return;

  const id = start.json('onboardingId');
  const sign = http.post(`${BASE_URL}/onboardings/${id}/contract-signature`, null, {
    tags: { name: 'POST /onboardings/:id/contract-signature' },
  });
  check(sign, { 'sign: 202': (r) => r.status === 202 });

  // 1 in 10 users checks progress (a query answered by the worker).
  if (Math.random() < 0.1) {
    const progress = http.get(`${BASE_URL}/onboardings/${id}`, { tags: { name: 'GET /onboardings/:id' } });
    check(progress, { 'progress: 200': (r) => r.status === 200 });
  }
}
