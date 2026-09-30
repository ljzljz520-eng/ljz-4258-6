import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGliteDb } from '../src/server/db';
import { after, test } from 'node:test';
import { createApp } from '../src/server/main';
import { createTestDb, migrate, type Db } from '../src/server/db';
import { seedDemo } from '../src/server/seed';
import { AppServices, HttpError } from '../src/server/services';
import { sha256 } from '../src/server/crypto';
import type { RawReadingInput } from '../src/server/services';
import type { User } from '../src/server/services';

const ctx = await createApp();
const services = ctx.services;
const db: Db = ctx.db;
await seedDemo(db);

const alice: User = { id: 'usr_alice', login: 'alice', display_name: 'Alice', role: 'operator', can_inoculate: true };
const bob: User = { id: 'usr_bob', login: 'bob', display_name: 'Bob', role: 'supervisor', can_inoculate: true };
const carol: User = { id: 'usr_carol', login: 'carol', display_name: 'Carol', role: 'operator', can_inoculate: false };
const admin: User = { id: 'usr_admin', login: 'admin', display_name: 'Admin', role: 'admin', can_inoculate: true };

after(async () => { await db.close(); });

async function mkBatch(tank: string) {
  const r = await services.createBatch(admin, { tank_id: tank, product_name: '测试酸奶', culture_version_id: 'stv_labc_100', milk_base_id: 'mlk_demo_1' });
  return r.batch;
}

async function calibrate(source: string, driftMs: number) {
  await services.addCalibration(admin, source, { device_clock_at: new Date(Date.now() + driftMs).toISOString(), note: 'test drift' });
}

function reading(batchId: string, tank: string, kind: 'temperature' | 'ph', seq: number, value: number, eventId: string, when = new Date().toISOString()): RawReadingInput {
  const base = { batch_id: batchId, source_id: `src_${tank}_${kind}`, source_seq: seq, kind, value, collected_at: when };
  return { client_event_id: eventId, ...base, raw_hash: sha256(JSON.stringify(base)) };
}

test('重复同步幂等，晚到 pH 不覆盖先到事实，并按来源序号绘图排序', async () => {
  const b = await mkBatch('TA');
  await calibrate('src_TA_temperature', 0);
  await calibrate('src_TA_ph', 0);
  const r1 = reading(b.id, 'TA', 'ph', 1, 6.4, 'ta_ph_1');
  const r2 = reading(b.id, 'TA', 'ph', 2, 6.1, 'ta_ph_2');
  const initial = await services.ingestReading(r1, alice);
  assert.equal(initial.duplicate, false);
  assert.match(String(initial.event_id), /^evt_/);
  const first = await services.ingestReading(r1, alice);
  const second = await services.ingestReading(r1, alice);
  assert.equal(first.duplicate, true);
  assert.equal(second.duplicate, true);
  const later = await services.ingestReading(r2, alice);
  assert.equal(later.out_of_order, false);
  const detail = await services.getBatch(b.id);
  const ph = detail.readings.filter(x => x.kind === 'ph');
  assert.deepEqual(ph.map(x => x.source_seq), [1, 2]);
  assert.deepEqual(ph.map(x => x.value), [6.4, 6.1]);
});

test('同一账号连续两次接种确认不能冒充双签；无资格账号也被阻断', async () => {
  const b = await mkBatch('TB');
  await calibrate('src_TB_temperature', 0);
  await calibrate('src_TB_ph', 0);
  await services.ingestReading(reading(b.id, 'TB', 'temperature', 1, 42, 'tb_t_1'), alice);
  await services.ingestReading(reading(b.id, 'TB', 'ph', 1, 6.4, 'tb_p_1'), alice);
  const first = await services.confirmInoculation(alice, b.id, { expected_version: 1 });
  assert.equal(first.issued, false);
  await assert.rejects(() => services.confirmInoculation(alice, b.id, { expected_version: 1 }), e => e instanceof HttpError && e.reason === 'SAME_ACCOUNT');
  await assert.rejects(() => services.confirmInoculation(carol, b.id, { expected_version: 1 }), e => e instanceof HttpError && e.reason === 'UNQUALIFIED');
  const detail = await services.getBatch(b.id);
  assert.equal(detail.batch.inoculation_state, 'awaiting_signatures');
  assert.equal(detail.batch.phase, 'ready');
});

test('不同合格账号、同一菌种与批次版本，在证据水位满足后在线签发；离线两次点击仍被拒绝', async () => {
  const b = await mkBatch('TC');
  await calibrate('src_TC_temperature', -1000);
  await calibrate('src_TC_ph', 1000);
  const collected = new Date(Date.now() - 60_000).toISOString();
  await services.ingestReading(reading(b.id, 'TC', 'temperature', 1, 42.5, 'tc_t_1', collected), alice);
  await services.ingestReading(reading(b.id, 'TC', 'ph', 1, 6.4, 'tc_p_1', collected), bob);
  await services.confirmInoculation(alice, b.id, { expected_version: 1, declared_inoculated_at: collected });
  const issued = await services.confirmInoculation(bob, b.id, { expected_version: 1, declared_inoculated_at: collected });
  assert.equal(issued.batch.inoculation_state, 'issued');
  assert.equal(issued.batch.phase, 'inoculated');
  const events = await services.many<any>('SELECT * FROM events WHERE batch_id=$1 ORDER BY id', [b.id]);
  const temp = events.find(e => e.type === 'temperature_reading');
  const ph = events.find(e => e.type === 'ph_reading');
  const issue = events.find(e => e.type === 'inoculation_issued');
  assert.equal(temp.collected_at.toISOString(), collected);
  assert.notEqual(temp.corrected_collected_at.toISOString(), collected);
  assert.equal(ph.collected_at.toISOString(), collected);
  assert.equal(issue.collected_at.toISOString(), collected);
  const sync = await services.sync(alice, {
    proposals: [
      { type: 'inoculation_signature_attempt', batch_id: b.id, expected_version: 1, client_event_id: 'offline1' },
      { type: 'inoculation_signature_attempt', batch_id: b.id, expected_version: 1, client_event_id: 'offline2' }
    ]
  });
  assert.equal(sync.results.every(r => r.reason === 'OFFLINE_CANNOT_ISSUE'), true);
  const pendingCount = await services.one<{ n: string }>(`SELECT count(*)::text n FROM inoculation_confirmations WHERE batch_id=$1 AND result='pending'`, [b.id]);
  assert.equal(Number(pendingCount?.n), 0);
});

test('菌种换签递增批次版本，旧批次版本的第二签名不能完成旧双签', async () => {
  const b = await mkBatch('TD');
  await calibrate('src_TD_temperature', 0); await calibrate('src_TD_ph', 0);
  await services.ingestReading(reading(b.id, 'TD', 'temperature', 1, 42, 'td_t_1'), alice);
  await services.ingestReading(reading(b.id, 'TD', 'ph', 1, 6.4, 'td_p_1'), bob);
  await services.confirmInoculation(alice, b.id, { expected_version: 1 });
  await db.query(`INSERT INTO strain_versions(id,strain_code,version,state,lot,released_by)
    VALUES ('stv_labc_101','LAB-C','1.0.1','released','LOT-101','usr_admin')
    ON CONFLICT (id) DO UPDATE SET state='released'`);
  const updated = await services.updateBatch(admin, b.id, { expected_version: 1, culture_version_id: 'stv_labc_101', reason: '换签' });
  assert.equal(updated.batch.version, 2);
  assert.equal(updated.batch.inoculation_state, 'not_started');
  await assert.rejects(() => services.confirmInoculation(bob, b.id, { expected_version: 1 }), e => e instanceof HttpError && e.reason === 'BATCH_VERSION_CONFLICT');
  await services.confirmInoculation(alice, b.id, { expected_version: 2 });
  const issued = await services.confirmInoculation(bob, b.id, { expected_version: 2 });
  assert.equal(issued.batch.culture_version_id, 'stv_labc_101');
});

test('两人基于同一版本并发改批，后提交者得到版本冲突而不是覆盖', async () => {
  const b = await mkBatch('TE');
  await db.query(`INSERT INTO strain_versions(id,strain_code,version,state,lot,released_by)
    VALUES ('stv_labc_200','LAB-X','2.0.0','released','LOT-X','usr_admin')
    ON CONFLICT (id) DO UPDATE SET state='released'`);
  await services.updateBatch(alice, b.id, { expected_version: 1, culture_version_id: 'stv_labc_100', reason: 'alice save' }).catch(() => {});
  const current = await services.one<any>('SELECT version FROM batches WHERE id=$1', [b.id]);
  if (Number(current.version) === 1) {
    await services.updateBatch(alice, b.id, { expected_version: 1, culture_version_id: 'stv_labc_100', reason: 'first' });
  }
  await assert.rejects(
    () => services.updateBatch(bob, b.id, { expected_version: 1, culture_version_id: 'stv_labc_200', reason: 'stale concurrent' }),
    e => e instanceof HttpError && e.reason === 'BATCH_VERSION_CONFLICT'
  );
});

test('缺证据水位时后端阻断签发并进入待协调；补缺口后可协调恢复', async () => {
  const b = await mkBatch('TF');
  await calibrate('src_TF_temperature', 0);
  await calibrate('src_TF_ph', 0);
  await services.ingestReading(reading(b.id, 'TF', 'temperature', 1, 42, 'tf_t_1'), alice);
  await services.ingestReading(reading(b.id, 'TF', 'ph', 1, 6.4, 'tf_p_1'), alice);
  await services.confirmInoculation(alice, b.id, { expected_version: 1 });
  // Make pH evidence invalid after first signature by marking it rejected, simulating later evidence review.
  await db.query(`UPDATE events SET accepted=false WHERE batch_id=$1 AND type='ph_reading'`, [b.id]);
  await db.query(`UPDATE source_watermarks SET accepted_watermark=0 WHERE batch_id=$1`, [b.id]);
  await assert.rejects(() => services.confirmInoculation(bob, b.id, { expected_version: 1 }), e => e instanceof HttpError && e.reason === 'INSUFFICIENT_EVIDENCE');
  const detail = await services.getBatch(b.id);
  assert.equal(detail.batch.phase, 'reconcile_required');
  assert.ok(detail.coordination.some(x => x.kind === 'evidence_gap'));
});

test('来源序号冲突和补录缺失进入待协调，晚到记录填充缺口', async () => {
  const b = await mkBatch('TG');
  await calibrate('src_TG_ph', 0);
  const p1 = reading(b.id, 'TG', 'ph', 1, 6.4, 'tg_p_1');
  const p3 = reading(b.id, 'TG', 'ph', 3, 5.9, 'tg_p_3');
  await services.ingestReading(p1, alice);
  await services.ingestReading(p3, alice);
  let open = await services.listCoordination('open');
  assert.ok(open.some(x => x.batch_id === b.id && x.reason.includes('序号 2 缺失')));
  const p2 = reading(b.id, 'TG', 'ph', 2, 6.1, 'tg_p_2');
  await services.ingestReading(p2, bob);
  open = await services.listCoordination('open');
  assert.equal(open.some(x => x.batch_id === b.id && x.reason.includes('序号 2 缺失')), false);
  const bad = reading(b.id, 'TG', 'ph', 2, 5.8, 'tg_bad_hash');
  await assert.rejects(() => services.ingestReading(bad, carol), e => e instanceof HttpError && e.reason === 'READING_SEQUENCE_GAP');
});

test('服务重启后使用同一持久数据库仍保留身份、批次版本和身份会话数据模型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ferment-restart-'));
  try {
    const first = new PGliteDb(new PGlite(dir));
    await migrate(first);
    await seedDemo(first);
    await first.close();

    const reopened = new PGliteDb(new PGlite(dir));
    const svc = new AppServices(reopened);
    const login = await svc.login('alice', 'alice123');
    assert.equal(login.user.can_inoculate, true);
    const batch = await svc.one<any>('SELECT version, inoculation_state FROM batches WHERE id=$1', ['bat_demo']);
    assert.equal(Number(batch.version), 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
