import type { Reading } from '../shared/model';

export function PhChart(props: { readings: Reading[] }) {
  const width = 520;
  const height = 220;
  const pad = 42;
  const points = () => props.readings.filter(r => r.kind === 'ph').sort((a, b) => a.source_seq! - b.source_seq!);
  function coords() {
    const ps = points();
    if (ps.length < 1) return [] as Array<{ x: number; y: number; r: Reading }>;
    const xs = ps.map((_, i) => i + 1);
    const ys = ps.map(p => p.value);
    const minX = 1;
    const maxX = Math.max(2, ...xs);
    const minY = Math.min(...ys) - 0.1;
    const maxY = Math.max(...ys) + 0.1;
    return ps.map((p, i) => ({
      x: pad + ((i + 1 - minX) / (maxX - minX)) * (width - pad * 2),
      y: height - pad - ((p.value - minY) / (maxY - minY)) * (height - pad * 2),
      r: p
    }));
  }
  const path = () => coords().map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return <div class="chart">
    <h4>pH 曲线（按设备来源序号，不按到达服务器顺序）</h4>
    {points().length === 0 ? <p class="muted">暂无 pH 读数</p> : <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="pH 曲线">
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#94a3b8" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="#94a3b8" />
      <path d={path()} fill="none" stroke="#2563eb" stroke-width="3" />
      {coords().map((p, i) => <g>
        <circle cx={p.x} cy={p.y} r={p.r.out_of_order ? 6 : 4} fill={p.r.out_of_order ? '#f97316' : '#2563eb'} />
        <text x={p.x} y={height - 16} text-anchor="middle" font-size="11">#{i + 1}</text>
        <text x={p.x + 7} y={p.y - 7} font-size="11">{p.r.value.toFixed(2)}</text>
      </g>)}
      <text x={14} y={20} font-size="12">pH</text>
      <text x={width - 95} y={height - 8} font-size="12">source_seq</text>
    </svg>}
  </div>;
}
