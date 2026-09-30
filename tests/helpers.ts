import { buildApp } from '../server/app.js';
import { MemoryStore } from '../server/store.js';
import { hmac } from '../server/auth.js';
import { Command, Device, User } from '../server/types.js';

export const users: User[] = [
  { id: 'u_operator', name: 'operator', roles: ['operator'], token: 'op' },
  { id: 'u_quality', name: 'quality', roles: ['quality'], token: 'qa' },
  { id: 'u_supervisor', name: 'supervisor', roles: ['supervisor'], token: 'boss' },
];
export const devices: Device[] = [
  { id: 'temp-001', name: 'temp', kind: 'temperature', ingestToken: 'temp-token', active: true },
  { id: 'ph-001', name: 'ph', kind: 'ph', ingestToken: 'ph-token', active: true },
];

export async function makeApp() {
  const store = new MemoryStore(users, devices);
  const app = await buildApp({ store, users, devices });
  return { app, store };
}

export async function post(app: Awaited<ReturnType<typeof makeApp>>['app'], path: string, body: unknown, token?: string, headers: Record<string,string> = {}) {
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  return app.inject({ method: 'POST', url: path, payload: body as any, headers: { ...auth, ...headers } });
}
export async function get(app: any, path: string, token = 'op') {
  return app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } });
}
export async function json(res: import('light-my-request').Response) { return res.json<any>(); }

export async function seedBatch(app: any, batchId: string, req: { tempMin?: number; phMin?: number } = {}) {
  await post(app, '/commands', { type: 'culture.register', cultureId: 'culture-1', code: 'C1' }, 'boss');
  await post(app, '/commands', { type: 'culture.release', cultureId: 'culture-1' }, 'qa');
  await post(app, '/commands', { type: 'milk.register', milkId: 'milk-1', code: 'M1', supplier: 'farm' }, 'op');
  await post(app, '/commands', { type: 'milk.release', milkId: 'milk-1' }, 'qa');
  await post(app, '/commands', { type: 'batch.create', batchId, label: batchId, cultureId: 'culture-1', milkId: 'milk-1', evidenceRequirements: [{ sourceId: 'temp-001', startSeq: 1, minCount: req.tempMin ?? 1 }, { sourceId: 'ph-001', startSeq: 1, minCount: req.phMin ?? 2 }] }, 'op');
}

export async function addReading(app: any, sourceId: 'temp-001'|'ph-001', batchId: string, seq: number, value: number, observedAt = new Date().toISOString()) {
  const token = sourceId === 'ph-001' ? 'ph-token' : 'temp-token';
  return post(app, '/device/readings', { sourceId, batchId, seq, value, observedAt }, undefined as any, { 'x-device-token': token });
}

export async function ticket(app: any, token: string) {
  const res = await post(app, '/auth/offline-ticket', { ttlMs: 3600_000 }, token);
  return res.json<{ ticketId: string; secret: string; expiresAt: string }>();
}

export function confirmationSyncToken(who: 'op'|'qa') { return who === 'op' ? 'op' : 'qa'; }

export async function confirmationItem(app: any, batchId: string, who: 'op'|'qa', suffix: string, versions: { batch: number; culture: number } = { batch: 1, culture: 1 }) {
  const t = await ticket(app, who);
  const command: Command = { type: 'inoculation.confirm', batchId, confirmationId: `conf-${suffix}`, cultureId: 'culture-1', culturePlanVersion: versions.culture, batchPlanVersion: versions.batch, observedAt: new Date().toISOString(), ticketId: t.ticketId };
  const clientItemId = `item-${suffix}`;
  return { clientItemId, offline: { clientItemId, command, signature: hmac(t.secret, { clientItemId, command }) } };
}
