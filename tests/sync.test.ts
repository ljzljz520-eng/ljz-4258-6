import test from 'node:test';
import assert from 'node:assert/strict';
import { addReading, confirmationItem, get, json, makeApp, post, seedBatch } from './helpers.js';

test('重复同步整批 anchor/readings/commands 是幂等的', async () => {
  const { app } = await makeApp();
  const id = 'dup-sync';
  await seedBatch(app, id);
  await addReading(app, 'temp-001', id, 1, 43);
  await addReading(app, 'ph-001', id, 1, 4.7);
  await addReading(app, 'ph-001', id, 2, 4.5);
  const opItem = await confirmationItem(app, id, 'op', 'once');
  const payload = {
    anchors: [{ sourceId: 'temp-001', seq: 1, deviceTime: new Date(Date.now()-1000).toISOString(), referenceTime: new Date().toISOString() }],
    readings: [{ sourceId: 'temp-001', batchId: id, seq: 1, value: 43, observedAt: new Date().toISOString() }],
    commands: [opItem],
  };
  const first = await json(await post(app, '/sync', payload, 'op'));
  const second = await json(await post(app, '/sync', payload, 'op'));
  assert.equal(first.anchors[0].ok, true);
  assert.equal(second.anchors[0].duplicate, true);
  assert.equal(second.readings[0].duplicate, true);
  assert.equal(second.commands[0].ok, false);
  assert.equal(second.commands[0].error.code, 'DUPLICATE_CONFIRMATION');
  const state = await json(await get(app, '/state', 'boss'));
  assert.equal(state.anchors.length, 1);
  assert.equal(state.readings.filter((r:any)=>r.batchId===id).length, 3);
});

test('菌种换签使旧版本离线确认进入待协调，后端拒绝签发，前端可读阻断原因', async () => {
  const { app } = await makeApp();
  const id = 'culture-change';
  await seedBatch(app, id);
  await addReading(app, 'temp-001', id, 1, 43);
  await addReading(app, 'ph-001', id, 1, 4.7);
  await addReading(app, 'ph-001', id, 2, 4.5);
  await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'op', 'op-v1', { batch: 1, culture: 1 })] }, 'op'));
  await json(await post(app, '/commands', { type: 'culture.change_sign', cultureId: 'culture-1', signVersion: 2 }, 'qa'));
  const stale = await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'qa', 'qa-v1', { batch: 1, culture: 1 })] }, 'qa'));
  assert.equal(stale.commands[0].ok, false);
  assert.equal(stale.commands[0].error.code, 'PENDING_RECONCILIATION');
  const issue = await post(app, '/commands', { type: 'inoculation.issue', batchId: id }, 'qa');
  assert.equal(issue.statusCode, 409);
  assert.match((await json(issue)).error.message, /待协调|菌种版本/);
  const batch = (await json(await get(app, `/batches/${id}`, 'qa'))).batch;
  assert.equal(batch.reconciliation[0].status, 'open');
  await post(app, '/commands', { type: 'reconciliation.resolve', batchId: id, reconciliationId: batch.reconciliation[0].id, resolution: 'rejected_and_rerecorded' }, 'boss');
});

test('时钟漂移锚点保留设备时间与参考时间，补录 observedAt 不改写已采集值', async () => {
  const { app } = await makeApp();
  const id = 'clock';
  await seedBatch(app, id);
  const observedAt = new Date('2026-09-30T08:00:00.000Z').toISOString();
  await addReading(app, 'ph-001', id, 1, 4.7, observedAt);
  const deviceTime = new Date('2026-09-30T07:59:30.000Z').toISOString();
  const referenceTime = new Date('2026-09-30T08:00:00.000Z').toISOString();
  const anchor = await json(await post(app, '/device/clock-anchor', { sourceId: 'ph-001', seq: 1, deviceTime, referenceTime }, undefined, { 'x-device-token': 'ph-token' }));
  assert.equal(anchor.driftMs, -30000);
  // Late backfill at sequence 2 carries a later observation timestamp; seq=1 remains untouched.
  await addReading(app, 'ph-001', id, 2, 4.4, new Date('2026-09-30T09:00:00.000Z').toISOString());
  const state = await json(await get(app, `/batches/${id}`, 'qa'));
  assert.equal(state.readings.find((r:any)=>r.seq===1).observedAt, observedAt);
  assert.equal(state.anchors[0].deviceTime, deviceTime);
  assert.equal(state.anchors[0].referenceTime, referenceTime);
});

test('两个账号并发改批：一个成功，旧批次版本得到 VERSION_CONFLICT', async () => {
  const { initialState } = await import('../server/types.js');
  // Construct deterministic two-command race against same snapshot by exercising store transaction semantics.
  const { app } = await makeApp();
  const id = 'concurrent-batch';
  await seedBatch(app, id);
  await addReading(app, 'temp-001', id, 1, 43);
  await addReading(app, 'ph-001', id, 1, 4.7);
  await addReading(app, 'ph-001', id, 2, 4.5);
  await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'op', 'op-concurrent')] }, 'op'));
  await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'qa', 'qa-concurrent')] }, 'qa'));
  await json(await post(app, '/commands', { type: 'inoculation.issue', batchId: id }, 'qa'));
  const results = await Promise.all([
    post(app, '/commands', { type: 'cooling.start', batchId: id, expectedPlanVersion: 2 }, 'op'),
    post(app, '/commands', { type: 'cooling.start', batchId: id, expectedPlanVersion: 2 }, 'op'),
  ]);
  const statuses = results.map((r)=>r.statusCode).sort();
  assert.deepEqual(statuses, [200, 409]);
  const bodies = await Promise.all(results.map((r)=>json(r)));
  assert.ok(bodies.some((b:any)=>b.error?.code === 'VERSION_CONFLICT'));
});
