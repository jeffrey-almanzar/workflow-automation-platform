// Types and Temporal definitions shared by the API (client side) and the worker.
// Keeping the signal/query definitions here means both sides agree on their names and shapes.

import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { Duration } from '@temporalio/common';

export const TASK_QUEUE = 'onboarding';

export const ROLES = ['engineer', 'sales', 'operations'] as const;
export type Role = (typeof ROLES)[number];

export interface NewHire {
  employeeId: string;
  fullName: string;
  personalEmail: string;
  role: Role;
  // ISO date ("2026-11-16", treated as midnight UTC) or full datetime.
  startDate: string;
}

// How long the workflow waits at each human step. Passed in as workflow input
// (not read from env inside the workflow) so it is recorded in history: changing
// the config later never alters the behavior of onboardings already in flight.
export interface OnboardingTimings {
  contractReminderDelay: Duration; // after sending the contract
  contractEscalationDelay: Duration; // after the reminder, if still unsigned
  welcomeLeadTime: Duration; // how long before the start date the welcome email goes out
}

export const DEFAULT_TIMINGS: OnboardingTimings = {
  contractReminderDelay: '3 days',
  contractEscalationDelay: '4 days', // i.e. day 7
  welcomeLeadTime: '1 day',
};

// Every unit of work the onboarding performs. GitHub is only provisioned for engineers.
export type StepName =
  | 'hrRecord'
  | 'contract'
  | 'email'
  | 'slack'
  | 'github'
  | 'laptop'
  | 'payroll'
  | 'welcome';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type OnboardingStatus =
  | 'AWAITING_CONTRACT'
  | 'PROVISIONING'
  | 'AWAITING_START_DATE'
  | 'COMPLETED'
  | 'FAILED';

export interface ContractState {
  sentAt: string | null;
  signedAt: string | null;
  remindersSent: number;
  escalatedAt: string | null;
}

export interface OnboardingProgress {
  status: OnboardingStatus;
  percentComplete: number;
  startDate: string;
  welcomeEmailAt: string | null; // when the welcome email is (or was) scheduled
  contract: ContractState;
  steps: Partial<Record<StepName, StepStatus>>;
  // IDs returned by each external system (email address, ticket number, ...).
  // Needed later to undo a step during compensation.
  resources: Partial<Record<StepName, string>>;
}

// Read-only view of a running (or finished) workflow's in-memory state.
export const progressQuery = defineQuery<OnboardingProgress>('progress');

// External events that move the onboarding forward.
export const contractSignedSignal = defineSignal('contractSigned');
export const updateStartDateSignal = defineSignal<[string]>('updateStartDate');
