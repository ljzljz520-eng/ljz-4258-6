import { createSignal, For, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { api, issueOfflineTicket, login, logout, queueAnchor, queueOfflineConfirmation, queueReading, syncOutbox, getSession, type Session } from './api';
import { allOutbox, type OutboxItem } from './db';

type Batch = any;
type Reading = any;
type State = any;

const [session, setSession] = createSignal<Session | undefined>();
const [state, setState] = createSignal<State>();
const [outbox, setOutbox] = createSignal<OutboxItem[]>([]);
const [message, setMessage] = createSignal<{ kind: 'ok'|'error'; text: string }>();
const [selected, setSelected] = createSignal('');
const [offline, setOffline] = createSignal(!navigator.onLine);
window.addEventListener('online', () => setOffline(false));
window.addEventListener('offline', () => setOffline(true));

const flash = (kind: 'ok'|'error', text: string) => setMessage({ kind, text });
async function refresh() {
  const s = session(); if (!s) return;
  try { setState(await api('/state', {}, s.bearer)); await refreshOutbox(); } catch (e) { /* offline: last snapshot remains */ }
}
async function refreshOutbox() { setOutbox(await allOutbox()); }
const isoLocal = () => new Date().toISOString();
const batchList = () => Object.values(state()?.state?.batches ?? {}) as Batch[];
const currentBatch = () => {
  const list = batchList();
  return list.find((b) => b.id === selected()) ?? list[0];
};
const batchReadings = () => ((state()?.readings ?? []) as Reading[]).filter((r) => r.batchId === currentBatch()?.id).sort((a,b) => a.seq-b.seq);
const phReadings = () => batchReadings().filter((r) => r.sourceKind === 'ph').sort((a,b)=>a.seq-b.seq);
const tempReadings = () => batchReadings().filter((r) => r.sourceKind === 'temperature').sort((a,b)=>a.seq-b.seq);

async function command(body: unknown, token?: string) {
  try { await api('/commands', { method: 'POST', body: JSON.stringify(body) }, token ?? session()?.bearer); flash('ok', '在线授权命令已接受'); await refresh(); }
  catch (e: any) { flash('error', explain(e)); }
}
function explain(e: any) { return e.body?.error?.message ? `${e.body.error.code}: ${e.body.error.message}` : e.message; }

async function doLogin(token: string) { try { const s = await login(token); setSession(s); flash('ok', `已登录：${s.user.name}`); await refresh(); } catch(e:any){ flash('error', explain(e)); } }
async function doTicket() { try { await issueOfflineTicket(); const s = await getSession(); setSession(s); flash('ok', '已在线领取离线票券；它仅用于离线事实，不代表可离线授权。'); } catch(e:any){ flash('error', explain(e)); } }

function App() {
  getSession().then((s) => { if (s) { setSession(s); refresh(); } });
  refreshOutbox();
  return <main>
    <header><div><h1>发酵乳记录平台</h1><p>记录事实 · 服务端授权 · 不建议接种量 · 不控制冷却</p></div><div class="pill">{offline() ? '离线：先本地保存' : '在线'}</div></header>
    <Show when={message()}><div class={`msg ${message()!.kind}`}>{message()!.text}</div></Show>
    <Show when={!session()} fallback={<SessionBar/>}><Login/></Show>
    <Show when={session()}><Workspace/></Show>
  </main>;
}

function Login() {
  const [token, setToken] = createSignal('demo-operator');
  return <section class="card"><h2>登录</h2><p>演示令牌：demo-operator / demo-quality / demo-supervisor</p><input value={token()} onInput={(e)=>setToken(e.currentTarget.value)}/><button onClick={()=>doLogin(token())}>登录</button></section>;
}
function SessionBar() { const sess = session; return <section class="card session"><div><b>{sess()!.user.name}</b> <span>{sess()!.user.roles.join(',')}</span><p>离线票券：{sess()!.ticket ? `${sess()!.ticket!.ticketId.slice(0,8)}… 到期 ${new Date(sess()!.ticket!.expiresAt).toLocaleString()}` : '未领取'}</p></div><button onClick={doTicket}>在线领取离线票券</button><button onClick={async()=>{await logout();setSession(undefined);}}>退出/换账号</button></section>; }

function Workspace() { return <div class="grid">
  <section class="card"><h2>主数据与建批</h2><MasterForms/></section>
  <section class="card"><h2>离线采集箱</h2><SyncBox/></section>
  <section class="wide"><h2>罐卡</h2><BatchCards/></section>
  <Show when={currentBatch()} keyed><div class="wide"><section class="card wide"><BatchActions b={currentBatch()!}/></section><section class="card wide"><PhChart b={currentBatch()!}/></section></div></Show>
  <section class="wide card"><h2>边界说明</h2><ul><li>离线保存的是设备读数、时钟锚点和“某人某时观察”的已签名事实。</li><li>双签资格、不同账号、菌种/批次版本、证据水位、状态转换只能由后端在线签发。</li><li>补录接种时间使用当时的 observedAt；服务器仍记录 receivedAt，且不会改写设备原始采集时间。</li><li>冲突命令进入待协调；前端展示阻断原因，但不能自行放行。</li></ul></section>
</div>; }

function MasterForms() {
  return <>
    <div class="row"><button onClick={()=>command({type:'culture.register',cultureId:'culture-1',code:'LBC-01'},'demo-supervisor')}>登记菌种 culture-1</button><button onClick={()=>command({type:'culture.release',cultureId:'culture-1'},'demo-quality')}>质量放行菌种</button></div>
    <div class="row"><button onClick={()=>command({type:'milk.register',milkId:'milk-1',code:'MILK-A',supplier:'演示牧场'},'demo-operator')}>登记奶基 milk-1</button><button onClick={()=>command({type:'milk.release',milkId:'milk-1'},'demo-quality')}>质量放行奶基</button></div>
    <CreateBatch/>
  </>;
}
function CreateBatch() {
  const [id,setId]=createSignal(`batch_${crypto.randomUUID().slice(0,8)}`);
  return <div class="form"><input value={id()} onInput={(e)=>setId(e.currentTarget.value)} placeholder="批次ID"/><button onClick={()=>command({type:'batch.create',batchId:id(),label:'发酵罐 '+id(),cultureId:'culture-1',milkId:'milk-1',evidenceRequirements:[{sourceId:'temp-001',startSeq:1,minCount:1},{sourceId:'ph-001',startSeq:1,minCount:2}]},'demo-operator')}>用当前菌种/奶基建批</button></div>;
}

function SyncBox() {
  const [seq,setSeq]=createSignal(1), [value,setValue]=createSignal(4.6), [observedAt,setObservedAt]=createSignal(isoLocal());
  async function add(kind: 'ph'|'temp') { try { await queueReading({sourceId:kind==='ph'?'ph-001':'temp-001',batchId:currentBatch().id,seq:Number(seq()),value:Number(value()),observedAt:observedAt()}); await refreshOutbox(); flash('ok','读数已保存在 IndexedDB；重复(sourceId,seq)同步时幂等忽略。'); } catch(e:any){flash('error',e.message);} }
  async function anchor() { try { await queueAnchor({sourceId:'ph-001',seq:Math.floor(Date.now()/1000),deviceTime:new Date(Date.now()-45000).toISOString(),referenceTime:new Date().toISOString()}); await refreshOutbox(); flash('ok','时钟校准锚点已入箱'); } catch(e:any){flash('error',e.message);} }
  return <>
    <p>当前离线箱 {outbox().length} 条，冲突/阻断 {outbox().filter(x=>x.status!=='synced').length} 条。</p>
    <div class="form"><label>来源序号<input type="number" value={seq()} onInput={(e)=>setSeq(Number(e.currentTarget.value))}/></label><label>pH/温度值<input type="number" step="0.01" value={value()} onInput={(e)=>setValue(Number(e.currentTarget.value))}/></label><label>设备采集时间<input type="datetime-local" value={observedAt().slice(0,16)} onInput={(e)=>setObservedAt(new Date(e.currentTarget.value).toISOString())}/></label></div>
    <div class="row"><button onClick={()=>add('ph')}>离线存 pH</button><button onClick={()=>add('temp')}>离线存温度</button><button onClick={anchor}>存时钟锚点</button></div>
    <button class="primary" disabled={offline()} onClick={async()=>{try{await syncOutbox();await refresh();flash('ok','同步完成');}catch(e:any){flash('error',explain(e));}}}>立即同步/在线授权</button>
    <For each={outbox()}>{(item)=><div class={`outbox ${item.status}`}><b>{item.kind}</b> {item.status} <Show when={item.lastError}><em>{item.lastError}</em></Show></div>}</For>
  </>;
}

function BatchCards() { return <div class="cards"><For each={batchList()}>{(b)=><button class={`tank ${currentBatch()?.id===b.id?'active':''}`} onClick={()=>setSelected(b.id)}><h3>{b.label}</h3><p>{b.id}</p><p>批次 v{b.planVersion} / 修订 {b.revision}</p><p>菌种 {b.cultureId} @v{b.culturePlanVersionAtCreation}</p><dl><dt>接种</dt><dd>{b.inoculation}</dd><dt>冷却</dt><dd>{b.cooling}</dd><dt>灌装</dt><dd>{b.filling}</dd></dl><Show when={b.reconciliation.some((r:any)=>r.status==='open')}><span class="warn">待协调</span></Show></button>}</For></div>; }

function BatchActions(props: {b:Batch}) {
  const [cultureVersion,setCultureVersion]=createSignal(state()?.state.cultures[props.b.cultureId]?.planVersion ?? 1);
  const [batchVersion,setBatchVersion]=createSignal(props.b.planVersion);
  const [observedAt,setObservedAt]=createSignal(isoLocal());
  const [finalTemp,setFinalTemp]=createSignal('');
  const completeCooling = async () => {
    const value = Number(finalTemp());
    if (!Number.isFinite(value)) { flash('error','请填写现场实测冷却终温；系统不提供建议值，也不控制设备。'); return; }
    await command({type:'cooling.complete',batchId:props.b.id,actualTemperatureC:value},'demo-operator');
  };
  async function offlineConfirm() {
    try {
      if (!session()?.ticket) throw new Error('请先用当前账号联网领取票券。若第二人确认，请退出并登录另一个账号；同一人连点两次无效。');
      await queueOfflineConfirmation({batchId:props.b.id,cultureId:props.b.cultureId,culturePlanVersion:cultureVersion(),batchPlanVersion:batchVersion(),observedAt:observedAt()});
      await refreshOutbox(); flash('ok','已保存一条离线接种观察事实；同步后仍须通过后端双人资格与证据水位签发。');
    } catch(e:any){flash('error',e.message);}
  }
  const blocked = props.b.lastIssueBlock?.reasons ?? [];
  return <><h2>{props.b.label} / 操作</h2>
  <div class="form"><label>绑定批次版本<input type="number" value={batchVersion()} onInput={(e)=>setBatchVersion(Number(e.currentTarget.value))}/></label><label>绑定菌种版本<input type="number" value={cultureVersion()} onInput={(e)=>setCultureVersion(Number(e.currentTarget.value))}/></label><label>观察时间（补录也不改原始值）<input type="datetime-local" value={observedAt().slice(0,16)} onInput={(e)=>setObservedAt(new Date(e.currentTarget.value).toISOString())}/></label></div>
  <div class="row"><button onClick={offlineConfirm}>保存本人离线接种确认</button><button onClick={()=>command({type:'inoculation.issue',batchId:props.b.id},'demo-quality')}>质量在线签发接种</button><button onClick={()=>command({type:'cooling.start',batchId:props.b.id,expectedPlanVersion:props.b.planVersion},'demo-operator')}>记录冷却开始</button><span class="inline-input"><input placeholder="实测终温°C（不建议）" value={finalTemp()} onInput={(e)=>setFinalTemp(e.currentTarget.value)}/><button onClick={completeCooling}>记录冷却完成终温</button></span><button onClick={()=>command({type:'filling.start',batchId:props.b.id},'demo-operator')}>记录灌装开始</button><button onClick={()=>command({type:'filling.complete',batchId:props.b.id,packages:1000},'demo-operator')}>记录灌装完成</button></div>
  <Show when={blocked.length}><div class="block"><h3>后端阻断原因</h3><ul><For each={blocked}>{(r)=><li>{r}</li>}</For></ul></div></Show>
  <Reconciliation b={props.b}/><Confirmations b={props.b}/></>;
}
function Confirmations(props:{b:Batch}) { return <div class="evidence"><h3>接种证据</h3><table><thead><tr><th>人员</th><th>角色</th><th>批次v</th><th>菌种v</th><th>观察时间/接收时间</th><th>有效性</th></tr></thead><tbody><For each={props.b.confirmations}>{(c:any)=><tr><td>{c.userName}</td><td>{c.roles.join('|') || '离线票券待核'}</td><td>{c.batchPlanVersion}</td><td>{c.culturePlanVersion}</td><td>{new Date(c.observedAt).toLocaleString()}<small>{new Date(c.receivedAt).toLocaleString()}</small></td><td>{c.valid?'有效':c.invalidReason}</td></tr>}</For></tbody></table></div>; }
function Reconciliation(props:{b:Batch}) { return <For each={props.b.reconciliation.filter((r:any)=>r.status==='open')}>{(r:any)=><div class="block"><h3>待协调：{r.kind}</h3><p>{r.summary}</p><button onClick={()=>command({type:'reconciliation.resolve',batchId:props.b.id,reconciliationId:r.id,resolution:'accepted_after_review'},'demo-supervisor')}>主管复核接受</button><button onClick={()=>command({type:'reconciliation.resolve',batchId:props.b.id,reconciliationId:r.id,resolution:'rejected_and_rerecorded'},'demo-supervisor')}>要求重录</button></div>}</For>; }

function PhChart(props:{b:Batch}) {
  const w=720,h=240,pad=38;
  const points = () => phReadings();
  const y = (v:number)=>h-pad-((v/14)*(h-2*pad));
  const x = (i:number)=>pad+i*((w-2*pad)/Math.max(1,points().length-1));
  const d = ()=>points().map((r,i)=>`${i?'L':'M'}${x(i)},${y(r.value)}`).join(' ');
  return <><h2>pH 曲线（按来源序号排序，晚到数据不重写原值）</h2><div class="chart"><svg viewBox={`0 0 ${w} ${h}`} role="img"><line x1={pad} y1={pad} x2={pad} y2={h-pad}/><line x1={pad} y1={h-pad} x2={w-pad} y2={h-pad}/><path d={d()} fill="none" stroke="#315f4a" stroke-width="3"/><For each={points()}>{(r,i)=><g><circle cx={x(i())} cy={y(r.value)} r="5" fill="#9bbf8f"/><text x={x(i())} y={h-12} text-anchor="middle">#{r.seq}</text></g>}</For><text x="10" y="22">14</text><text x="14" y={h-pad+4}>0</text></svg></div><h3>温度与水位</h3><p>温度：{tempReadings().map(r=>`#${r.seq}@${r.value}℃`).join('，') || '暂无'}；pH：{points().map(r=>`#${r.seq}=${r.value}`).join('，') || '暂无'}</p></>;
}
render(()=><App/>, document.getElementById('root')!);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
