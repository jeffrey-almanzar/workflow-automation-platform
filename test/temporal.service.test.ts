// TemporalService against a fake Temporal client: how Temporal errors and states
// map to HTTP responses.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { TemporalService } from '../src/temporal.service';

const hire = {
  employeeId: 'E1',
  fullName: 'Ana López',
  personalEmail: 'ana@example.com',
  role: 'engineer' as const,
  startDate: '2026-11-16',
};

function serviceWith(handle: Record<string, jest.Mock>, start = jest.fn()) {
  const service = new TemporalService();
  const client = {
    workflow: { start, getHandle: jest.fn(() => handle) },
    withDeadline: (_deadline: unknown, fn: () => Promise<unknown>) => fn(),
  };
  (service as unknown as { client: unknown }).client = client;
  return { service, client };
}

const notFound = () => new WorkflowNotFoundError('not found', 'wf', undefined);
const described = (status: string) => ({ status: { name: status }, startTime: new Date(), closeTime: undefined });

describe('startOnboarding', () => {
  test('derives the workflow ID from the employee ID', async () => {
    const start = jest.fn(async (_type: string, opts: { workflowId: string }) => ({ workflowId: opts.workflowId }));
    const { service } = serviceWith({}, start);
    await expect(service.startOnboarding(hire)).resolves.toBe('onboarding-E1');
    expect(start).toHaveBeenCalledWith('onboardingWorkflow', expect.objectContaining({ workflowId: 'onboarding-E1' }));
  });

  test('409 when an onboarding is already running for that employee', async () => {
    const start = jest.fn(async () => {
      throw new WorkflowExecutionAlreadyStartedError('exists', 'onboarding-E1', 'onboardingWorkflow');
    });
    const { service } = serviceWith({}, start);
    await expect(service.startOnboarding(hire)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('signals', () => {
  test('409 when the workflow has already finished', async () => {
    const { service } = serviceWith({
      signal: jest.fn(async () => Promise.reject(notFound())),
      describe: jest.fn(async () => described('COMPLETED')),
    });
    await expect(service.signContract('onboarding-E1')).rejects.toBeInstanceOf(ConflictException);
  });

  test('404 when the workflow does not exist', async () => {
    const { service } = serviceWith({
      signal: jest.fn(async () => Promise.reject(notFound())),
      describe: jest.fn(async () => Promise.reject(notFound())),
    });
    await expect(service.cancelOnboarding('onboarding-X', 'reason')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('getOnboarding', () => {
  test('degrades to the server-side status when no worker answers the query', async () => {
    const { service } = serviceWith({
      describe: jest.fn(async () => described('RUNNING')),
      query: jest.fn(async () => Promise.reject(new Error('deadline exceeded'))),
    });
    const result = await service.getOnboarding('onboarding-E1');
    expect(result).toMatchObject({ onboardingId: 'onboarding-E1', workflowStatus: 'RUNNING', progress: null });
  });

  test('404 for an unknown onboarding', async () => {
    const { service } = serviceWith({ describe: jest.fn(async () => Promise.reject(notFound())) });
    await expect(service.getOnboarding('onboarding-X')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('startOffboarding', () => {
  test('409 while the onboarding is still running', async () => {
    const { service } = serviceWith({ describe: jest.fn(async () => described('RUNNING')) });
    await expect(service.startOffboarding('E1', 'Resigned')).rejects.toThrow(/is RUNNING/);
  });

  test('409 when the onboarding was cancelled', async () => {
    const { service } = serviceWith({
      describe: jest.fn(async () => described('COMPLETED')),
      result: jest.fn(async () => ({ status: 'CANCELLED', resources: {} })),
    });
    await expect(service.startOffboarding('E1', 'Resigned')).rejects.toThrow(/is CANCELLED/);
  });

  test("starts offboarding with the onboarding's resources", async () => {
    const resources = { email: 'ana.lopez@company.com', slack: 'U-1' };
    const start = jest.fn(async () => ({}));
    const { service } = serviceWith(
      {
        describe: jest.fn(async () => described('COMPLETED')),
        result: jest.fn(async () => ({ status: 'COMPLETED', resources })),
      },
      start,
    );
    await expect(service.startOffboarding('E1', 'Resigned')).resolves.toBe('offboarding-E1');
    expect(start).toHaveBeenCalledWith(
      'offboardingWorkflow',
      expect.objectContaining({ args: [{ employeeId: 'E1', reason: 'Resigned', revokeAccessAt: undefined, resources }] }),
    );
  });
});

test('refuses to boot with an invalid timer override', () => {
  process.env.CONTRACT_REMINDER_DELAY = '3 dayz';
  try {
    expect(() => new TemporalService()).toThrow(/Invalid duration for contractReminderDelay/);
  } finally {
    delete process.env.CONTRACT_REMINDER_DELAY;
  }
});
