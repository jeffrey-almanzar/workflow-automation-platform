// HTTP layer: request validation and routing, with TemporalService mocked out.
// The app is configured exactly like production (configureApp).

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup';
import { OffboardingController } from '../src/offboarding.controller';
import { OnboardingController } from '../src/onboarding.controller';
import { TemporalService } from '../src/temporal.service';

const temporal = {
  startOnboarding: jest.fn(async () => 'onboarding-E1'),
  getOnboarding: jest.fn(),
  signContract: jest.fn(async () => undefined),
  updateStartDate: jest.fn(async () => undefined),
  cancelOnboarding: jest.fn(async () => undefined),
  startOffboarding: jest.fn(async () => 'offboarding-E1'),
  getOffboarding: jest.fn(),
};

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [OnboardingController, OffboardingController],
    providers: [{ provide: TemporalService, useValue: temporal }],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => jest.clearAllMocks());

function send(method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validHire = {
  employeeId: 'E1',
  fullName: 'Ana López',
  personalEmail: 'ana@example.com',
  role: 'engineer',
  startDate: '2026-11-16',
};

describe('POST /onboardings', () => {
  test('202 with the onboarding ID for a valid hire', async () => {
    const res = await send('POST', '/onboardings', validHire);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ onboardingId: 'onboarding-E1' });
    expect(temporal.startOnboarding).toHaveBeenCalledWith(expect.objectContaining(validHire));
  });

  test.each([
    ['an invalid email', { personalEmail: 'not-an-email' }, 'personalEmail must be an email'],
    ['an unknown role', { role: 'ceo' }, 'role must be one of the following values: engineer, sales, operations'],
    ['a non-ISO date', { startDate: 'next monday' }, 'startDate must be a valid ISO 8601 date string'],
    ['an employee ID with spaces', { employeeId: 'E 1' }, 'employeeId must be alphanumeric (dashes allowed)'],
    ['an unexpected field', { salary: 100000 }, 'property salary should not exist'],
  ])('400 for %s, without starting a workflow', async (_, override, message) => {
    const res = await send('POST', '/onboardings', { ...validHire, ...override });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain(message);
    expect(temporal.startOnboarding).not.toHaveBeenCalled();
  });
});

describe('signals', () => {
  test('contract signature', async () => {
    const res = await send('POST', '/onboardings/onboarding-E1/contract-signature');
    expect(res.status).toBe(202);
    expect(temporal.signContract).toHaveBeenCalledWith('onboarding-E1');
  });

  test('start date change requires a valid date', async () => {
    expect((await send('PATCH', '/onboardings/onboarding-E1/start-date', { startDate: 'soon' })).status).toBe(400);
    const res = await send('PATCH', '/onboardings/onboarding-E1/start-date', { startDate: '2026-12-01' });
    expect(res.status).toBe(202);
    expect(temporal.updateStartDate).toHaveBeenCalledWith('onboarding-E1', '2026-12-01');
  });

  test('cancellation requires a reason', async () => {
    expect((await send('POST', '/onboardings/onboarding-E1/cancellation', {})).status).toBe(400);
    const res = await send('POST', '/onboardings/onboarding-E1/cancellation', { reason: 'Offer withdrawn' });
    expect(res.status).toBe(202);
    expect(temporal.cancelOnboarding).toHaveBeenCalledWith('onboarding-E1', 'Offer withdrawn');
  });
});

describe('POST /offboardings', () => {
  test('revokeAccessAt is optional (immediate offboarding)', async () => {
    const res = await send('POST', '/offboardings', { employeeId: 'E1', reason: 'Resigned' });
    expect(res.status).toBe(202);
    expect(temporal.startOffboarding).toHaveBeenCalledWith('E1', 'Resigned', undefined);
  });

  test('400 without a reason', async () => {
    expect((await send('POST', '/offboardings', { employeeId: 'E1' })).status).toBe(400);
  });
});
