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

export default function () {
  const res = http.get('http://localhost:3000/workflow/start');
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}
