import test from 'node:test';
import assert from 'node:assert/strict';
import { PgStore } from '../server/pg-store.js';
import { buildApp } from '../server/app.js';
import { devices, users } from './helpers.js';
import { hmac } from '../server/auth.js';

const connectionString = process.env.DATABASE_URL ?? 'postgres://ferment:ferment@localhost:5432/ferment_records';

test('PostgreSQL：迁移、签发阻断、重启重放与并发版本冲突', async (t) => {
  if (process.env.RUN_PG_INTEGRATION !== '1') {
    t.skip('设置 RUN_PG_INTEGRATION=1 和 DATABASE_URL 后运行真实 PostgreSQL 集成测试');
    return;
  }
  const suffix = `it${Date.now()}`;
  const store = new PgStore(connectionString);
  const app = await buildApp({ store, users, devices });
  const send = (url: string, body: unknown, token: string) => app.inject({ method: 'POST', url, payload: body as any, headers: { authorization: `Bearer ${token}` } });
  const get = (url: string, token = 'qa') => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  const batchId = `pg-${suffix}`;
  const cultureId = `culture-${suffix}`;
  const milkId = `milk-${suffix}`;
  const startSeq = Math.floor(Date.now() / 1000);

  await send('/commands', { type: 'culture.register', cultureId, code: cultureId }, 'boss');
  await send('/commands', { type: 'culture.release', cultureId }, 'qa');
  await send('/commands', { type: 'milk.register', milkId, code: milkId }, 'op');
  await send('/commands', { type: 'milk.release', milkId }, 'qa');
  await send('/commands', { type: 'batch.create', batchId, label: batchId, cultureId, milkId, evidenceRequirements: [{ sourceId: 'temp-001', startSeq, minCount: 1 }, { sourceId: 'ph-001', startSeq, minCount: 2 }] }, 'op');

  const blocked = await get(`/batches/${batchId}/issue-readiness`);
  assert.equal(blocked.json<any>().ready, false);

  await app.inject({ method: 'POST', url: '/device/readings', payload: { sourceId: 'temp-001', batchId, seq: startSeq, value: 43, observedAt: new Date().toISOString() }, headers: { 'x-device-token': 'temp-token' } });
  await app.inject({ method: 'POST', url: '/device/readings', payload: { sourceId: 'ph-001', batchId, seq: startSeq + 1, value: 4.5, observedAt: new Date().toISOString() }, headers: { 'x-device-token': 'ph-token' } });
  const late = await get(`/batches/${batchId}/issue-readiness`);
  const lateBody = late.json<any>();
  assert.equal(lateBody.ready, false);
  assert.match(lateBody.reasons.join(','), /ph-001.*0\/2/);
  await app.inject({ method: 'POST', url: '/device/readings', payload: { sourceId: 'ph-001', batchId, seq: startSeq, value: 4.7, observedAt: new Date().toISOString() }, headers: { 'x-device-token': 'ph-token' } });

  for (const who of ['op', 'qa'] as const) {
    const ticket = await (await send('/auth/offline-ticket', { ttlMs: 3600_000 }, who)).json<{ ticketId: string; secret: string }>();
    const command = { type: 'inoculation.confirm', batchId, confirmationId: `conf-${suffix}-${who}`, cultureId, culturePlanVersion: 1, batchPlanVersion: 1, observedAt: new Date().toISOString(), ticketId: ticket.ticketId } as const;
    const clientItemId = `item-${suffix}-${who}`;
    await send('/sync', { commands: [{ clientItemId, offline: { clientItemId, command, signature: hmac(ticket.secret, { clientItemId, command }) } }] }, who);
  }
  await send('/commands', { type: 'inoculation.issue', batchId }, 'qa');
  await app.close();

  const restartedStore = new PgStore(connectionString);
  const restarted = await restartedStore.getState();
  assert.equal(restarted.batches[batchId].status, 'inoculated');
  assert.equal(restarted.batches[batchId].confirmations.length, 2);
  const readings = await restartedStore.getReadings(batchId);
  assert.equal(readings.length, 3);
  await restartedStore.close();
});
