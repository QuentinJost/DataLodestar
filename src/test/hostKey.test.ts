import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { answers, executed, installVscodeStub } from './vscodeStub';

installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { showChangedHostKey } = require('../sessionManager') as typeof import('../sessionManager');

test('a changed host key offers the reset command, which confirms on its own', async () => {
  answers.next = 'Reset Pinned SSH Host Key…';
  await showChangedHostKey({ id: 'c1' } as never, 'bastion:22', 'SHA256:old', 'SHA256:new');
  assert.deepEqual(executed, [['dataLodestar.resetHostKey', 'c1']]);
  answers.next = undefined;
  await showChangedHostKey({ id: 'c1' } as never, 'bastion:22', 'SHA256:old', 'SHA256:new');
  assert.equal(executed.length, 1, 'dismissed: nothing runs');
});
