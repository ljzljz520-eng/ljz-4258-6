import { clientItemId, enqueue, kvGet, kvSet, allOutbox, updateOutbox } from './db';

export const api = async <T>(path: string, init: RequestInit = {}, token?: string): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? res.statusText), { status: res.status, body: json });
  return json;
};

export function stableStringify(value: unknown): string { return JSON.stringify(cloneSorted(value)); }
function cloneSorted(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneSorted);
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, cloneSorted(value[k])]));
}
export async function hmacHex(secret: string, payload: unknown) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(await stableStringify(payload)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Session { bearer: string; user: { id: string; name: string; roles: string[] }; ticket?: { ticketId: string; secret: string; expiresAt: string } }

export async function login(token: string) {
  const data = await api<{ user: Session['user']; bearer: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ token }) });
  const session: Session = { bearer: data.bearer, user: data.user };
  await kvSet('session', session);
  return session;
}
export async function getSession() { return kvGet<Session>('session'); }
export async function logout() { await kvSet('session', undefined); }
export async function issueOfflineTicket(): Promise<NonNullable<Session['ticket']>> {
  const s = await getSession(); if (!s) throw new Error('请先登录');
  const t = await api<NonNullable<Session['ticket']>>('/auth/offline-ticket', { method: 'POST', body: JSON.stringify({ ttlMs: 3600_000 }) }, s.bearer);
  await kvSet('session', { ...s, ticket: t });
  return t;
}

export async function queueOfflineConfirmation(input: { batchId: string; cultureId: string; culturePlanVersion: number; batchPlanVersion: number; observedAt: string }) {
  const s = await getSession();
  if (!s?.ticket) throw new Error('离线确认需要先联网领取本账号票券；点击两次不能冒充双人。');
  const id = clientItemId();
  const command = { type: 'inoculation.confirm', confirmationId: clientItemId(), ...input, ticketId: s.ticket.ticketId };
  const signature = await hmacHex(s.ticket.secret, { clientItemId: id, command });
  await enqueue({ id, kind: 'command', attempts: 0, createdAt: new Date().toISOString(), status: 'queued', payload: { clientItemId: id, offline: { clientItemId: id, command, signature } } });
}

export async function queueReading(r: { sourceId: string; batchId: string; seq: number; value: number; observedAt: string }) {
  await enqueue({ id: clientItemId(), kind: 'reading', attempts: 0, createdAt: new Date().toISOString(), status: 'queued', payload: r });
}
export async function queueAnchor(a: { sourceId: string; seq: number; deviceTime: string; referenceTime: string }) {
  await enqueue({ id: clientItemId(), kind: 'anchor', attempts: 0, createdAt: new Date().toISOString(), status: 'queued', payload: a });
}

export async function syncOutbox() {
  const s = await getSession(); if (!s) throw new Error('未登录');
  const items = await allOutbox();
  const queued = items.filter((i) => i.status !== 'synced');
  const payload = {
    anchors: queued.filter((i) => i.kind === 'anchor').map((i) => i.payload),
    readings: queued.filter((i) => i.kind === 'reading').map((i) => i.payload),
    commands: queued.filter((i) => i.kind === 'command').map((i) => i.payload),
  };
  if (!payload.anchors.length && !payload.readings.length && !payload.commands.length) return { anchors: [], readings: [], commands: [] };
  const result = await api<any>('/sync', { method: 'POST', body: JSON.stringify(payload) }, s.bearer);
  const groups = [...result.anchors.map((r: any, i: number) => [i, r]), ...result.readings.map((r: any, i: number) => [i, r]), ...result.commands.map((r: any, i: number) => [i, r])];
  const byKind = { anchor: result.anchors, reading: result.readings, command: result.commands } as Record<string, any[]>;
  for (const item of queued) {
    const r = byKind[item.kind]?.shift();
    const next = { ...item, attempts: item.attempts + 1 };
    if (r?.ok || r?.duplicate) Object.assign(next, { status: 'synced', lastError: undefined });
    else Object.assign(next, { status: r?.error?.statusCode === 409 ? 'conflict' : 'blocked', lastError: r?.error?.message ?? '同步失败' });
    await updateOutbox(next);
  }
  return result;
}
