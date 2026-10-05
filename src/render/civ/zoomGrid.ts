/**
 * 放大后逐点重画文明层(细节层,见 detail.ts)用的零件:
 *
 * - 工作网格(detailGrid):细节层画布按 step × step 个画布像素一格,每一格中心在世界上的位置。
 *   等距圆柱是一个仿射变换;弯边投影(伪圆柱)每一行是一条纬线,同一行里世界 x 和画布 x 成正比 ——
 *   所以每一行只记"世界 y、x = a + b·i、有效列"。世界 x 是展开的(可以超出 [0, W),取像素时再取模)。
 * - 界线的空间索引(segIndex / nearestSide):把视口附近的界线切成线段放进网格,
 *   查"离这一点最近的线段在哪一侧、多远"——色块的边跟着平滑后的界线走,放大多少倍都是一条顺滑的线,不是像素台阶。
 * - 海岸抗锯齿(coastBlocks / landCover):水陆像素之间按海拔过零处插值(湖岸取中点),和海岸墨线的位置一致。
 *
 * 纯计算,不碰 DOM。
 */
import type { Raster } from '../../gen/raster';
import type { Mesh } from '../../gen/mesh';
import type { MapProj } from '../projection';
import type { SidedLine } from './borders';
import { xRange } from './lines';

/** 细节层画布:地图平面 → 画布像素(画布 = 平面 × s + (ox, oy))。等距圆柱的地图平面就是世界坐标,x 可以到 2W(右边接的那一份) */
export interface PlaneToCanvas {
  s: number;
  ox: number;
  oy: number;
  /** 弯边投影;等距圆柱 = null */
  mp: MapProj | null;
}

export interface DetailGrid {
  /** 网格大小、一格几个画布像素 */
  gw: number;
  gh: number;
  step: number;
  /** 每一行:世界 y、世界 x = a + b·i、有效列 [i0, i1)、一格约几个世界单位 */
  wy: Float64Array;
  a: Float64Array;
  b: Float64Array;
  i0: Int32Array;
  i1: Int32Array;
  u: Float32Array;
  /** 盖住的世界范围(x 展开的) */
  box: [number, number, number, number];
}

/** 细节层画布(cw × ch)按 step 分格,算每一格中心的世界坐标。W、H = 世界大小 */
export function detailGrid(v: PlaneToCanvas, cw: number, ch: number, step: number, W: number, H: number): DetailGrid {
  const gw = Math.max(1, Math.ceil(cw / step));
  const gh = Math.max(1, Math.ceil(ch / step));
  const wy = new Float64Array(gh);
  const a = new Float64Array(gh);
  const b = new Float64Array(gh);
  const i0 = new Int32Array(gh);
  const i1 = new Int32Array(gh);
  const u = new Float32Array(gh);
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  const mp = v.mp;
  // 画布像素 → 地图平面
  const px = (i: number) => ((i + 0.5) * step - v.ox) / v.s;
  const py = (j: number) => ((j + 0.5) * step - v.oy) / v.s;
  if (!mp) {
    for (let j = 0; j < gh; j++) {
      const y = py(j);
      wy[j] = y;
      a[j] = px(0);
      b[j] = step / v.s;
      u[j] = step / v.s;
      if (y < 0 || y > H) continue;
      i1[j] = gw;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    bx0 = px(0);
    bx1 = px(gw - 1);
  } else {
    const { def } = mp;
    const lam0 = (mp.lon0 * Math.PI) / 180;
    // 地图平面 y → 世界 y(外轮廓上下以外 = NaN)
    const worldY = (my: number) => {
      const phi = def.phi((H / 2 - my) / mp.s);
      return Number.isFinite(phi) ? ((Math.PI / 2 - phi) / Math.PI) * H : NaN;
    };
    for (let j = 0; j < gh; j++) {
      const my = py(j);
      const phi = def.phi((H / 2 - my) / mp.s);
      if (!Number.isFinite(phi)) continue;
      const K = mp.s * def.kx(phi);
      if (K < 1e-9) continue;
      const y = ((Math.PI / 2 - phi) / Math.PI) * H;
      wy[j] = y;
      // 世界 x = W·(λrel + λ0 + π) / 2π,λrel = (mx − W/2) / K —— 和 mx 成正比
      const c = W / (2 * Math.PI * K);
      a[j] = (W * (lam0 + Math.PI)) / (2 * Math.PI) + c * (px(0) - W / 2);
      b[j] = (c * step) / v.s;
      const hw = K * Math.PI;
      const lo = Math.ceil(((W / 2 - hw) * v.s + v.ox) / step - 0.5);
      const hi = Math.floor(((W / 2 + hw) * v.s + v.ox) / step - 0.5);
      i0[j] = Math.max(0, lo);
      i1[j] = Math.min(gw, hi + 1);
      if (i1[j] <= i0[j]) {
        i1[j] = i0[j] = 0;
        continue;
      }
      // 一格的世界大小:横向 b,纵向按上下半格的世界 y 差(取两者的几何平均)
      const ya = worldY(my - (0.5 * step) / v.s);
      const yb = worldY(my + (0.5 * step) / v.s);
      const vert = Number.isFinite(ya) && Number.isFinite(yb) ? Math.abs(yb - ya) : b[j];
      u[j] = Math.sqrt(b[j] * Math.max(1e-9, vert));
      const xa = a[j] + b[j] * i0[j];
      const xb = a[j] + b[j] * (i1[j] - 1);
      if (xa < bx0) bx0 = xa;
      if (xb > bx1) bx1 = xb;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  if (!(bx0 <= bx1)) bx0 = bx1 = by0 = by1 = 0;
  return { gw, gh, step, wy, a, b, i0, i1, u, box: [bx0, by0, bx1, by1] };
}

// ---------------------------------------------------------------------------
// 界线的空间索引

/** 断头外面(过了海岸端点再往前):保持原来的归属(同 borders.ts 的 bandLabels) */
export const KEEP = -32768;

export interface SegIndex {
  /** 网格:左上角(世界坐标)、格宽、格数 */
  ox: number;
  oy: number;
  cs: number;
  nx: number;
  ny: number;
  /** 第 c 格的线段:list[start[c] .. start[c+1]) */
  start: Int32Array;
  list: Int32Array;
  /** 多远以内算数(世界单位) */
  band: number;
  // 线段(已挪到和视口同一份):起点、方向、1/长度²、两端的"两侧法线之和"、左右归属、属于哪一份线
  ax: Float64Array;
  ay: Float64Array;
  dx: Float64Array;
  dy: Float64Array;
  inv: Float64Array;
  n0x: Float64Array;
  n0y: Float64Array;
  n1x: Float64Array;
  n1y: Float64Array;
  left: Int32Array;
  right: Int32Array;
  copy: Int32Array;
  /** 每一份线的两个海岸断头:位置、往外的方向(没有断头 = NaN) */
  ends: Float64Array;
}

/** 网格最多多少格 */
const MAX_CELLS = 1 << 20;

/**
 * 把 box(世界坐标,x 展开的)附近、band 以内的界线段放进网格。线的 x 已展开,东西相连时挪整圈放进和 box 同一份。
 * 没有线 = null
 */
export function segIndex(lines: readonly SidedLine[], band: number, box: readonly [number, number, number, number], W: number): SegIndex | null {
  const bx0 = box[0] - band;
  const by0 = box[1] - band;
  const bx1 = box[2] + band;
  const by1 = box[3] + band;
  // 先数线段(每份线挪到哪几圈)
  const copies: { l: SidedLine; sh: number }[] = [];
  let nseg = 0;
  for (const l of lines) {
    const m = l.pts.length / 2;
    if (m < 2) continue;
    let ylo = Infinity;
    let yhi = -Infinity;
    for (let i = 1; i < l.pts.length; i += 2) {
      if (l.pts[i] < ylo) ylo = l.pts[i];
      if (l.pts[i] > yhi) yhi = l.pts[i];
    }
    if (yhi < by0 || ylo > by1) continue;
    const [lo, hi] = xRange(l.pts);
    const k0 = W ? Math.ceil((bx0 - hi) / W) : 0;
    const k1 = W ? Math.floor((bx1 - lo) / W) : 0;
    if (!W && (hi < bx0 || lo > bx1)) continue;
    for (let k = k0; k <= k1; k++) {
      copies.push({ l, sh: k * W });
      nseg += m - 1;
    }
  }
  if (!nseg) return null;
  const cs = Math.max(band, Math.sqrt(((bx1 - bx0) * (by1 - by0)) / MAX_CELLS));
  const nx = Math.max(1, Math.ceil((bx1 - bx0) / cs));
  const ny = Math.max(1, Math.ceil((by1 - by0) / cs));
  const ax = new Float64Array(nseg);
  const ay = new Float64Array(nseg);
  const dx = new Float64Array(nseg);
  const dy = new Float64Array(nseg);
  const inv = new Float64Array(nseg);
  const n0x = new Float64Array(nseg);
  const n0y = new Float64Array(nseg);
  const n1x = new Float64Array(nseg);
  const n1y = new Float64Array(nseg);
  const left = new Int32Array(nseg);
  const right = new Int32Array(nseg);
  const copy = new Int32Array(nseg);
  const ends = new Float64Array(copies.length * 8).fill(NaN);
  let s = 0;
  copies.forEach(({ l, sh }, ci) => {
    const p = l.pts;
    const m = p.length / 2;
    const segs = m - 1;
    const nxs = new Float64Array(segs);
    const nys = new Float64Array(segs);
    for (let i = 0; i < segs; i++) {
      const ddx = p[i * 2 + 2] - p[i * 2];
      const ddy = p[i * 2 + 3] - p[i * 2 + 1];
      const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      nxs[i] = -ddy / len;
      nys[i] = ddx / len;
    }
    for (let i = 0; i < segs; i++) {
      const prev = i > 0 ? i - 1 : l.closed ? segs - 1 : i;
      const next = i + 1 < segs ? i + 1 : l.closed ? 0 : i;
      ax[s] = p[i * 2] + sh;
      ay[s] = p[i * 2 + 1];
      dx[s] = p[i * 2 + 2] - p[i * 2];
      dy[s] = p[i * 2 + 3] - p[i * 2 + 1];
      const l2 = dx[s] * dx[s] + dy[s] * dy[s];
      inv[s] = l2 > 0 ? 1 / l2 : 0;
      n0x[s] = nxs[prev] + nxs[i];
      n0y[s] = nys[prev] + nys[i];
      n1x[s] = nxs[i] + nxs[next];
      n1y[s] = nys[i] + nys[next];
      left[s] = l.left;
      right[s] = l.right;
      copy[s] = ci;
      s++;
    }
    // 海岸断头:往外的方向取最后几个点(手绘抖动不影响)
    const back = Math.min(segs, 4);
    if (l.end0) {
      ends[ci * 8] = p[0] + sh;
      ends[ci * 8 + 1] = p[1];
      ends[ci * 8 + 2] = p[0] - p[back * 2];
      ends[ci * 8 + 3] = p[1] - p[back * 2 + 1];
    }
    if (l.end1) {
      ends[ci * 8 + 4] = p[segs * 2] + sh;
      ends[ci * 8 + 5] = p[segs * 2 + 1];
      ends[ci * 8 + 6] = p[segs * 2] - p[(segs - back) * 2];
      ends[ci * 8 + 7] = p[segs * 2 + 1] - p[(segs - back) * 2 + 1];
    }
  });
  // 每段放进它(外扩 band)盖到的格:先数、再填(CSR)
  const N = nx * ny;
  const count = new Int32Array(N + 1);
  const span = (i: number, f: (c: number) => void) => {
    const xa = Math.min(ax[i], ax[i] + dx[i]) - band;
    const xb = Math.max(ax[i], ax[i] + dx[i]) + band;
    const ya = Math.min(ay[i], ay[i] + dy[i]) - band;
    const yb = Math.max(ay[i], ay[i] + dy[i]) + band;
    const cx0 = Math.max(0, Math.floor((xa - bx0) / cs));
    const cx1 = Math.min(nx - 1, Math.floor((xb - bx0) / cs));
    const cy0 = Math.max(0, Math.floor((ya - by0) / cs));
    const cy1 = Math.min(ny - 1, Math.floor((yb - by0) / cs));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) f(cy * nx + cx);
  };
  for (let i = 0; i < nseg; i++) span(i, (c) => count[c + 1]++);
  for (let c = 0; c < N; c++) count[c + 1] += count[c];
  const list = new Int32Array(count[N]);
  const fill = count.slice(0, N);
  for (let i = 0; i < nseg; i++) span(i, (c) => (list[fill[c]++] = i));
  return { ox: bx0, oy: by0, cs, nx, ny, start: count, list, band, ax, ay, dx, dy, inv, n0x, n0y, n1x, n1y, left, right, copy, ends };
}

/** (px, py) 落在哪一格(网格外 = −1) */
export function segCell(ix: SegIndex, px: number, py: number): number {
  const cx = Math.floor((px - ix.ox) / ix.cs);
  const cy = Math.floor((py - ix.oy) / ix.cs);
  if (cx < 0 || cy < 0 || cx >= ix.nx || cy >= ix.ny) return -1;
  return cy * ix.nx + cx;
}

/**
 * 第 cell 格里离 (px, py) 最近的线段(band 以内):返回距离(世界单位;没有 = Infinity),
 * side[0] = 在线的哪一侧的归属(断头外面 = KEEP)。和 bandLabels 同一套判法
 */
export function nearestSide(ix: SegIndex, cell: number, px: number, py: number, side: Int32Array): number {
  const { list, ax, ay, dx, dy, inv, n0x, n0y, n1x, n1y } = ix;
  let best = ix.band * ix.band;
  let hit = -1;
  let hitSide = 0;
  for (let q = ix.start[cell]; q < ix.start[cell + 1]; q++) {
    const i = list[q];
    const rx = px - ax[i];
    const ry = py - ay[i];
    const t = (rx * dx[i] + ry * dy[i]) * inv[i];
    let qx: number;
    let qy: number;
    let sd: number;
    if (t <= 0) {
      qx = rx;
      qy = ry;
      sd = rx * n0x[i] + ry * n0y[i];
    } else if (t >= 1) {
      qx = rx - dx[i];
      qy = ry - dy[i];
      sd = qx * n1x[i] + qy * n1y[i];
    } else {
      qx = rx - dx[i] * t;
      qy = ry - dy[i] * t;
      sd = dx[i] * ry - dy[i] * rx;
    }
    const d2 = qx * qx + qy * qy;
    if (d2 > best) continue;
    best = d2;
    hit = i;
    hitSide = sd;
  }
  if (hit < 0) return Infinity;
  side[0] = hitSide > 0 ? ix.left[hit] : ix.right[hit];
  // 海岸断头外面(过了端点、沿线的方向再往前,band 以内):保持原样
  const e = ix.ends;
  const o = ix.copy[hit] * 8;
  const b2 = ix.band * ix.band;
  for (let k = 0; k < 8; k += 4) {
    const ex = e[o + k];
    if (ex !== ex) continue;
    const ey = e[o + k + 1];
    const vx = px - ex;
    const vy = py - ey;
    if (vx * e[o + k + 2] + vy * e[o + k + 3] > 0 && vx * vx + vy * vy <= b2) {
      side[0] = KEEP;
      break;
    }
  }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------------------
// 海岸抗锯齿

const blockCache = new WeakMap<Raster, Uint8Array>();

/**
 * 每个 2×2 像素块(左上角是第 k 个像素,右边一列东西相连,下边一行到底就用本行)是 0 全是陆地 / 1 水陆都有 / 2 全是水。
 * 每张像素图算一次
 */
export function coastBlocks(r: Raster): Uint8Array {
  let b = blockCache.get(r);
  if (b) return b;
  const { w, h, water } = r;
  b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x1 = x + 1 === w ? 0 : x + 1;
      const n = (water[y * w + x] ? 1 : 0) + (water[y * w + x1] ? 1 : 0) + (water[y1 * w + x] ? 1 : 0) + (water[y1 * w + x1] ? 1 : 0);
      b[y * w + x] = n === 0 ? 0 : n === 4 ? 2 : 1;
    }
  }
  blockCache.set(r, b);
  return b;
}

/**
 * 水陆都有的 2×2 块里一点的陆地覆盖度(0–1):四角(像素中心)的值双线性插值,过零处就是岸线。
 * 只有海:按海拔(陆地取 ≥ 0、海取 < 0)过零,和手绘风的海岸墨线(fantasy.ts 的 fantasyCoastLines)、
 * 写实风放大后的岸线(realistic.ts 的 addLandCells)同一个位置;碰到湖按"陆 1 / 水 −1"取中点。
 * k00 = 左上像素,k10 右、k01 下、k11 右下;fx、fy = 在块里的位置(0–1);rpp = 一个工作格是几个像素(抗锯齿过渡的宽度)
 */
export function landCover(r: Raster, k00: number, k10: number, k01: number, k11: number, fx: number, fy: number, rpp: number): number {
  const { water, elev } = r;
  const lake = water[k00] === 2 || water[k10] === 2 || water[k01] === 2 || water[k11] === 2;
  const val = (k: number) => (lake ? (water[k] ? -1 : 1) : water[k] ? Math.min(-1e-3, elev[k]) : Math.max(0, elev[k]));
  const v00 = val(k00);
  const v10 = val(k10);
  const v01 = val(k01);
  const v11 = val(k11);
  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  const v = top + (bot - top) * fy;
  // 梯度(每像素):换算成"离岸线几个工作格",一格宽的过渡
  const gx = (v10 - v00) * (1 - fy) + (v11 - v01) * fy;
  const gy = bot - top;
  const g = Math.sqrt(gx * gx + gy * gy) * rpp;
  if (!(g > 1e-12)) return v > 0 ? 1 : 0;
  const c = 0.5 + v / g;
  return c <= 0 ? 0 : c >= 1 ? 1 : c;
}

// ---------------------------------------------------------------------------
// 界线管不到的地方

/**
 * 2×2 像素块里几个像素的归属不一样、附近又没有界线(海岸断头外面那一小截、岸边借了邻州的像素……):
 * 看这一点离哪个像素所在地块的中心最近(球面上),就取那个像素 —— 放大后边是顺滑的直线段,不是一格一格的台阶。
 * (cl, sl) = 这一点纬度的余弦、正弦,lon = 经度(弧度);ks = 四个像素的下标。返回 ks 里的第几个
 */
export function nearestCellPixel(mesh: Mesh, cell: Int32Array, ks: Int32Array, cl: number, sl: number, lon: number): number {
  const px = cl * Math.cos(lon);
  const py = cl * Math.sin(lon);
  const xyz = mesh.xyz;
  let best = -Infinity;
  let at = 0;
  for (let q = 0; q < 4; q++) {
    const c = cell[ks[q]] * 3;
    const d = px * xyz[c] + py * xyz[c + 1] + sl * xyz[c + 2];
    if (d > best) {
      best = d;
      at = q;
    }
  }
  return at;
}
