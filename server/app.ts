import Fastify from 'fastify';
import cors from '@fastify/cors';
import { decide, decideOrReject, DomainError, evidenceCount, issueReasons, newId, nowIso, watermark } from './domain.js';
import { authenticate, hmac, randomSecret, randomTicketId, verifyOfflineCommand, type OfflineEnvelope } from './auth.js';
import { Store } from './store.js';
import { Device, User, Command, ClockAnchor, SourceKind, Reading } from './types.js';

export interface AppOptions {
  store: Store;
  users: User[];
  devices: Device[];
  logger?: boolean;
  allowedOrigin?: string;
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: opts.allowedOrigin ?? true });

  app.setErrorHandler((error, _req, reply) => {
    const code = (error as DomainError).code ?? 'INTERNAL';
    const status = (error as DomainError).statusCode ?? 500;
    if (status >= 500) app.log.error(error as Error);
    reply.status(status).send({ error: { code, message: (error as Error).message } });
  });

  const actorOf = (req: import('fastify').FastifyRequest) => authenticate(opts.users, req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  const deviceOf = (req: import('fastify').FastifyRequest) => {
    const token = req.headers['x-device-token'];
    const device = opts.devices.find((d) => d.ingestToken === token && d.active);
    if (!device) throw new DomainError('UNAUTHORIZED', '设备令牌无效或设备停用', 401);
    return device;
  };

  app.get('/health', async () => ({ ok: true, time: nowIso() }));

  app.post('/auth/login', async (req) => {
    const { token } = req.body as { token?: string };
    const user = opts.users.find((u) => u.token === token);
    if (!user) throw new DomainError('UNAUTHORIZED', '账号令牌无效', 401);
    return { user: { id: user.id, name: user.name, roles: user.roles }, bearer: user.token };
  });

  app.post('/auth/offline-ticket', async (req) => {
    const actor = actorOf(req);
    const ttlMs = Number((req.body as { ttlMs?: number }).ttlMs ?? 12 * 60 * 60 * 1000);
    if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) throw new DomainError('BAD_TTL', '离线票券 TTL 必须在 1 分钟到 7 天之间');
    const ticketId = randomTicketId(), secret = randomSecret();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const ticket = await opts.store.issueTicket({ ticketId, userId: actor.userId, secret, expiresAt });
    return { ticketId: ticket.ticketId, secret: ticket.secret, expiresAt: ticket.expiresAt, scope: ['inoculation.confirm'], note: '该票券只能证明账号在离线前完成了在线授权；授权在服务端签发时再次校验。' };
  });

  app.post('/auth/offline-ticket/:id/revoke', async (req) => {
    actorOf(req);
    await opts.store.revokeTicket((req.params as { id: string }).id);
    return { revoked: true };
  });

  app.get('/me', async (req) => ({ actor: actorOf(req) }));

  app.get('/state', async (req) => {
    actorOf(req);
    const state = await opts.store.getState();
    const readings = await opts.store.getReadings();
    const anchors = await opts.store.getAnchors();
    return { state, readings, anchors, devices: opts.devices.map(({ ingestToken, ...d }) => d), users: opts.users.map(({ token, ...u }) => u) };
  });

  app.get('/batches/:id', async (req) => {
    actorOf(req);
    const id = (req.params as { id: string }).id;
    const state = await opts.store.getState();
    const batch = state.batches[id];
    if (!batch) throw new DomainError('NOT_FOUND', '批次不存在', 404);
    const readings = await opts.store.getReadings(id);
    const anchors = await opts.store.getAnchors();
    const watermarks = state.batches[id]?.evidenceRequirements.map((req) => ({ ...req, globalWatermark: watermark(readings, req.sourceId), currentCount: evidenceCount(readings, req.sourceId, req.startSeq) })) ?? [];
    return { batch, readings, anchors: anchors.filter((a) => watermarks.some((w) => w.sourceId === a.sourceId)), watermarks };
  });

  app.post('/commands', async (req) => {
    const actor = actorOf(req);
    const command = req.body as Command;
    const readings = await opts.store.getReadings();
    const out = await opts.store.transact((state) => decideOrReject(state, command, actor, readings)) as { events: import('./types.js').StoredEvent[]; state: import('./types.js').RootState; rejection?: DomainError };
    if (out.rejection) throw out.rejection;
    return { accepted: true, events: out.events };
  });

  interface ReadingInput { clientReadingId?: string; sourceId?: string; batchId?: string; seq?: number; value?: number; observedAt?: string; calibrationAnchorId?: string }
  interface AnchorInput { sourceId?: string; seq?: number; deviceTime?: string; referenceTime?: string }
  app.post('/sync', async (req) => {
    const actor = actorOf(req);
    const body = req.body as { anchors?: AnchorInput[]; readings?: ReadingInput[]; commands?: Array<{ clientItemId: string; online?: Command; offline?: OfflineEnvelope<Command> }> };
    const anchorsResult = [];
    for (const input of body.anchors ?? []) {
      try {
        const device = opts.devices.find((d) => d.id === input.sourceId && d.active);
        if (!device) throw new DomainError('UNKNOWN_SOURCE', '未注册或已停用的时钟来源', 400);
        if (!input.seq || !input.deviceTime || !input.referenceTime) throw new DomainError('BAD_ANCHOR', '锚点需要 sourceId, seq, deviceTime, referenceTime');
        const anchorSeq = input.seq;
        const deviceMs = Date.parse(input.deviceTime), refMs = Date.parse(input.referenceTime);
        if (Number.isNaN(deviceMs) || Number.isNaN(refMs)) throw new DomainError('BAD_TIME', '时间格式无效');
        const anchor: Omit<ClockAnchor, 'receivedAt'> = { anchorId: newId('anc'), sourceId: device.id, seq: anchorSeq, deviceTime: input.deviceTime, referenceTime: input.referenceTime, driftMs: deviceMs - refMs };
        const result = await opts.store.addAnchor(anchor);
        anchorsResult.push(result.duplicate ? { ok: true, duplicate: true, sourceId: device.id, seq: input.seq } : { ok: true, anchor });
      } catch (error) { anchorsResult.push({ ok: false, error: explain(error) }); }
    }

    const readingsResult = [];
    for (const input of body.readings ?? []) {
      try {
        const device = opts.devices.find((d) => d.id === input.sourceId && d.active);
        if (!device) throw new DomainError('UNKNOWN_SOURCE', '未注册或已停用的读数来源', 400);
        if (!input.batchId || !input.seq || !Number.isFinite(input.value) || !input.observedAt) throw new DomainError('BAD_READING', '读数需要 sourceId,batchId,seq,value,observedAt');
        const readingSeq = input.seq!; const readingValue = input.value!;
        if (Number.isNaN(Date.parse(input.observedAt))) throw new DomainError('BAD_TIME', 'observedAt 格式无效');
        validateValue(device.kind, readingValue);
        const state = await opts.store.getState();
        if (!state.batches[input.batchId]) throw new DomainError('UNKNOWN_BATCH', '批次不存在', 404);
        const reading: Omit<Reading, 'receivedAt'> = { readingId: newId('rdg'), sourceId: device.id, sourceKind: device.kind, batchId: input.batchId, seq: readingSeq, value: readingValue, observedAt: input.observedAt, calibrationAnchorId: input.calibrationAnchorId };
        const result = await opts.store.addReading(reading);
        readingsResult.push(result.duplicate ? { ok: true, duplicate: true, sourceId: device.id, seq: input.seq, note: '相同(sourceId,seq)被视为重复同步，不移动水位' } : { ok: true, reading });
      } catch (error) { readingsResult.push({ ok: false, error: explain(error) }); }
    }

    const commandsResult = [];
    for (const item of body.commands ?? []) {
      try {
        let actorCurrent = actor, command: Command;
        if (item.offline) ({ actor: actorCurrent, command } = await verifyOfflineCommand(opts.users, (id) => opts.store.getTicket(id), item.offline, actor));
        else if (item.online) command = item.online;
        else throw new DomainError('BAD_ITEM', '命令必须是 online 或 offline');
        const readings = await opts.store.getReadings();
        const out = await opts.store.transact((state) => decideOrReject(state, command, actorCurrent, readings)) as { events: import('./types.js').StoredEvent[]; state: import('./types.js').RootState; rejection?: DomainError };
        if (out.rejection) throw out.rejection;
        commandsResult.push({ clientItemId: item.clientItemId ?? (item.offline?.clientItemId), ok: true, events: out.events });
      } catch (error) { commandsResult.push({ clientItemId: item.clientItemId ?? item.offline?.clientItemId, ok: false, error: explain(error) }); }
    }
    return { ok: true, anchors: anchorsResult, readings: readingsResult, commands: commandsResult, boundary: boundaryNote };
  });

  app.post('/device/clock-anchor', async (req) => {
    deviceOf(req);
    const input = req.body as AnchorInput;
    const device = opts.devices.find((d) => d.id === input.sourceId && d.active);
    if (!device) throw new DomainError('UNKNOWN_SOURCE', '来源未注册', 400);
    if (!input.seq || !input.deviceTime || !input.referenceTime) throw new DomainError('BAD_ANCHOR', '锚点字段不完整');
    const driftMs = Date.parse(input.deviceTime) - Date.parse(input.referenceTime);
    const result = await opts.store.addAnchor({ anchorId: newId('anc'), sourceId: device.id, seq: input.seq, deviceTime: input.deviceTime, referenceTime: input.referenceTime, driftMs });
    return result.duplicate ? { duplicate: true } : { ok: true, driftMs };
  });

  app.post('/device/readings', async (req) => {
    const device = deviceOf(req);
    const input = req.body as ReadingInput;
    if (!input.batchId || !input.seq || !Number.isFinite(input.value) || !input.observedAt) throw new DomainError('BAD_READING', '读数字段不完整');
    const deviceSeq = input.seq!; const deviceValue = input.value!;
    validateValue(device.kind, deviceValue);
    const state = await opts.store.getState();
    if (!state.batches[input.batchId]) throw new DomainError('UNKNOWN_BATCH', '批次不存在', 404);
    const inserted = await opts.store.addReading({ readingId: newId('rdg'), sourceId: device.id, sourceKind: device.kind, batchId: input.batchId, seq: deviceSeq, value: deviceValue, observedAt: input.observedAt, calibrationAnchorId: input.calibrationAnchorId });
    return inserted.duplicate ? { duplicate: true, watermark: watermark(await opts.store.getReadings(input.batchId), device.id) } : { ok: true, watermark: watermark(await opts.store.getReadings(input.batchId), device.id) };
  });

  app.get('/batches/:id/issue-readiness', async (req) => {
    actorOf(req);
    const id = (req.params as { id: string }).id;
    const state = await opts.store.getState();
    const b = state.batches[id];
    if (!b) throw new DomainError('NOT_FOUND', '批次不存在', 404);
    const readings = await opts.store.getReadings(id);
    return { ready: issueReasons(state, b, readings, true).length === 0, reasons: issueReasons(state, b, readings, true), watermarks: b.evidenceRequirements.map((r) => ({ ...r, globalWatermark: watermark(readings, r.sourceId), currentCount: evidenceCount(readings, r.sourceId, r.startSeq) })) };
  });

  return app;
}

export const boundaryNote = {
  offlineFacts: ['设备读数', '校准锚点', '带有在线签发票券/HMAC签名的人工观察事实', '原始 observedAt 与 (sourceId,seq) 不可由服务端改写'],
  onlineAuthorization: ['身份和资格', '不同账号双签', '菌种/批次版本匹配', '状态机转换', '证据水位', '冲突是否关闭', '最终签发'],
  noAutomation: '平台只记录与阻断，不建议接种量，也不控制冷却设备。'
};

function validateValue(kind: SourceKind, value: number) {
  if (kind === 'ph' && (value < 0 || value > 14)) throw new DomainError('BAD_PH', 'pH 必须在 0-14');
  if (kind === 'temperature' && (value < -10 || value > 130)) throw new DomainError('BAD_TEMPERATURE', '温度超出 -10~130°C');
}
function explain(error: unknown) {
  const e = error as DomainError;
  return { code: e.code ?? 'INTERNAL', message: e.message, statusCode: e.statusCode ?? 500 };
}
export { hmac };
