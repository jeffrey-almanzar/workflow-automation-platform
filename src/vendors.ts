// Client for the vendors Lambda (lambdas/vendors). Locally LAMBDA_ENDPOINT points at
// the Lambda Runtime Interface Emulator; on AWS it is unset and the SDK calls the
// real Lambda API with the function name from VENDOR_FUNCTION_NAME.

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Context } from '@temporalio/activity';

export type VendorSystem = 'esignature' | 'email' | 'slack' | 'github' | 'laptop' | 'payroll';
export type VendorOperation = 'create' | 'deactivate' | 'send' | 'update';

export interface VendorResponse {
  resourceId: string;
  replayed: boolean;
}

const lambda = new LambdaClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.LAMBDA_ENDPOINT || undefined,
  // Temporal already retries the whole activity with backoff; SDK-level retries
  // on top would multiply attempts and hide failures from the workflow history.
  maxAttempts: 1,
});
const FUNCTION_NAME = process.env.VENDOR_FUNCTION_NAME ?? 'function';

// The idempotency key identifies this activity *call*: it is identical on every
// retry of the call, and different for any other call, including a later rehire.
export function idempotencyKey(): string {
  const { workflowExecution, activityId } = Context.current().info;
  if (!workflowExecution) throw new Error('Activities in this project must be started by a workflow');
  return `${workflowExecution.runId}:${activityId}`;
}

export async function callVendor(
  system: VendorSystem,
  operation: VendorOperation,
  payload: Record<string, string | undefined>,
): Promise<VendorResponse> {
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      Payload: JSON.stringify({ system, operation, idempotencyKey: idempotencyKey(), payload }),
    }),
  );
  const body = result.Payload ? JSON.parse(Buffer.from(result.Payload).toString() || 'null') : null;
  // A handler that throws still returns HTTP 200, with the error in the payload.
  if (result.FunctionError || body?.errorMessage) {
    throw new Error(`${system}.${operation} failed: ${body?.errorMessage ?? result.FunctionError}`);
  }
  return body as VendorResponse;
}
