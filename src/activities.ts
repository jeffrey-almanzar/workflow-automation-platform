// Activities: the "real work" units a workflow can invoke.
// Unlike workflow code, activities can do I/O
// (HTTP calls, DB, whatever) and Temporal automatically retries them on failure.
//
// For now every external system is mocked. Each call has realistic latency and,
// when MOCK_FAILURE_RATE is set (e.g. 0.3), fails randomly so you can watch
// Temporal retry it in the UI. Each activity returns the ID of the resource it
// created, which the workflow keeps for later compensation.

import { log } from '@temporalio/activity';
import type { NewHire } from './shared';

const FAILURE_RATE = Number(process.env.MOCK_FAILURE_RATE ?? 0);

async function simulateCall(system: string, minMs = 200, maxMs = 1500): Promise<void> {
  const latency = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, latency));
  if (Math.random() < FAILURE_RATE) {
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
