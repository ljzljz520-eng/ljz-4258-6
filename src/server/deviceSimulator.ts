import { connectDb, migrate, type Db } from './db';
import { AppServices } from './services';
import { seedDemo } from './seed';
import { sha256 } from './crypto';

function iso(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }

export async function runSimulation(db?: Db, opts: { migrateFirst?: boolean; seedFirst?: boolean; loop?: boolean } = {}) {
  db ??= await connectDb();
  if (opts.migrateFirst !== false) await migrate(db);
  if (opts.seedFirst !== false) await seedDemo(db);
  const services = new AppServices(db);
  const admin = { id: 'usr_admin' };
  const runId = Date.now().toString(36);
  const batchId = process.env.SIM_BATCH_ID ?? `bat_sim_${runId}`;
  const tankId = process.env.SIM_TANK_ID ?? `TSIM${runId.slice(-5)}`;
  const out: unknown[] = [];

  async function calibration(source: string, driftMs: number) {
    const r = await services.addCalibration({ id: 'usr_admin' } as any, source, { device_clock_at: iso(driftMs), note: `模拟设备时钟漂移 ${driftMs}ms` });
    out.push(r);
  }
  const existing = await services.one('SELECT id,tank_id FROM batches WHERE id=$1', [batchId]);
  if (existing) {
    if (existing.tank_id !== tankId) throw new Error('SIM_TANK_ID 必须与指定批次罐号一致');
  } else {
    await db.query(
      `INSERT INTO batches(id,version,tank_id,product_name,culture_version_id,milk_base_id,culture_state,milk_state,phase,created_by)
       VALUES ($1,1,$2,'设备模拟发酵乳','stv_labc_100','mlk_demo_1','released','verified','ready','usr_admin')`,
      [batchId, tankId]
    );
    for (const kind of ['temperature', 'ph'] as const) {
      await db.query(
        `INSERT INTO sources(source_id,kind,tank_id) VALUES ($1,$2,$3) ON CONFLICT (source_id) DO NOTHING`,
        [`src_${tankId}_${kind}`, kind, tankId]
      );
    }
    await db.query(
      `INSERT INTO batch_versions(batch_id,version,culture_version_id,milk_base_id,changed_by,reason)
       VALUES ($1,1,'stv_labc_100','mlk_demo_1','usr_admin','simulator')`,
      [batchId]
    );
  }
  await calibration(`src_${tankId}_temperature`, -2500);
  await calibration(`src_${tankId}_ph`, 4300);

  function reading(kind: 'temperature' | 'ph', seq: number, value: number, offsetMs: number, eventId: string) {
    const collectedAt = new Date(iso(offsetMs)).toISOString();
    const canonical = {
      batch_id: batchId, source_id: `src_${tankId}_${kind}`, source_seq: seq,
      kind, value, collected_at: collectedAt
    };
    return { client_event_id: eventId, ...canonical, raw_hash: sha256(JSON.stringify(canonical)) };
  }

  const first = [
    reading('temperature', 1, 42.1, -60_000, `sim_temp_1_${runId}`),
    reading('ph', 1, 6.40, -55_000, `sim_ph_1_${runId}`),
    reading('ph', 2, 6.25, -30_000, `sim_ph_2_${runId}`)
  ];
  for (const r of first) out.push(await services.ingestReading(r, admin));

  // 重复同步必须幂等。
  out.push(await services.ingestReading(first[1], admin));

  // 晚到 pH：序号 3 在重复同步/网络恢复后才到，不覆盖前序事实。
  out.push(await services.ingestReading(reading('ph', 3, 5.90, -10_000, `sim_ph_3_${runId}`), admin));

  if (opts.loop) {
    let seq = 4;
    for (let i = 0; i < 5; i++) {
      out.push(await services.ingestReading(reading('ph', seq++, 5.8 - i * 0.08, -i * 5000, `sim_ph_late_${runId}_${i}`), admin));
      await new Promise(r => setTimeout(r, 20));
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await connectDb();
  const result = await runSimulation(db, { migrateFirst: true, seedFirst: true, loop: process.argv.includes('--loop') });
  console.log(JSON.stringify(result, null, 2));
  await db.close();
}
