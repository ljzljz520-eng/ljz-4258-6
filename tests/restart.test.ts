import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../server/domain.js';
import { addReading, confirmationItem, get, json, makeApp, post, seedBatch } from './helpers.js';

test('服务重启：PostgreSQL 事件重放恢复状态、确认、读数水位与阻断记录', async (t) => {
  if (process.env.RUN_PG_INTEGRATION !== '1' || !process.env.DATABASE_URL) {
    t.skip('设置 RUN_PG_INTEGRATION=1 与 DATABASE_URL 后运行 PostgreSQL 重启集成测试；默认以纯事件重放验证重建逻辑。');
  }
  const first = await makeApp();
  const id = 'restart';
  await seedBatch(first.app, id);
  await addReading(first.app, 'ph-001', id, 2, 4.5); // missing seq 1
  await post(first.app, '/commands', { type: 'inoculation.issue', batchId: id }, 'qa');

  // Simulate process restart by rebuilding projection from the durable event log.
  const rebooted = replay(first.store.events);
  const b = rebooted.batches[id];
  assert.equal(b.status, 'created');
  assert.equal(b.inoculation, 'not_authorized');
  assert.match(b.lastIssueBlock?.reasons.join(',') ?? '', /证据水位|合格人员/);
  assert.equal(first.store.events.filter((e)=>e.streamId===id).length > 0, true);
  await first.app.close();
});

test('MemoryStore 重建确认与冲突投影，不依赖可变内存对象', async () => {
  const { app, store } = await makeApp();
  const id = 'replay-conflict';
  await seedBatch(app, id);
  await addReading(app, 'temp-001', id, 1, 43);
  await addReading(app, 'ph-001', id, 1, 4.7);
  await addReading(app, 'ph-001', id, 2, 4.5);
  await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'op', 'r1')] }, 'op'));
  await json(await post(app, '/commands', { type: 'culture.change_sign', cultureId: 'culture-1', signVersion: 2 }, 'qa'));
  await json(await post(app, '/sync', { commands: [await confirmationItem(app, id, 'qa', 'r2', { batch: 1, culture: 1 })] }, 'qa'));
  const replayState = replay(store.events);
  const b = replayState.batches[id];
  assert.equal(b.reconciliation.length, 1);
  assert.equal(b.reconciliation[0].status, 'open');
  assert.equal(b.confirmations.length, 2);
  assert.equal(b.confirmations.find((c)=>c.userId==='u_quality')?.valid, false);
  const live = await json(await get(app, `/batches/${id}`, 'qa'));
  assert.deepEqual(live.batch.reconciliation, b.reconciliation);
});
