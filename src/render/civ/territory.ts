/**
 * 文明叠加层 · 民族色块和国土,同一套画法换一层归属、换一套颜色。
 *
 * - 民族 · 写实:淡淡一层纯色罩染,靠边界处稍浓一点 —— 边界看得清,又不糊住地形。
 * - 国土 · 写实:更淡的罩染,紧贴国界往里一道稍浓的色带(政区图的画法);国界线本身在 borders.ts 画。
 * - 手绘:水彩晕染 —— 沿边界最浓、往里渐淡,再叠一层纸纹颗粒;民族色块的边缘颜料积成一道深一点的"水痕",
 *   国土不要水痕(国界是墨色虚线,水痕会把虚线的空当填满)。
 *   颜料给地形符号"让位":墨线、河流上不上色,林块、山的纸色底只在紧贴边界的一道色带里上色,往里保持本色
 *   (否则朱红罩在深绿树林上成了泥褐色、山符号变粉);遮罩来自手绘地图的符号层(fantasy.ts 的 fantasyInkMask)。
 * - 色块按像素归属(Raster.cell → 州 → 归属)逐像素上色,所以边界落在州界上(山脊、大河);
 *   离界线不远的像素再按平滑后的界线判在哪一侧(borders.ts 的 bandLabels):色块的边和画出来的国界严丝合缝。
 *   海、湖的像素不上色,海岸线和地形图严丝合缝。
 * - 两层都打开时只铺民族色块,国家只画国界(见 overlay.ts)。
 * - 回放 / 拖时间轴时(fast)用半分辨率,静止时用全分辨率;刚归属的州用几十年渐入,看起来像颜料慢慢洇开。
 *
 * washPixels 是纯计算(不碰 DOM),stress 脚本在 Node 里给它计时。
 * 主图东西相连:离边界的距离左右相通(粗网格左右各接上一截另一头),按界线判归属时伸出左右边的线在另一边也判。
 */
import type { Raster } from '../../gen/raster';
import type { Civ } from '../../gen/civ/types';
import { Layer } from '../../gen/civ/types';
import { ownersAt, recentChanges, type Owners } from '../../gen/civ/timeline';
import type { Mesh } from '../../gen/mesh';
import { hash2 } from '../common';
import { bandLabels, borderLines } from './borders';
import { meshWrap } from './lines';
import { fantasyGlobeInkMask, fantasyInkMask, fantasyInkProj, type InkMask } from '../fantasy';
import { reprojectImage } from '../projection';
import type { CivDrawParams, CivStyle } from './overlay';

/** 刚被占的州用多少年渐入 */
export const FADE_YEARS = 30;

/** 罩染的浓淡(不透明度 0–1),d = 离边界的距离(全分辨率像素) */
const REAL_FILL = 0.3;
const REAL_EDGE = 0.32;
const REAL_EDGE_W = 2.6;
/** 写实:边界描边的半宽(像素)和不透明度 */
const REAL_LINE_W = 0.9;
const REAL_LINE_ALPHA = 0.85;
/** 写实 · 国土:更淡的罩染 + 紧贴国界的色带(国界线另画,不要本色描边) */
const REAL_POL_FILL = 0.3;
const REAL_POL_EDGE = 0.38;
const REAL_POL_EDGE_W = 6;
const PAINT_FILL = 0.16;
const PAINT_EDGE = 0.45;
const PAINT_EDGE_W = 9;
/** 手绘 · 国土:比民族色块浓一点、晕边宽一点(国土是手绘政区图上最主要的信息) */
const PAINT_POL_FILL = 0.2;
const PAINT_POL_EDGE = 0.5;
const PAINT_POL_EDGE_W = 12;
/** 手绘:边缘"水痕"宽度(像素)、加深多少、额外不透明度 */
const PAINT_RIM_W = 1.1;
const PAINT_RIM_DARK = 0.78;
const PAINT_RIM_ALPHA = 0.16;
/**
 * 手绘:水彩给地形符号"让位"(遮罩见 fantasy.ts 的 fantasyInkMask)——
 * 墨线、河流上不上色;林块、山的纸色底在国土内部分别让开 SYM_FOREST / SYM_PAPER;
 * 紧贴边界的一道色带照样上色(让位打折 SYM_RIB × e^(−d/SYM_RIB_W),d = 离边界的像素):林多的国家靠这道色带也看得出疆域。
 */
const SYM_FOREST = 0.85;
const SYM_PAPER = 0.55;
const SYM_RIB = 0.9;
const SYM_RIB_W = 14;
/** 纸纹颗粒:不透明度乘 (1 − GRAIN/2 .. 1 + GRAIN/2) */
const GRAIN = 0.45;

const WATER = -2;
const GRAIN_N = 128;
/** 浓淡查表的长度(步长 1/4 像素,最远 64 像素) */
const LUT_N = 256;
/** 符号上保留几成水彩(按离边界的距离查表,同上) */
const SYM_KEEP = Float32Array.from({ length: LUT_N }, (_, i) => SYM_RIB * Math.exp(-i / 4 / SYM_RIB_W));

let grainTile: Float32Array | null = null;
/** 可平铺的值噪声:period 格一个周期,格点值取哈希(坐标按周期取模,所以左右、上下无缝) */
function tiledNoise(x: number, y: number, period: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, s);
  const b = hash2(x1, y0, s);
  const c = hash2(x0, y1, s);
  const d = hash2(x1, y1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** 128² 的可平铺纸纹颗粒(两层值噪声:8 像素一格 + 4 像素一格),全局只算一次 */
function grain(): Float32Array {
  if (grainTile) return grainTile;
  const g = new Float32Array(GRAIN_N * GRAIN_N);
  for (let y = 0; y < GRAIN_N; y++) {
    for (let x = 0; x < GRAIN_N; x++) {
      g[y * GRAIN_N + x] = 0.6 * tiledNoise(x / 8, y / 8, GRAIN_N / 8, 3) + 0.4 * tiledNoise(x / 4, y / 4, GRAIN_N / 4, 7);
    }
  }
  grainTile = g;
  return g;
}

/** 每个像素属于哪个州(水 = −1)。陆地像素最近的地块若是水(海岸细节),就借一个相邻陆地块的州 */
export function pixelRegions(mesh: Mesh, raster: Raster, regionOf: Int32Array): Int16Array {
  const { w, h, cell, water } = raster;
  const out = new Int16Array(w * h);
  const { adjStart, adj } = mesh;
  for (let k = 0; k < w * h; k++) {
    if (water[k] !== 0) {
      out[k] = -1;
      continue;
    }
    const c = cell[k];
    let r = regionOf[c];
    if (r < 0) {
      for (let q = adjStart[c]; q < adjStart[c + 1] && r < 0; q++) r = regionOf[adj[q]];
    }
    out[k] = r;
  }
  return out;
}

export interface WashInput {
  /** 全分辨率尺寸 */
  w: number;
  h: number;
  /** 工作分辨率:1 = 全分辨率,2 = 半分辨率 */
  f: number;
  /** 像素 → 州(全分辨率,水 = −1) */
  pixRegion: Int16Array;
  /** 州 → 归属(民族 / 国家编号,−1 = 无) */
  owner: Int16Array;
  /** 归属 → 颜色:colors[i×3..i×3+2] */
  colors: Uint8Array;
  /** 州 → 0..1 的渐入系数;不给 = 全部 1 */
  fade?: Float32Array | null;
  style: CivStyle;
  /**
   * 工作分辨率(⌈w/f⌉ × ⌈h/f⌉)的归属图:−2 水、−1 无、≥ 0 归属(见 labelImage)。
   * 给了就用它(色块的边跟着平滑后的界线走),不给就按 pixRegion → owner
   */
  label?: Int16Array;
  /** 国土:写实风换成更淡的罩染 + 紧贴国界的色带 */
  polity?: boolean;
  /** 手绘:符号"让位"遮罩(全分辨率,见 fantasyInkMask):水彩在符号上减淡,不把墨线、树林染脏 */
  ink?: InkMask | null;
  /** 主图东西相连:离边界的距离左右相通(粗网格左右各接上一截另一头);不给 = 不相连(单测用的小图) */
  wrap?: boolean;
  /**
   * 弯边投影(手绘):符号遮罩要按投影后的符号层在显卡上合成(见 drawTerritory),这里不乘 ink,
   * 另把"紧贴边界的色带里符号上还留几成水彩"换算成的让位系数(1 − SYM_KEEP,0–255)写进这张图的透明通道
   */
  keepOut?: Uint8ClampedArray;
}

interface Scratch {
  label: Int16Array;
  dist: Float32Array;
}
const scratch = new Map<string, Scratch>();

/**
 * 把一层归属画成 RGBA(工作分辨率 ⌈w/f⌉ × ⌈h/f⌉,不预乘)。
 * 离边界的距离在更粗一倍的网格上算(两遍倒角距离),再双线性插值。
 */
export function washPixels(inp: WashInput, out: Uint8ClampedArray): void {
  const { w, h, f, pixRegion, owner, colors, fade, style, label: lab, polity, ink } = inp;
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const G = 2 * f;
  const GW0 = Math.ceil(w / G);
  const GH = Math.ceil(h / G);
  // 东西相连:粗网格左右各多接 PAD 列(另一头的列),距离算完只用中间那段 —— 离边界的距离左右相通。
  // 浓淡查表最远 64 像素,接的长度够用就行;不相连时 PAD = 0
  const PAD = inp.wrap ? Math.ceil(LUT_N / 4 / G) + 2 : 0;
  const GW = GW0 + 2 * PAD;
  const key = `${GW}x${GH}`;
  let sc = scratch.get(key);
  if (!sc) scratch.set(key, (sc = { label: new Int16Array(GW * GH), dist: new Float32Array(GW * GH) }));
  const { label, dist } = sc;

  // ---- 粗网格上的归属 ----
  const half = G >> 1;
  for (let gy = 0; gy < GH; gy++) {
    const py = Math.min(h - 1, gy * G + half);
    const wy = Math.min(H - 1, gy * 2 + 1);
    for (let gx = 0; gx < GW; gx++) {
      // 这一列对应主图上的第几列粗格(接上去的列取另一头)
      const cx = PAD ? (gx - PAD + GW0) % GW0 : gx;
      if (lab) {
        const v = lab[wy * W + Math.min(W - 1, cx * 2 + 1)];
        label[gy * GW + gx] = v === -2 ? WATER : v;
        continue;
      }
      const px = Math.min(w - 1, cx * G + half);
      const r = pixRegion[py * w + px];
      label[gy * GW + gx] = r < 0 ? WATER : owner[r];
    }
  }
  // ---- 离边界的距离(粗网格单位):两块不同归属的陆地相邻处为 0 ----
  const INF = 1e6;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const k = gy * GW + gx;
      const l = label[k];
      let src = false;
      if (l !== WATER) {
        const a = gx > 0 ? label[k - 1] : l;
        const b = gx < GW - 1 ? label[k + 1] : l;
        const c = gy > 0 ? label[k - GW] : l;
        const d = gy < GH - 1 ? label[k + GW] : l;
        src =
          (a !== l && a !== WATER) || (b !== l && b !== WATER) || (c !== l && c !== WATER) || (d !== l && d !== WATER);
      }
      dist[k] = src ? 0.5 : INF;
    }
  }
  const D = Math.SQRT2;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const k = gy * GW + gx;
      let v = dist[k];
      if (gx > 0 && dist[k - 1] + 1 < v) v = dist[k - 1] + 1;
      if (gy > 0) {
        if (dist[k - GW] + 1 < v) v = dist[k - GW] + 1;
        if (gx > 0 && dist[k - GW - 1] + D < v) v = dist[k - GW - 1] + D;
        if (gx < GW - 1 && dist[k - GW + 1] + D < v) v = dist[k - GW + 1] + D;
      }
      dist[k] = v;
    }
  }
  for (let gy = GH - 1; gy >= 0; gy--) {
    for (let gx = GW - 1; gx >= 0; gx--) {
      const k = gy * GW + gx;
      let v = dist[k];
      if (gx < GW - 1 && dist[k + 1] + 1 < v) v = dist[k + 1] + 1;
      if (gy < GH - 1) {
        if (dist[k + GW] + 1 < v) v = dist[k + GW] + 1;
        if (gx < GW - 1 && dist[k + GW + 1] + D < v) v = dist[k + GW + 1] + D;
        if (gx > 0 && dist[k + GW - 1] + D < v) v = dist[k + GW - 1] + D;
      }
      dist[k] = v;
    }
  }

  // ---- 浓淡查表(按全分辨率像素距离,步长 1/4 像素) ----
  const paint = style === 'fantasy';
  const lut = new Float32Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const d = i / 4;
    lut[i] = paint
      ? polity
        ? PAINT_POL_FILL + PAINT_POL_EDGE * Math.exp(-d / PAINT_POL_EDGE_W)
        : PAINT_FILL + PAINT_EDGE * Math.exp(-d / PAINT_EDGE_W)
      : polity
        ? REAL_POL_FILL + REAL_POL_EDGE * Math.exp(-d / REAL_POL_EDGE_W)
        : REAL_FILL + REAL_EDGE * Math.exp(-d / REAL_EDGE_W);
  }
  const gr = paint ? grain() : null;
  const hard = ink?.hard;
  const soft = ink?.soft;
  const keepOut = inp.keepOut;

  // ---- 逐像素上色 ----
  const off = f >> 1;
  const inv = f / G;
  for (let y = 0; y < H; y++) {
    const py = Math.min(h - 1, y * f + off);
    const gyf = Math.max(0, (y + 0.5) * inv - 0.5);
    const gy0 = Math.min(GH - 1, Math.floor(gyf));
    const gy1 = Math.min(GH - 1, gy0 + 1);
    const ty = gyf - gy0;
    const row0 = gy0 * GW;
    const row1 = gy1 * GW;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const px = Math.min(w - 1, x * f + off);
      const r = pixRegion[py * w + px];
      const c = lab ? lab[y * W + x] : r < 0 ? -1 : owner[r];
      if (c < 0) {
        out[o + 3] = 0;
        continue;
      }
      const gxf = Math.max(0, (x + 0.5) * inv - 0.5 + PAD);
      const gx0 = Math.min(GW - 1, Math.floor(gxf));
      const gx1 = Math.min(GW - 1, gx0 + 1);
      const tx = gxf - gx0;
      const d0 = dist[row0 + gx0] + (dist[row0 + gx1] - dist[row0 + gx0]) * tx;
      const d1 = dist[row1 + gx0] + (dist[row1 + gx1] - dist[row1 + gx0]) * tx;
      const dpx = (d0 + (d1 - d0) * ty) * G; // 全分辨率像素
      const li = dpx * 4;
      const ii = li < LUT_N - 1 ? li | 0 : LUT_N - 1;
      let a = lut[ii];
      let cr = colors[c * 3];
      let cg = colors[c * 3 + 1];
      let cb = colors[c * 3 + 2];
      if (gr) {
        a *= 1 - GRAIN / 2 + GRAIN * gr[(py & (GRAIN_N - 1)) * GRAIN_N + (px & (GRAIN_N - 1))];
        if (!polity && dpx < PAINT_RIM_W * 2) {
          // 边缘水痕:颜料积在晕染的边上,颜色深一点
          const t = Math.max(0, 1 - dpx / (PAINT_RIM_W * 2));
          const k = 1 - (1 - PAINT_RIM_DARK) * t;
          cr *= k;
          cg *= k;
          cb *= k;
          a += PAINT_RIM_ALPHA * t;
        }
      } else if (!polity && dpx < REAL_LINE_W * 2) {
        // 写实:紧贴边界一道细细的本色描边,底下地形颜色再花也认得出是哪一族
        const t = Math.max(0, 1 - dpx / (REAL_LINE_W * 2));
        a += (REAL_LINE_ALPHA - a) * t;
      }
      if (fade && r >= 0) a *= fade[r];
      if (keepOut) keepOut[o + 3] = 255 * (1 - SYM_KEEP[ii]);
      if (hard && soft) {
        // 给符号让位:墨线全让开;林块、山的纸色底往国土里让开,紧贴边界的色带留着
        const q = py * w + px;
        const give = (hard[q] + soft[q] * (1 - SYM_KEEP[ii])) / 255;
        a *= give >= 1 ? 0 : 1 - give;
      }
      out[o] = cr;
      out[o + 1] = cg;
      out[o + 2] = cb;
      out[o + 3] = a * 255;
    }
  }
}

/**
 * 工作分辨率的归属图:像素 → 州 → 归属(−2 水、−1 无);给了界线就把离界线不远的像素按界线的哪一侧重新判(bandLabels)。
 * 纯计算,测试里用它核对"色块和国界严丝合缝"。
 */
export function labelImage(
  w: number,
  h: number,
  f: number,
  scale: number,
  pixRegion: Int16Array,
  owner: Int16Array,
  lines: Parameters<typeof bandLabels>[5] | null,
  out: Int16Array,
  /** 世界东西相连的周期(世界宽度;0 = 不相连):伸出主图左右边的界线在另一边也判 */
  wrap = 0,
): Int16Array {
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const off = f >> 1;
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, y * f + off) * w;
    for (let x = 0; x < W; x++) {
      const r = pixRegion[row + Math.min(w - 1, x * f + off)];
      out[y * W + x] = r < 0 ? -2 : owner[r];
    }
  }
  if (lines) bandLabels(out, W, H, f, scale, lines, wrap);
  return out;
}

// ---- 画到叠加层上 ----

interface Buf {
  f: number;
  img: ImageData;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  label: Int16Array;
  /** 弯边投影(手绘)用的让位系数图(见 WashInput.keepOut) */
  keep?: { img: ImageData; canvas: HTMLCanvasElement | OffscreenCanvas };
  /**
   * 画布里现在是哪一版(同一年、同一层、同样的画法):弯边投影换中心时、
   * 主图的文明层和地球仪的文明贴图各要一次同一年的色块时,都不用重算
   */
  key?: string;
}
interface LayerLook {
  colors: Uint8Array;
  since: Float32Array;
  fade: Float32Array;
}
interface Cache {
  raster: Raster;
  pix: Int16Array;
  own: Owners;
  looks: [LayerLook, LayerLook];
  bufs: Map<number, Buf>;
}
const caches = new WeakMap<Civ, Cache>();

function lookOf(list: { color: [number, number, number] }[], R: number): LayerLook {
  const colors = new Uint8Array(Math.max(1, list.length) * 3);
  list.forEach((e, i) => colors.set(e.color, i * 3));
  return { colors, since: new Float32Array(R), fade: new Float32Array(R) };
}

function cacheOf(p: CivDrawParams): Cache {
  const { civ, raster, world } = p;
  let c = caches.get(civ);
  if (!c || c.raster !== raster) {
    const R = civ.regions.count;
    c = {
      raster,
      pix: pixelRegions(world.mesh, raster, civ.regions.of),
      own: { culture: new Int16Array(R), polity: new Int16Array(R) },
      looks: [lookOf(civ.cultures, R), lookOf(civ.polities, R)],
      bufs: new Map(),
    };
    caches.set(civ, c);
  }
  return c;
}

/** slot:同样大小的画布分开存几份(地球仪按自己的让位遮罩画的那份单独一份,不和主图的抢) */
function bufOf(c: Cache, f: number, slot = f): Buf {
  let b = c.bufs.get(slot);
  if (!b) {
    const W = Math.ceil(c.raster.w / f);
    const H = Math.ceil(c.raster.h / f);
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(W, H)
        : Object.assign(document.createElement('canvas'), { width: W, height: H });
    b = { f, img: new ImageData(W, H), canvas, label: new Int16Array(W * H) };
    c.bufs.set(slot, b);
  }
  return b;
}

/** 州 → 渐入系数:最近 FADE_YEARS 年里才归属这一层的州按年份渐入,其余为 1 */
export function fadeIn(civ: Civ, year: number, since: Float32Array, out: Float32Array, layer: Layer = Layer.Culture): Float32Array {
  recentChanges(civ, layer, year, FADE_YEARS, since);
  for (let r = 0; r < out.length; r++) {
    const s = since[r];
    out[r] = s === -Infinity ? 1 : Math.min(1, Math.max(0, (year - s) / FADE_YEARS));
  }
  return out;
}

/** 这一帧铺哪一层:民族打开就铺民族(国家只画国界),只开国家就铺国土 */
export function washLayer(p: CivDrawParams): Layer | null {
  if (p.show.cultures && p.civ.cultures.length) return Layer.Culture;
  if (p.show.polities && p.civ.polities.length) return Layer.Polity;
  return null;
}

/** 手绘风:符号"让位"遮罩(每张地图算一次,之后每帧直接用) */
function inkOf(p: CivDrawParams): InkMask | null {
  return p.style === 'fantasy' ? fantasyInkMask(p.world, p.raster, SYM_FOREST, SYM_PAPER) : null;
}

export function drawTerritory(ctx: CanvasRenderingContext2D, p: CivDrawParams): void {
  const layer = washLayer(p);
  if (layer === null) return;
  const { civ, raster } = p;
  const c = cacheOf(p);
  const f = p.fast ? 2 : 1;
  // 地球仪的文明贴图 · 手绘:按地球仪贴图的符号层让位(单独一份画布,不和主图的抢)
  const globeInk = !!p.globeInk && p.style === 'fantasy' && !p.proj;
  const b = bufOf(c, f, globeInk ? f + 10 : f);
  // 弯边投影 · 手绘:符号遮罩按投影后的符号层合成,色块本身不乘遮罩
  const projInk = !!p.proj && p.style === 'fantasy';
  if (projInk && !b.keep) {
    const W = b.img.width;
    const H = b.img.height;
    b.keep = {
      img: new ImageData(W, H),
      canvas: typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }),
    };
  }
  const key = `${layer}|${p.year}|${p.style}|${projInk ? 1 : 0}`;
  if (b.key !== key) {
    const own = ownersAt(civ, p.year, c.own);
    const owner = layer === Layer.Culture ? own.culture : own.polity;
    const look = c.looks[layer];
    const wrap = meshWrap(p.world.mesh);
    labelImage(raster.w, raster.h, f, raster.scale, c.pix, owner, borderLines(p, layer), b.label, wrap);
    washPixels(
      {
        w: raster.w,
        h: raster.h,
        f,
        pixRegion: c.pix,
        owner,
        colors: look.colors,
        fade: fadeIn(civ, p.year, look.since, look.fade, layer),
        style: p.style,
        label: b.label,
        polity: layer === Layer.Polity,
        ink: projInk ? null : globeInk ? fantasyGlobeInkMask(p.world, p.raster, SYM_FOREST, SYM_PAPER) : inkOf(p),
        wrap: wrap > 0,
        keepOut: projInk ? b.keep!.img.data : undefined,
      },
      b.img.data,
    );
    const bctx = b.canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    bctx.putImageData(b.img, 0, 0);
    if (projInk) (b.keep!.canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(b.keep!.img, 0, 0);
    b.key = key;
  }
  if (p.proj) {
    drawWashProjected(ctx, p, b, projInk);
    return;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(b.canvas, 0, 0, raster.w, raster.h);
  ctx.restore();
}

/** 合成用的几张地图平面大小的草稿画布(按大小留一套) */
let washScratch: { w: number; h: number; a: HTMLCanvasElement | OffscreenCanvas; k: HTMLCanvasElement | OffscreenCanvas; g: HTMLCanvasElement | OffscreenCanvas } | null = null;

/** 回到等距圆柱时释放合成用的草稿画布 */
export function releaseWashScratch(): void {
  if (!washScratch) return;
  washScratch.a.width = washScratch.a.height = washScratch.k.width = washScratch.k.height = washScratch.g.width = washScratch.g.height = 0;
  washScratch = null;
}

function scratchCanvases(w: number, h: number) {
  if (washScratch && washScratch.w === w && washScratch.h === h) return washScratch;
  const mk = () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
  if (washScratch) washScratch.a.width = washScratch.a.height = washScratch.k.width = washScratch.k.height = washScratch.g.width = washScratch.g.height = 0;
  washScratch = { w, h, a: mk(), k: mk(), g: mk() };
  return washScratch;
}

/**
 * 弯边投影:色块(等距圆柱算好的那张)按行重投影到地图平面上。
 * 手绘风还要给地形符号"让位"(和等距圆柱一样的算法,只是按投影后的符号层):
 *   让位 = hard + soft × (1 − SYM_KEEP(离边界的距离)),色块透明度 × (1 − 让位)。
 *   hard / soft 来自投影后的符号层(fantasy.ts 的 fantasyInkProj),(1 − SYM_KEEP) 是 washPixels 顺手写的那张图(同样重投影过来),
 *   在显卡上合成:soft ∩ keep(destination-in 相乘)→ 加上 hard(lighter 相加)→ 从色块里挖掉(destination-out)
 */
function drawWashProjected(ctx: CanvasRenderingContext2D, p: CivDrawParams, b: Buf, projInk: boolean) {
  const mp = p.proj!.mp;
  const v = { s: p.raster.scale, ox: 0, oy: 0 };
  const sw = b.canvas.width;
  const sh = b.canvas.height;
  if (!projInk) {
    reprojectImage(ctx, b.canvas, sw, sh, mp, v);
    return;
  }
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const sc = scratchCanvases(W, H);
  const A = sc.a.getContext('2d') as CanvasRenderingContext2D;
  const K = sc.k.getContext('2d') as CanvasRenderingContext2D;
  const G = sc.g.getContext('2d') as CanvasRenderingContext2D;
  for (const g of [A, K, G]) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
  }
  reprojectImage(A, b.canvas, sw, sh, mp, v);
  reprojectImage(K, b.keep!.canvas, sw, sh, mp, v);
  const ink = fantasyInkProj(p.world, p.raster, mp, SYM_FOREST, SYM_PAPER);
  G.drawImage(ink.soft, 0, 0, W, H);
  G.globalCompositeOperation = 'destination-in';
  G.drawImage(sc.k, 0, 0);
  G.globalCompositeOperation = 'lighter';
  G.drawImage(ink.hard, 0, 0, W, H);
  G.globalCompositeOperation = 'source-over';
  A.globalCompositeOperation = 'destination-out';
  A.drawImage(sc.g, 0, 0);
  A.globalCompositeOperation = 'source-over';
  ctx.drawImage(sc.a, 0, 0);
}
