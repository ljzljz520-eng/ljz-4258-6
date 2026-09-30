import { Command } from './types.js';
import { hmac } from './auth.js';

const base = process.env.API_URL ?? 'http://localhost:8080';

async function req(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  const bodyText = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? '');
  const idempotentSetup = path === '/commands' && init.method === 'POST' && (json.error?.code === 'EXISTS' || (json.error?.code === 'INVALID_STATE' && bodyText.includes('release')));
  if (!res.ok && !idempotentSetup) throw Object.assign(new Error(json.error?.message ?? res.statusText), { status: res.status, json });
  return json;
}
interface Ticket { ticketId: string; secret: string; expiresAt: string }
async function ticket(token: string): Promise<Ticket> { return req('/auth/offline-ticket', { method: 'POST', body: JSON.stringify({ ttlMs: 3600_000 }) }, token); }
function offlineEnvelope(clientItemId: string, command: Command, t: Ticket) {
  return { clientItemId, offline: { clientItemId, command, signature: hmac(t.secret, { clientItemId, command }) } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function simulate(options: { scenario?: string; batchId?: string } = {}) {
  const batchId = options.batchId ?? `batch_${Date.now()}`;
  const runId = batchId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const cultureId = `culture-${runId}`;
  const milkId = `milk-${runId}`;
  const tempStart = 1000 + Math.floor((Date.now() % 1_000_000) / 10) * 3;
  const phStart = tempStart + 5000;
  const scenario = options.scenario ?? process.env.SCENARIO ?? 'happy';
  console.log(`场景=${scenario} 批次=${batchId} 温度起始#=${tempStart} pH起始#=${phStart}`);

  await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'culture.register', cultureId, code: `LBC-${runId}` }) }, 'demo-supervisor');
  await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'culture.release', cultureId }) }, 'demo-quality');
  await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'milk.register', milkId, code: `MILK-${runId}`, supplier: '演示牧场' }) }, 'demo-operator');
  await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'milk.release', milkId }) }, 'demo-quality');
  await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'batch.create', batchId, label: '原味发酵乳', cultureId, milkId, evidenceRequirements: [{ sourceId: 'temp-001', startSeq: tempStart, minCount: 2 }, { sourceId: 'ph-001', startSeq: phStart, minCount: 2 }] }) }, 'demo-operator');

  await req('/device/clock-anchor', { method: 'POST', headers: { 'x-device-token': 'ingest-temp-001' }, body: JSON.stringify({ sourceId: 'temp-001', seq: tempStart, deviceTime: new Date(Date.now() - 90_000).toISOString(), referenceTime: new Date().toISOString() }) });
  await req('/device/clock-anchor', { method: 'POST', headers: { 'x-device-token': 'ingest-ph-001' }, body: JSON.stringify({ sourceId: 'ph-001', seq: phStart, deviceTime: new Date(Date.now() - 45_000).toISOString(), referenceTime: new Date().toISOString() }) });

  const observedBase = Date.now() - 60_000;
  // The second sequence arrives first to prove late seq start fills a contiguous window.
  await req('/device/readings', { method: 'POST', headers: { 'x-device-token': 'ingest-temp-001' }, body: JSON.stringify({ sourceId: 'temp-001', batchId, seq: tempStart + 1, value: 42.6, observedAt: new Date(observedBase + 4000).toISOString() }) });
  await req('/device/readings', { method: 'POST', headers: { 'x-device-token': 'ingest-temp-001' }, body: JSON.stringify({ sourceId: 'temp-001', batchId, seq: tempStart, value: 43.1, observedAt: new Date(observedBase).toISOString() }) });
  await req('/device/readings', { method: 'POST', headers: { 'x-device-token': 'ingest-ph-001' }, body: JSON.stringify({ sourceId: 'ph-001', batchId, seq: phStart + 1, value: 4.55, observedAt: new Date(observedBase + 4000).toISOString() }) });
  const beforeIssue = await req(`/batches/${batchId}/issue-readiness`, {}, 'demo-quality');
  console.log('晚到 pH 起始序号前阻断：', beforeIssue.reasons);
  await req('/device/readings', { method: 'POST', headers: { 'x-device-token': 'ingest-ph-001' }, body: JSON.stringify({ sourceId: 'ph-001', batchId, seq: phStart, value: 4.62, observedAt: new Date(observedBase).toISOString() }) });
  // Exact duplicate is idempotent and never overwrites the original value.
  await req('/device/readings', { method: 'POST', headers: { 'x-device-token': 'ingest-ph-001' }, body: JSON.stringify({ sourceId: 'ph-001', batchId, seq: phStart, value: 9.99, observedAt: new Date(observedBase).toISOString() }) });

  const state0 = await req('/state', {}, 'demo-operator');
  const batchPlanVersion = state0.state.batches[batchId].planVersion;
  const culturePlanVersion = state0.state.cultures[cultureId].planVersion;
  const opTicket = await ticket('demo-operator');
  const qTicket = await ticket('demo-quality');
  const observedInoc = new Date(Date.now() - 20_000).toISOString();
  const confirm = (id: string, who: 'operator'|'quality', version: number, t: Ticket) => offlineEnvelope(`confirm-${id}-${runId}`, { type: 'inoculation.confirm', batchId, confirmationId: `confirmation-${id}-${runId}`, cultureId, culturePlanVersion: version, batchPlanVersion, observedAt: observedInoc, ticketId: t.ticketId }, t);
  const opBody = { commands: [confirm('operator', 'operator', culturePlanVersion, opTicket)] };
  if (scenario === 'double-click') opBody.commands.push(confirm('operator-again', 'operator', culturePlanVersion, opTicket));
  await req('/sync', { method: 'POST', body: JSON.stringify(opBody) }, 'demo-operator');

  if (scenario === 'culture-change') {
    await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'culture.change_sign', cultureId, signVersion: 2 }) }, 'demo-quality');
  }
  await req('/sync', { method: 'POST', body: JSON.stringify({ commands: [confirm('quality', 'quality', scenario === 'culture-change' ? 1 : culturePlanVersion, qTicket)] }) }, 'demo-quality');

  try {
    await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'inoculation.issue', batchId }) }, 'demo-quality');
  } catch (error) { console.log('签发阻断（预期用于换签/双点）：', (error as any).json.error.message); }

  const after = await req(`/batches/${batchId}`, {}, 'demo-quality');
  console.log('接种状态:', after.batch.inoculation, '待协调:', after.batch.reconciliation.length, '证据窗口:', after.watermarks);

  if (scenario === 'happy' && after.batch.inoculation === 'inoculated') {
    await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'cooling.start', batchId }) }, 'demo-operator');
    await sleep(10);
    await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'cooling.complete', batchId, actualTemperatureC: 4.2 }) }, 'demo-operator');
    await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'filling.start', batchId }) }, 'demo-operator');
    await req('/commands', { method: 'POST', body: JSON.stringify({ type: 'filling.complete', batchId, packages: 1200 }) }, 'demo-operator');
  }
  return batchId;
}

if (import.meta.url === `file://${process.argv[1]}`) await simulate();
