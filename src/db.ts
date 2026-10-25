// PostgreSQL access shared by the worker (activities write) and the API (reads).
// This is our own system of record: the "HR system" plus an audit trail of
// everything the workflows did. Temporal's own tables live in separate databases.

import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://user:password@postgres:5432/workflows',
  max: 10,
});

// Idempotent schema setup, run on startup by both the API and the worker. The
// advisory lock stops the two from racing on CREATE TABLE.
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('onboarding-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        employee_id    TEXT PRIMARY KEY,
        full_name      TEXT NOT NULL,
        personal_email TEXT NOT NULL,
        role           TEXT NOT NULL,
        start_date     TEXT NOT NULL,
        company_email  TEXT,
        status         TEXT NOT NULL,  -- ONBOARDING | ACTIVE | ARCHIVED
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id              BIGSERIAL PRIMARY KEY,
        employee_id     TEXT NOT NULL,
        workflow_id     TEXT NOT NULL,
        event           TEXT NOT NULL,
        details         JSONB NOT NULL DEFAULT '{}',
        -- One row per activity execution, however many times it is retried.
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS audit_log_employee_idx ON audit_log (employee_id, id);
    `);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('onboarding-migrations'))").catch(() => {});
    client.release();
  }
}
