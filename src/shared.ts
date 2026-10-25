// Types and Temporal definitions shared by the API (client side) and the worker.
// Keeping the query definition here means both sides agree on its name and shape.

import { defineQuery } from '@temporalio/workflow';

export const TASK_QUEUE = 'onboarding';

export const ROLES = ['engineer', 'sales', 'operations'] as const;
export type Role = (typeof ROLES)[number];

export interface NewHire {
  employeeId: string;
  fullName: string;
  personalEmail: string;
  role: Role;
  startDate: string; // ISO date, e.g. "2026-11-16"
}

// Every unit of work the onboarding performs. GitHub is only provisioned for engineers.
export type StepName = 'hrRecord' | 'email' | 'slack' | 'github' | 'laptop' | 'payroll';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type OnboardingStatus = 'PROVISIONING' | 'COMPLETED' | 'FAILED';

export interface OnboardingProgress {
  status: OnboardingStatus;
  percentComplete: number;
  steps: Partial<Record<StepName, StepStatus>>;
  // IDs returned by each external system (email address, ticket number, ...).
  // Needed later to undo a step during compensation.
  resources: Partial<Record<StepName, string>>;
}

// Read-only view of a running (or finished) workflow's in-memory state.
export const progressQuery = defineQuery<OnboardingProgress>('progress');
