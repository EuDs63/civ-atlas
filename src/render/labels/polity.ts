/**
 * 国名排版:在国土里找一条放国名的路径,定字号,决定横排还是竖排、写全称还是简称。
 * 纯计算(不碰画布),世界坐标;排出来的路径由 polityCandidates 在画布上逐字摆放(先正中,摆不下再前后左右挪)。
 *
 * 借 Azgaar 的"最难到达点 + 放射线拟合",按汉字改:
 *
 *   1. 国土栅格:地图按 G 世界单位一格铺成网格,记下每格属于哪个州(每个文明只算一次);
 *      某一年每格属于哪国 = 那个州这一年的归属。
 *   2. 离界距离:每格离"不是本国的格子"(别国、无主地、海、湖、图外)有多远 —— 倒角距离,所有国家一遍算完。
 *   3. 锚点 = 本国离界最远的格子("最难到达点",国土最宽处的中心)。
 *   4. 放射线:从锚点每隔 5° 发一条射线往外走,记下沿途离界距离的最小值。
 *      字号 s 的一行字要放得下,整条路径离界都要 ≥ 半个字高再加一点留白 —— 射线在这个字号下能走多远,
 *      就是这行字能排多长(一次走完,任何字号都能查)。
 *   5. 两条射线拼成一条路径(最多弯 35°,拐角处抹圆),国名沿它"略带弧度"地排:
 *      横排 —— 整体走向和水平线的夹角 ≤ 25°,越平越好;竖排 —— 几乎竖直、笔直。
 *      字号从大往小试,第一个"路径长 ≥ 这行字按疏排字距要的长度"的字号就是它的字号(上限按国土大小,帝国大、小国小)。
 *      竖排的字号要比横排大出 25% 以上才竖排(狭长的国家)。汉字等宽,字号和长度的关系是精确的。
 *   6. 全称 / 简称(growth.ts 的 polityShortTitle):全称的字号不小于简称的 80%、而且认得清,就写全称。
 *
 * 字号用世界单位给(LabelItem.sizeWorld):地图按 REF_MAP_CSS 宽显示、缩放 1 倍时正好铺满国土;
 * 放大地图时字只按 k^grow 变大(比国土长得慢),所以放大后照样在国土里。
 */
import type { World } from '../../gen/world';
import type { Raster } from '../../gen/raster';
import type { ChangeLog, Civ, Year } from '../../gen/civ/types';
import { logIndexAfter, ownersAt, type Owners } from '../../gen/civ/timeline';
import { capitalAt, dynastyIndexAt, polityAlive, polityName, polityShortTitle, polityTierAt } from '../../gen/civ/growth';
import { Polyline, type Candidate, type Glyph } from './layout';
import { pathToCanvas, type LabelView } from './draw';
import { projectWorld, unprojectWorld, type MapProj } from '../projection';

/** 网格边长(世界单位) */
export const GRID = 4;
/** 放射线:每隔多少度一条 */
const RAY_STEP_DEG = 5;
const RAYS = 360 / RAY_STEP_DEG;
/** 射线每步走多少格 */
const MARCH = 0.5;
/** 最多拐多少度(两条射线拼成路径时) */
const MAX_BEND = 35;
/** 横排:整体走向和水平线最多夹多少度 */
const MAX_TILT = 25;
/** 竖排:整体走向和水平线至少夹多少度;最多拐多少度 */
const MIN_VERTICAL = 72;
const MAX_BEND_VERTICAL = 12;
/** 竖排的字号要比横排大这么多倍才竖排 */
const VERTICAL_GAIN = 1.25;
/** 路径离界至少 = 字号 × HALF + MARGIN(世界单位) */
const HALF = 0.55;
const MARGIN = 2;
/** 拟合时按这个字距(字宽的倍数)算一行字要多长:疏排 */
export const FIT_TRACKING = 0.8;
/** 字号上限(CSS 像素,参照宽度、缩放 1 倍):按州数 */
export function maxNameCss(regions: number): number {
  return Math.max(12, Math.min(26, 9 + 1.75 * Math.sqrt(regions)));
}
/** 字号下限(CSS 像素):再小也照样拟合(放大地图后才放得下) */
const MIN_FIT_CSS = 5;
/** 认得清的字号(CSS 像素):全称小于它、简称不小于它时写简称 */
const READABLE_CSS = 11;
/** 全称字号不小于简称的这么多倍就写全称 */
const FULL_RATIO = 0.8;

export interface TerritoryGrid {
  G: number;
  gw: number;
  gh: number;
  /** 格子 → 州(水 = −1) */
  region: Int16Array;
  /** 东西相连:最左一列和最右一列相邻,离界距离、放射线、查归属都跨过左右边(网格宽 × G = 世界宽;不给 = 不相连的一块小网格,单测用) */
  wrap?: boolean;
}

/** 只看州(地理)和像素图:按 civ.regions 存 —— 改了名的 civ(阶段 4,州是同一份)不用重算 */
const grids = new WeakMap<Civ['regions'], { raster: Raster; grid: TerritoryGrid }>();

/** 国土栅格:每格中心那个像素属于哪个州(每个文明、每张像素图只算一次) */
export function territoryGrid(world: World, raster: Raster, civ: Civ): TerritoryGrid {
  const hit = grids.get(civ.regions);
  if (hit && hit.raster === raster) return hit.grid;
  const G = GRID;
  const gw = Math.ceil(world.width / G);
  const gh = Math.ceil(world.height / G);
  const region = new Int16Array(gw * gh).fill(-1);
  const { w, h, scale, cell, water } = raster;
  const of = civ.regions.of;
  const { adjStart, adj } = world.mesh;
  for (let gy = 0; gy < gh; gy++) {
    const py = Math.min(h - 1, Math.floor((gy + 0.5) * G * scale));
    for (let gx = 0; gx < gw; gx++) {
      const px = Math.min(w - 1, Math.floor((gx + 0.5) * G * scale));
      const k = py * w + px;
      if (water[k] !== 0) continue;
      const c = cell[k];
      let r = of[c];
      // 陆地像素最近的地块是水(海岸细节):借一个相邻陆地块的州(和 territory.ts 的 pixelRegions 一样)
      if (r < 0) for (let q = adjStart[c]; q < adjStart[c + 1] && r < 0; q++) r = of[adj[q]];
      region[gy * gw + gx] = r;
    }
  }
  const grid: TerritoryGrid = { G, gw, gh, region };
  if (gw * G === world.width) grid.wrap = true;
  grids.set(civ.regions, { raster, grid });
  return grid;
}

/** 某一年的国土栅格:每格属于哪国(−1 = 无主 / 水)+ 离界距离(世界单位,已减去格子本身的误差) */
export interface TerritoryField {
  grid: TerritoryGrid;
  owner: Int16Array;
  dist: Float32Array;
}

export function territoryField(grid: TerritoryGrid, polityOf: Int16Array): TerritoryField {
  const { gw, gh, region, G } = grid;
  const N = gw * gh;
  const owner = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const r = region[i];
    owner[i] = r >= 0 ? polityOf[r] : -1;
  }
  if (grid.wrap) return { grid, owner, dist: wrapDistance(owner, gw, gh, G) };
  // 倒角距离(格子单位):边界格 = 到格子边的距离,往里按 1 / √2 累加,只在同一国的格子之间传
  const d = new Float32Array(N);
  const INF = 1e9;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const o = owner[i];
      if (o < 0) {
        d[i] = 0;
        continue;
      }
      let v = INF;
      if (x === 0 || x === gw - 1 || y === 0 || y === gh - 1) v = 0.5;
      else if (owner[i - 1] !== o || owner[i + 1] !== o || owner[i - gw] !== o || owner[i + gw] !== o) v = 0.5;
      else if (owner[i - gw - 1] !== o || owner[i - gw + 1] !== o || owner[i + gw - 1] !== o || owner[i + gw + 1] !== o) v = 0.71;
      d[i] = v;
    }
  }
  const S2 = Math.SQRT2;
  for (let y = 1; y < gh; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x;
      const o = owner[i];
      if (o < 0 || d[i] <= 0.5) continue;
      let v = d[i];
      if (owner[i - 1] === o && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (owner[i - gw] === o && d[i - gw] + 1 < v) v = d[i - gw] + 1;
      if (owner[i - gw - 1] === o && d[i - gw - 1] + S2 < v) v = d[i - gw - 1] + S2;
      if (owner[i - gw + 1] === o && d[i - gw + 1] + S2 < v) v = d[i - gw + 1] + S2;
      d[i] = v;
    }
  }
  for (let y = gh - 2; y >= 0; y--) {
    for (let x = gw - 2; x >= 1; x--) {
      const i = y * gw + x;
      const o = owner[i];
      if (o < 0 || d[i] <= 0.5) continue;
      let v = d[i];
      if (owner[i + 1] === o && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (owner[i + gw] === o && d[i + gw] + 1 < v) v = d[i + gw] + 1;
      if (owner[i + gw + 1] === o && d[i + gw + 1] + S2 < v) v = d[i + gw + 1] + S2;
      if (owner[i + gw - 1] === o && d[i + gw - 1] + S2 < v) v = d[i + gw - 1] + S2;
      d[i] = v;
    }
  }
  // 换成世界单位;格子里任意一点离格子中心最多 0.7 格,扣掉一点
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) dist[i] = owner[i] < 0 ? 0 : Math.max(0, (d[i] - 0.35) * G);
  return { grid, owner, dist };
}

/**
 * 同 territoryField 里的倒角距离,但左右两边相接(整个世界的网格):左右邻居的列下标取模,只有上下边算"图外"。
 * 一趟正扫 + 一趟反扫传不过接缝,所以来回扫两遍(跨接缝的国家两边的距离都对上)
 */
function wrapDistance(owner: Int16Array, gw: number, gh: number, G: number): Float32Array {
  const N = gw * gh;
  const d = new Float32Array(N);
  const INF = 1e9;
  const L = (i: number, x: number) => (x === 0 ? i + gw - 1 : i - 1);
  const R = (i: number, x: number) => (x === gw - 1 ? i - gw + 1 : i + 1);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const o = owner[i];
      if (o < 0) {
        d[i] = 0;
        continue;
      }
      let v = INF;
      if (y === 0 || y === gh - 1) v = 0.5;
      else {
        const l = L(i, x);
        const r = R(i, x);
        if (owner[l] !== o || owner[r] !== o || owner[i - gw] !== o || owner[i + gw] !== o) v = 0.5;
        else if (owner[l - gw] !== o || owner[r - gw] !== o || owner[l + gw] !== o || owner[r + gw] !== o) v = 0.71;
      }
      d[i] = v;
    }
  }
  const S2 = Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 1; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const o = owner[i];
        if (o < 0 || d[i] <= 0.5) continue;
        const l = L(i, x);
        const r = R(i, x);
        let v = d[i];
        if (owner[l] === o && d[l] + 1 < v) v = d[l] + 1;
        if (owner[i - gw] === o && d[i - gw] + 1 < v) v = d[i - gw] + 1;
        if (owner[l - gw] === o && d[l - gw] + S2 < v) v = d[l - gw] + S2;
        if (owner[r - gw] === o && d[r - gw] + S2 < v) v = d[r - gw] + S2;
        d[i] = v;
      }
    }
    for (let y = gh - 2; y >= 0; y--) {
      for (let x = gw - 1; x >= 0; x--) {
        const i = y * gw + x;
        const o = owner[i];
        if (o < 0 || d[i] <= 0.5) continue;
        const l = L(i, x);
        const r = R(i, x);
        let v = d[i];
        if (owner[r] === o && d[r] + 1 < v) v = d[r] + 1;
        if (owner[i + gw] === o && d[i + gw] + 1 < v) v = d[i + gw] + 1;
        if (owner[r + gw] === o && d[r + gw] + S2 < v) v = d[r + gw] + S2;
        if (owner[l + gw] === o && d[l + gw] + S2 < v) v = d[l + gw] + S2;
        d[i] = v;
      }
    }
  }
  const dist = new Float32Array(N);
  for (let i = 0; i < N; i++) dist[i] = owner[i] < 0 ? 0 : Math.max(0, (d[i] - 0.35) * G);
  return dist;
}

/** 某一年每格属于哪国(不算离界距离;回放时核对国名落没落在当年的国土上用,见 polityOwnerGrid) */
export type OwnerGrid = Pick<TerritoryField, 'grid' | 'owner'>;

/** 世界坐标 (wx, wy) 属于哪国(−1 = 无主 / 水 / 图外) */
export function ownerAtPoint(f: OwnerGrid, wx: number, wy: number): number {
  const { gw, gh, G } = f.grid;
  let gx = Math.floor(wx / G);
  const gy = Math.floor(wy / G);
  if (f.grid.wrap) gx = ((gx % gw) + gw) % gw;
  if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return -1;
  return f.owner[gy * gw + gx];
}

/** 一个国家的国名摆法 */
export interface PolityLabel {
  polity: number;
  /** 地图上写的(全称或简称) */
  text: string;
  /** 这一年的全称 */
  full: string;
  /** 路径(世界坐标 x,y,x,y…):直线,或拐角抹圆的两段(略带弧度);文字居中排在上面 */
  path: number[];
  /** 字号(世界单位):地图按参照宽度显示、缩放 1 倍时正好铺满国土的大小 */
  size: number;
  vertical: boolean;
  /** 最难到达点(世界坐标) */
  anchor: [number, number];
  /** 这一年的州数 */
  regions: number;
  /** 备选摆法:绕开国都(正中那条被国都挡住时用) */
  alt?: { path: number[]; size: number; vertical: boolean };
  /** 路径、锚点是地图平面坐标(弯边投影下按投影后的国土拟合的,见 PolityLabelOptions.proj) */
  planar?: boolean;
}

/** 一个国家的放射线:各方向在"离界 ≥ h"的条件下能走多远 */
interface Rays {
  px: number;
  py: number;
  /** 锚点离界距离 */
  depth: number;
  /** prof[ray × maxSteps + j] = 走到第 j 步为止离界距离的最小值;len[ray] = 记了几步 */
  prof: Float32Array;
  len: Int32Array;
  maxSteps: number;
  /** 每步多长(世界单位) */
  step: number;
}

const COS = new Float64Array(RAYS);
const SIN = new Float64Array(RAYS);
for (let i = 0; i < RAYS; i++) {
  const a = (i * RAY_STEP_DEG * Math.PI) / 180;
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
}

/** 要绕开的圆(世界坐标 x, y, 半径):国都符号 */
type Hole = [number, number, number];

/** 某格的离界距离;有要绕开的圆时再和"离圆边多远"取小 */
function depthAt(f: TerritoryField, i: number, hole?: Hole): number {
  const d = f.dist[i];
  if (!hole) return d;
  const { gw, G } = f.grid;
  const y = (Math.floor(i / gw) + 0.5) * G;
  let x = ((i % gw) + 0.5) * G;
  // 东西相连:按离国都最近的那一圈算
  if (f.grid.wrap) x = hole[0] + wrapDx(x - hole[0], gw * G);
  return Math.min(d, Math.max(0, Math.hypot(x - hole[0], y - hole[1]) - hole[2]));
}

/** 横向差挪到 (−P/2, P/2] 里(东西相连时两点之间走短边) */
function wrapDx(dx: number, P: number): number {
  return dx - P * Math.round(dx / P);
}

function castRays(f: TerritoryField, p: number, cell: number, maxLen: number, hole?: Hole): Rays {
  const { gw, gh, G } = f.grid;
  const wrap = !!f.grid.wrap;
  const cx = (cell % gw) + 0.5;
  const cy = Math.floor(cell / gw) + 0.5;
  // 东西相连:国都挪到离锚点最近的那一圈;射线走出左右边就接着从另一边走(路径的 x 是展开的,可以超出地图)
  if (hole && wrap) hole = [cx * G + wrapDx(hole[0] - cx * G, gw * G), hole[1], hole[2]];
  const maxSteps = Math.max(2, Math.ceil(maxLen / G / MARCH) + 1);
  const prof = new Float32Array(RAYS * maxSteps);
  const len = new Int32Array(RAYS);
  const depth = depthAt(f, cell, hole);
  for (let r = 0; r < RAYS; r++) {
    let m = depth;
    let j = 0;
    const base = r * maxSteps;
    prof[base] = m;
    for (j = 1; j < maxSteps; j++) {
      const x = cx + COS[r] * j * MARCH;
      const y = cy + SIN[r] * j * MARCH;
      let gx = Math.floor(x);
      const gy = Math.floor(y);
      if (wrap) gx = ((gx % gw) + gw) % gw;
      let v = 0;
      if (gx >= 0 && gy >= 0 && gx < gw && gy < gh) {
        const i = gy * gw + gx;
        if (f.owner[i] === p) {
          v = f.dist[i];
          if (hole) v = Math.min(v, Math.max(0, Math.hypot(x * G - hole[0], y * G - hole[1]) - hole[2]));
        }
      }
      if (v < m) m = v;
      prof[base + j] = m;
      if (m <= 0) break;
    }
    len[r] = Math.min(j + 1, maxSteps);
  }
  return { px: cx * G, py: cy * G, depth, prof, len, maxSteps, step: MARCH * G };
}

/** 射线 r 在离界 ≥ h 的条件下能走多远(世界单位) */
function reach(R: Rays, r: number, h: number): number {
  const base = r * R.maxSteps;
  let lo = 0;
  let hi = R.len[r] - 1;
  if (R.prof[base] < h) return -1;
  // prof 单调不增:找最后一个 ≥ h 的
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (R.prof[base + mid] >= h) lo = mid;
    else hi = mid - 1;
  }
  return lo * R.step;
}

interface Fit {
  size: number;
  i: number;
  j: number;
  li: number;
  lj: number;
  vertical: boolean;
}

/** 一行 n 个字、字号 s,疏排要多长 */
const needLen = (n: number, s: number) => s * ((1 + FIT_TRACKING) * (n - 1) + 1);

/** 各字号下各条射线能走多远(用到才算) */
class ReachTable {
  private tab: Float32Array;
  constructor(
    private R: Rays,
    private sizes: number[],
  ) {
    this.tab = new Float32Array(sizes.length * RAYS).fill(NaN);
  }
  get(si: number, r: number): number {
    const k = si * RAYS + r;
    let v = this.tab[k];
    if (v !== v) v = this.tab[k] = reach(this.R, r, this.sizes[si] * HALF + MARGIN);
    return v;
  }
}

/** 字号从大往小试,找放得下 n 个字的最大字号和路径(横排或竖排) */
function fitText(R: Rays, n: number, sizes: number[], T: ReachTable, vertical: boolean): Fit | null {
  for (let si = 0; si < sizes.length; si++) {
    const s = sizes[si];
    const h = s * HALF + MARGIN;
    if (R.depth < h) continue;
    const need = needLen(n, s);
    let best: Fit | null = null;
    let bestScore = -Infinity;
    const minD = RAYS / 2 - Math.floor((vertical ? MAX_BEND_VERTICAL : MAX_BEND) / RAY_STEP_DEG);
    for (let i = 0; i < RAYS; i++) {
      const li = T.get(si, i);
      if (li < 0) continue;
      for (let d = minD; d <= RAYS / 2; d++) {
        const j = (i + d) % RAYS;
        const lj = T.get(si, j);
        if (lj < 0 || li + lj < need) continue;
        // 整体走向(两个端点的连线)和水平线的夹角
        const ax = COS[i] * li;
        const ay = SIN[i] * li;
        const bx = COS[j] * lj;
        const by = SIN[j] * lj;
        const tilt = (Math.atan2(Math.abs(by - ay), Math.abs(bx - ax)) * 180) / Math.PI;
        // 路径在锚点处拐了多少度
        const turn = Math.abs(180 - d * RAY_STEP_DEG);
        let w: number;
        if (vertical) {
          if (tilt < MIN_VERTICAL) continue;
          w = 1 - 0.3 * ((90 - tilt) / (90 - MIN_VERTICAL)) ** 2;
        } else {
          if (tilt > MAX_TILT) continue;
          w = 1 - 0.5 * (tilt / MAX_TILT) ** 2;
        }
        w *= 1 - 0.3 * (turn / MAX_BEND) ** 2;
        // 锚点别太靠一头:按较短一条射线略加分
        const score = (li + lj) * w * (1 + 0.1 * Math.min(li, lj) / Math.max(li, lj, 1e-6));
        if (score > bestScore) {
          bestScore = score;
          best = { size: s, i, j, li, lj, vertical };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** 两条射线拼成的路径:A → 锚点 → C,拐角处抹圆;从左往右(竖排从上往下)的方向交给 layoutCurve 再理 */
function pathOf(R: Rays, f: Fit): number[] {
  const { px, py } = R;
  const ax = px + COS[f.i] * f.li;
  const ay = py + SIN[f.i] * f.li;
  const cx = px + COS[f.j] * f.lj;
  const cy = py + SIN[f.j] * f.lj;
  const turn = Math.abs(180 - (((f.j - f.i + RAYS) % RAYS) * RAY_STEP_DEG));
  if (turn < 3 || f.vertical) return [ax, ay, cx, cy];
  // 拐角抹圆:从锚点往两边各退 rc,用以锚点为控制点的二次曲线连起来(曲线在拐角内侧)
  const rc = Math.min(f.li, f.lj) * 0.6;
  const out: number[] = [ax, ay];
  const x0 = px + COS[f.i] * rc;
  const y0 = py + SIN[f.i] * rc;
  const x1 = px + COS[f.j] * rc;
  const y1 = py + SIN[f.j] * rc;
  const M = 8;
  for (let t = 0; t <= M; t++) {
    const u = t / M;
    out.push((1 - u) * (1 - u) * x0 + 2 * u * (1 - u) * px + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * u * (1 - u) * py + u * u * y1);
  }
  out.push(cx, cy);
  return out;
}

/** 字号阶梯(世界单位):从上限往下每次缩 8% */
function sizeLadder(maxCss: number, worldPerCss: number): number[] {
  const out: number[] = [];
  for (let c = maxCss; c >= MIN_FIT_CSS; c *= 0.92) out.push(c * worldPerCss);
  return out;
}

interface Cached {
  key: string;
  labels: PolityLabel[];
}
const cache = new WeakMap<Civ, Cached>();
/** 弯边投影下按投影后的国土拟合的(和上面的分开存:拖动时用世界坐标那一份,停下来用这一份,来回不互相冲掉) */
const projCache = new WeakMap<Civ, Cached>();
let ownScratch: Owners | undefined;

export interface PolityLabelOptions {
  /** 参照宽度(CSS 像素):字号按"地图这么宽、缩放 1 倍"来铺满国土 */
  refCss: number;
  /**
   * 弯边投影(罗宾森、摩尔威德……):国土栅格铺在投影后的地图平面上(从主栅格反查,见 projectedTerritoryGrid),
   * 在那里拟合 —— 弯边投影下国土的形状变了,国名按屏幕上看到的形状排。拟合出来的路径、锚点是地图平面坐标(PolityLabel.planar)
   */
  proj?: MapProj;
}

/**
 * 某一年所有国家的国名摆法。归属和国号都没变时直接用上次的结果(回放时大部分帧不用重算)。
 */
export function polityLabels(world: World, raster: Raster, civ: Civ, year: Year, opt: PolityLabelOptions): { labels: PolityLabel[]; field: TerritoryField | null } {
  if (!civ.polities.length) return { labels: [], field: null };
  const idx = logIndexAfter(civ.log, year);
  // 国号档位、国都(迁都后国名要绕开新国都)、第几朝(改朝换代后国名换了)都算进缓存键
  const tiers = civ.polities
    .map((p) => (polityAlive(p, year) ? `${polityTierAt(p, year)}@${capitalAt(p, year)}#${dynastyIndexAt(p, year)}` : -1))
    .join(',');
  const mp = opt.proj;
  if (mp) return projectedPolityLabels(world, raster, civ, year, opt, mp, idx, tiers);
  const key = `${idx}|${tiers}|${opt.refCss}|${raster.w}`;
  const grid = territoryGrid(world, raster, civ);
  // 归属只看日志下标:同一个下标 = 同样的国土。国土只看日志和州,按 civ.log 存(改了名的 civ 共用);
  // 国名的摆法和名字有关(字数),按 civ 存
  let fc = fieldCache.get(civ.log);
  if (!fc || fc.idx !== idx || fc.grid !== grid) {
    ownScratch = ownersAt(civ, year, ownScratch);
    fc = { idx, grid, field: territoryField(grid, ownScratch.polity), count: countRegions(ownScratch.polity, civ.polities.length) };
    fieldCache.set(civ.log, fc);
  }
  const hit = cache.get(civ);
  if (hit && hit.key === key) return { labels: hit.labels, field: fc.field };
  const { x: mx, y: my } = world.mesh;
  const capitalXY = (id: number): [number, number] | null => {
    const s = civ.settlements[capitalAt(civ.polities[id], year)];
    return s ? [mx[s.cell], my[s.cell]] : null;
  };
  const labels = fitAll(civ, year, fc.field, fc.count, opt, world.width, capitalXY);
  cache.set(civ, { key, labels });
  return { labels, field: fc.field };
}

const fieldCache = new WeakMap<ChangeLog, { idx: number; grid: TerritoryGrid; field: TerritoryField; count: Int32Array }>();
const projFieldCache = new WeakMap<ChangeLog, { idx: number; grid: TerritoryGrid; field: TerritoryField; count: Int32Array }>();
const projGrids = new WeakMap<Civ['regions'], { raster: Raster; key: string; grid: TerritoryGrid }>();

/**
 * 弯边投影下的国土栅格:地图平面按 GRID 一格铺开,每格中心反投影回世界坐标,取那个像素的州;
 * 外轮廓外面、水 = −1(离界距离在轮廓处归零,国名不出轮廓)。按投影 + 中央经线缓存
 */
export function projectedTerritoryGrid(world: World, raster: Raster, civ: Civ, mp: MapProj): TerritoryGrid {
  const hit = projGrids.get(civ.regions);
  if (hit && hit.raster === raster && hit.key === mp.key) return hit.grid;
  const G = GRID;
  const gw = Math.ceil(mp.W / G);
  const gh = Math.ceil(mp.H / G);
  const region = new Int16Array(gw * gh).fill(-1);
  const { w, h, scale, cell, water } = raster;
  const of = civ.regions.of;
  const { adjStart, adj } = world.mesh;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const p = unprojectWorld(mp, (gx + 0.5) * G, (gy + 0.5) * G);
      if (!p) continue;
      const px = Math.min(w - 1, Math.floor(p[0] * scale));
      const py = Math.min(h - 1, Math.max(0, Math.floor(p[1] * scale)));
      const k = py * w + px;
      if (water[k] !== 0) continue;
      const c = cell[k];
      let r = of[c];
      if (r < 0) for (let q = adjStart[c]; q < adjStart[c + 1] && r < 0; q++) r = of[adj[q]];
      region[gy * gw + gx] = r;
    }
  }
  const grid: TerritoryGrid = { G, gw, gh, region };
  projGrids.set(civ.regions, { raster, key: mp.key, grid });
  return grid;
}

/** polityLabels 的弯边投影版:在投影后的国土栅格里拟合,路径是地图平面坐标 */
function projectedPolityLabels(
  world: World,
  raster: Raster,
  civ: Civ,
  year: Year,
  opt: PolityLabelOptions,
  mp: MapProj,
  idx: number,
  tiers: string,
): { labels: PolityLabel[]; field: TerritoryField | null } {
  const grid = projectedTerritoryGrid(world, raster, civ, mp);
  let fc = projFieldCache.get(civ.log);
  if (!fc || fc.idx !== idx || fc.grid !== grid) {
    ownScratch = ownersAt(civ, year, ownScratch);
    fc = { idx, grid, field: territoryField(grid, ownScratch.polity), count: countRegions(ownScratch.polity, civ.polities.length) };
    projFieldCache.set(civ.log, fc);
  }
  const key = `${idx}|${tiers}|${opt.refCss}|${raster.w}|${mp.key}`;
  const hit = projCache.get(civ);
  if (hit && hit.key === key) return { labels: hit.labels, field: fc.field };
  const { x: mx, y: my } = world.mesh;
  const capitalXY = (id: number): [number, number] | null => {
    const s = civ.settlements[capitalAt(civ.polities[id], year)];
    return s ? projectWorld(mp, mx[s.cell], my[s.cell]) : null;
  };
  const labels = fitAll(civ, year, fc.field, fc.count, opt, mp.W, capitalXY);
  for (const l of labels) l.planar = true;
  projCache.set(civ, { key, labels });
  return { labels, field: fc.field };
}
const ownerCache = new WeakMap<ChangeLog, { idx: number; grid: TerritoryGrid; f: OwnerGrid }>();
let ownScratch2: Owners | undefined;

/**
 * 某一年的国土栅格(只有归属,不算离界距离,很快)。回放时国名每 20 年才重排一次(见 render/civ/labels.ts),
 * 这期间国土会被攻占、缩小:国名的每个字要落在"当年"的国土上,就按它核对
 */
export function polityOwnerGrid(world: World, raster: Raster, civ: Civ, year: Year): OwnerGrid {
  const grid = territoryGrid(world, raster, civ);
  const idx = logIndexAfter(civ.log, year);
  const fc = fieldCache.get(civ.log);
  if (fc && fc.idx === idx && fc.grid === grid) return fc.field;
  const hit = ownerCache.get(civ.log);
  if (hit && hit.idx === idx && hit.grid === grid) return hit.f;
  ownScratch2 = ownersAt(civ, year, ownScratch2);
  const N = grid.gw * grid.gh;
  const owner = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    const r = grid.region[i];
    owner[i] = r >= 0 ? ownScratch2.polity[r] : -1;
  }
  const f = { grid, owner };
  ownerCache.set(civ.log, { idx, grid, f });
  return f;
}

function countRegions(polityOf: Int16Array, n: number): Int32Array {
  const c = new Int32Array(n);
  for (let r = 0; r < polityOf.length; r++) if (polityOf[r] >= 0) c[polityOf[r]]++;
  return c;
}

/** 国都符号在拟合时当成多大的圆(世界单位,圆心在国都往上一点:手绘风的城堡带小旗,往上伸得高) */
const HOLE_R = 12;
const HOLE_UP = 4;

/** 按已算好的国土栅格给每个国家排国名(纯计算,测试直接调它)。capitalXY(国家) = 国都的世界坐标 */
export function fitAll(
  civ: Civ,
  year: Year,
  field: TerritoryField,
  count: Int32Array,
  opt: PolityLabelOptions,
  worldW: number,
  capitalXY?: (polity: number) => [number, number] | null,
): PolityLabel[] {
  const { gw, gh } = field.grid;
  const N = gw * gh;
  // 每国离界最远的格子(并列取编号小的)和外接框
  const P = civ.polities.length;
  const bestCell = new Int32Array(P).fill(-1);
  const bestD = new Float32Array(P);
  const box = new Int32Array(P * 4);
  for (let p = 0; p < P; p++) box.set([gw, gh, -1, -1], p * 4);
  for (let i = 0; i < N; i++) {
    const o = field.owner[i];
    if (o < 0) continue;
    if (field.dist[i] > bestD[o]) {
      bestD[o] = field.dist[i];
      bestCell[o] = i;
    }
    const x = i % gw;
    const y = (i - x) / gw;
    const b = o * 4;
    if (x < box[b]) box[b] = x;
    if (y < box[b + 1]) box[b + 1] = y;
    if (x > box[b + 2]) box[b + 2] = x;
    if (y > box[b + 3]) box[b + 3] = y;
  }
  const worldPerCss = worldW / opt.refCss;
  const readable = READABLE_CSS * worldPerCss;
  const out: PolityLabel[] = [];
  for (const p of civ.polities) {
    if (!polityAlive(p, year) || count[p.id] <= 0 || bestCell[p.id] < 0) continue;
    const tier = polityTierAt(p, year);
    const full = polityName(p, year);
    const short = polityShortTitle(p, tier, year);
    const maxCss = maxNameCss(count[p.id]);
    const sizes = sizeLadder(maxCss, worldPerCss);
    const maxLen = maxCss * worldPerCss * 14;
    const R = castRays(field, p.id, bestCell[p.id], maxLen);
    const T = new ReachTable(R, sizes);
    const ff = fitBoth(R, sizes, T, full);
    const fs = short !== full ? fitBoth(R, sizes, T, short) : ff;
    let text = full;
    let f = ff;
    if (fs && fs !== ff) {
      const sf = ff?.size ?? 0;
      const useFull = ff && sf >= FULL_RATIO * fs.size && (sf >= readable || fs.size < readable);
      if (!useFull) {
        text = short;
        f = fs;
      }
    }
    if (!f) {
      text = short;
      f = longest(R, sizes[sizes.length - 1]);
    }
    const label: PolityLabel = {
      polity: p.id,
      text,
      full,
      path: pathOf(R, f),
      size: f.size,
      vertical: f.vertical,
      anchor: [R.px, R.py],
      regions: count[p.id],
    };
    // 备选:把国都当成一个圆洞绕开(国都常在国土正中,国名正好压着它时用这条)
    const cap = capitalXY?.(p.id);
    if (cap) {
      const hole: Hole = [cap[0], cap[1] - HOLE_UP, HOLE_R];
      const b = p.id * 4;
      let start = -1;
      let bd = 0;
      for (let y = box[b + 1]; y <= box[b + 3]; y++) {
        for (let x = box[b]; x <= box[b + 2]; x++) {
          const i = y * gw + x;
          if (field.owner[i] !== p.id || field.dist[i] <= bd) continue;
          const d = depthAt(field, i, hole);
          if (d > bd) {
            bd = d;
            start = i;
          }
        }
      }
      if (start >= 0) {
        const R2 = castRays(field, p.id, start, maxLen, hole);
        const f2 = fitBoth(R2, sizes, new ReachTable(R2, sizes), text) ?? longest(R2, sizes[sizes.length - 1]);
        const path = pathOf(R2, f2);
        // 东西相连:备选路径挪到离主路径锚点最近的那一圈(两条路径在同一个展开的视窗里排)
        if (field.grid.wrap) {
          const P = gw * field.grid.G;
          const sh = wrapDx(R2.px - R.px, P) - (R2.px - R.px);
          if (sh) for (let q = 0; q < path.length; q += 2) path[q] += sh;
        }
        label.alt = { path, size: f2.size, vertical: f2.vertical };
      }
    }
    out.push(label);
  }
  return out;
}

/** 横排、竖排各拟合一次,挑字号大的(竖排要大出 VERTICAL_GAIN 倍) */
function fitBoth(R: Rays, sizes: number[], T: ReachTable, text: string): Fit | null {
  const n = [...text].length;
  const h = fitText(R, n, sizes, T, false);
  const v = n >= 2 ? fitText(R, n, sizes, T, true) : null;
  if (v && (!h || v.size >= h.size * VERTICAL_GAIN)) return v;
  return h ?? v;
}

/** 最小的字号也放不下:按最小字号找一条最长、尽量平的路(放大地图后再显示) */
function longest(R: Rays, s: number): Fit {
  // 国土太窄:离界只要求锚点处的一半,至少让路径有点长度(字摆在哪儿再由 placeMap 按国土筛)
  const h = Math.min(s * HALF + MARGIN, R.depth * 0.5);
  let bi = 0;
  let bl = -1;
  for (let i = 0; i < RAYS / 2; i++) {
    const l = Math.max(0, reach(R, i, h)) + Math.max(0, reach(R, i + RAYS / 2, h));
    const tilt = Math.min(i, RAYS / 2 - i) * RAY_STEP_DEG;
    const score = l * (1 - 0.5 * Math.min(1, tilt / 90));
    if (score > bl) {
      bl = score;
      bi = i;
    }
  }
  return { size: s, i: bi, j: bi + RAYS / 2, li: Math.max(0, reach(R, bi, h)), lj: Math.max(0, reach(R, bi + RAYS / 2, h)), vertical: false };
}

// ---------------------------------------------------------------------------
// 画布上的候选摆法

/**
 * 沿路径往前后挪几个半字距、往两侧挪大半个字的组合(按挪动多少排序):
 * 国都常在国土正中(国家从那里长出来),国名正好压着国都时,挪半个字距就能让国都落在两个字的空当里
 */
const SHIFTS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (const along of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2, 3, -3]) {
    for (const across of [0, -0.95, 0.95, -1.8, 1.8, -2.6, 2.6]) out.push([along, across]);
  }
  return out.sort((a, b) => Math.abs(a[0]) * 0.8 + Math.abs(a[1]) - (Math.abs(b[0]) * 0.8 + Math.abs(b[1])));
})();
/** 按原字号摆不下时,再试小一档、小两档(不小于最小字号) */
const STEP_DOWN = [1, 0.86, 0.74];

/** 字随路径转的最大角度、相邻两字转角最多差多少(和 layout.ts 的屈曲字列一致) */
const LIM = (40 * Math.PI) / 180;
const TURN = (22 * Math.PI) / 180;

/**
 * 国名的候选摆法(画布像素):沿路径均匀疏排(字距在 tracking 之间按路径长取),横排时字随路径略转,
 * 竖排时字正立、从上往下。先试正中,再按 SHIFTS 前后左右挪;落在国土外的由 placeMap 按 area 筛掉。
 */
export function polityCandidates(
  text: string,
  pathWorld: ArrayLike<number>,
  px0: number,
  tracking: [number, number],
  view: LabelView,
  vertical: boolean,
  minPx = 0,
  planar = false,
): Candidate[] {
  const out: Candidate[] = [];
  let last = 0;
  for (const f of STEP_DOWN) {
    const px = Math.max(minPx, px0 * f);
    if (px === last) continue;
    last = px;
    for (const c of alongPath(text, pathWorld, px, tracking, view, vertical, planar)) out.push(f === 1 ? c : { ...c, px });
  }
  return out;
}

/** planar = 路径已经是地图平面坐标(弯边投影下按投影后的国土拟合的),不再投影 */
function alongPath(text: string, pathWorld: ArrayLike<number>, px: number, tracking: [number, number], view: LabelView, vertical: boolean, planar = false): Candidate[] {
  const cs = [...text];
  const n = cs.length;
  if (!n) return [];
  const pts = pathToCanvas(pathWorld, view, planar);
  let path = new Polyline(pts);
  const m = path.xs.length;
  if (m < 2) {
    // 退化成一个点:横排在点上
    const x0 = path.xs[0] ?? 0;
    const y0 = path.ys[0] ?? 0;
    const pitch = px * (1 + tracking[0]);
    return [{ on: 0, glyphs: cs.map((ch, i) => ({ ch, x: x0 + (i - (n - 1) / 2) * pitch, y: y0, a: 0 })) }];
  }
  const gx = path.xs[m - 1] - path.xs[0];
  const gy = path.ys[m - 1] - path.ys[0];
  if (vertical ? gy < 0 : gx < 0) path = path.reversed();
  const L = path.length;
  const pitch = n > 1 ? Math.max(px * (1 + tracking[0]), Math.min(px * (1 + tracking[1]), (L * 0.92) / n)) : px;
  const span = pitch * (n - 1);
  // 整条路径的法线(横排朝上为负;竖排朝右)
  const cl = Math.hypot(gx, gy) || 1;
  let nx = -gy / cl;
  let ny = gx / cl;
  if (vertical ? nx < 0 : ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const out: Candidate[] = [];
  for (const [along, across] of SHIFTS) {
    const sc = L / 2 + along * pitch;
    // 整行字不出路径两头太多(放大后国名相对变小,挪动的余地就大了)
    if (sc - span / 2 < -px * 0.3 || sc + span / 2 > L + px * 0.3) continue;
    const ox = nx * across * px;
    const oy = ny * across * px;
    const glyphs: Glyph[] = [];
    for (let i = 0; i < n; i++) {
      const s = sc - span / 2 + i * pitch;
      const [x, y] = path.at(s);
      let a = 0;
      if (!vertical) {
        const [ux, uy] = path.dir(s, pitch * 0.6);
        a = Math.max(-LIM, Math.min(LIM, Math.atan2(uy, ux)));
        if (i > 0) a = Math.max(glyphs[i - 1].a - TURN, Math.min(glyphs[i - 1].a + TURN, a));
      }
      glyphs.push({ ch: cs[i], x: x + ox, y: y + oy, a });
    }
    out.push({ on: 0, glyphs });
  }
  return out;
}
