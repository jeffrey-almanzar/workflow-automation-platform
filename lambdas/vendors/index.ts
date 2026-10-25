// AWS Lambda that stands in for the external SaaS vendors onboarding talks to
// (e-signature, email, Slack, GitHub, laptop vendor, payroll). It keeps its own
// state in a separate `vendors` schema, the way a real vendor has its own database.
//
// Every request carries an idempotency key. The key is claimed and the response
// stored in the same transaction as the side effect, so a retried request (e.g.
// after a timeout where the work actually succeeded) gets the original response
// back instead of creating a second account, even if the duplicates race.
//
// Failure injection, for demos:
//   MOCK_FAILURE_RATE        probability (0-1) a call fails before doing any work
//   MOCK_FAILING_SYSTEMS     comma-separated systems that always fail, e.g. "github,slack"
//   MOCK_LOST_RESPONSE_RATE  probability the work is committed but the response is lost
//   MOCK_LATENCY_SCALE       multiplier for simulated latency (0 disables it, e.g. in tests)

import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';

export const SYSTEMS = ['esignature', 'email', 'slack', 'github', 'laptop', 'payroll'] as const;
export type VendorSystem = (typeof SYSTEMS)[number];
export type VendorOperation = 'create' | 'deactivate' | 'send' | 'update';

export interface VendorRequest {
  system: VendorSystem;
  operation: VendorOperation;
  idempotencyKey: string;
  payload: Record<string, string | undefined>;
}

export interface VendorResponse {
  resourceId: string;
  replayed: boolean; // true when this is a stored response to an earlier identical request
}

// Created outside the handler so warm invocations reuse connections. On AWS each
// instance serves one request at a time, so a tiny pool is enough; the local
// server runs invocations concurrently in one process and raises it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 2) });
let migrated: Promise<void> | undefined;

// Read per invocation (it's cheap) so tests can change failure injection between calls.
function mockConfig() {
  return {
    failureRate: Number(process.env.MOCK_FAILURE_RATE ?? 0),
    lostResponseRate: Number(process.env.MOCK_LOST_RESPONSE_RATE ?? 0),
    latencyScale: Number(process.env.MOCK_LATENCY_SCALE ?? 1),
    failingSystems: new Set(
      (process.env.MOCK_FAILING_SYSTEMS ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

export function closePool(): Promise<void> {
  return pool.end();
}

// Per-vendor latency range in ms. The laptop vendor is the slowest.
const LATENCY: Record<VendorSystem, [number, number]> = {
  esignature: [200, 800],
  email: [100, 600],
  slack: [200, 800],
  github: [200, 800],
  laptop: [800, 2000],
  payroll: [200, 1000],
};

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // Several cold-starting instances may race; the advisory lock serializes them.
    await client.query("SELECT pg_advisory_lock(hashtext('vendors-migrations'))");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS vendors;
      CREATE TABLE IF NOT EXISTS vendors.requests (
        idempotency_key TEXT PRIMARY KEY,
        system          TEXT NOT NULL,
        operation       TEXT NOT NULL,
        response        JSONB NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vendors.resources (
        system      TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        employee_id TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (system, resource_id)
      );
    `);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('vendors-migrations'))").catch(() => {});
    client.release();
  }
}

function validate(event: VendorRequest): void {
  if (!SYSTEMS.includes(event?.system)) throw new Error(`Unknown system: ${event?.system}`);
  if (!['create', 'deactivate', 'send', 'update'].includes(event.operation)) {
    throw new Error(`Unknown operation: ${event.operation}`);
  }
  if (!event.idempotencyKey) throw new Error('idempotencyKey is required');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Email addresses are allocated like a real provider would: if the address is
// taken, append a number. Without idempotency, a retried request would get
// "ana.lopez2@" and the first account would be orphaned.
async function allocateEmail(db: PoolClient, fullName = 'new hire'): Promise<string> {
  const local = fullName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .join('.');
  for (let n = 1; ; n++) {
    const candidate = `${local}${n === 1 ? '' : n}@company.com`;
    const taken = await db.query('SELECT 1 FROM vendors.resources WHERE system = $1 AND resource_id = $2', [
      'email',
      candidate,
    ]);
    if (taken.rowCount === 0) return candidate;
  }
}

const PREFIX: Record<VendorSystem, string> = {
  esignature: 'envelope',
  email: 'email',
  slack: 'U',
  github: 'gh-invite',
  laptop: 'order',
  payroll: 'payroll',
};

async function perform(db: PoolClient, { system, operation, payload }: VendorRequest): Promise<string> {
  switch (operation) {
    case 'create': {
      const resourceId =
        system === 'email'
          ? await allocateEmail(db, payload.fullName)
          : `${PREFIX[system]}-${randomUUID().slice(0, 8)}`;
      await db.query('INSERT INTO vendors.resources (system, resource_id, employee_id) VALUES ($1, $2, $3)', [
        system,
        resourceId,
        payload.employeeId,
      ]);
      return resourceId;
    }
    case 'deactivate': {
      // Deactivating something already inactive (or unknown) is a success: undo
      // operations get retried, and "already gone" is the desired end state.
      await db.query(
        "UPDATE vendors.resources SET status = 'inactive', updated_at = now() WHERE system = $1 AND resource_id = $2",
        [system, payload.resourceId],
      );
      return payload.resourceId ?? '';
    }
    case 'update':
      await db.query('UPDATE vendors.resources SET updated_at = now() WHERE system = $1 AND resource_id = $2', [
        system,
        payload.resourceId,
      ]);
      return payload.resourceId ?? '';
    case 'send':
      // Messages (reminders, welcome emails, return labels) aren't tracked as resources.
      return `msg-${randomUUID().slice(0, 8)}`;
  }
}

export const handler = async (event: VendorRequest): Promise<VendorResponse> => {
  validate(event);
  await (migrated ??= migrate());

  const prior = await pool.query('SELECT response FROM vendors.requests WHERE idempotency_key = $1', [
    event.idempotencyKey,
  ]);
  if (prior.rowCount) {
    console.log(JSON.stringify({ msg: 'replayed', system: event.system, key: event.idempotencyKey }));
    return { ...prior.rows[0].response, replayed: true };
  }

  const config = mockConfig();
  const db = await pool.connect();
  let response: VendorResponse;
  try {
    await db.query('BEGIN');
    // Claim the key *before* doing the work. If an identical request is in flight,
    // this INSERT blocks until that transaction ends: if it committed, we get a
    // conflict and return its response; if it rolled back, we proceed.
    const claimed = await db.query(
      `INSERT INTO vendors.requests (idempotency_key, system, operation, response)
       VALUES ($1, $2, $3, '{}') ON CONFLICT (idempotency_key) DO NOTHING`,
      [event.idempotencyKey, event.system, event.operation],
    );
    if (claimed.rowCount === 0) {
      await db.query('ROLLBACK');
      const winner = await db.query('SELECT response FROM vendors.requests WHERE idempotency_key = $1', [
        event.idempotencyKey,
      ]);
      return { ...winner.rows[0].response, replayed: true };
    }

    // Simulated processing time, while holding the key. A failure here rolls back
    // the claim too, so a retry starts from scratch.
    const [min, max] = LATENCY[event.system];
    await sleep((min + Math.random() * (max - min)) * config.latencyScale);
    if (config.failingSystems.has(event.system) || Math.random() < config.failureRate) {
      throw new Error(`${event.system} is temporarily unavailable`);
    }

    const resourceId = await perform(db, event);
    response = { resourceId, replayed: false };
    await db.query('UPDATE vendors.requests SET response = $2 WHERE idempotency_key = $1', [
      event.idempotencyKey,
      { resourceId },
    ]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }

  console.log(JSON.stringify({ msg: 'performed', ...event, resourceId: response.resourceId }));
  if (Math.random() < config.lostResponseRate) {
    // The work is committed, but the caller never hears back: the classic case
    // where a naive retry would create a duplicate.
    throw new Error(`${event.system}: connection reset after the request was processed`);
  }
  return response;
};
