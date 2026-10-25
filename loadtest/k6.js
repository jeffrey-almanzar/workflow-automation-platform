import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<300'],
    http_req_failed: ['rate<0.01'],
  },
  stages: [
    { duration: '5m', target: 100 },
    { duration: '10m', target: 2000 },
    { duration: '5m', target: 0 },
  ],
};

const roles = ['engineer', 'sales', 'operations'];

export default function () {
  // Unique per VU + iteration: the API rejects duplicate employee IDs with 409.
  const employeeId = `load-${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({
    employeeId,
    fullName: 'Load Test',
    personalEmail: `${employeeId}@example.com`,
    role: roles[__ITER % roles.length],
    startDate: '2026-12-01',
  });
  const res = http.post('http://localhost:3000/onboardings', payload, {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, {
    'status is 202': (r) => r.status === 202,
  });
  sleep(1);
}
