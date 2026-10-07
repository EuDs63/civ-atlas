/**
 * 河流侵蚀:地壳被抬升,雨水汇成河把它切开 —— 山谷、山脊、水系都是"冲"出来的,不是画出来的。
 *
 * 模型:流水功率侵蚀定律  dh/dt = U - K · A^m · S
 *   U = 抬升速率,A = 上游汇水量(按降雨加权),S = 坡度。
 * 解法:Braun & Willett (2013) 隐式格式 —— 从入海口往上游逐个 cell 解,无条件稳定。
 * 排水路径:Priority-Flood(Barnes 2014)—— 内陆洼地沿最低溢出口排出,保证每条河都能入海。
 */
import type { Mesh } from './mesh';
import { MinHeap } from './util';
import { geometryOf } from './geometry';

export interface Drainage {
  /** 从入海口到源头的处理顺序(下游一定排在上游前面) */
  order: Int32Array;
  orderLen: number;
  /** 每个陆地 cell 的下游 cell(海洋 cell 为 -1) */
  receiver: Int32Array;
  /** 填平洼地后的水面高度(用于找湖) */
  filled: Float32Array;
}

/**
 * Priority-Flood:从海岸往内陆"涨水",算出每个陆地 cell 的排水去向与处理顺序。
 * eps > 0 时填平区带微坡度(用于路由);eps = 0 时 filled 就是真实积水水位(用于找湖)。
 */
export function drainage(mesh: Mesh, land: Uint8Array, h: Float32Array, eps: number, out?: Drainage): Drainage {
  const { n, adjStart, adj } = mesh;
  const elen = geometryOf(mesh).edgeLengths();
  const order = out?.order ?? new Int32Array(n);
  const receiver = out?.receiver ?? new Int32Array(n);
  const filled = out?.filled ?? new Float32Array(n);
  receiver.fill(-1);
  const state = new Uint8Array(n); // 0 未见, 1 已入堆, 2 已出堆
  const heap = new MinHeap(n);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    state[i] = 2;
    filled[i] = Math.min(h[i], 0);
  }
  // 挨着海的陆地先入堆(先后见 shoreSeeds)
  for (const j of shoreSeeds(mesh, land)) {
    state[j] = 1;
    filled[j] = Math.max(h[j], eps);
    heap.push(j, filled[j]);
  }
  let len = 0;
  while (heap.size) {
    const i = heap.pop();
    state[i] = 2;
    order[len++] = i;
    const fi = filled[i];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (state[j] !== 0) continue;
      state[j] = 1;
      filled[j] = Math.max(h[j], fi + eps);
      heap.push(j, filled[j]);
    }
  }
  // 最陡下降:在填平面上选坡度最大的更低邻居(填平保证一定存在)
  for (let a = 0; a < len; a++) {
    const i = order[a];
    const fi = filled[i];
    let best = -1;
    let bestS = -Infinity;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const fj = land[j] ? filled[j] : Math.min(filled[j], 0);
      if (fj >= fi && land[j]) continue;
      const s = (fi - fj) / elen[k];
      if (s > bestS) {
        bestS = s;
        best = j;
      }
    }
    receiver[i] = best;
  }
  return { order, orderLen: len, receiver, filled };
}

/**
 * 挨着海的陆地块,按"海里的地块按编号、各自的邻居按邻接表的先后"第一次碰到的先后排(注水时就按这个顺序入堆)。
 * 只和海陆有关:侵蚀时同一份海陆要注水几十次,按 land 记住上一次的结果(先核对海陆一个字节都没变)
 */
function shoreSeeds(mesh: Mesh, land: Uint8Array): Int32Array {
  const c = shoreCache.get(land);
  if (c && c.mesh === mesh && sameBytes(c.land, land)) return c.seeds;
  const { n, adjStart, adj } = mesh;
  const seen = new Uint8Array(n);
  const seeds: number[] = [];
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (land[j] && !seen[j]) {
        seen[j] = 1;
        seeds.push(j);
      }
    }
  }
  const out = Int32Array.from(seeds);
  shoreCache.set(land, { mesh, land: land.slice(), seeds: out });
  return out;
}
const shoreCache = new WeakMap<Uint8Array, { mesh: Mesh; land: Uint8Array; seeds: Int32Array }>();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 按 order 逆序把汇水量累加到下游。weight 为每个 cell 自身的产流量。 */
export function accumulate(d: Drainage, land: Uint8Array, weight: Float32Array, out: Float32Array) {
  out.set(weight);
  for (let a = d.orderLen - 1; a >= 0; a--) {
    const i = d.order[a];
    const r = d.receiver[i];
    if (r >= 0 && land[r]) out[r] += out[i];
  }
  return out;
}

export interface ErosionParams {
  steps: number;
  dt: number;
  K: number;
  m: number;
}

/**
 * 在 h 上原地做 steps 步侵蚀。海洋 cell 不动(海平面 = 侵蚀基准面)。
 * rain:每个 cell 的相对降水,决定汇水量(干旱区侵蚀弱 → 高原更完整)。
 */
export function erode(
  mesh: Mesh,
  land: Uint8Array,
  h: Float32Array,
  uplift: Float32Array,
  rain: Float32Array,
  p: ErosionParams,
  onStep?: (step: number) => void,
) {
  const { n, spacing } = mesh;
  const geo = geometryOf(mesh);
  const A = new Float32Array(n);
  let d: Drainage | undefined;
  for (let s = 0; s < p.steps; s++) {
    d = drainage(mesh, land, h, 1e-5, d);
    accumulate(d, land, rain, A);
    const { order, orderLen, receiver } = d;
    for (let a = 0; a < orderLen; a++) {
      const i = order[a];
      const r = receiver[i];
      if (r < 0) continue;
      const hr = land[r] ? h[r] : 0;
      const dist = geo.dist(r, i) / spacing;
      const F = (p.K * p.dt * Math.pow(A[i], p.m)) / dist;
      h[i] = (h[i] + p.dt * uplift[i] + F * hr) / (1 + F);
    }
    onStep?.(s);
  }
}
