import { Show } from 'solid-js';
import type { Batch, Reading } from '../shared/model';
import { coolingLabel, fillingLabel, phaseLabel } from '../server/state';
import { PhChart } from './PhChart';

export function BatchCard(props: {
  data: { batch: Batch; readings: Reading[]; confirmations: any[]; coordination: any[]; events: any[] };
  onOpen: (id: string) => void;
}) {
  const b = () => props.data.batch;
  const ph = () => props.data.readings.filter(r => r.kind === 'ph');
  const latest = (kind: string) => [...props.data.readings].filter(r => r.kind === kind).sort((a, z) => z.source_seq! - a.source_seq!)[0];
  return <article class={`card phase-${b().phase}`}>
    <div class="card-head">
      <div>
        <h3>罐 {b().tank_id} · {b().product_name}</h3>
        <p class="muted">{b().id} · v{b().version}</p>
      </div>
      <span class={`pill ${b().phase === 'reconcile_required' ? 'danger' : ''}`}>{phaseLabel(b().phase)}</span>
    </div>
    <div class="state-grid">
      <span>接种：{b().inoculation_state}</span>
      <span>冷却：{coolingLabel(b().cooling_state)}</span>
      <span>灌装：{fillingLabel(b().filling_state)}</span>
      <span>pH：{latest('ph') ? latest('ph').value.toFixed(2) : '—'}</span>
      <span>温度：{latest('temperature') ? `${latest('temperature').value.toFixed(1)}°C` : '—'}</span>
      <span>签名：{props.data.confirmations.filter(c => c.result === 'pending' || c.result === 'issued').length}/2</span>
    </div>
    <PhChart readings={ph()} />
    <Show when={props.data.coordination.length > 0}>
      <div class="warning">开放协调项：{props.data.coordination.length}</div>
    </Show>
    <button onClick={() => props.onOpen(b().id)}>打开批次记录</button>
  </article>;
}
