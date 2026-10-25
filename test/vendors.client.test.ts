// The vendor client (src/vendors.ts): idempotency key derivation and Lambda error
// handling, run inside Temporal's MockActivityEnvironment with the AWS SDK stubbed.

import { LambdaClient } from '@aws-sdk/client-lambda';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { callVendor } from '../src/vendors';

const send = jest.spyOn(LambdaClient.prototype, 'send') as unknown as jest.Mock;

function lambdaReturns(body: unknown, functionError?: string) {
  send.mockResolvedValue({ Payload: Buffer.from(JSON.stringify(body)), FunctionError: functionError });
}

function sentPayload(call = 0) {
  return JSON.parse(send.mock.calls[call][0].input.Payload);
}

function activityEnv(info: { runId?: string; activityId?: string; attempt?: number } = {}) {
  return new MockActivityEnvironment(
    {
      activityId: info.activityId ?? '7',
      attempt: info.attempt ?? 1,
      workflowExecution: { workflowId: 'onboarding-E1', runId: info.runId ?? 'run-1' },
    },
    { logger: new DefaultLogger('ERROR') }, // the expected failure below would otherwise be logged
  );
}

beforeEach(() => send.mockReset());

test('sends the request with a <runId>:<activityId> idempotency key', async () => {
  lambdaReturns({ resourceId: 'U-1', replayed: false });
  const result = await activityEnv().run(callVendor, 'slack', 'create', { employeeId: 'E1' });
  expect(result).toEqual({ resourceId: 'U-1', replayed: false });
  expect(sentPayload()).toEqual({
    system: 'slack',
    operation: 'create',
    idempotencyKey: 'run-1:7',
    payload: { employeeId: 'E1' },
  });
});

test('the key is the same on every retry of a call, and different for another call or a new run', async () => {
  lambdaReturns({ resourceId: 'U-1', replayed: false });
  await activityEnv({ attempt: 1 }).run(callVendor, 'slack', 'create', {});
  await activityEnv({ attempt: 4 }).run(callVendor, 'slack', 'create', {});
  await activityEnv({ activityId: '8' }).run(callVendor, 'slack', 'create', {});
  await activityEnv({ runId: 'run-2' }).run(callVendor, 'slack', 'create', {});
  const keys = [0, 1, 2, 3].map((i) => sentPayload(i).idempotencyKey);
  expect(keys).toEqual(['run-1:7', 'run-1:7', 'run-1:8', 'run-2:7']);
});

test('a Lambda function error becomes an activity failure (so Temporal retries it)', async () => {
  lambdaReturns({ errorType: 'Error', errorMessage: 'github is temporarily unavailable' }, 'Unhandled');
  await expect(activityEnv().run(callVendor, 'github', 'create', {})).rejects.toThrow(
    'github.create failed: github is temporarily unavailable',
  );
});
