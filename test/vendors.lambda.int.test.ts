// The vendors Lambda handler against the real docker-compose Postgres: the
// idempotency guarantees that make Temporal's retries safe.

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { VendorRequest, closePool, handler } from '../lambdas/vendors/index';

jest.setTimeout(30_000);

const db = new Pool({ connectionString: process.env.DATABASE_URL });
const employeeId = `IT-${randomUUID().slice(0, 8)}`;
// Letters only: the email vendor derives the address from the name.
const fullName = `Test ${randomUUID().replace(/[^a-f]/g, '').slice(0, 10) || 'abc'}`;

function request(overrides: Partial<VendorRequest> = {}): VendorRequest {
  return {
    system: 'email',
    operation: 'create',
    idempotencyKey: `${employeeId}:${randomUUID()}`,
    payload: { employeeId, fullName },
    ...overrides,
  };
}

async function resources(system = 'email') {
  const { rows } = await db.query('SELECT resource_id, status FROM vendors.resources WHERE employee_id = $1 AND system = $2', [
    employeeId,
    system,
  ]);
  return rows;
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {}); // the handler logs every request
});

beforeEach(async () => {
  // Earlier tests in this file must not affect counts in the next one.
  await handler(request({ operation: 'send' })); // ensures the schema exists
  await db.query('DELETE FROM vendors.resources WHERE employee_id = $1', [employeeId]);
});

afterAll(async () => {
  await db.query('DELETE FROM vendors.resources WHERE employee_id = $1', [employeeId]);
  await db.query('DELETE FROM vendors.requests WHERE idempotency_key LIKE $1', [`${employeeId}:%`]);
  await Promise.all([db.end(), closePool()]);
});

test('a repeated key returns the stored response instead of creating a second resource', async () => {
  const req = request();
  const first = await handler(req);
  const second = await handler(req);
  expect(first.replayed).toBe(false);
  expect(second).toEqual({ resourceId: first.resourceId, replayed: true });
  expect(await resources()).toHaveLength(1);
});

test('lost response: the work is committed, and the retry gets the same resource back', async () => {
  const req = request();
  process.env.MOCK_LOST_RESPONSE_RATE = '1';
  await expect(handler(req)).rejects.toThrow(/connection reset after the request was processed/);
  process.env.MOCK_LOST_RESPONSE_RATE = '0';

  const retry = await handler(req);
  expect(retry.replayed).toBe(true);
  expect(await resources()).toEqual([{ resource_id: retry.resourceId, status: 'active' }]);
});

test('concurrent identical requests: exactly one does the work, all get the same answer', async () => {
  const req = request();
  // Some processing time guarantees the five transactions overlap.
  process.env.MOCK_LATENCY_SCALE = '0.3';
  const results = await Promise.all(Array.from({ length: 5 }, () => handler(req))).finally(() => {
    process.env.MOCK_LATENCY_SCALE = '0';
  });
  expect(new Set(results.map((r) => r.resourceId)).size).toBe(1);
  expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  expect(await resources()).toHaveLength(1);
});

test('different keys for the same name are different hires and get distinct addresses', async () => {
  const a = await handler(request());
  const b = await handler(request());
  expect(a.resourceId).not.toBe(b.resourceId);
  expect(b.resourceId).toBe(a.resourceId.replace('@', '2@'));
});

test('a failed call stores nothing, so the retry does the work', async () => {
  const req = request({ system: 'slack' });
  process.env.MOCK_FAILING_SYSTEMS = 'slack';
  await expect(handler(req)).rejects.toThrow('slack is temporarily unavailable');
  process.env.MOCK_FAILING_SYSTEMS = '';

  const retry = await handler(req);
  expect(retry.replayed).toBe(false);
  expect(await resources('slack')).toHaveLength(1);
});

test('deactivation is idempotent, including for resources that no longer exist', async () => {
  const created = await handler(request({ system: 'slack' }));
  const deactivate = request({ system: 'slack', operation: 'deactivate', payload: { resourceId: created.resourceId } });
  await handler(deactivate);
  await handler({ ...deactivate, idempotencyKey: `${employeeId}:${randomUUID()}` }); // a second, distinct undo
  expect(await resources('slack')).toEqual([{ resource_id: created.resourceId, status: 'inactive' }]);

  const unknown = request({ system: 'slack', operation: 'deactivate', payload: { resourceId: 'U-does-not-exist' } });
  await expect(handler(unknown)).resolves.toEqual({ resourceId: 'U-does-not-exist', replayed: false });
});

test('rejects malformed requests', async () => {
  await expect(handler(request({ system: 'fax' as never }))).rejects.toThrow('Unknown system: fax');
  await expect(handler(request({ idempotencyKey: '' }))).rejects.toThrow('idempotencyKey is required');
});
