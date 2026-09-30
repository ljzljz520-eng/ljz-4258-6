import type { Db } from './db';
import { canonicalHash, newId, sha256 } from './crypto';
import { applyBatchCommand, cultureTransition, milkTransition, StateError, type BatchCommand } from './state';
import type { BlockReason } from '../shared/model';

export interface User {
  id: string;
  login: string;
  display_name: string;
  role: 'operator' | 'supervisor' | 'quality' | 'admin';
  can_inoculate: boolean;
}

interface AuthRow extends User { password_hash: string; salt: string }
type AnyRow = Record<string, any>;

export class HttpError extends Error {
  constructor(public status: number, public reason: string, message: string, public payload: unknown = undefined) {
    super(message);
  }
}

export interface RawReadingInput {
  client_event_id: string;
  batch_id: string;
  source_id: string;
  source_seq: number;
  kind: 'temperature' | 'ph';
  value: number;
  collected_at: string;
  device_clock_at?: string;
  raw_hash?: string;
}

export interface SyncResult {
  results: Array<Record<string, unknown>>;
  coordination: AnyRow[];
}

const evidenceKinds = ['temperature', 'ph'] as const;

export class AppServices {
  constructor(private db: Db) {}

  async one<T = AnyRow>(sql: string, params: unknown[] = []) {
    const r = await this.db.query<T>(sql, params);
    return r.rows[0] as T | undefined;
  }

  async many<T = AnyRow>(sql: string, params: unknown[] = []) {
    return (await this.db.query<T>(sql, params)).rows as T[];
  }

  async login(login: string, password: string) {
    const user = await this.one<AuthRow>('SELECT * FROM users WHERE login=$1', [login]);
    if (!user) throw new HttpError(401, 'UNAUTHORIZED', '账号或密码错误');
    const { scryptSync, timingSafeEqual } = await import('node:crypto');
    const actual = Buffer.from(scryptSync(password, user.salt, 64));
    const wanted = Buffer.from(user.password_hash, 'hex');
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
      throw new HttpError(401, 'UNAUTHORIZED', '账号或密码错误');
    }
    const { randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('hex');
    await this.db.query(
      `INSERT INTO sessions(token,user_id,expires_at) VALUES ($1,$2, now() + interval '7 days')`,
      [token, user.id]
    );
    return { token, user: this.publicUser(user) };
  }

  async authenticate(token?: string): Promise<User> {
    if (!token) throw new HttpError(401, 'UNAUTHORIZED', '需要登录');
    const row = await this.one<AuthRow>(`
      SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token=$1 AND s.expires_at > now()
    `, [token]);
    if (!row) throw new HttpError(401, 'UNAUTHORIZED', '会话已过期，请重新登录');
    return this.publicUser(row);
  }

  async requireRole(user: User, roles: User['role'][]) {
    if (!roles.includes(user.role)) throw new HttpError(403, 'FORBIDDEN', '角色无权执行该操作');
  }

  publicUser(u: AuthRow): User {
    return { id: u.id, login: u.login, display_name: u.display_name, role: u.role, can_inoculate: u.can_inoculate };
  }

  async logAuth(user: User | { id: string }, action: string, allowed: boolean, reason: string, batchId?: string, payload = {}) {
    await this.db.query(
      `INSERT INTO authorization_log(user_id,action,batch_id,allowed,reason,payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, action, batchId ?? null, allowed, reason, JSON.stringify(payload)]
    );
  }

  async listStrains() {
    return this.many(`SELECT * FROM strain_versions ORDER BY strain_code, version`);
  }

  async createStrain(user: User, input: { id?: string; strain_code: string; version: string; lot: string; state?: string }) {
    await this.requireRole(user, ['quality', 'admin']);
    const id = input.id ?? newId('stv');
    const state = input.state ?? 'staged';
    try {
      await this.db.query(
        `INSERT INTO strain_versions(id,strain_code,version,lot,state,released_by)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $5='released' THEN $6 ELSE NULL END)`,
        [id, input.strain_code, input.version, input.lot, state, user.id]
      );
    } catch (e: any) {
      if (String(e.message).includes('duplicate')) throw new HttpError(409, 'CONFLICT', '菌种版本已存在');
      throw e;
    }
    return this.one('SELECT * FROM strain_versions WHERE id=$1', [id]);
  }

  async transitionStrain(user: User, id: string, target: string) {
    await this.requireRole(user, ['quality', 'admin']);
    const row = await this.one<any>('SELECT * FROM strain_versions WHERE id=$1', [id]);
    if (!row) throw new HttpError(404, 'NOT_FOUND', '菌种版本不存在');
    try { cultureTransition(row.state, target as any); } catch (e) { throw this.toHttp(e); }
    await this.db.query(
      `UPDATE strain_versions SET state=$1, released_by=COALESCE(released_by,$2), updated_at=now() WHERE id=$3`,
      [target, user.id, id]
    );
    return this.one('SELECT * FROM strain_versions WHERE id=$1', [id]);
  }

  async listMilkBases() {
    return this.many(`SELECT * FROM milk_bases ORDER BY created_at DESC`);
  }

  async createMilkBase(user: User, input: { batch_ref: string; volume_liters: number }) {
    const id = newId('mlk');
    try {
      await this.db.query(
        `INSERT INTO milk_bases(id,batch_ref,state,volume_liters,created_by) VALUES ($1,$2,'prepared',$3,$4)`,
        [id, input.batch_ref, input.volume_liters, user.id]
      );
    } catch (e: any) {
      if (String(e.message).includes('duplicate')) throw new HttpError(409, 'CONFLICT', '奶基批号已存在');
      throw e;
    }
    return this.one('SELECT * FROM milk_bases WHERE id=$1', [id]);
  }

  async transitionMilk(user: User, id: string, target: string) {
    await this.requireRole(user, ['quality', 'admin', 'supervisor']);
    const row = await this.one<any>('SELECT * FROM milk_bases WHERE id=$1', [id]);
    if (!row) throw new HttpError(404, 'NOT_FOUND', '奶基不存在');
    try { milkTransition(row.state, target as any); } catch (e) { throw this.toHttp(e); }
    await this.db.query('UPDATE milk_bases SET state=$1, updated_at=now() WHERE id=$2', [target, id]);
    return this.one('SELECT * FROM milk_bases WHERE id=$1', [id]);
  }

  normalizeReading(row: any) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const kind = row.kind ?? (row.type === 'ph_reading' ? 'ph' : row.type === 'temperature_reading' ? 'temperature' : undefined);
    return {
      ...row,
      kind,
      payload,
      value: Number(payload?.value),
      source_seq: row.source_seq == null ? null : Number(row.source_seq),
      clock_offset_ms: Number(row.clock_offset_ms ?? 0)
    };
  }

  async listBatches() {
    const rows = await this.many<any>(`
      SELECT b.*,
        COALESCE((SELECT jsonb_agg(e ORDER BY e.source_id,e.source_seq)
          FROM events e WHERE e.batch_id=b.id AND e.type IN ('temperature_reading','ph_reading') AND e.accepted=true
        ), '[]'::jsonb) AS readings,
        COALESCE((SELECT jsonb_agg(c ORDER BY c.created_at)
          FROM inoculation_confirmations c WHERE c.batch_id=b.id
        ), '[]'::jsonb) AS confirmations,
        COALESCE((SELECT jsonb_agg(ci ORDER BY ci.created_at DESC)
          FROM coordination_items ci WHERE ci.batch_id=b.id AND ci.status='open'
        ), '[]'::jsonb) AS coordination
      FROM batches b ORDER BY b.updated_at DESC
    `);
    return rows.map(row => ({
      ...row,
      version: Number(row.version),
      readings: (row.readings ?? []).map((r: any) => this.normalizeReading(r)),
      confirmations: row.confirmations ?? [],
      coordination: row.coordination ?? [],
      events: []
    }));
  }

  async getBatch(id: string) {
    const batch = await this.one<any>('SELECT * FROM batches WHERE id=$1', [id]);
    if (!batch) throw new HttpError(404, 'NOT_FOUND', '批次不存在');
    const [readings, confirmations, coordination, events, sources] = await Promise.all([
      this.many<any>(`
        SELECT e.* FROM events e WHERE e.batch_id=$1 AND e.type IN ('temperature_reading','ph_reading') AND e.accepted=true
        ORDER BY e.source_id, e.source_seq
      `, [id]),
      this.many<any>('SELECT * FROM inoculation_confirmations WHERE batch_id=$1 ORDER BY created_at', [id]),
      this.many<any>('SELECT * FROM coordination_items WHERE batch_id=$1 ORDER BY created_at DESC', [id]),
      this.many<any>('SELECT event_id,type,auth_scope AS authorization,accepted,out_of_order,source_id,source_seq,collected_at,corrected_collected_at,client_created_at FROM events WHERE batch_id=$1 ORDER BY id DESC LIMIT 100', [id]),
      this.many<any>('SELECT * FROM sources WHERE tank_id=$1 ORDER BY kind', [batch.tank_id])
    ]);
    return { batch, readings: readings.map(x => this.normalizeReading(x)), confirmations, coordination, events, sources };
  }

  async createBatch(user: User, input: { tank_id: string; product_name: string; culture_version_id?: string; milk_base_id?: string }) {
    const id = newId('bat');
    let cultureState = 'staged';
    let milkState = 'prepared';
    if (input.culture_version_id) {
      const c = await this.one<any>('SELECT * FROM strain_versions WHERE id=$1', [input.culture_version_id]);
      if (!c) throw new HttpError(404, 'NOT_FOUND', '菌种版本不存在');
      cultureState = c.state;
    }
    if (input.milk_base_id) {
      const m = await this.one<any>('SELECT * FROM milk_bases WHERE id=$1', [input.milk_base_id]);
      if (!m) throw new HttpError(404, 'NOT_FOUND', '奶基不存在');
      milkState = m.state;
    }
    await this.db.query(
      `INSERT INTO batches(id,tank_id,product_name,culture_version_id,milk_base_id,culture_state,milk_state,phase,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6='released' AND $7='verified' THEN 'ready' ELSE 'draft' END,$8)`,
      [id, input.tank_id, input.product_name, input.culture_version_id ?? null, input.milk_base_id ?? null, cultureState, milkState, user.id]
    );
    await this.db.query(
      `INSERT INTO batch_versions(batch_id,version,culture_version_id,milk_base_id,changed_by,reason)
       VALUES ($1,1,$2,$3,$4,'created')`,
      [id, input.culture_version_id ?? null, input.milk_base_id ?? null, user.id]
    );
    for (const kind of evidenceKinds) {
      await this.db.query(
        `INSERT INTO sources(source_id,kind,tank_id) VALUES ($1,$2,$3)
         ON CONFLICT (source_id) DO UPDATE SET tank_id=EXCLUDED.tank_id, kind=EXCLUDED.kind`,
        [`src_${input.tank_id}_${kind}`, kind, input.tank_id]
      );
    }
    return this.getBatch(id);
  }

  async updateBatch(user: User, id: string, patch: { expected_version: number; culture_version_id?: string; milk_base_id?: string; reason?: string }) {
    const batch = await this.requireBatch(id);
    if (Number(batch.version) !== Number(patch.expected_version)) {
      await this.logAuth(user, 'batch_update', false, 'BATCH_VERSION_CONFLICT', id, { expected: patch.expected_version, current: batch.version });
      throw new HttpError(409, 'BATCH_VERSION_CONFLICT', '批次已被其他人修改，请刷新后再改', { current_version: batch.version });
    }
    if (batch.inoculation_state === 'issued') throw new HttpError(409, 'INVALID_TRANSITION', '接种已签发，不能换绑菌种或奶基');
    const cultureId = patch.culture_version_id ?? batch.culture_version_id;
    const milkId = patch.milk_base_id ?? batch.milk_base_id;
    const culture = cultureId ? await this.one<any>('SELECT * FROM strain_versions WHERE id=$1', [cultureId]) : undefined;
    const milk = milkId ? await this.one<any>('SELECT * FROM milk_bases WHERE id=$1', [milkId]) : undefined;
    if (cultureId && !culture) throw new HttpError(404, 'NOT_FOUND', '菌种版本不存在');
    if (milkId && !milk) throw new HttpError(404, 'NOT_FOUND', '奶基不存在');
    if (culture && culture.state !== 'released') throw new HttpError(409, 'INVALID_TRANSITION', '只能换绑到 released 状态的菌种版本');
    if (milk && milk.state !== 'verified') throw new HttpError(409, 'INVALID_TRANSITION', '只能使用 verified 状态的奶基');
    const nextVersion = Number(batch.version) + 1;
    await this.db.query(
      `UPDATE inoculation_confirmations
       SET result='rejected', reject_reason='BATCH_VERSION_CONFLICT: 菌种/奶基换签或批次内容已变化', authorized_at=now()
       WHERE batch_id=$1 AND batch_version=$2 AND result='pending'`,
      [id, batch.version]
    );
    await this.db.query(
      `UPDATE batches SET version=$1,culture_version_id=$2,milk_base_id=$3,
        inoculation_state=CASE WHEN inoculation_state='awaiting_signatures' THEN 'not_started' ELSE inoculation_state END,
        culture_state=$5, milk_state=$6, updated_at=now() WHERE id=$4`,
      [nextVersion, cultureId ?? null, milkId ?? null, id, culture?.state ?? batch.culture_state, milk?.state ?? batch.milk_state]
    );
    await this.db.query(
      `INSERT INTO batch_versions(batch_id,version,culture_version_id,milk_base_id,changed_by,reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, nextVersion, cultureId ?? null, milkId ?? null, user.id, patch.reason ?? 'updated']
    );
    await this.db.query(
      `INSERT INTO events(event_id,batch_id,type,payload,author_id,author_role,auth_scope,client_created_at)
       VALUES ($1,$2,'batch_version_changed',$3,$4,$5,'online_authorized',now())`,
      [newId('evt'), id, JSON.stringify({ from: batch.version, to: nextVersion, culture_version_id: cultureId ?? null, milk_base_id: milkId ?? null }), user.id, user.role]
    );
    return this.getBatch(id);
  }

  async addCalibration(user: User, sourceId: string, input: { device_clock_at: string; note?: string }) {
    const source = await this.one<any>('SELECT * FROM sources WHERE source_id=$1', [sourceId]);
    if (!source) throw new HttpError(404, 'NOT_FOUND', '设备来源不存在');
    const deviceMs = Date.parse(input.device_clock_at);
    if (Number.isNaN(deviceMs)) throw new HttpError(400, 'BAD_REQUEST', 'device_clock_at 不是有效时间');
    const offset = Date.now() - deviceMs;
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO calibration_anchors(source_id,device_clock_at,clock_offset_ms,recorded_by,note)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [sourceId, new Date(deviceMs).toISOString(), offset, user.id, input.note ?? '']
    );
    return { id: rows[0].id, source_id: sourceId, device_clock_at: new Date(deviceMs).toISOString(), anchored_at: new Date().toISOString(), clock_offset_ms: offset };
  }

  async listSources() {
    return this.many(`SELECT s.*,
      (SELECT clock_offset_ms FROM calibration_anchors c WHERE c.source_id=s.source_id ORDER BY c.anchored_at DESC LIMIT 1) AS latest_offset_ms
      FROM sources s ORDER BY s.tank_id,s.kind`);
  }

  async ingestReading(input: RawReadingInput, user: User | { id: string; role?: string }) {
    this.validateReading(input);
    const batch = await this.requireBatch(input.batch_id);
    const source = await this.one<any>('SELECT * FROM sources WHERE source_id=$1', [input.source_id]);
    if (!source || source.tank_id !== batch.tank_id || source.kind !== input.kind) {
      throw new HttpError(400, 'BAD_REQUEST', '设备来源、类型或罐号不匹配');
    }
    const canonical = {
      batch_id: input.batch_id, source_id: input.source_id, source_seq: input.source_seq,
      kind: input.kind, value: input.value, collected_at: new Date(input.collected_at).toISOString()
    };
    const hash = sha256(JSON.stringify(canonical));
    if (input.raw_hash && input.raw_hash !== hash) {
      throw new HttpError(409, 'duplicate_mismatch', '原始记录哈希与内容不一致');
    }
    const existingEvent = await this.one<any>('SELECT * FROM events WHERE event_id=$1', [input.client_event_id]);
    if (existingEvent) {
      if (existingEvent.raw_hash === hash) return { duplicate: true, accepted: existingEvent.accepted, event_id: existingEvent.event_id };
      await this.createCoordination('duplicate_mismatch', input.batch_id, input.source_id, '同一客户端事件 ID 提交了不同内容', { client_event_id: input.client_event_id, first_hash: existingEvent.raw_hash, new_hash: hash });
      throw new HttpError(409, 'duplicate_mismatch', '重复同步但内容不同，已进入待协调');
    }
    const sameSeq = await this.one<any>(
      'SELECT * FROM events WHERE batch_id=$1 AND source_id=$2 AND source_seq=$3',
      [input.batch_id, input.source_id, input.source_seq]
    );
    if (sameSeq) {
      if (sameSeq.raw_hash === hash) return { duplicate: true, accepted: sameSeq.accepted, event_id: sameSeq.event_id };
      await this.createCoordination('sequence_conflict', input.batch_id, input.source_id, `来源序号 ${input.source_seq} 出现不同记录`, { source_seq: input.source_seq, first: sameSeq.raw_hash, incoming: hash });
      throw new HttpError(409, 'READING_SEQUENCE_GAP', `来源序号 ${input.source_seq} 冲突，已进入待协调`);
    }

    const anchor = await this.one<any>(
      `SELECT * FROM calibration_anchors WHERE source_id=$1 AND anchored_at <= now() ORDER BY anchored_at DESC LIMIT 1`,
      [input.source_id]
    );
    const offset = anchor ? Number(anchor.clock_offset_ms) : 0;
    const collected = new Date(input.collected_at);
    const corrected = new Date(collected.getTime() + offset);
    const priorMax = await this.one<{ max: number | null }>(
      `SELECT max(source_seq)::int AS max FROM events WHERE batch_id=$1 AND source_id=$2 AND accepted=true`,
      [input.batch_id, input.source_id]
    );
    const outOfOrder = priorMax?.max != null && input.source_seq <= priorMax.max;
    const eventId = newId('evt');
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO events(event_id,batch_id,source_id,source_seq,type,payload,author_id,collected_at,corrected_collected_at,
        client_created_at,calibration_anchor_id,clock_offset_ms,raw_hash,auth_scope,accepted,out_of_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,'offline_fact',true,$13) RETURNING id`,
      [eventId, input.batch_id, input.source_id, input.source_seq, `${input.kind}_reading`,
       JSON.stringify({ value: input.value, unit: input.kind === 'ph' ? 'pH' : 'C' }),
       user.id, collected.toISOString(), corrected.toISOString(), anchor?.id ?? null, offset, hash, outOfOrder]
    );
    await this.refreshWatermark(input.batch_id, input.source_id, rows[0].id);
    if (input.source_seq > (priorMax?.max ?? 0) + 1) {
      for (let seq = (priorMax?.max ?? 0) + 1; seq < input.source_seq; seq++) {
        await this.createCoordination('sequence_conflict', input.batch_id, input.source_id, `来源序号 ${seq} 缺失`, { missing_seq: seq }, 'sequence_gap');
      }
    }
    if (outOfOrder) await this.resolveGapCoordination(input.batch_id, input.source_id, input.source_seq);
    return { duplicate: false, accepted: true, event_id: eventId, out_of_order: outOfOrder, corrected_collected_at: corrected.toISOString() };
  }

  validateReading(input: RawReadingInput) {
    if (!input.client_event_id || !input.batch_id || !input.source_id) throw new HttpError(400, 'BAD_REQUEST', '缺少事件、批次或来源 ID');
    if (!Number.isInteger(input.source_seq) || input.source_seq < 1) throw new HttpError(400, 'BAD_REQUEST', 'source_seq 必须是从 1 开始的整数');
    if (!['temperature', 'ph'].includes(input.kind)) throw new HttpError(400, 'BAD_REQUEST', '未知测量类型');
    if (typeof input.value !== 'number' || !Number.isFinite(input.value)) throw new HttpError(400, 'BAD_REQUEST', '测量值无效');
    if (Number.isNaN(Date.parse(input.collected_at))) throw new HttpError(400, 'BAD_REQUEST', '采集时间无效');
    if (input.kind === 'ph' && (input.value < 3 || input.value > 8)) throw new HttpError(400, 'BAD_REQUEST', 'pH 超出合理范围 3-8（仅格式校验，不提供工艺建议）');
    if (input.kind === 'temperature' && (input.value < -5 || input.value > 100)) throw new HttpError(400, 'BAD_REQUEST', '温度超出合理范围 -5~100°C');
  }

  async refreshWatermark(batchId: string, sourceId: string, eventId: number) {
    const rows = await this.many<{ source_seq: number }>(
      `SELECT source_seq FROM events WHERE batch_id=$1 AND source_id=$2 AND accepted=true AND source_seq IS NOT NULL ORDER BY source_seq`,
      [batchId, sourceId]
    );
    let watermark = 0;
    const seqs = new Set(rows.map(r => Number(r.source_seq)));
    while (seqs.has(watermark + 1)) watermark++;
    await this.db.query(
      `INSERT INTO source_watermarks(batch_id,source_id,accepted_watermark,last_event_id,updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (batch_id,source_id) DO UPDATE SET accepted_watermark=EXCLUDED.accepted_watermark,
         last_event_id=EXCLUDED.last_event_id, updated_at=now()`,
      [batchId, sourceId, watermark, eventId]
    );
  }

  async evidence(batchId: string) {
    const sources = await this.many<any>('SELECT * FROM sources WHERE tank_id=(SELECT tank_id FROM batches WHERE id=$1)', [batchId]);
    const result: Record<string, { kind: string; watermark: number; total: number; calibrated: boolean }> = {};
    for (const s of sources) {
      const w = await this.one<{ accepted_watermark: number }>('SELECT accepted_watermark FROM source_watermarks WHERE batch_id=$1 AND source_id=$2', [batchId, s.source_id]);
      const total = await this.one<{ n: string }>('SELECT count(*)::text AS n FROM events WHERE batch_id=$1 AND source_id=$2 AND accepted=true', [batchId, s.source_id]);
      const anchor = await this.one('SELECT id FROM calibration_anchors WHERE source_id=$1', [s.source_id]);
      result[s.source_id] = { kind: s.kind, watermark: Number(w?.accepted_watermark ?? 0), total: Number(total?.n ?? 0), calibrated: !!anchor };
    }
    return result;
  }

  async evidenceProblems(batchId: string) {
    const evidence = await this.evidence(batchId);
    const problems: string[] = [];
    for (const kind of evidenceKinds) {
      const item = Object.values(evidence).find(e => e.kind === kind);
      if (!item) problems.push(`缺少 ${kind} 设备来源`);
      else if (!item.calibrated) problems.push(`${kind} 设备缺少时钟校准锚点`);
      else if (item.watermark < 1) problems.push(`${kind} 证据连续水位不足（至少需要序号 1）`);
    }
    const gaps = await this.many<any>(`SELECT * FROM coordination_items WHERE batch_id=$1 AND status='open' AND kind='sequence_conflict'`, [batchId]);
    if (gaps.length) problems.push(`存在 ${gaps.length} 个未解决的来源序号缺口/冲突`);
    return { evidence, problems };
  }

  async confirmInoculation(user: User, batchId: string, input: { declared_inoculated_at?: string; expected_version: number; client_created_at?: string }) {
    const batch = await this.requireBatch(batchId);
    if (Number(batch.version) !== Number(input.expected_version)) {
      await this.logAuth(user, 'inoculation_confirm', false, 'BATCH_VERSION_CONFLICT', batchId, input);
      throw new HttpError(409, 'BATCH_VERSION_CONFLICT', '批次版本已变化（可能已换菌种/奶基），旧签名不能计入', { current_version: batch.version });
    }
    if (!batch.culture_version_id) throw new HttpError(409, 'NOT_READY', '批次尚未绑定菌种版本');
    if (batch.culture_state !== 'released') throw new HttpError(409, 'INVALID_TRANSITION', '菌种不是 released，不能接种');
    if (batch.milk_state !== 'verified') throw new HttpError(409, 'NOT_READY', '奶基未 verified');
    if (!user.can_inoculate) {
      await this.logAuth(user, 'inoculation_confirm', false, 'UNQUALIFIED', batchId, {});
      throw new HttpError(403, 'UNQUALIFIED', '当前账号没有接种签字资格');
    }
    if (batch.inoculation_state === 'issued') throw new HttpError(409, 'INVALID_TRANSITION', '接种已经签发');
    if (batch.inoculation_state === 'cancelled') throw new HttpError(409, 'INVALID_TRANSITION', '接种已取消');
    let declared: Date | null = null;
    if (input.declared_inoculated_at) {
      const ms = Date.parse(input.declared_inoculated_at);
      if (Number.isNaN(ms)) throw new HttpError(400, 'BAD_REQUEST', '接种时间无效');
      if (ms > Date.now() + 60_000) throw new HttpError(400, 'BAD_REQUEST', '接种时间不能在未来');
      declared = new Date(ms);
    }
    const { evidence, problems } = await this.evidenceProblems(batchId);
    const watermark = Math.min(...Object.values(evidence).map(e => e.watermark), 0);
    const existingMine = await this.one<any>(
      `SELECT * FROM inoculation_confirmations WHERE batch_id=$1 AND batch_version=$2 AND culture_version_id=$3 AND signer_id=$4 AND result='pending'`,
      [batchId, batch.version, batch.culture_version_id, user.id]
    );
    if (existingMine) throw new HttpError(409, 'SAME_ACCOUNT', '同一账号不能重复点击冒充双签；请另一个有资格账号登录确认');

    const issuedAlready = await this.one<any>(
      `SELECT signer_id FROM inoculation_confirmations WHERE batch_id=$1 AND batch_version=$2 AND culture_version_id=$3 AND result='pending'`,
      [batchId, batch.version, batch.culture_version_id]
    );
    if (issuedAlready?.signer_id === user.id) throw new HttpError(409, 'SAME_ACCOUNT', '同一账号不能进行第二次签字');

    await this.db.query(
      `INSERT INTO inoculation_confirmations(batch_id,batch_version,culture_version_id,signer_id,evidence_watermark,evidence_summary,declared_inoculated_at,result,client_created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
       ON CONFLICT (batch_id,batch_version,culture_version_id,signer_id) DO NOTHING`,
      [batchId, batch.version, batch.culture_version_id, user.id, watermark, JSON.stringify(evidence),
       declared?.toISOString() ?? null, input.client_created_at ? new Date(input.client_created_at).toISOString() : new Date().toISOString()]
    );
    await this.db.query(`UPDATE batches SET inoculation_state='awaiting_signatures', updated_at=now() WHERE id=$1 AND inoculation_state='not_started'`, [batchId]);
    await this.db.query(
      `INSERT INTO events(event_id,batch_id,type,payload,author_id,author_role,auth_scope,client_created_at,collected_at)
       VALUES ($1,$2,'inoculation_signature',$3,$4,$5,'online_authorized',now(),$6)`,
      [newId('evt'), batchId, JSON.stringify({ batch_version: batch.version, culture_version_id: batch.culture_version_id, evidence_ready: problems.length === 0 }), user.id, user.role, declared?.toISOString() ?? null]
    );
    return this.tryIssue(batchId, user);
  }

  async tryIssue(batchId: string, actor: User): Promise<any> {
    const batch = await this.requireBatch(batchId);
    const confirmations = await this.many<any>(
      `SELECT c.*, u.can_inoculate, u.login, u.display_name FROM inoculation_confirmations c
       JOIN users u ON u.id=c.signer_id
       WHERE c.batch_id=$1 AND c.batch_version=$2 AND c.culture_version_id=$3 AND c.result='pending'
       ORDER BY c.created_at`,
      [batchId, batch.version, batch.culture_version_id]
    );
    const distinct = new Map(confirmations.map(c => [c.signer_id, c]));
    if (distinct.size < 2) {
      return { issued: false, status: 'awaiting_signatures', signatures: confirmations.length, need: 2 - distinct.size };
    }
    const reasons: string[] = [];
    for (const c of confirmations) {
      if (!c.can_inoculate) reasons.push(`签字人 ${c.login} 已无接种资格`);
    }
    if (new Set(confirmations.map(c => c.signer_id)).size < 2) reasons.push('两个签名来自同一账号');
    const { problems } = await this.evidenceProblems(batchId);
    reasons.push(...problems);
    if (batch.culture_state !== 'released') reasons.push('菌种当前不是 released');
    if (batch.milk_state !== 'verified') reasons.push('奶基当前不是 verified');
    if (reasons.length) {
      await this.createCoordination('evidence_gap', batchId, null, '接种签发被阻断：' + reasons.join('；'), { reasons });
      for (const c of confirmations) {
        await this.db.query(`UPDATE inoculation_confirmations SET result='rejected', reject_reason=$1, authorized_at=now() WHERE id=$2`, [reasons.join(';'), c.id]);
      }
      await this.db.query(`UPDATE batches SET phase='reconcile_required', updated_at=now() WHERE id=$1`, [batchId]);
      await this.logAuth(actor, 'inoculation_issue', false, 'INSUFFICIENT_EVIDENCE', batchId, { reasons });
      throw new HttpError(409, 'INSUFFICIENT_EVIDENCE', '后端签发检查未通过', { reasons });
    }
    const declaredTimes = confirmations.map(c => c.declared_inoculated_at).filter(Boolean).sort();
    const inoculatedAt = declaredTimes[0] ?? new Date().toISOString();
    await this.db.query(
      `UPDATE batches SET inoculation_state='issued', phase='inoculated', inoculated_at=$1, updated_at=now() WHERE id=$2`,
      [inoculatedAt, batchId]
    );
    for (const c of confirmations) {
      await this.db.query(`UPDATE inoculation_confirmations SET result='issued', authorized_at=now() WHERE id=$1`, [c.id]);
    }
    await this.db.query(
      `INSERT INTO events(event_id,batch_id,type,payload,author_id,author_role,auth_scope,client_created_at,collected_at)
       VALUES ($1,$2,'inoculation_issued',$3,$4,$5,'online_authorized',now(),$6)`,
      [newId('evt'), batchId, JSON.stringify({
        batch_version: batch.version,
        culture_version_id: batch.culture_version_id,
        signers: confirmations.map(c => c.signer_id),
        declared_inoculated_at: inoculatedAt,
        note: '原始设备/人工采集时间保留在各自 events.collected_at，本时间不回写它们'
      }), actor.id, actor.role, inoculatedAt]
    );
    await this.logAuth(actor, 'inoculation_issue', true, 'ISSUED', batchId, { signers: confirmations.map(c => c.signer_id) });
    return this.getBatch(batchId);
  }

  async command(user: User, batchId: string, command: BatchCommand, expectedVersion?: number) {
    const batch = await this.requireBatch(batchId);
    if (expectedVersion && Number(expectedVersion) !== Number(batch.version)) {
      throw new HttpError(409, 'BATCH_VERSION_CONFLICT', '命令基于旧批次版本', { current_version: batch.version });
    }
    let patch: Record<string, unknown>;
    try { patch = applyBatchCommand(batch, command); } catch (e) { throw this.toHttp(e); }
    const fields = Object.entries(patch).map(([k], i) => `${k}=$${i + 2}`).join(',');
    await this.db.query(`UPDATE batches SET ${fields}, updated_at=now() WHERE id=$1`, [batchId, ...Object.values(patch)]);
    await this.db.query(
      `INSERT INTO events(event_id,batch_id,type,payload,author_id,author_role,auth_scope,client_created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'online_authorized',now())`,
      [newId('evt'), batchId, `${command}_command`, JSON.stringify({ expected_version: expectedVersion ?? batch.version }), user.id, user.role]
    );
    return this.getBatch(batchId);
  }

  async sync(user: User, body: { readings?: RawReadingInput[]; proposals?: any[] }) {
    const results: Array<Record<string, unknown>> = [];
    for (const reading of body.readings ?? []) {
      try {
        const result = await this.ingestReading(reading, user);
        results.push({ type: 'reading', client_event_id: reading.client_event_id, ok: true, ...result });
      } catch (e: any) {
        results.push({ type: 'reading', client_event_id: reading.client_event_id, ok: false, reason: e.reason ?? 'BAD_REQUEST', message: e.message });
      }
    }
    for (const proposal of body.proposals ?? []) {
      try {
        if (proposal.type === 'inoculation_signature_attempt') {
          await this.db.query(
            `INSERT INTO events(event_id,batch_id,type,payload,author_id,auth_scope,accepted,client_created_at,collected_at)
             VALUES ($1,$2,'offline_inoculation_attempt',$3,$4,'offline_fact',false,$5,$6)`,
            [proposal.client_event_id ?? newId('evt'), proposal.batch_id, JSON.stringify(proposal), user.id,
             proposal.client_created_at ? new Date(proposal.client_created_at).toISOString() : new Date().toISOString(),
             proposal.declared_inoculated_at ? new Date(proposal.declared_inoculated_at).toISOString() : null]
          );
          await this.logAuth(user, 'offline_inoculation_attempt', false, 'OFFLINE_CANNOT_ISSUE', proposal.batch_id, proposal);
          results.push({ type: proposal.type, client_event_id: proposal.client_event_id, ok: false, reason: 'OFFLINE_CANNOT_ISSUE', message: '离线点击只保存为操作事实，不能形成授权签名；必须由第二个有资格账号在线确认。' });
        } else if (proposal.type === 'batch_command') {
          const batch = await this.requireBatch(proposal.batch_id);
          if (Number(proposal.expected_version) !== Number(batch.version)) {
            await this.createCoordination('offline_conflict', proposal.batch_id, null, '离线状态命令基于旧版本，未获授权', { proposal, current_version: batch.version });
            await this.db.query(`UPDATE batches SET phase='reconcile_required', updated_at=now() WHERE id=$1`, [batch.id]);
            results.push({ type: proposal.type, ok: false, reason: 'BATCH_VERSION_CONFLICT', message: '离线状态与服务器冲突，批次进入待协调' });
          } else {
            const r = await this.command(user, proposal.batch_id, proposal.command, proposal.expected_version);
            results.push({ type: proposal.type, ok: true, batch: r.batch });
          }
        } else if (proposal.type === 'batch_update') {
          try {
            const r = await this.updateBatch(user, proposal.batch_id, proposal);
            results.push({ type: 'batch_update', ok: true, batch: r.batch });
          } catch (e: any) {
            await this.createCoordination('offline_conflict', proposal.batch_id, null, '离线批次修改未获授权: ' + e.message, { proposal });
            await this.db.query(`UPDATE batches SET phase='reconcile_required', updated_at=now() WHERE id=$1`, [proposal.batch_id]);
            results.push({ type: 'batch_update', ok: false, reason: e.reason ?? 'CONFLICT', message: e.message });
          }
        } else {
          results.push({ type: proposal.type, ok: false, reason: 'BAD_REQUEST', message: '未知离线提案' });
        }
      } catch (e: any) {
        results.push({ type: proposal.type, ok: false, reason: e.reason ?? 'CONFLICT', message: e.message });
      }
    }
    const coordination = await this.many<any>('SELECT * FROM coordination_items WHERE status=\'open\' ORDER BY created_at DESC LIMIT 20');
    return { results, coordination };
  }

  async listCoordination(status = 'open') {
    return this.many<any>('SELECT * FROM coordination_items WHERE status=$1 ORDER BY created_at DESC', [status]);
  }

  async resolveCoordination(user: User, id: number, decision: 'resolved' | 'rejected', note = '') {
    await this.requireRole(user, ['quality', 'admin']);
    const item = await this.one<any>('SELECT * FROM coordination_items WHERE id=$1', [id]);
    if (!item) throw new HttpError(404, 'NOT_FOUND', '协调项不存在');
    await this.db.query('UPDATE coordination_items SET status=$1, resolved_at=now(), payload=jsonb_set(COALESCE(payload,\'{}\'::jsonb), \'{resolution}\', $2::jsonb) WHERE id=$3',
      [decision, JSON.stringify({ by: user.id, note, at: new Date().toISOString() }), id]);
    const open = await this.one<{ n: string }>('SELECT count(*)::text n FROM coordination_items WHERE batch_id=$1 AND status=\'open\'', [item.batch_id]);
    if (item.batch_id && Number(open?.n ?? 0) === 0) {
      const b = await this.one<any>('SELECT * FROM batches WHERE id=$1', [item.batch_id]);
      if (b?.phase === 'reconcile_required') {
        let phase = b.inoculation_state === 'issued' ? 'inoculated' : 'ready';
        if (b.cooling_state === 'cooling') phase = 'cooling';
        if (b.cooling_state === 'cooled') phase = 'cooled';
        if (b.filling_state === 'filling') phase = 'filling';
        if (b.filling_state === 'filled') phase = 'completed';
        await this.db.query('UPDATE batches SET phase=$1, updated_at=now() WHERE id=$2', [phase, b.id]);
      }
    }
    return this.one('SELECT * FROM coordination_items WHERE id=$1', [id]);
  }

  async createCoordination(kind: any, batchId: string, sourceId: string | null, reason: string, payload: unknown, key?: string) {
    if (key) {
      const existing = await this.one<any>('SELECT id FROM coordination_items WHERE batch_id=$1 AND source_id IS NOT DISTINCT FROM $2 AND kind=$3 AND status=\'open\' AND payload->>\'key\'=$4',
        [batchId, sourceId, kind, key]);
      if (existing) return existing.id;
    }
    const p = { ...(payload as object), ...(key ? { key } : {}) };
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO coordination_items(kind,batch_id,source_id,reason,payload) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [kind, batchId, sourceId, reason, JSON.stringify(p)]
    );
    return rows[0].id;
  }

  async resolveGapCoordination(batchId: string, sourceId: string, seq: number) {
    await this.db.query(
      `UPDATE coordination_items SET status='resolved', resolved_at=now()
       WHERE kind='sequence_conflict' AND batch_id=$1 AND source_id=$2 AND status='open' AND payload->>'missing_seq'=$3`,
      [batchId, sourceId, String(seq)]
    );
  }

  async requireBatch(id: string) {
    const b = await this.one<any>('SELECT * FROM batches WHERE id=$1', [id]);
    if (!b) throw new HttpError(404, 'NOT_FOUND', '批次不存在');
    return b;
  }

  toHttp(e: unknown) {
    if (e instanceof StateError) return new HttpError(409, e.reason as BlockReason, e.message);
    return e instanceof Error ? new HttpError(500, 'CONFLICT', e.message) : new HttpError(500, 'CONFLICT', '未知错误');
  }
}
