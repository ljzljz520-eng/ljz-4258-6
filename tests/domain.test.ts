import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../server/types.js';
import { addReading, confirmationItem, get, json, makeApp, post, seedBatch } from './helpers.js';

const op = { userId: 'u_operator', name: 'op', roles: ['operator'] as const };
const qa = { userId: 'u_quality', name: 'qa', roles: ['quality'] as const };

test('菌种、奶基、接种、冷却、灌装遵循显式状态机', async () => {
  const { app } = await makeApp();
  const id = 'state-machine';
  await seedBatch(app, id);
  await addReading(app, 'temp-001', id, 1, 43);
  await addReading(app, 'ph-001', id, 1, 4.7);
  await addReading(app, 'ph-001', id, 2, 4.5);
  await post(app, '/sync', { commands: [await confirmationItem(app, id, 'op', 'a')] }, 'op');
  await post(app, '/sync', { commands: [await confirmationItem(app, id, 'qa', 'b')] }, 'qa');
  await post(app, '/commands', { type: 'inoculation.issue', batchId: id }, 'qa');
    await post(app, '/commands', { type: 'cooling.start', batchId: id, expectedPlanVersion: 2 }, 'op');
  await post(app, '/commands', { type: 'cooling.complete', batchId: id, actualTemperatureC: 4.2 }, 'op');
  await post(app, '/commands', { type: 'filling.start', batchId: id }, 'op');
  await post(app, '/commands', { type: 'filling.complete', batchId: id, packages: 12 }, 'op');
  const res = await get(app, `/batches/${id}`, 'qa');
  const body = await json(res);
  assert.equal(body.batch.inoculation, 'inoculated');
  assert.equal(body.batch.cooling, 'completed');
  assert.equal(body.batch.filling, 'completed');
  assert.equal(body.batch.status, 'filled');
});

test('同一账号连续离线点击不能冒充双签，且必须 operator + quality', async () => {
  const { app } = await makeApp();
  const id = 'same-account';
  await seedBatch(app, id);
  await addReading(app, 'temp-001', id, 1, 43);
  await addReading(app, 'ph-001', id, 1, 4.7);
  await addReading(app, 'ph-001', id, 2, 4.5);
  const first = await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'op', 'one')] }, 'op'));
  const sameAccountSync = await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'op', 'two')] }, 'op'));
  const sync = { commands: [first.commands[0], sameAccountSync.commands[0]] };
  assert.equal(sync.commands[0].ok, true);
  assert.equal(sync.commands[1].ok, false);
  assert.equal(sync.commands[1].error.code, 'PENDING_RECONCILIATION');
  assert.match(sync.commands[1].error.message, /同一账号重复点击|不同账号/);
  let issue = await post(app, '/commands', { type: 'inoculation.issue', batchId: id }, 'qa');
  assert.equal(issue.statusCode, 409);
  assert.match((await json(issue)).error.message, /待协调冲突/);
  let batch = (await json(await get(app, `/batches/${id}`, 'qa'))).batch;
  assert.equal(batch.reconciliation.at(-1).status, 'open');
  await post(app, '/commands', { type: 'reconciliation.resolve', batchId: id, reconciliationId: batch.reconciliation.at(-1).id, resolution: 'rejected_and_rerecorded' }, 'boss');
  issue = await post(app, '/commands', { type: 'inoculation.issue', batchId: id }, 'qa');
  assert.equal(issue.statusCode, 409);
  assert.match((await json(issue)).error.message, /两名不同账号|operator 与 quality/);
  batch = (await json(await get(app, `/batches/${id}`, 'qa'))).batch;
  assert.equal(batch.inoculation, 'one_person');
});

