import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { api, login as doLogin, logout } from './api';
import { idbAllOutbox, idbDeleteOutbox, idbGet } from './db/idb';
import { BatchCard } from './components/BatchCard';
import { BatchDetail } from './components/BatchDetail';

export default function App() {
  const [user, setUser] = createSignal<any>(null);
  const [loginName, setLoginName] = createSignal('alice');
  const [password, setPassword] = createSignal('alice123');
  const [batches, setBatches] = createSignal<any[]>([]);
  const [detail, setDetail] = createSignal<any>(null);
  const [outbox, setOutbox] = createSignal<any[]>([]);
  const [coordination, setCoordination] = createSignal<any[]>([]);
  const [online, setOnline] = createSignal(navigator.onLine);
  const [tank, setTank] = createSignal('T2');
  const [product, setProduct] = createSignal('原味发酵乳');
  const [message, setMessage] = createSignal('');
  const [strains, setStrains] = createSignal<any[]>([]);
  const [milks, setMilks] = createSignal<any[]>([]);

  async function refreshUser() {
    const cached = await idbGet<any>('user');
    if (cached) setUser(cached);
    try { const me = await api<{ user: any }>('/auth/me'); setUser(me.user); } catch { /* token absent/expired */ }
  }
  async function refresh() {
    await refreshUser();
    setOutbox(await idbAllOutbox());
    const data = await api<{ items: any[] }>('/batches').catch(() => ({ items: [] }));
    setBatches(data.items);
    const [c, st, mb] = await Promise.all([
      api<{ items: any[] }>('/coordination?status=open').catch(() => ({ items: [] })),
      api<{ items: any[] }>('/strains').catch(() => ({ items: [] })),
      api<{ items: any[] }>('/milk-bases').catch(() => ({ items: [] }))
    ]);
    setCoordination(c.items); setStrains(st.items); setMilks(mb.items);
  }
  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    const up = () => { setOnline(true); refresh(); };
    const down = () => setOnline(false);
    addEventListener('online', up); addEventListener('offline', down);
    onCleanup(() => { clearInterval(timer); removeEventListener('online', up); removeEventListener('offline', down); });
  });

  async function submitLogin() {
    try { setUser(await doLogin(loginName(), password())); setMessage(''); await refresh(); }
    catch (e: any) { setMessage(e.message); }
  }
  async function doLogout() { await logout(); setUser(null); setDetail(null); }

  async function syncOutbox() {
    const queued = (await idbAllOutbox()).filter(x => x.status === 'queued');
    const readings = queued.filter(x => x.kind === 'temperature' || x.kind === 'ph');
    const proposals = queued.filter(x => x.type === 'inoculation_signature_attempt' || x.type === 'batch_command' || x.type === 'batch_update');
    const result = await api<{ results: any[]; coordination: any[] }>('/sync', {
      method: 'POST',
      body: JSON.stringify({ readings, proposals })
    });
    for (const item of readings) {
      const r = result.results.find(x => x.client_event_id === item.client_event_id);
      if (r?.ok) await idbDeleteOutbox(item.client_event_id);
    }
    for (const item of proposals) {
      const r = result.results.find(x => x.client_event_id === item.client_event_id || x.type === item.type);
      if (r?.ok || r?.reason === 'OFFLINE_CANNOT_ISSUE') await idbDeleteOutbox(item.client_event_id);
    }
    setMessage('同步完成。离线接种尝试仅作为未授权事实留痕，不能产生双签。');
    await refresh();
  }

  async function openBatch(id: string) {
    try { setDetail(await api(`/batches/${id}`)); }
    catch (e: any) { setMessage(e.message); }
  }

  async function resolveItem(id: number) {
    try {
      await api(`/coordination/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision: 'resolved', note: '前端协调确认' }) });
      setMessage('协调项已处理；系统按当前授权状态重新计算批次阶段。');
      await refresh();
    } catch (e: any) { setMessage(e.message); }
  }

  async function transition(type: 'strains' | 'milk-bases', id: string, state: string) {
    try {
      await api(`/${type}/${id}/transition`, { method: 'POST', body: JSON.stringify({ state }) });
      setMessage(`${type === 'strains' ? '菌种' : '奶基'}状态转换已在线授权：${state}`);
      await refresh();
    } catch (e: any) { setMessage(e.message); }
  }

  async function createStrain() {
    try {
      const code = `LAB-${Date.now().toString(36).toUpperCase()}`;
      await api('/strains', { method: 'POST', body: JSON.stringify({ strain_code: code, version: '1.0.0', lot: `LOT-${Date.now()}`, state: 'staged' }) });
      setMessage(`菌种 ${code} 已登记为 staged，需在线放行后才能用于接种。`);
      await refresh();
    } catch (e: any) { setMessage(e.message); }
  }

  async function createMilk() {
    try {
      await api('/milk-bases', { method: 'POST', body: JSON.stringify({ batch_ref: `MILK-${Date.now()}`, volume_liters: 1000 }) });
      setMessage('奶基已登记为 prepared；由质量/主管在线 verified 后才能接种。');
      await refresh();
    } catch (e: any) { setMessage(e.message); }
  }

  async function createBatch() {
    try {
      await api('/batches', { method: 'POST', body: JSON.stringify({ tank_id: tank(), product_name: product() }) });
      setMessage('已创建草稿批次；可在详情中换绑已放行菌种和已验证奶基。');
      await refresh();
    } catch (e: any) { setMessage(e.message); }
  }

  return <main>
    <header>
      <div><h1>发酵乳记录平台</h1><p>罐卡 · pH 谱系 · 离线事实 / 在线授权边界</p></div>
      <div class="userbox">
        <span class={online() ? 'pill' : 'pill danger'}>{online() ? '在线' : '离线'}</span>
        <Show when={user()} fallback={<span>未登录</span>}>
          <span>{user()!.display_name}（{user()!.role}{user()!.can_inoculate ? '，可接种签字' : '，无接种资格'}）</span>
          <button onClick={doLogout}>切换账号/登出</button>
        </Show>
      </div>
    </header>

    <Show when={message()}><div class="notice">{message()}</div></Show>
    <Show when={coordination().length}><div class="warning">平台有 {coordination().length} 个开放待协调项；相关批次状态推进被阻断。</div></Show>

    <Switch>
      <Match when={!user()}>
        <section class="login card">
          <h2>登录</h2>
          <label>账号<input value={loginName()} onInput={e => setLoginName(e.currentTarget.value)} /></label>
          <label>密码<input type="password" value={password()} onInput={e => setPassword(e.currentTarget.value)} /></label>
          <button onClick={submitLogin}>登录（在线授权）</button>
          <p class="muted">演示：alice/alice123、bob/bob123 可接种；carol/carol123 无资格。</p>
        </section>
      </Match>
      <Match when={detail()}>
        <BatchDetail data={detail()} onClose={() => setDetail(null)} onChanged={() => openBatch(detail().batch.id)} />
      </Match>
      <Match when={true}>
        <section class="toolbar card">
          <h2>罐卡总览</h2>
          <label>罐号<input value={tank()} onInput={e => setTank(e.currentTarget.value)} /></label>
          <label>产品<input value={product()} onInput={e => setProduct(e.currentTarget.value)} /></label>
          <button onClick={createBatch}>新建批次</button>
          <button class="secondary" onClick={createStrain}>登记菌种</button>
          <button class="secondary" onClick={createMilk}>登记奶基</button>
          <button class="secondary" disabled={!outbox().some(x => x.status === 'queued')} onClick={syncOutbox}>同步 IndexedDB 队列（{outbox().filter(x => x.status === 'queued').length}）</button>
          <p class="muted">离线可采集温度/pH 事实；状态推进、换签和接种签发均需在线服务授权。</p>
        </section>
        <section class="cards">
          <For each={batches()}>{b => <BatchCard data={b} onOpen={openBatch} />}</For>
        </section>
        <section class="card">
          <h2>物料状态机（在线授权）</h2>
          <h3>菌种</h3>
          <For each={strains()}>{x => <div class="queue-row">{x.strain_code} {x.version} · {x.lot} · {x.state}
            <button onClick={() => transition('strains', x.id, x.state === 'released' ? 'quarantined' : 'released')}>{x.state === 'released' ? '隔离' : '放行'}</button>
            <button class="secondary" onClick={() => transition('strains', x.id, 'consumed')}>消耗</button>
          </div>}</For>
          <h3>奶基</h3>
          <For each={milks()}>{x => <div class="queue-row">{x.batch_ref} · {String(x.volume_liters)}L · {x.state}
            <button disabled={x.state !== 'prepared'} onClick={() => transition('milk-bases', x.id, 'verified')}>验证</button>
            <button class="secondary" disabled={x.state === 'consumed' || x.state === 'rejected'} onClick={() => transition('milk-bases', x.id, x.state === 'verified' ? 'consumed' : 'rejected')}>{x.state === 'verified' ? '消耗' : '拒收'}</button>
          </div>}</For>
        </section>
        <section class="card">
          <h2>开放待协调</h2>
          <For each={coordination()}>{c => <div class="warning queue-row"><b>{c.kind}</b> · {c.batch_id ?? '平台'} · {c.reason} <button onClick={() => resolveItem(c.id)}>处理</button></div>}</For>
          <Show when={coordination().length === 0}><p class="muted">无开放协调项。</p></Show>
        </section>
        <section class="card">
          <h2>本地 IndexedDB 队列</h2>
          <For each={outbox()}>{x => <div class="queue-row">{x.kind ? `${x.kind} #${x.source_seq}` : x.type} · {x.client_event_id} · {x.status}</div>}</For>
          <Show when={outbox().length === 0}><p class="muted">暂无待同步事实。</p></Show>
        </section>
      </Match>
    </Switch>
  </main>;
}
