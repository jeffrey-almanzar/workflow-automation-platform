// Determinism check: replays recorded histories (test/histories/) against the
// current workflow code. If a code change would make Temporal take a different
// path than the one recorded (e.g. reordering or removing activity calls), the
// replay fails with a nondeterminism error. In production that change would break
// every workflow already in flight, so it needs patched() / versioning instead.

import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import { Worker } from '@temporalio/worker';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import './helpers'; // installs the quiet Runtime logger

jest.setTimeout(60_000);

const DIR = join(__dirname, 'histories');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

test('there are histories to replay', () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)('replays %s with the current workflow code', async (file) => {
  const history = historyFromJSON(JSON.parse(readFileSync(join(DIR, file), 'utf8')));
  await Worker.runReplayHistory({ workflowsPath: require.resolve('../src/workflows') }, history);
});
