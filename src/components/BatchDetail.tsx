import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Reading } from '../shared/model';
import { api, ApiError } from '../api';
import { idbNextSourceSeq, idbPutOutbox } from '../db/idb';
import { PhChart } from './PhChart';
import { coolingLabel, fillingLabel, phaseLabel } from '../server/state';

function hashCanonical(value: unknown) {
  const text = JSON.stringify(value);
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(buf => Array.from(new Uint8Array(buf)).map(x => x.toString(16).padStart(2, '0')).join(''));
}

export function BatchDetail(props: { data: any; onClose: () => void; onChanged: () => void }) {
  const [notice, setNotice] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [kind, setKind] = createSignal<'temperature' | 'ph'>('ph');
  const [value, setValue] = createSignal('');
  const [collectedAt, setCollectedAt] = createSignal('');
  const [declaredAt, setDeclaredAt] = createSignal('');
  const [expectedVersion, setExpectedVersion] = createSignal(String(props.data.batch.version));
  const [cultureId, setCultureId] = createSignal(props.data.batch.culture_version_id ?? '');
  const [strains, setStrains] = createSignal<any[]>([]);
  const b = createMemo(() => props.data.batch);
  const ph = createMemo<Reading[]>(() => props.data.readings.filter((r: Reading) => r.kind === 'ph'));

  async function loadStrains() {
    const data = await api<{ items: any[] }>('/strains').catch(() => ({ items: [] }));
    setStrains(data.items);
  }
  loadStrains();

  async function run(fn: () => Promise<any>, ok: string) {
    try { const r = await fn(); setNotice({ ok: true, text: ok }); props.onChanged(); return r; }
    catch (e) {
      if (e instanceof ApiError) setNotice({ ok: false, text: explain(e) });
      else setNotice({ ok: false, text: String(e) });
    }
  }

  function explain(e: ApiError) {
    const map: Record<string, string> = {
      OFFLINE_CANNOT_ISSUE: '离线点击只是“操作事实”，不是授权；必须恢复网络并由第二个不同账号在线确认。',
      SAME_ACCOUNT: '双签被阻断：两次确认来自同一账号。请另一位有资格账号登录确认。',
      UNQUALIFIED: '双签被阻断：签字账号没有接种资格。',
      CULTURE_VERSION_MISMATCH: '双签被阻断：签名绑定的菌种版本与当前批次不一致。',
      BATCH_VERSION_CONFLICT: '并发修改冲突：批次版本已变化，旧操作不能覆盖新版本。',
      INSUFFICIENT_EVIDENCE: '后端签发检查未通过：温度/pH 证据水位、校准或资格不满足要求。',
      READING_SEQUENCE_GAP: '设备来源序号发生冲突，已进入待协调。',
      INVALID_TRANSITION: '状态机阻断：当前状态不允许该转换。',
      NOT_READY: '前置条件未满足（如奶基未 verified）。',
      OFFLINE: '网络不可用：已按选择保存离线事实或在线授权被暂缓。'
    };
    return `${map[e.code] ?? e.message}${e.details ? ' ' + JSON.stringify(e.details) : ''}`;
  }

  async function capture(online: boolean) {
    const v = Number(value());
    if (!Number.isFinite(v)) return setNotice({ ok: false, text: '请输入有效数值' });
    const sourceId = `src_${b().tank_id}_${kind()}`;
    const seq = await idbNextSourceSeq(sourceId);
    const collected = collectedAt() ? new Date(collectedAt()).toISOString() : new Date().toISOString();
    const clientEventId = `loc_${sourceId}_${seq}_${Date.now().toString(36)}`;
    const canonical = { batch_id: b().id, source_id: sourceId, source_seq: seq, kind: kind(), value: v, collected_at: collected };
    const rawHash = await hashCanonical(canonical);
    const item = { client_event_id: clientEventId, ...canonical, raw_hash: rawHash, status: online ? 'syncing' : 'queued', created_at: new Date().toISOString() };
    await idbPutOutbox(item);
    if (!online) {
      setNotice({ ok: true, text: `已离线保存为事实：${sourceId} 序号 ${seq}。恢复网络后可同步；离线操作不授权接种。` });
      props.onChanged();
      return;
    }
    await run(async () => {
      const r = await api(`/batches/${b().id}/readings`, { method: 'POST', body: JSON.stringify(item) });
      return r;
    }, `测量已在线接收：${sourceId} 序号 ${seq}`);
  }

  async function offlineDoubleClickAttempt() {
    const item = {
      client_event_id: `offline_sig_${crypto.randomUUID()}`,
      type: 'inoculation_signature_attempt',
      batch_id: b().id,
      expected_version: Number(expectedVersion()),
      culture_version_id: cultureId(),
      declared_inoculated_at: declaredAt() ? new Date(declaredAt()).toISOString() : null,
      status: 'queued',
      created_at: new Date().toISOString()
    };
    await idbPutOutbox(item);
    setNotice({ ok: false, text: '已记录一次离线点击。即使连续点两次，同步时也只会保存为两条未授权操作事实，不能冒充双签。' });
    props.onChanged();
  }

  function confirm(online: boolean) {
    if (!online) return offlineDoubleClickAttempt();
    return run(() => api(`/batches/${b().id}/inoculation/confirm`, {
      method: 'POST',
      body: JSON.stringify({ expected_version: Number(expectedVersion()), declared_inoculated_at: declaredAt() || undefined })
    }), '在线签名已提交；若证据与第二名不同合格账号均满足，后端已签发。');
  }

  function command(command: string) {
    return run(() => api(`/batches/${b().id}/commands`, { method: 'POST', body: JSON.stringify({ command, expected_version: Number(expectedVersion()) }) }), '在线状态转换已授权。');
  }

  function changeCulture() {
    return run(() => api(`/batches/${b().id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expected_version: Number(expectedVersion()), culture_version_id: cultureId(), reason: '前端换绑菌种' })
    }), '菌种版本已换签，批次版本递增，旧签名失效。');
  }

  return <section class="drawer">
    <div class="drawer-head">
      <h2>罐 {b().tank_id} / {b().id} · v{b().version} · {phaseLabel(b().phase)}</h2>
      <button onClick={props.onClose}>关闭</button>
    </div>
    <Show when={notice()}><div class={notice()!.ok ? 'ok' : 'error'}>{notice()!.text}</div></Show>
    <div class="two-col">
      <div>
        <h3>状态机</h3>
        <div class="state-grid">
          <span>菌种：{b().culture_state}</span><span>奶基：{b().milk_state}</span>
          <span>接种：{b().inoculation_state}</span><span>冷却：{coolingLabel(b().cooling_state)}</span>
          <span>灌装：{fillingLabel(b().filling_state)}</span><span>接种时间：{b().inoculated_at ?? '未签发'}</span>
        </div>
        <p class="muted">系统只记录和校验状态，不建议接种量，也不自动控制冷却/灌装设备。</p>
        <div class="actions">
          <button disabled={b().phase !== 'ready' && b().inoculation_state !== 'awaiting_signatures'} onClick={() => confirm(true)}>在线接种确认（当前账号）</button>
          <button class="secondary" onClick={() => confirm(false)}>离线点击（仅记事实）</button>
          <button disabled={b().phase !== 'inoculated'} onClick={() => command('start_cooling')}>授权开始冷却</button>
          <button disabled={b().phase !== 'cooling'} onClick={() => command('complete_cooling')}>授权冷却完成</button>
          <button disabled={b().phase !== 'cooled'} onClick={() => command('start_filling')}>授权开始灌装</button>
          <button disabled={b().phase !== 'filling'} onClick={() => command('complete_filling')}>授权灌装完成</button>
        </div>
      </div>
      <div>
        <h3>离线采集</h3>
        <label>类型<select value={kind()} onChange={e => setKind(e.currentTarget.value as any)}><option value="ph">pH</option><option value="temperature">温度</option></select></label>
        <label>数值<input value={value()} onInput={e => setValue(e.currentTarget.value)} placeholder={kind() === 'ph' ? '例如 5.80' : '例如 38.5'} /></label>
        <label>设备显示采集时间<input type="datetime-local" value={collectedAt()} onInput={e => setCollectedAt(e.currentTarget.value)} /></label>
        <div class="actions"><button onClick={() => capture(true)}>在线接收</button><button class="secondary" onClick={() => capture(false)}>存入 IndexedDB</button></div>
        <h3>接种/并发</h3>
        <label>批次版本<input value={expectedVersion()} onInput={e => setExpectedVersion(e.currentTarget.value)} /></label>
        <label>声明接种时间（补录不会改写设备原始 collected_at）<input type="datetime-local" value={declaredAt()} onInput={e => setDeclaredAt(e.currentTarget.value)} /></label>
        <label>菌种版本<select value={cultureId()} onChange={e => setCultureId(e.currentTarget.value)}><For each={strains()}>{s => <option value={s.id}>{s.strain_code} {s.version} / {s.state}</option>}</For></select></label>
        <button onClick={changeCulture}>换绑菌种并递增批次版本</button>
      </div>
    </div>
    <PhChart readings={ph()} />
    <h3>双签（同一 batch_version + culture_version_id）</h3>
    <table><thead><tr><th>账号</th><th>版本</th><th>菌种</th><th>证据水位</th><th>结果</th><th>原因</th></tr></thead><tbody>
      <For each={props.data.confirmations}>{c => <tr><td>{c.signer_id}</td><td>{c.batch_version}</td><td>{c.culture_version_id}</td><td>{c.evidence_watermark}</td><td>{c.result}</td><td>{c.reject_reason ?? ''}</td></tr>}</For>
    </tbody></table>
    <h3>待协调</h3>
    <For each={props.data.coordination}>{c => <div class="warning"><b>{c.kind}</b>：{c.reason}</div>}</For>
    <h3>事件谱系（最近）</h3>
    <table><thead><tr><th>事件</th><th>类型</th><th>边界</th><th>来源序号</th><th>原始时间</th><th>校准时间</th><th>迟序</th></tr></thead><tbody>
      <For each={props.data.events}>{e => <tr><td>{e.event_id.slice(0, 12)}</td><td>{e.type}</td><td>{e.authorization === 'online_authorized' ? '在线授权' : '离线事实'}</td><td>{e.source_id ? `${e.source_id}#${e.source_seq}` : ''}</td><td>{e.collected_at ?? ''}</td><td>{e.corrected_collected_at ?? ''}</td><td>{e.out_of_order ? '是' : ''}</td></tr>}</For>
    </tbody></table>
  </section>;
}
