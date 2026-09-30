import type { Db } from './db';
import { AppServices } from './services';
import { hashPassword, newId } from './crypto';

export async function seedDemo(db: Db) {
  const services = new AppServices(db);
  const users = [
    { id: 'usr_alice', login: 'alice', display_name: 'Alice 操作员', role: 'operator' as const, can_inoculate: true, password: 'alice123' },
    { id: 'usr_bob', login: 'bob', display_name: 'Bob 班长', role: 'supervisor' as const, can_inoculate: true, password: 'bob123' },
    { id: 'usr_carol', login: 'carol', display_name: 'Carol 见习', role: 'operator' as const, can_inoculate: false, password: 'carol123' },
    { id: 'usr_admin', login: 'admin', display_name: '管理员', role: 'admin' as const, can_inoculate: true, password: 'admin123' }
  ];
  for (const u of users) {
    const { salt, hash } = hashPassword(u.password);
    await db.query(
      `INSERT INTO users(id,login,display_name,role,can_inoculate,password_hash,salt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET login=EXCLUDED.login, display_name=EXCLUDED.display_name,
         role=EXCLUDED.role, can_inoculate=EXCLUDED.can_inoculate, password_hash=EXCLUDED.password_hash, salt=EXCLUDED.salt`,
      [u.id, u.login, u.display_name, u.role, u.can_inoculate, hash, salt]
    );
  }

  const strainId = 'stv_labc_100';
  await db.query(
    `INSERT INTO strain_versions(id,strain_code,version,state,lot,released_by)
     VALUES ($1,'LAB-C','1.0.0','released','LOT-LABC-100','usr_admin')
     ON CONFLICT (id) DO UPDATE SET state='released', lot=EXCLUDED.lot, updated_at=now()`,
    [strainId]
  );
  const milkId = 'mlk_demo_1';
  await db.query(
    `INSERT INTO milk_bases(id,batch_ref,state,volume_liters,created_by)
     VALUES ($1,'MILK-DEMO-001','verified',1000,'usr_admin')
     ON CONFLICT (id) DO UPDATE SET state='verified', updated_at=now()`,
    [milkId]
  );
  const exists = await services.one('SELECT id FROM batches WHERE id=$1', ['bat_demo']);
  if (!exists) {
    await db.query(
      `INSERT INTO batches(id,version,tank_id,product_name,culture_version_id,milk_base_id,culture_state,milk_state,phase,created_by)
       VALUES ('bat_demo',1,'T1','原味发酵乳',$1,$2,'released','verified','ready','usr_admin')`,
      [strainId, milkId]
    );
    await db.query(
      `INSERT INTO batch_versions(batch_id,version,culture_version_id,milk_base_id,changed_by,reason)
       VALUES ('bat_demo',1,$1,$2,'usr_admin','demo')`,
      [strainId, milkId]
    );
  }
  for (const kind of ['temperature', 'ph'] as const) {
    await db.query(
      `INSERT INTO sources(source_id,kind,tank_id) VALUES ($1,$2,'T1') ON CONFLICT (source_id) DO NOTHING`,
      [`src_T1_${kind}`, kind]
    );
  }
  return { users: users.map(u => ({ login: u.login, password: u.password })), batchId: 'bat_demo' };
}

export function randomDemoId() { return newId('demo'); }
