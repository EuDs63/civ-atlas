/**
 * 改地形(阶段 4):把作者的地形修改(gen/edits.ts 的 TerrainOp,格式见那里的文件头"地形修改")套进生成流程。
 * 纯计算,不碰 DOM。
 *
 * 不直接改最终的海拔,而是在生成流程里对应的那一步"补一把自然之力",之后的侵蚀、排水、气候、群落照常跑 ——
 * 改过的地形和天然长出来的一样(河谷、雪线、群落都跟着变):
 *
 * - 侵蚀之前(applyTerrainTectonics,原地改板块那一步得到的 land、uplift、oceanDepth):
 *   - 火山:抬升场里加一个圆锥(中心最强);放在海里的,锥体中间一片改成陆地(成岛),周围海底抬高成海山
 *   - 山脉:沿折线加一道抬升脊,脊上高低起伏、两头收尖;穿过海面、抬得够高的一段改成陆地(岛链 / 半岛)
 *   - 抬起陆地:画笔走过的地方改成陆地(低平,和天然平原一样的基础抬升);本来就是陆地的稍微抬高
 *   - 沉成海:画笔走过的地方改成浅海;边上留下的陆地抬升减弱(海岸低平)
 *   侵蚀按抬升造山、按降水刻河谷,火山、山脉就被刻出放射状的山谷和水系。
 *   新海岸线加一点噪声,不是整整齐齐的圆。
 * - 海拔换算成米时,"最高峰"取样跳过改过的地块(返回的 touched):一座大火山不会把全世界的山都压矮
 * - 随机洼地之后(carveLakes):在湖的位置挖一个碗形洼地,碗底比碗沿外一圈的最低处还低,
 *   排水(Priority-Flood)自己把它灌满成湖;用户挖的湖不受"太大的湖填成平地"的限制
 * - 最后(volcanoPeaks):每座火山的峰顶地块,手绘风在那里画火山符号
 *
 * 确定性:不用随机数;山脉脊上的起伏、新海岸线的细碎用 subSeed(seed, 'terrain-edit') 的噪声。
 */
import type { Mesh } from './mesh';
import type { Tectonics } from './tectonics';
import type { TerrainKind, TerrainOp } from './edits';
import { clamp, smoothstep, subSeed } from './util';
import { geometryOf, type Geometry } from './geometry';

/** 世界坐标的范围(= world.ts 的 MAP_W × MAP_H;这里不引 world.ts,免得循环引用,单测核对两边一致)。x 是经度,绕一圈 = TERRAIN_W */
export const TERRAIN_W = 2048;
export const TERRAIN_H = 1024;
/** 最多多少处地形修改 */
export const TERRAIN_MAX_OPS = 200;
/** 一条折线最多多少个点 */
export const TERRAIN_MAX_PTS = 256;
/** 大小(r)、强度(s)的范围 */
export const TERRAIN_R: readonly [number, number] = [3, 160];
export const TERRAIN_S: readonly [number, number] = [0.2, 2];

/** 每种工具三档(小 / 中 / 大;山脉是低 / 中 / 高)的大小 r(世界坐标)和强度 s:改地形的工具条、AI 改写共用 */
export const TERRAIN_PRESETS: Record<TerrainKind, [r: number, s: number][]> = {
  volcano: [
    [18, 0.85],
    [28, 1.05],
    [40, 1.3],
  ],
  range: [
    [18, 0.55],
    [23, 1],
    [28, 1.45],
  ],
  lake: [
    [10, 0.7],
    [16, 1],
    [26, 1.2],
  ],
  raise: [
    [14, 1],
    [24, 1],
    [40, 1],
  ],
  sink: [
    [14, 1],
    [24, 1],
    [40, 1],
  ],
  river: [
    [6, 0.7],
    [9, 1],
    [14, 1.3],
  ],
};

const KINDS: readonly TerrainKind[] = ['volcano', 'range', 'lake', 'raise', 'sink', 'river'];
/** 只有一个点的种类 */
export const isPointKind = (k: TerrainKind) => k === 'volcano' || k === 'lake';

// ---------------------------------------------------------------------------
// 清理(读档、加一处修改时用)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** 经度(世界 x)取整、取模到 [0, TERRAIN_W) */
export const wrapLon = (x: number) => {
  const v = Math.round(x - TERRAIN_W * Math.floor(x / TERRAIN_W));
  return v >= TERRAIN_W ? v - TERRAIN_W : v;
};
/** 经度(世界 x)取整,挪到离 ref 最近的那一圈(差不超过半圈) */
export const nearLon = (x: number, ref: number) => Math.round(x - TERRAIN_W * Math.round((x - ref) / TERRAIN_W));

/**
 * 清理一处地形修改:种类不认识、坐标 / 大小 / 强度不是有限数、点不够的 = null;
 * 坐标取整:y 夹在两极之间 [0, TERRAIN_H];x 是经度,不夹 —— 第一个点取模到 [0, TERRAIN_W),之后每个点挪到离上一个点
 * 最近的那一圈(跨 180° 经线的一笔是连着的,x 可以超出 [0, TERRAIN_W));
 * 大小、强度夹到范围内(大小保留一位小数,强度两位);火山、湖只留第一个点,折线最多 TERRAIN_MAX_PTS 个点。
 * 本来就合格的原样返回(同一个对象)
 */
export function cleanTerrainOp(x: unknown): TerrainOp | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const kind = o.kind as TerrainKind;
  if (!KINDS.includes(kind) || !Array.isArray(o.pts) || o.pts.length < 2) return null;
  const raw = o.pts as unknown[];
  const take = isPointKind(kind) ? 2 : Math.min(raw.length, TERRAIN_MAX_PTS * 2) & ~1;
  const pts: number[] = [];
  for (let i = 0; i < take; i += 2) {
    const px = num(raw[i]);
    const py = num(raw[i + 1]);
    if (px === null || py === null) return null;
    pts.push(i ? nearLon(px, pts[i - 2]) : wrapLon(px), Math.round(clamp(py, 0, TERRAIN_H)));
  }
  const r0 = num(o.r);
  const s0 = num(o.s);
  if (r0 === null || s0 === null) return null;
  const r = Math.round(clamp(r0, TERRAIN_R[0], TERRAIN_R[1]) * 10) / 10;
  const s = Math.round(clamp(s0, TERRAIN_S[0], TERRAIN_S[1]) * 100) / 100;
  const same =
    Object.keys(o).length === 4 && r === o.r && s === o.s && raw.length === pts.length && pts.every((v, i) => v === raw[i]);
  return same ? (x as TerrainOp) : { kind, pts, r, s };
}

/** 清理一份地形修改列表(规则同 cleanTerrainOp;不合格的丢掉,最多 TERRAIN_MAX_OPS 处)。全都合格时返回原数组 */
export function cleanTerrainOps(list: unknown): TerrainOp[] {
  if (!Array.isArray(list)) return [];
  const out: TerrainOp[] = [];
  let same = list.length <= TERRAIN_MAX_OPS;
  for (const x of list as unknown[]) {
    if (out.length >= TERRAIN_MAX_OPS) break;
    const v = cleanTerrainOp(x);
    if (v) out.push(v);
    if (v !== x) same = false;
  }
  return same ? (list as TerrainOp[]) : out;
}

/** 两份地形修改是不是一样(逐处逐字段比) */
export function sameTerrain(a: readonly TerrainOp[], b: readonly TerrainOp[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.kind === y.kind && x.r === y.r && x.s === y.s && x.pts.length === y.pts.length && x.pts.every((v, j) => v === y.pts[j]);
  });
}

// ---------------------------------------------------------------------------
// 形状(点到折线的最近点在 geometry.ts 的 polyline)

/** 形状扭一扭(域扭曲):山脊蜿蜒、火山和湖不是正圆。把地块 i 扭过的位置(世界坐标)写进 out */
function warper(geo: Geometry, seed: number) {
  const wx = geo.fbm(subSeed(seed, 'terrain-edit') ^ 0x3c6e, 3);
  const wy = geo.fbm(subSeed(seed, 'terrain-edit') ^ 0x7a91, 3);
  return (i: number, amp: number, out: number[]) => geo.moveCell(out, i, amp * wx.atScale(i, 48), amp * wy.atScale(i, 48));
}

// ---------------------------------------------------------------------------
// 侵蚀之前:陆地 / 海洋、抬升、海底

/** 火山圆锥中心的抬升(× 强度;天然碰撞带最强约 1.1–1.5,火山细而尖,要更大的抬升才堆得起来) */
const VOLCANO_U = 3.2;
/** 山脉脊线上的抬升(× 强度) */
const RANGE_U = 1.5;
/** 抬起陆地:新陆地上额外的丘陵抬升(× 强度) */
const RAISE_U = 0.07;

/**
 * 侵蚀之前套上火山、山脉、抬起陆地、沉成海(原地改 tect.land / tect.uplift / tect.oceanDepth,按列表先后,后改的盖住先改的)。
 * 返回"改过的地块"(1 = 这里的地形被改过;换算成米时不参与最高峰取样)。没有这几种修改 = null(什么都没动)
 */
export function applyTerrainTectonics(mesh: Mesh, tect: Tectonics, ops: readonly TerrainOp[], seed: number): Uint8Array | null {
  const shapes = ops.filter((o) => o.kind !== 'lake' && o.kind !== 'river');
  if (!shapes.length) return null;
  const { n } = mesh;
  const geo = geometryOf(mesh);
  const { land, uplift, oceanDepth } = tect;
  const nz = geo.fbm(subSeed(seed, 'terrain-edit'), 3);
  const warp = warper(geo, seed);
  const q = [0, 0];
  /** 1 = 改成陆地,−1 = 改成海 */
  const over = new Int8Array(n);
  const add = new Float32Array(n);
  const mul = new Float32Array(n).fill(1);
  /** 沉成海的地方的水深(负数) */
  const sea = new Float32Array(n);
  /** 海底往浅处抬的程度 0–1 */
  const floor = new Float32Array(n);
  const touched = new Uint8Array(n);

  for (const op of shapes) {
    const r = op.r;
    const s = op.s;
    const reach = op.kind === 'volcano' ? 2.6 * r : op.kind === 'range' ? 2.4 * r : 2.2 * r;
    // 山脊蜿蜒、火山山体不正圆、画笔画出的海岸线不是光溜溜的一条(边上另有细碎的海岸噪声)
    const amp = op.kind === 'range' ? 0.45 * r : op.kind === 'volcano' ? 0.2 * r : 0.35 * r;
    const sh = geo.polyline(op.pts, reach);
    // 山脉两头收尖的长度;太短的(几乎是点一下)当成一座圆山
    const taperLen = Math.min(sh.len * 0.35, 1.8 * r);
    for (let i = 0; i < n; i++) {
      if (!sh.covers(i)) continue;
      warp(i, amp, q);
      const h = sh.nearest(q[0], q[1]);
      const t = h.d / r;
      // 海岸线的细碎:同一张噪声,两种尺度
      const coast = 0.6 * nz.atScale(i, 22) + 0.4 * nz.atScale(i, 9, 31.7, -12.9);
      if (op.kind === 'volcano') {
        if (t >= 2.6) continue;
        if (t < 1) {
          add[i] += s * VOLCANO_U * Math.pow(1 - t, 1.6);
          if (t + 0.16 * coast < 0.72) over[i] = 1;
        }
        floor[i] = Math.max(floor[i], 1 - smoothstep(0.6, 2.6, t));
        touched[i] = 1;
      } else if (op.kind === 'range') {
        if (t >= 2.4) continue;
        const a = h.a;
        const taper = taperLen > 0.5 * r ? 0.15 + 0.85 * smoothstep(0, taperLen, a) * smoothstep(0, taperLen, sh.len - a) : 1;
        // 脊上高低起伏:按最近点的位置取噪声(同一处的两道山脉起伏一致)
        const v = 0.78 + 0.32 * nz.pointScale(h.qx, h.qy, 60, 7.3, -3.1);
        const f = taper * v * Math.exp(-1.4 * t * t);
        add[i] += s * RANGE_U * f;
        if (f + 0.14 * coast > 0.55) over[i] = 1;
        floor[i] = Math.max(floor[i], taper * Math.exp(-0.45 * t * t));
        touched[i] = 1;
      } else {
        // 画笔:核心一片实心,边缘软
        if (t >= 2.2) continue;
        const f = 1 - smoothstep(0.55, 1.1, t);
        const core = f + 0.42 * coast > 0.5;
        if (op.kind === 'raise') {
          if (core) over[i] = 1;
          add[i] += s * RAISE_U * f;
          floor[i] = Math.max(floor[i], 1 - smoothstep(0.8, 2.2, t));
        } else {
          if (core) {
            over[i] = -1;
            add[i] = 0;
            sea[i] = -(30 + 220 * s * smoothstep(0.3, 1, f + 0.2 * coast));
            floor[i] = 0;
          } else {
            // 边上的陆地抬升减弱:新海岸低平
            mul[i] *= 1 - 0.75 * (1 - smoothstep(0.9, 2.2, t));
          }
        }
        touched[i] = 1;
      }
    }
  }

  // 套上:改陆地 / 海洋,再加抬升;海底往浅处抬
  const base = geo.fbm(subSeed(seed, 'terrain-edit') ^ 0x5bd1, 3);
  for (let i = 0; i < n; i++) {
    if (!touched[i]) continue;
    if (over[i] === 1 && !land[i]) {
      land[i] = 1;
      oceanDepth[i] = 0;
      // 新陆地的基础抬升和天然平原一样(0.02–0.07)
      uplift[i] = 0.045 + 0.025 * base.atScale(i, 180);
    } else if (over[i] === -1 && land[i]) {
      land[i] = 0;
      uplift[i] = 0;
      oceanDepth[i] = Math.min(-20, sea[i]);
    }
    if (land[i]) uplift[i] = uplift[i] * mul[i] + add[i];
    else if (floor[i] > 0 && over[i] !== -1) {
      // 海山 / 海岭:往 −60 米抬,只往浅里抬
      const d = oceanDepth[i] + (-60 - oceanDepth[i]) * floor[i];
      if (d > oceanDepth[i]) oceanDepth[i] = Math.min(-20, d);
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// 随机洼地之后:湖

/** 湖最深多少米(× 强度),碗沿再低多少米 */
const LAKE_DEPTH = 50;
const LAKE_LIP = 6;

/**
 * 在每个湖的位置挖碗形洼地(原地改 elevation):碗里的地块都低于碗外一圈邻居里最低的那个(= 溢出口),
 * 排水时自己灌满成湖,从溢出口流出去。湖心点在海里的不挖。
 * 返回用户湖的地块(1 = 这里是作者挖的湖,"太大的湖填平"跳过它们);没有湖 = null
 */
export function carveLakes(mesh: Mesh, land: Uint8Array, elevation: Float32Array, ops: readonly TerrainOp[], seed: number): Uint8Array | null {
  const lakes = ops.filter((o) => o.kind === 'lake');
  if (!lakes.length) return null;
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);
  const mask = new Uint8Array(n);
  const inBowl = new Uint8Array(n);
  const warp = warper(geo, seed);
  const q = [0, 0];
  for (const op of lakes) {
    const [px, py] = op.pts;
    const r = op.r;
    // 碗:湖心半径 r 内的陆地(湖岸扭一扭,不是正圆)
    const bowl: number[] = [];
    const amp = 0.3 * r;
    const R = r + amp;
    let c = -1;
    let cd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = geo.nearTo(i, px, py, R);
      if (d < 0) continue;
      if (d < cd) {
        cd = d;
        c = i;
      }
      warp(i, amp, q);
      if (geo.pointDist(q[0], q[1], px, py) < r && land[i]) bowl.push(i);
    }
    if (c < 0 || !land[c]) continue;
    if (!bowl.includes(c)) bowl.push(c);
    for (const i of bowl) inBowl[i] = 1;
    // 碗沿 = 碗外一圈邻居里最低的(海 = 0 米)
    let rim = Infinity;
    for (const i of bowl) {
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (inBowl[j]) continue;
        rim = Math.min(rim, land[j] ? elevation[j] : 0);
      }
    }
    if (!Number.isFinite(rim)) rim = elevation[c];
    for (const i of bowl) {
      warp(i, amp, q);
      const t = Math.min(1, geo.pointDist(q[0], q[1], px, py) / r);
      const target = rim - LAKE_LIP - LAKE_DEPTH * op.s * (1 - t * t);
      if (elevation[i] > target) elevation[i] = target;
      mask[i] = 1;
      inBowl[i] = 0;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// 湖之后:河

/** 河谷:河道比两岸最低处还低多少米(× 强度),一路往下游每个地块至少再低多少米 */
const RIVER_CUT = 12;
const RIVER_DROP = 0.4;

/**
 * 沿作者画的河挖一道河谷(原地改 elevation):把线经过的地块串成一条链,低的那头当河口(有一头在海里的,那头是河口);
 * 从源头往下游,每个地块挖到比它两岸(不在链上的邻居)最低处还低、也比上游那块低 —— 排水时水就顺着这条链流。
 * 链走到海、湖就停(河口)。海拔不低于 1 米(不挖到海平面以下积成一串湖)。
 * 返回"一定画成河"的地块(1 = 这里是作者画的河道,流量不够也画);没有河 = null
 */
export function carveRivers(mesh: Mesh, water: Uint8Array, elevation: Float32Array, ops: readonly TerrainOp[]): Uint8Array | null {
  const rivers = ops.filter((o) => o.kind === 'river');
  if (!rivers.length) return null;
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);
  const at = geo.locator();
  const forced = new Uint8Array(n);
  const onChain = new Uint8Array(n);
  for (const op of rivers) {
    // 线上密密地取点,每个点落在哪块,连成链(相邻的重复去掉)
    const sh = geo.polyline(op.pts, 0);
    const step = Math.max(0.5, mesh.spacing / 3);
    const chain: number[] = [];
    const m = op.pts.length >> 1;
    for (let k = 0; k < Math.max(1, m - 1); k++) {
      const ax = op.pts[2 * k];
      const ay = op.pts[2 * k + 1];
      const bx = m > 1 ? op.pts[2 * k + 2] : ax;
      const by = m > 1 ? op.pts[2 * k + 3] : ay;
      const len = m > 1 ? sh.cum[k + 1] - sh.cum[k] : 0;
      const steps = Math.max(1, Math.ceil(len / step));
      for (let t = 0; t <= steps; t++) {
        const c = at(ax + ((bx - ax) * t) / steps, ay + ((by - ay) * t) / steps);
        if (chain[chain.length - 1] !== c) chain.push(c);
      }
    }
    // 哪头是源头:有一头在水里的,那头是河口;否则高的那头是源头
    const head = chain[0];
    const tail = chain[chain.length - 1];
    const wetHead = water[head] !== 0;
    const wetTail = water[tail] !== 0;
    if ((wetHead && !wetTail) || (!wetHead && !wetTail && elevation[head] < elevation[tail])) chain.reverse();
    // 源头那头在水里的部分去掉,走到水就停
    let s0 = 0;
    while (s0 < chain.length && water[chain[s0]] !== 0) s0++;
    let s1 = s0;
    while (s1 < chain.length && water[chain[s1]] === 0) s1++;
    const run = chain.slice(s0, s1);
    if (run.length < 2) continue;
    for (const c of run) onChain[c] = 1;
    let prev = Infinity;
    for (const c of run) {
      let low = Infinity;
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        if (onChain[j]) continue;
        low = Math.min(low, water[j] === 0 ? elevation[j] : 0);
      }
      let e = Math.min(elevation[c], low - RIVER_CUT * op.s, prev - RIVER_DROP);
      if (!Number.isFinite(e)) e = elevation[c];
      e = Math.max(1, e);
      elevation[c] = e;
      prev = e;
      forced[c] = 1;
    }
    for (const c of run) onChain[c] = 0;
  }
  return forced;
}

// ---------------------------------------------------------------------------
// 火山峰顶(手绘风的火山符号)

/** 每座火山的峰顶地块(火山中心 0.6 个半径内最高的陆地;一块陆地都没有的火山跳过),按修改的先后 */
export function volcanoPeaks(mesh: Mesh, water: Uint8Array, elevation: Float32Array, ops: readonly TerrainOp[]): number[] {
  const out: number[] = [];
  const { n } = mesh;
  const geo = geometryOf(mesh);
  for (const op of ops) {
    if (op.kind !== 'volcano') continue;
    const [px, py] = op.pts;
    const R = Math.max(op.r * 0.6, 8);
    let best = -1;
    for (let i = 0; i < n; i++) {
      const d = geo.nearTo(i, px, py, R);
      if (d < 0 || water[i] !== 0 || d >= R) continue;
      if (best < 0 || elevation[i] > elevation[best]) best = i;
    }
    if (best >= 0 && !out.includes(best)) out.push(best);
  }
  return out;
}
