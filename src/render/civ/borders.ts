/**
 * 文明叠加层 · 国界:三角形行进法 + Chaikin 平滑,手绘风再加一点抖动。
 *
 * 1. **州界的"链"**(每个 civ 只算一次,regionChains):遍历 mesh.triangles ——
 *    三个顶点分属两个州的三角形,连两条"异色边"的中点;分属三个州的,三条边的中点各连到重心。
 *    在三州交汇处、海岸(一端碰到水)断开,每条链记下左右两侧各是哪个州。
 * 2. **某一年的界线**(borderLines):左右两州归属不同的链挑出来;在"正好两条被挑中的链相接"的交汇处
 *    把它们接成一条长折线 —— 国界穿过州的交汇处时也是一整条顺滑的线,不会在那里折一下 ——
 *    再用 Chaikin 抹平两遍;手绘风按位置加一点抖动(同一处每帧抖得一样,回放时不闪)。
 * 3. **色块和国界严丝合缝**:territory.ts 铺色块时,离界线 BAND 以内的像素按"在这条线的哪一侧"重新判归属
 *    (bandLabels),色块的边就是画出来的这条线;离得远的像素照旧按 Raster.cell → 州 → 归属。
 *    只画"陆地 — 陆地"之间的界线,海岸线由地形画风负责。
 *
 * 画法:
 *   写实 —— 两国之间:浅色描边 + 深色细实线;国家和部落地带之间:同样的描边 + 虚线
 *   手绘 —— 墨色虚线,每一笔粗细不一;国家和部落地带之间是点划线(和道路的虚线区分开)。沿界的水彩晕染在 territory.ts
 *
 * 主图东西相连:边中点、重心按球面算;链、界线的 x 展开成连续的(见 lines.ts),
 * 接成长线时后一条挪到前一条的那一份上;色块按界线重新判归属、画线时,伸出主图左右边的部分在另一边再算 / 画一份。
 */
import type { Mesh } from '../../gen/mesh';
import type { Civ } from '../../gen/civ/types';
import { Layer } from '../../gen/civ/types';
import { logIndexAfter, ownersAt, type Owners } from '../../gen/civ/timeline';
import { nearX, valueNoise, wrapShifts } from '../common';
import { addToPath, chaikin, cullLines, meshWrap, sphereMean, xRange } from './lines';
import type { CivDrawParams } from './overlay';
import { projectLinePts, type Projector } from '../projection';

/** 色块按界线重新判归属的范围(世界单位):平滑后的线离原始像素分界最多约 3 个单位(单测核对) */
export const BAND = 4;
/** 界线平滑几遍(Chaikin):两遍后每段约 1 个单位长,地图上已看不出折角 */
const SMOOTH_ROUNDS = 2;
/** 手绘抖动:幅度(世界单位)、波长(世界单位) */
const JITTER_AMP = 0.55;
const JITTER_WAVE = 5;

// ---------------------------------------------------------------------------
// 1. 州界的链

export interface RegionChains {
  count: number;
  /** 链的左 / 右两侧是哪个州(沿点的顺序看) */
  left: Int32Array;
  right: Int32Array;
  /** 起点 / 终点的节点编号(三州交汇处或海岸断头);首尾相连的环为 −1 */
  n0: Int32Array;
  n1: Int32Array;
  /** 点(世界坐标 x,y):第 c 条链是 pts[start[c]*2 .. start[c+1]*2) */
  start: Int32Array;
  pts: Float32Array;
  /** 节点在整张州界图里的度数:1 = 海岸 / 湖岸断头,3 = 三州交汇 */
  nodeDeg: Uint8Array;
  /** 节点 → 以它为端点的链(CSR) */
  incStart: Int32Array;
  inc: Int32Array;
  /** 世界东西相连的周期(世界宽度):链的 x 已展开成连续的 */
  wrap: number;
}

/** label[地块] → 分组(< 0 = 不参与,比如水)。描出所有分组之间的链(未平滑) */
export function traceChains(mesh: Mesh, label: ArrayLike<number>): RegionChains {
  const { n, x, y, triangles } = mesh;
  const nodeOf = new Map<number, number>();
  const nx: number[] = [];
  const ny: number[] = [];
  const node = (key: number, px: number, py: number) => {
    let id = nodeOf.get(key);
    if (id === undefined) {
      id = nx.length;
      nodeOf.set(key, id);
      nx.push(px);
      ny.push(py);
    }
    return id;
  };
  const W = meshWrap(mesh);
  const tmp = [0, 0];
  const mid = (a: number, b: number) => {
    sphereMean(mesh, a, b, -1, tmp);
    return node(a < b ? a * n + b : b * n + a, tmp[0], tmp[1]);
  };
  // 线段 p → q 左侧是 o 吗(屏幕坐标 y 朝下,"左"只是一个一致的约定;东西相连时横向差取短的那边)
  const leftOf = (p: number, q: number, ox: number, oy: number) =>
    (nearX(nx[q], nx[p], W) - nx[p]) * (oy - ny[p]) - (ny[q] - ny[p]) * (nearX(ox, nx[p], W) - nx[p]) > 0;
  const la: number[] = [];
  const lb: number[] = [];
  const lL: number[] = [];
  const lR: number[] = [];
  const link = (a: number, b: number, L: number, R: number) => {
    la.push(a);
    lb.push(b);
    lL.push(L);
    lR.push(R);
  };
  const v = [0, 0, 0];
  const l = [0, 0, 0];
  const diff: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    v[0] = triangles[t];
    v[1] = triangles[t + 1];
    v[2] = triangles[t + 2];
    l[0] = label[v[0]];
    l[1] = label[v[1]];
    l[2] = label[v[2]];
    diff.length = 0;
    for (let e = 0; e < 3; e++) {
      const a = l[e];
      const b = l[(e + 1) % 3];
      if (a >= 0 && b >= 0 && a !== b) diff.push(e);
    }
    if (!diff.length) continue;
    if (diff.length === 2) {
      // 两组:连两条异色边的中点;"落单"的顶点是两条异色边的公共顶点
      const e1 = diff[0];
      const e2 = diff[1];
      const odd = (e1 + 1) % 3 === e2 ? e2 : e1;
      const other = (odd + 1) % 3;
      const m1 = mid(v[e1], v[(e1 + 1) % 3]);
      const m2 = mid(v[e2], v[(e2 + 1) % 3]);
      const o = v[odd];
      if (leftOf(m1, m2, x[o], y[o])) link(m1, m2, l[odd], l[other]);
      else link(m1, m2, l[other], l[odd]);
      continue;
    }
    // 三组交汇,或一个顶点是水(断头):各条异色边的中点连到重心
    sphereMean(mesh, v[0], v[1], v[2], tmp);
    const c = node(n * n + t / 3, tmp[0], tmp[1]);
    for (const e of diff) {
      const u = v[e];
      const w = v[(e + 1) % 3];
      const m = mid(u, w);
      if (leftOf(m, c, x[u], y[u])) link(m, c, l[e], l[(e + 1) % 3]);
      else link(m, c, l[(e + 1) % 3], l[e]);
    }
  }

  // 节点 → 线段(CSR)
  const N = nx.length;
  const M = la.length;
  const deg = new Uint8Array(N);
  for (let i = 0; i < M; i++) {
    deg[la[i]]++;
    deg[lb[i]]++;
  }
  const aStart = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) aStart[i + 1] = aStart[i] + deg[i];
  const fill = aStart.slice(0, N);
  const aLink = new Int32Array(aStart[N]);
  for (let i = 0; i < M; i++) {
    aLink[fill[la[i]]++] = i;
    aLink[fill[lb[i]]++] = i;
  }

  // 串链:从度数 ≠ 2 的节点出发;剩下的是环
  const used = new Uint8Array(M);
  const cL: number[] = [];
  const cR: number[] = [];
  const c0: number[] = [];
  const c1: number[] = [];
  const cStart: number[] = [0];
  const P: number[] = [];
  const walk = (start: number, first: number) => {
    let cur = start;
    let li = first;
    const p0 = P.length;
    const fwd = la[li] === cur;
    cL.push(fwd ? lL[li] : lR[li]);
    cR.push(fwd ? lR[li] : lL[li]);
    P.push(nx[cur], ny[cur]);
    for (;;) {
      used[li] = 1;
      const next = la[li] === cur ? lb[li] : la[li];
      P.push(nx[next], ny[next]);
      cur = next;
      if (deg[cur] !== 2 || cur === start) break;
      let nl = -1;
      for (let k = aStart[cur]; k < aStart[cur + 1]; k++) if (!used[aLink[k]]) nl = aLink[k];
      if (nl < 0) break;
      li = nl;
    }
    const closed = cur === start && deg[start] === 2;
    c0.push(closed ? -1 : start);
    c1.push(closed ? -1 : cur);
    // 东西相连:这条链的 x 展开成连续的
    if (W) for (let i = p0 + 2; i < P.length; i += 2) P[i] = nearX(P[i], P[i - 2], W);
    cStart.push(P.length / 2);
  };
  for (let a = 0; a < N; a++) {
    if (deg[a] === 2) continue;
    for (let k = aStart[a]; k < aStart[a + 1]; k++) if (!used[aLink[k]]) walk(a, aLink[k]);
  }
  for (let i = 0; i < M; i++) if (!used[i]) walk(la[i], i);

  const count = cL.length;
  const incDeg = new Int32Array(N);
  for (let c = 0; c < count; c++) {
    if (c0[c] >= 0) incDeg[c0[c]]++;
    if (c1[c] >= 0 && c1[c] !== c0[c]) incDeg[c1[c]]++;
  }
  const incStart = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) incStart[i + 1] = incStart[i] + incDeg[i];
  const f2 = incStart.slice(0, N);
  const inc = new Int32Array(incStart[N]);
  for (let c = 0; c < count; c++) {
    if (c0[c] >= 0) inc[f2[c0[c]]++] = c;
    if (c1[c] >= 0 && c1[c] !== c0[c]) inc[f2[c1[c]]++] = c;
  }
  return {
    count,
    left: Int32Array.from(cL),
    right: Int32Array.from(cR),
    n0: Int32Array.from(c0),
    n1: Int32Array.from(c1),
    start: Int32Array.from(cStart),
    pts: Float32Array.from(P),
    nodeDeg: deg,
    incStart,
    inc,
    wrap: W,
  };
}

const chainCache = new WeakMap<Civ, RegionChains>();

/** 州界的链(按 civ 缓存) */
export function regionChains(mesh: Mesh, civ: Civ): RegionChains {
  let c = chainCache.get(civ);
  if (!c) chainCache.set(civ, (c = traceChains(mesh, civ.regions.of)));
  return c;
}

// ---------------------------------------------------------------------------
// 2. 某一年的界线

/** 一条界线(世界坐标,已平滑):左右两侧的归属(−1 = 无);end0 / end1 = 这一端是海岸 / 湖岸断头 */
export interface SidedLine {
  pts: Float32Array;
  closed: boolean;
  left: number;
  right: number;
  end0: boolean;
  end1: boolean;
}

/**
 * 按州的归属(owner[州],−1 = 无)挑出界线,在只有两条相接的交汇处接起来(未平滑)。
 * 返回的每条线左右两侧的归属都是一致的。
 */
export function mergeChains(rc: RegionChains, owner: ArrayLike<number>): SidedLine[] {
  const { count, left, right, n0, n1, start, pts, nodeDeg, incStart, inc, wrap } = rc;
  const sel = new Uint8Array(count);
  const selDeg = new Uint8Array(nodeDeg.length);
  for (let c = 0; c < count; c++) {
    if (owner[left[c]] === owner[right[c]]) continue;
    sel[c] = 1;
    if (n0[c] >= 0) {
      selDeg[n0[c]]++;
      selDeg[n1[c]]++;
    }
  }
  const used = new Uint8Array(count);
  const out: SidedLine[] = [];
  const buf: number[] = [];
  const append = (c: number, fwd: boolean) => {
    const s = start[c];
    const e = start[c + 1];
    const skip = buf.length ? 1 : 0;
    // 东西相连:接上来的这条链可能展开在另一份上(差整圈),挪到和前一条接得上的那一份
    let sh = 0;
    if (buf.length) {
      const fx = fwd ? pts[s * 2] : pts[(e - 1) * 2];
      sh = nearX(fx, buf[buf.length - 2], wrap) - fx;
    }
    if (fwd) for (let i = s + skip; i < e; i++) buf.push(pts[i * 2] + sh, pts[i * 2 + 1]);
    else for (let i = e - 1 - skip; i >= s; i--) buf.push(pts[i * 2] + sh, pts[i * 2 + 1]);
  };
  const walk = (from: number, c0: number) => {
    buf.length = 0;
    let c = c0;
    let at = from;
    const fwd0 = n0[c] === at;
    const L = fwd0 ? owner[left[c]] : owner[right[c]];
    const R = fwd0 ? owner[right[c]] : owner[left[c]];
    for (;;) {
      used[c] = 1;
      const fwd = n0[c] === at;
      append(c, fwd);
      at = fwd ? n1[c] : n0[c];
      if (selDeg[at] !== 2 || at === from) break;
      let nc = -1;
      for (let k = incStart[at]; k < incStart[at + 1]; k++) {
        const q = inc[k];
        if (sel[q] && !used[q]) nc = q;
      }
      if (nc < 0) break;
      c = nc;
    }
    const closed = at === from && selDeg[from] === 2;
    out.push({
      pts: Float32Array.from(buf),
      closed,
      left: L,
      right: R,
      end0: !closed && nodeDeg[from] === 1,
      end1: !closed && nodeDeg[at] === 1,
    });
  };
  for (let c = 0; c < count; c++) {
    if (!sel[c] || used[c] || n0[c] >= 0) continue;
    // 本身就是环的链(一个州整个被另一个州围住)
    used[c] = 1;
    buf.length = 0;
    append(c, true);
    out.push({ pts: Float32Array.from(buf), closed: true, left: owner[left[c]], right: owner[right[c]], end0: false, end1: false });
  }
  for (let c = 0; c < count; c++) {
    if (!sel[c] || used[c]) continue;
    for (const end of [n0[c], n1[c]]) {
      if (used[c] || selDeg[end] === 2) continue;
      walk(end, c);
    }
  }
  // 剩下的:经过的交汇处都只有两条被挑中的链,连成了环
  for (let c = 0; c < count; c++) if (sel[c] && !used[c]) walk(n0[c], c);
  return out;
}

/** Chaikin 平滑;手绘风再按位置沿法线抖一抖(端点不动,两头渐弱) */
function finish(l: SidedLine, fantasy: boolean): SidedLine {
  const s = chaikin(l, SMOOTH_ROUNDS);
  const p = s.pts;
  if (fantasy) {
    const m = p.length / 2;
    const q = p.slice();
    for (let i = 1; i < m - 1; i++) {
      const w = l.closed ? 1 : Math.min(1, i / 10, (m - 1 - i) / 10);
      const tx = p[(i + 1) * 2] - p[(i - 1) * 2];
      const ty = p[(i + 1) * 2 + 1] - p[(i - 1) * 2 + 1];
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      const x = p[i * 2];
      const y = p[i * 2 + 1];
      const d = JITTER_AMP * w * (2 * valueNoise(x / JITTER_WAVE, y / JITTER_WAVE, 71) - 1);
      q[i * 2] = x - (ty / len) * d;
      q[i * 2 + 1] = y + (tx / len) * d;
    }
    if (l.closed && m > 1) {
      // 环首尾对上(绕极点一圈的环,首尾差一整圈)
      const wx = p[(m - 1) * 2] - p[0];
      q[(m - 1) * 2] = wx ? q[0] + wx : q[0];
      q[(m - 1) * 2 + 1] = q[1];
    }
    return { ...l, pts: q };
  }
  return { ...l, pts: p };
}

interface LinesCache {
  key: number;
  lines: SidedLine[];
}
interface CivLines {
  /** 每一层:日志前 i 条里有几条属于这一层 */
  prefix: [Int32Array, Int32Array];
  owners: Owners;
  byKey: Map<string, LinesCache>;
}
const lineCaches = new WeakMap<Civ, CivLines>();

function civLines(civ: Civ): CivLines {
  let c = lineCaches.get(civ);
  if (!c) {
    const L = civ.log;
    const pc = new Int32Array(L.size + 1);
    const pp = new Int32Array(L.size + 1);
    for (let i = 0; i < L.size; i++) {
      pc[i + 1] = pc[i] + (L.layer[i] === Layer.Culture ? 1 : 0);
      pp[i + 1] = pp[i] + (L.layer[i] === Layer.Polity ? 1 : 0);
    }
    const R = civ.regions.count;
    c = { prefix: [pc, pp], owners: { culture: new Int16Array(R), polity: new Int16Array(R) }, byKey: new Map() };
    lineCaches.set(civ, c);
  }
  return c;
}

/**
 * 某一年某一层(民族 / 国家)的界线,已平滑(手绘风已抖动)。
 * 按"这一层到这一年生效了几条日志"缓存:回放时这一层没变就不重算。
 */
export function borderLines(p: CivDrawParams, layer: Layer): SidedLine[] {
  const { civ, world } = p;
  const c = civLines(civ);
  const key = c.prefix[layer][logIndexAfter(civ.log, p.year)];
  const fantasy = p.style === 'fantasy';
  const ck = `${layer}|${fantasy ? 1 : 0}`;
  const hit = c.byKey.get(ck);
  if (hit && hit.key === key) return hit.lines;
  const own = ownersAt(civ, p.year, c.owners);
  const owner = layer === Layer.Culture ? own.culture : own.polity;
  const lines = mergeChains(regionChains(world.mesh, civ), owner).map((l) => finish(l, fantasy));
  c.byKey.set(ck, { key, lines });
  return lines;
}

// ---------------------------------------------------------------------------
// 3. 色块按界线重新判归属

interface BandScratch {
  best: Float32Array;
  lab: Int16Array;
  stamp: Int32Array;
  s: number;
}
const bandScratch = new Map<number, BandScratch>();

/** 按原样保留(线的断头外面) */
const KEEP = -32768;
const NO_RANGE: [number, number] = [0, 0];

/**
 * label:工作分辨率 W × H 的归属图(−2 水、−1 无、≥ 0 归属),就地改写。
 * 离界线 BAND 以内的陆地像素,按离它最近的那段线判在哪一侧,取那一侧的归属;
 * 落在海岸断头外面(过了端点再往前)的,保持原样(那里的像素本来就按地块归属,线在那儿断了)。
 * 最近点落在折线顶点上时,按两侧线段法线之和判左右(尖角外侧也不会判反)。
 * 像素的采样点和 washPixels 一样:工作像素 (x, y) 对应全分辨率像素 (x·f + ⌊f/2⌋, …) 的中心。
 */
export function bandLabels(label: Int16Array, W: number, H: number, f: number, scale: number, lines: SidedLine[], wrap = 0): void {
  const N = W * H;
  let sc = bandScratch.get(N);
  if (!sc) bandScratch.set(N, (sc = { best: new Float32Array(N), lab: new Int16Array(N), stamp: new Int32Array(N), s: 0 }));
  const st = ++sc.s;
  const { best, lab, stamp } = sc;
  const off = (f >> 1) + 0.5;
  const band = BAND * scale;
  const band2 = band * band;
  const touched: number[] = [];
  for (const l of lines) {
    const p = l.pts;
    const m = p.length / 2;
    // 各段的单位法线(左手边):(−dy, dx) / 长度。最近点落在折线的顶点上时,用两侧法线之和判左右
    // (只看一段的延长线,在尖角外侧会判反)
    const nx = new Float64Array(m - 1);
    const ny = new Float64Array(m - 1);
    for (let i = 0; i + 1 < m; i++) {
      const dx = p[i * 2 + 2] - p[i * 2];
      const dy = p[i * 2 + 3] - p[i * 2 + 1];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      nx[i] = -dy / len;
      ny[i] = dx / len;
    }
    const segs = m - 1;
    // 东西相连:伸出主图左右边的线在另一边再判一份(平移 sh 个世界单位;不相连时只有 0)
    const [lo, hi] = wrap ? xRange(p) : NO_RANGE;
    for (const sh of wrapShifts(lo, hi, wrap, BAND)) {
      const ox = sh * scale;
      // 海岸断头:断头外面(过了端点、沿线的方向再往前)BAND 以内的像素保持原样。方向取最后几个点,抖动不影响
      const back = Math.min(segs, 4);
      const e0x = p[0] * scale + ox;
      const e0y = p[1] * scale;
      const d0x = p[0] - p[back * 2];
      const d0y = p[1] - p[back * 2 + 1];
      const e1x = p[segs * 2] * scale + ox;
      const e1y = p[segs * 2 + 1] * scale;
      const d1x = p[segs * 2] - p[(segs - back) * 2];
      const d1y = p[segs * 2 + 1] - p[(segs - back) * 2 + 1];
      const beyond = (px: number, py: number) =>
        (l.end0 && (px - e0x) * d0x + (py - e0y) * d0y > 0 && (px - e0x) ** 2 + (py - e0y) ** 2 <= band2) ||
        (l.end1 && (px - e1x) * d1x + (py - e1y) * d1y > 0 && (px - e1x) ** 2 + (py - e1y) ** 2 <= band2);
      for (let i = 0; i < segs; i++) {
        const ax = p[i * 2] * scale + ox;
        const ay = p[i * 2 + 1] * scale;
        const bx = p[i * 2 + 2] * scale + ox;
        const by = p[i * 2 + 3] * scale;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const inv = len2 > 0 ? 1 / len2 : 0;
        // 顶点处的"两侧法线之和":起点和上一段、终点和下一段(环首尾相接;开放折线的两头就用本段)
        const prev = i > 0 ? i - 1 : l.closed ? segs - 1 : i;
        const next = i + 1 < segs ? i + 1 : l.closed ? 0 : i;
        const n0x = nx[prev] + nx[i];
        const n0y = ny[prev] + ny[i];
        const n1x = nx[i] + nx[next];
        const n1y = ny[i] + ny[next];
        // 工作像素范围:采样点 = x·f + off
        const x0 = Math.max(0, Math.ceil((Math.min(ax, bx) - band - off) / f));
        const x1 = Math.min(W - 1, Math.floor((Math.max(ax, bx) + band - off) / f));
        const y0 = Math.max(0, Math.ceil((Math.min(ay, by) - band - off) / f));
        const y1 = Math.min(H - 1, Math.floor((Math.max(ay, by) + band - off) / f));
        for (let y = y0; y <= y1; y++) {
          const py = y * f + off;
          const row = y * W;
          for (let x = x0; x <= x1; x++) {
            const k = row + x;
            if (label[k] === -2) continue;
            const px = x * f + off;
            const t = ((px - ax) * dx + (py - ay) * dy) * inv;
            let qx: number;
            let qy: number;
            let side: number;
            if (t <= 0) {
              qx = ax - px;
              qy = ay - py;
              side = (px - ax) * n0x + (py - ay) * n0y;
            } else if (t >= 1) {
              qx = bx - px;
              qy = by - py;
              side = (px - bx) * n1x + (py - by) * n1y;
            } else {
              qx = ax + dx * t - px;
              qy = ay + dy * t - py;
              side = dx * (py - ay) - dy * (px - ax);
            }
            const d2 = qx * qx + qy * qy;
            if (d2 > band2) continue;
            if (stamp[k] === st && d2 >= best[k]) continue;
            if (stamp[k] !== st) {
              stamp[k] = st;
              touched.push(k);
            }
            best[k] = d2;
            lab[k] = (l.end0 || l.end1) && beyond(px, py) ? KEEP : side > 0 ? l.left : l.right;
          }
        }
      }
    }
  }
  for (const k of touched) if (lab[k] !== KEEP) label[k] = lab[k];
}

// ---------------------------------------------------------------------------
// 画国界

/**
 * 手绘风国界每一笔的粗细档(0 = 最细):按这一笔起点的位置取,和 inkDashes 同一个公式 ——
 * 地球仪上的矢量国界(render/globeLines.ts)也按它分档,粗细的起伏和主图一致
 */
export function inkPen(x: number, y: number, pens: number): number {
  const w = valueNoise(x / 7, y / 7, 23);
  return Math.min(pens - 1, Math.floor(w * w * pens * 1.6));
}

/**
 * 手绘风的一笔一笔:沿折线切成虚线,每一笔按位置取粗细,分三档各进一条 Path2D。
 * proj(弯边投影):先逐点投影,在画布上按画布长度切(每一笔的长短、空当处处一样)
 */
function inkDashes(lines: SidedLine[], S: number, dash: number, gap: number, paths: Path2D[], wrap = 0, proj?: Projector | null) {
  const nb = paths.length;
  if (proj) {
    const v = { s: S, ox: 0, oy: 0 };
    for (const l of lines) for (const q of projectLinePts(l.pts, 2, proj, v)) dashCanvas(q);
    return;
  }
  /** 画布上的折线(已投影)切成虚线:长度按画布像素(dash、gap × S),粗细按地图平面位置取 */
  function dashCanvas(p: Float64Array) {
    const m = p.length / 2;
    const D = dash * S;
    const G = gap * S;
    let phase = 0;
    let pen: Path2D | null = null;
    for (let i = 0; i + 1 < m; i++) {
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const bx = p[i * 2 + 2];
      const by = p[i * 2 + 3];
      const seg = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      let t = 0;
      while (t < seg) {
        const inDash = phase < D;
        const room = (inDash ? D : D + G) - phase;
        const step = Math.min(room, seg - t);
        const x0 = ax + ((bx - ax) * t) / seg;
        const y0 = ay + ((by - ay) * t) / seg;
        const x1 = ax + ((bx - ax) * (t + step)) / seg;
        const y1 = ay + ((by - ay) * (t + step)) / seg;
        if (inDash) {
          if (!pen) {
            const w = valueNoise(x0 / S / 7, y0 / S / 7, 23);
            pen = paths[Math.min(nb - 1, Math.floor(w * w * nb * 1.6))];
            pen.moveTo(x0, y0);
          }
          pen.lineTo(x1, y1);
        }
        t += step;
        phase += step;
        if (phase >= D && pen) pen = null;
        if (phase >= D + G) phase -= D + G;
      }
    }
  }
  for (const l of lines) {
    const [lo, hi] = wrap ? xRange(l.pts) : NO_RANGE;
    // 东西相连:伸出主图左右边的线在另一边再画一份(每一笔的粗细按展开后的位置取,两份一样)
    for (const sh of wrapShifts(lo, hi, wrap, 4)) dashLine(l, sh);
  }
  function dashLine(l: SidedLine, sh: number) {
    const p = l.pts;
    const m = p.length / 2;
    let phase = 0; // 在"一笔 + 一空"周期里的位置(世界单位)
    let pen: Path2D | null = null;
    for (let i = 0; i + 1 < m; i++) {
      const ax = p[i * 2];
      const ay = p[i * 2 + 1];
      const bx = p[i * 2 + 2];
      const by = p[i * 2 + 3];
      const seg = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      let t = 0;
      while (t < seg) {
        const inDash = phase < dash;
        const room = (inDash ? dash : dash + gap) - phase;
        const step = Math.min(room, seg - t);
        const x0 = ax + ((bx - ax) * t) / seg;
        const y0 = ay + ((by - ay) * t) / seg;
        const x1 = ax + ((bx - ax) * (t + step)) / seg;
        const y1 = ay + ((by - ay) * (t + step)) / seg;
        if (inDash) {
          if (!pen) {
            const w = valueNoise(x0 / 7, y0 / 7, 23);
            pen = paths[Math.min(nb - 1, Math.floor(w * w * nb * 1.6))];
            pen.moveTo((x0 + sh) * S, y0 * S);
          }
          pen.lineTo((x1 + sh) * S, y1 * S);
        }
        t += step;
        phase += step;
        if (phase >= dash && pen) pen = null;
        if (phase >= dash + gap) phase -= dash + gap;
      }
    }
  }
}

export function drawBorders(ctx: CanvasRenderingContext2D, p: CivDrawParams): void {
  if (!p.show.polities || !p.civ.polities.length) return;
  const all0 = borderLines(p, Layer.Polity);
  const lines = p.cull ? cullLines(all0, p.cull, meshWrap(p.world.mesh), 8) : all0;
  if (!lines.length) return;
  const S = p.raster.scale;
  // 线宽、虚线长短(细节层按屏幕重画时 × pen,见 overlay.ts)
  const P = S * (p.pen ?? 1);
  const wrap = meshWrap(p.world.mesh);
  // 两国之间 / 国家和部落地带之间
  const inner = lines.filter((l) => l.left >= 0 && l.right >= 0);
  const outer = lines.filter((l) => l.left < 0 || l.right < 0);
  const path = (ls: SidedLine[]) => {
    const pa = new Path2D();
    addToPath(pa, ls, S, wrap, p.proj);
    return pa;
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.style === 'fantasy') {
    const pens = [new Path2D(), new Path2D(), new Path2D()];
    // 墨线下面先垫一道淡淡的纸色,穿过深色树林时也看得清
    ctx.strokeStyle = 'rgba(246,236,210,0.6)';
    ctx.lineWidth = 3.8 * P;
    ctx.stroke(path(inner));
    const pen = p.pen ?? 1;
    inkDashes(inner, S, 5 * pen, 3 * pen, pens, wrap, p.proj);
    const widths = [1.45, 2.05, 2.75];
    ctx.strokeStyle = 'rgba(58,32,20,0.9)';
    pens.forEach((pa, i) => {
      ctx.lineWidth = widths[i] * P;
      ctx.stroke(pa);
    });
    // 国家和部落地带之间:点划线(旧地图上的"界"),和道路的虚线区分开
    ctx.strokeStyle = 'rgba(246,236,210,0.45)';
    ctx.lineWidth = 3 * P;
    ctx.stroke(path(outer));
    ctx.strokeStyle = 'rgba(58,32,20,0.78)';
    ctx.lineWidth = 1.35 * P;
    ctx.setLineDash([4.2 * P, 1.9 * P, 0.01, 1.9 * P]);
    ctx.stroke(path(outer));
  } else {
    const all = path(lines);
    ctx.strokeStyle = 'rgba(255,252,244,0.6)';
    ctx.lineWidth = 4 * P;
    ctx.stroke(all);
    ctx.strokeStyle = 'rgba(62,28,40,0.95)';
    ctx.lineWidth = 1.7 * P;
    ctx.stroke(path(inner));
    ctx.setLineDash([3.6 * P, 2.4 * P]);
    ctx.strokeStyle = 'rgba(62,28,40,0.85)';
    ctx.lineWidth = 1.4 * P;
    ctx.stroke(path(outer));
  }
  ctx.restore();
}
