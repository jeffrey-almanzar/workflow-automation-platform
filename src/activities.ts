// Activities: the "real work" units a workflow can invoke.
// Unlike workflow code, activities can do I/O
// (HTTP calls, DB, whatever) and Temporal automatically retries them on failure.
//
// Two kinds of side effects happen here:
//  - Our own PostgreSQL (src/db.ts): the employee record and the audit log.
//  - External vendors, reached through the vendors Lambda (src/vendors.ts).
// Both are safe to retry: database writes are upserts / ON CONFLICT DO NOTHING,
// and every vendor call carries an idempotency key that is stable across retries.
// Each create activity returns the ID of the resource it created, which the
// workflow keeps for compensation and offboarding.

import { Context, log } from '@temporalio/activity';
import { pool } from './db';
import type { NewHire } from './shared';
import { VendorOperation, VendorSystem, callVendor, idempotencyKey } from './vendors';

async function audit(employeeId: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
  // Keyed by activity call, so a retried activity never writes a second row.
  const key = idempotencyKey();
  await pool.query(
    `INSERT INTO audit_log (employee_id, workflow_id, event, details, idempotency_key)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING`,
    [employeeId, Context.current().info.workflowExecution!.workflowId, event, details, key],
  );
}

async function vendorStep(
  employeeId: string,
  event: string,
  system: VendorSystem,
  operation: VendorOperation,
  payload: Record<string, string | undefined> = {},
): Promise<string> {
  const { resourceId, replayed } = await callVendor(system, operation, { employeeId, ...payload });
  if (replayed) {
    // An earlier attempt succeeded at the vendor but its response never arrived.
    log.warn('Vendor returned stored response; duplicate prevented', { system, operation, resourceId });
  }
  await audit(employeeId, event, { system, resourceId, replayed });
  log.info(event, { employeeId, system, resourceId });
  return resourceId;
}

// --- Forward steps ---

export async function createHrRecord(hire: NewHire): Promise<string> {
  // Upsert: safe to retry, and a rehire reuses the existing row.
  await pool.query(
    `INSERT INTO employees (employee_id, full_name, personal_email, role, start_date, status)
     VALUES ($1, $2, $3, $4, $5, 'ONBOARDING')
     ON CONFLICT (employee_id) DO UPDATE SET
       full_name = EXCLUDED.full_name, personal_email = EXCLUDED.personal_email, role = EXCLUDED.role,
       start_date = EXCLUDED.start_date, company_email = NULL, status = 'ONBOARDING', updated_at = now()`,
    [hire.employeeId, hire.fullName, hire.personalEmail, hire.role, hire.startDate],
  );
  await audit(hire.employeeId, 'HR_RECORD_CREATED', { role: hire.role, startDate: hire.startDate });
  log.info('HR record created', { employeeId: hire.employeeId });
  return `hr-${hire.employeeId}`;
}

export async function createEmailAccount(hire: NewHire): Promise<string> {
  const email = await vendorStep(hire.employeeId, 'EMAIL_ACCOUNT_CREATED', 'email', 'create', {
    fullName: hire.fullName,
  });
  await pool.query('UPDATE employees SET company_email = $2, updated_at = now() WHERE employee_id = $1', [
    hire.employeeId,
    email,
  ]);
  return email;
}

export function createSlackAccount(hire: NewHire): Promise<string> {
  return vendorStep(hire.employeeId, 'SLACK_ACCOUNT_CREATED', 'slack', 'create');
}

export function grantGithubAccess(hire: NewHire): Promise<string> {
  return vendorStep(hire.employeeId, 'GITHUB_ACCESS_GRANTED', 'github', 'create');
}

export function orderLaptop(hire: NewHire): Promise<string> {
  return vendorStep(hire.employeeId, 'LAPTOP_ORDERED', 'laptop', 'create', {
    role: hire.role,
    deliverBy: hire.startDate,
  });
}

export function enrollInPayroll(hire: NewHire): Promise<string> {
  return vendorStep(hire.employeeId, 'PAYROLL_ENROLLED', 'payroll', 'create', { startDate: hire.startDate });
}

export async function activateEmployee(employeeId: string): Promise<void> {
  await pool.query("UPDATE employees SET status = 'ACTIVE', updated_at = now() WHERE employee_id = $1", [employeeId]);
  await audit(employeeId, 'EMPLOYEE_ACTIVATED');
}

// --- Human-in-the-loop notifications ---

export function sendContract(hire: NewHire): Promise<string> {
  return vendorStep(hire.employeeId, 'CONTRACT_SENT', 'esignature', 'create', { to: hire.personalEmail });
}

export async function sendContractReminder(hire: NewHire): Promise<void> {
  await vendorStep(hire.employeeId, 'CONTRACT_REMINDER_SENT', 'email', 'send', {
    to: hire.personalEmail,
    template: 'contract-reminder',
  });
}

export async function escalateToHr(employeeId: string, reason: string): Promise<void> {
  await audit(employeeId, 'ESCALATED_TO_HR', { reason });
  log.warn('Escalated to HR', { employeeId, reason });
}

export async function notifyStartDateChanged(hire: NewHire, newStartDate: string, laptopOrderId?: string): Promise<void> {
  await pool.query('UPDATE employees SET start_date = $2, updated_at = now() WHERE employee_id = $1', [
    hire.employeeId,
    newStartDate,
  ]);
  // Reschedule delivery so the laptop arrives in time for the new date.
  await vendorStep(hire.employeeId, 'START_DATE_CHANGED', 'laptop', 'update', {
    resourceId: laptopOrderId,
    deliverBy: newStartDate,
  });
}

export function sendWelcomeEmail(hire: NewHire, companyEmail: string): Promise<string> {
  return vendorStep(hire.employeeId, 'WELCOME_EMAIL_SENT', 'email', 'send', {
    to: hire.personalEmail,
    template: 'welcome',
    companyEmail,
    startDate: hire.startDate,
  });
}

// --- Undo operations ---
// Used both as saga compensations (cancelled/failed onboarding) and by offboarding.
// Each one must be idempotent: Temporal may retry it, so "already gone" is success.

export async function archiveHrRecord(employeeId: string, hrRecordId: string): Promise<void> {
  await pool.query("UPDATE employees SET status = 'ARCHIVED', updated_at = now() WHERE employee_id = $1", [
    employeeId,
  ]);
  await audit(employeeId, 'HR_RECORD_ARCHIVED', { hrRecordId });
  log.info('HR record archived', { employeeId, hrRecordId });
}

export async function voidContract(employeeId: string, envelopeId: string): Promise<void> {
  await vendorStep(employeeId, 'CONTRACT_VOIDED', 'esignature', 'deactivate', { resourceId: envelopeId });
}

export async function deactivateEmailAccount(employeeId: string, email: string): Promise<void> {
  await vendorStep(employeeId, 'EMAIL_ACCOUNT_DEACTIVATED', 'email', 'deactivate', { resourceId: email });
}

export async function deactivateSlackAccount(employeeId: string, slackUserId: string): Promise<void> {
  await vendorStep(employeeId, 'SLACK_ACCOUNT_DEACTIVATED', 'slack', 'deactivate', { resourceId: slackUserId });
}

export async function revokeGithubAccess(employeeId: string, inviteId: string): Promise<void> {
  await vendorStep(employeeId, 'GITHUB_ACCESS_REVOKED', 'github', 'deactivate', { resourceId: inviteId });
}

export async function cancelLaptopOrder(employeeId: string, orderId: string): Promise<void> {
  await vendorStep(employeeId, 'LAPTOP_ORDER_CANCELLED', 'laptop', 'deactivate', { resourceId: orderId });
}

export async function removeFromPayroll(employeeId: string, payrollId: string): Promise<void> {
  await vendorStep(employeeId, 'PAYROLL_REMOVED', 'payroll', 'deactivate', { resourceId: payrollId });
}

export async function requestLaptopReturn(employeeId: string, orderId: string): Promise<void> {
  await vendorStep(employeeId, 'LAPTOP_RETURN_REQUESTED', 'laptop', 'send', { resourceId: orderId });
}
