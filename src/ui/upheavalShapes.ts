/**
 * 地形大事在地图上的形状(世界坐标,UpheavalOverlay 画):
 * - cellShapes:一组地块(会沉进海里 / 会抬出水面的)的样子 —— 每个地块一块多边形(围着它的三角形的重心连起来),外圈的边
 * - bandOutline:涂的几笔合起来的外轮廓(每笔是一条带子:折线 + 半径)—— 在格子上算"离最近那一笔多远",描出 0 那条等高线
 * 纯计算,不碰 DOM。
 */
import type { Mesh } from '../gen/mesh';

/** cells 那些地块的多边形和外圈的边(跨 180° 经线、在主图上横跨半张图以上的三角形不算) */
export function cellShapes(mesh: Pick<Mesh, 'x' | 'y' | 'triangles' | 'width'>, cells: readonly number[]): { polys: number[][]; edges: number[] } {
  const { x, y, triangles: T, width: W } = mesh;
  const set = new Set(cells);
  const nt = T.length / 3;
  const cen = new Map<number, [number, number]>();
  const around = new Map<number, number[]>();
  const edgeTris = new Map<number, number[]>();
  const N = x.length;
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t];
    const b = T[3 * t + 1];
    const c = T[3 * t + 2];
    const ia = set.has(a);
    const ib = set.has(b);
    const ic = set.has(c);
    if (!ia && !ib && !ic) continue;
    if (Math.max(x[a], x[b], x[c]) - Math.min(x[a], x[b], x[c]) > W / 2) continue;
    cen.set(t, [(x[a] + x[b] + x[c]) / 3, (y[a] + y[b] + y[c]) / 3]);
    if (ia) (around.get(a) ?? around.set(a, []).get(a)!).push(t);
    if (ib) (around.get(b) ?? around.set(b, []).get(b)!).push(t);
    if (ic) (around.get(c) ?? around.set(c, []).get(c)!).push(t);
    for (const [p, q, ip, iq] of [
      [a, b, ia, ib],
      [b, c, ib, ic],
      [c, a, ic, ia],
    ] as [number, number, boolean, boolean][]) {
      if (ip === iq) continue;
      const k = p < q ? p * N + q : q * N + p;
      (edgeTris.get(k) ?? edgeTris.set(k, []).get(k)!).push(t);
    }
  }
  const polys: number[][] = [];
  for (const [v, ts] of around) {
    const pts = ts.map((t) => cen.get(t)!);
    pts.sort((p, q) => Math.atan2(p[1] - y[v], p[0] - x[v]) - Math.atan2(q[1] - y[v], q[0] - x[v]));
    polys.push(pts.flat());
  }
  const edges: number[] = [];
  for (const ts of edgeTris.values()) {
    if (ts.length !== 2) continue;
    const [p, q] = [cen.get(ts[0])!, cen.get(ts[1])!];
    edges.push(p[0], p[1], q[0], q[1]);
  }
  return { polys, edges };
}

/** 点到折线(pts = x0, y0, x1, y1, …;只有一个点 = 到那个点)的距离 */
function segDist(pts: readonly number[], px: number, py: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const bx = i + 2 < pts.length ? pts[i + 2] : ax;
    const by = i + 2 < pts.length ? pts[i + 3] : ay;
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

/** 格子最多这么多个点(笔很长很粗时格子放粗一点) */
const GRID_MAX = 250_000;

/**
 * 几笔带子(折线 + 半径)合起来的外轮廓:闭合的折线,每条 = [x0, y0, x1, y1, …](首尾相接,不重复第一个点)。
 * 格子边长取最细那一笔半径的十分之一,轮廓在格子边上按距离插值,够圆滑
 */
export function bandOutline(strokes: readonly { pts: readonly number[]; r: number }[]): number[][] {
  if (!strokes.length) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let rMin = Infinity;
  for (const s of strokes) {
    rMin = Math.min(rMin, s.r);
    for (let i = 0; i < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i] - s.r);
      x1 = Math.max(x1, s.pts[i] + s.r);
      y0 = Math.min(y0, s.pts[i + 1] - s.r);
      y1 = Math.max(y1, s.pts[i + 1] + s.r);
    }
  }
  let cell = Math.max(0.5, rMin / 10);
  while (((x1 - x0) / cell + 3) * ((y1 - y0) / cell + 3) > GRID_MAX) cell *= 1.5;
  const ox = x0 - cell;
  const oy = y0 - cell;
  const nx = Math.ceil((x1 - x0) / cell) + 3;
  const ny = Math.ceil((y1 - y0) / cell) + 3;
  // 每个格点:离最近那一笔的带子边多远(带子里面是负的);只算每段附近的格点
  const f = new Float32Array(nx * ny).fill(Infinity);
  for (const s of strokes) {
    const n = s.pts.length;
    for (let i = 0; i < n; i += 2) {
      const seg = i + 2 < n ? s.pts.slice(i, i + 4) : s.pts.slice(i, i + 2);
      const sx0 = Math.min(seg[0], seg[2] ?? seg[0]) - s.r - cell;
      const sx1 = Math.max(seg[0], seg[2] ?? seg[0]) + s.r + cell;
      const sy0 = Math.min(seg[1], seg[3] ?? seg[1]) - s.r - cell;
      const sy1 = Math.max(seg[1], seg[3] ?? seg[1]) + s.r + cell;
      const i0 = Math.max(0, Math.floor((sx0 - ox) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((sx1 - ox) / cell));
      const j0 = Math.max(0, Math.floor((sy0 - oy) / cell));
      const j1 = Math.min(ny - 1, Math.ceil((sy1 - oy) / cell));
      for (let j = j0; j <= j1; j++)
        for (let ii = i0; ii <= i1; ii++) {
          const d = segDist(seg, ox + ii * cell, oy + j * cell) - s.r;
          const k = j * nx + ii;
          if (d < f[k]) f[k] = d;
        }
    }
  }
  // 等高线 0(marching squares):交点按"在哪条格子边上"编号,一个格子里连一两段,再把段首尾接成闭合的折线
  const at = (i: number, j: number) => f[j * nx + i];
  /** 横边 (i, j)–(i+1, j) = 2k,竖边 (i, j)–(i, j+1) = 2k + 1(k = j * nx + i) */
  const pt = new Map<number, [number, number]>();
  const cross = (id: number): number => {
    if (pt.has(id)) return id;
    const k = id >> 1;
    const i = k % nx;
    const j = (k / nx) | 0;
    const a = at(i, j);
    const b = id & 1 ? at(i, j + 1) : at(i + 1, j);
    const t = a / (a - b);
    pt.set(id, id & 1 ? [ox + i * cell, oy + (j + t) * cell] : [ox + (i + t) * cell, oy + j * cell]);
    return id;
  };
  const link = new Map<number, number[]>();
  const join = (p: number, q: number) => {
    (link.get(p) ?? link.set(p, []).get(p)!).push(q);
    (link.get(q) ?? link.set(q, []).get(q)!).push(p);
  };
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = at(i, j) < 0;
      const b = at(i + 1, j) < 0;
      const c = at(i + 1, j + 1) < 0;
      const d = at(i, j + 1) < 0;
      const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const k = j * nx + i;
      const top = 2 * k;
      const bottom = 2 * (k + nx);
      const left = 2 * k + 1;
      const right = 2 * (k + 1) + 1;
      const E = (e: number) => cross(e);
      switch (code) {
        case 1:
        case 14:
          join(E(top), E(left));
          break;
        case 2:
        case 13:
          join(E(top), E(right));
          break;
        case 3:
        case 12:
          join(E(left), E(right));
          break;
        case 4:
        case 11:
          join(E(right), E(bottom));
          break;
        case 6:
        case 9:
          join(E(top), E(bottom));
          break;
        case 7:
        case 8:
          join(E(left), E(bottom));
          break;
        case 5:
        case 10: {
          // 两个对角在里面:看格子中心在不在里面
          const mid = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 < 0;
          if ((code === 5) === mid) {
            join(E(top), E(right));
            join(E(left), E(bottom));
          } else {
            join(E(top), E(left));
            join(E(right), E(bottom));
          }
          break;
        }
      }
    }
  const out: number[][] = [];
  const seen = new Set<number>();
  for (const start of link.keys()) {
    if (seen.has(start)) continue;
    const line: number[] = [];
    let prev = -1;
    let cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = pt.get(cur)!;
      line.push(p[0], p[1]);
      const nb = link.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    if (line.length >= 6) out.push(line);
  }
  return out;
}
