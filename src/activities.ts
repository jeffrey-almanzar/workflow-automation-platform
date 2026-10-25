// Activities: the "real work" units a workflow can invoke.
// Unlike workflow code, activities can do I/O
// (HTTP calls, DB, whatever) and Temporal automatically retries them on failure.
//
// For now every external system is mocked. Each call has realistic latency and,
// when MOCK_FAILURE_RATE is set (e.g. 0.3), fails randomly so you can watch
// Temporal retry it in the UI. MOCK_FAILING_SYSTEMS (e.g. "GitHub,Slack") makes
// those systems fail every call, to reproduce permanent outages.
// Each activity returns the ID of the resource it created, which the workflow
// keeps for compensation.

import { log } from '@temporalio/activity';
import type { NewHire } from './shared';

const FAILURE_RATE = Number(process.env.MOCK_FAILURE_RATE ?? 0);
const FAILING_SYSTEMS = new Set(
  (process.env.MOCK_FAILING_SYSTEMS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);

async function simulateCall(system: string, minMs = 200, maxMs = 1500): Promise<void> {
  const latency = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, latency));
  if (FAILING_SYSTEMS.has(system) || Math.random() < FAILURE_RATE) {
    throw new Error(`${system} is temporarily unavailable`);
  }
}

function companyEmail(hire: NewHire): string {
  const local = hire.fullName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .join('.');
  return `${local}@company.com`;
}

export async function createHrRecord(hire: NewHire): Promise<string> {
  await simulateCall('HR system');
  log.info('HR record created', { employeeId: hire.employeeId });
  return `hr-${hire.employeeId}`;
}

export async function createEmailAccount(hire: NewHire): Promise<string> {
  await simulateCall('Email provider');
  const email = companyEmail(hire);
  log.info('Email account created', { email });
  return email;
}

export async function createSlackAccount(hire: NewHire): Promise<string> {
  await simulateCall('Slack');
  log.info('Slack account created', { employeeId: hire.employeeId });
  return `slack-U${hire.employeeId}`;
}

export async function grantGithubAccess(hire: NewHire): Promise<string> {
  await simulateCall('GitHub');
  log.info('GitHub org invite sent', { employeeId: hire.employeeId });
  return `gh-invite-${hire.employeeId}`;
}

export async function orderLaptop(hire: NewHire): Promise<string> {
  // Vendor APIs are the slowest system in the chain.
  await simulateCall('Laptop vendor', 1000, 3000);
  log.info('Laptop ordered', { employeeId: hire.employeeId, role: hire.role });
  return `order-${hire.employeeId}`;
}

export async function enrollInPayroll(hire: NewHire): Promise<string> {
  await simulateCall('Payroll');
  log.info('Enrolled in payroll', { employeeId: hire.employeeId, startDate: hire.startDate });
  return `payroll-${hire.employeeId}`;
}

// --- Human-in-the-loop notifications ---

export async function sendContract(hire: NewHire): Promise<string> {
  await simulateCall('E-signature service');
  log.info('Contract sent for signature', { employeeId: hire.employeeId, to: hire.personalEmail });
  return `envelope-${hire.employeeId}`;
}

export async function sendContractReminder(hire: NewHire): Promise<void> {
  await simulateCall('Email provider', 100, 500);
  log.info('Contract reminder sent', { employeeId: hire.employeeId, to: hire.personalEmail });
}

export async function escalateToHr(employeeId: string, reason: string): Promise<void> {
  await simulateCall('HR ticketing', 100, 500);
  log.warn('Escalated to HR', { employeeId, reason });
}

export async function notifyStartDateChanged(hire: NewHire, newStartDate: string): Promise<void> {
  // Tells the laptop vendor and IT so delivery and account activation line up.
  await simulateCall('Laptop vendor', 200, 800);
  log.info('Start date change propagated', { employeeId: hire.employeeId, newStartDate });
}

export async function sendWelcomeEmail(hire: NewHire, companyEmail: string): Promise<string> {
  await simulateCall('Email provider', 100, 500);
  log.info('Welcome email sent', { to: hire.personalEmail, companyEmail, startDate: hire.startDate });
  return `welcome-${hire.employeeId}`;
}

// --- Undo operations ---
// Used both as saga compensations (cancelled/failed onboarding) and by offboarding.
// Each one must be idempotent: Temporal may retry it, so "already gone" is success.

export async function archiveHrRecord(employeeId: string, hrRecordId: string): Promise<void> {
  await simulateCall('HR system');
  log.info('HR record archived', { employeeId, hrRecordId });
}

export async function voidContract(employeeId: string, envelopeId: string): Promise<void> {
  await simulateCall('E-signature service');
  log.info('Contract voided', { employeeId, envelopeId });
}

export async function deactivateEmailAccount(employeeId: string, email: string): Promise<void> {
  await simulateCall('Email provider');
  log.info('Email account deactivated', { employeeId, email });
}

export async function deactivateSlackAccount(employeeId: string, slackUserId: string): Promise<void> {
  await simulateCall('Slack');
  log.info('Slack account deactivated', { employeeId, slackUserId });
}

export async function revokeGithubAccess(employeeId: string, inviteId: string): Promise<void> {
  await simulateCall('GitHub');
  log.info('GitHub access revoked', { employeeId, inviteId });
}

export async function cancelLaptopOrder(employeeId: string, orderId: string): Promise<void> {
  await simulateCall('Laptop vendor', 1000, 3000);
  log.info('Laptop order cancelled', { employeeId, orderId });
}

export async function removeFromPayroll(employeeId: string, payrollId: string): Promise<void> {
  await simulateCall('Payroll');
  log.info('Removed from payroll', { employeeId, payrollId });
}

export async function requestLaptopReturn(employeeId: string, orderId: string): Promise<void> {
  await simulateCall('Laptop vendor', 500, 1500);
  log.info('Laptop return shipping label sent', { employeeId, orderId });
}
