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
import { bandLabels, borderLines, type SidedLine } from './borders';
import { meshWrap } from './lines';
import { fantasyGlobeInkMask, fantasyInkMask, fantasyInkProj, inkFromPixels, type InkMask } from '../fantasy';
import { coastBlocks, KEEP, landCover, nearestCellPixel, nearestSide, type DetailGrid, type SegIndex } from './zoomGrid';
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
  /** 离边界的距离(edgeField 算好的;不给就现算) */
  edge?: EdgeField;
}

/**
 * 离边界的距离(粗网格,格宽 G = 2f 个全分辨率像素):两块不同归属的陆地相邻处约 0.5 格,往里按倒角距离增大。
 * 东西相连时左右各多接 PAD 列(另一头的列)。取样:全分辨率坐标 (px, py)(像素中心 = 整数 + 0.5)对应
 * 网格的 (px / G − 0.5 + PAD, py / G − 0.5),双线性插值,× G = 全分辨率像素
 */
export interface EdgeField {
  G: number;
  GW: number;
  GH: number;
  PAD: number;
  /** 粗网格上的归属(−2 水) */
  label: Int16Array;
  dist: Float32Array;
}

const scratch = new Map<string, EdgeField>();

/**
 * 算离边界的距离(见 EdgeField)。out 给了且大小对就写进它,否则按大小用一份共用的草稿(下一次同样大小的调用会覆盖)
 */
export function edgeField(inp: WashInput, out?: EdgeField | null): EdgeField {
  const { w, h, f, pixRegion, owner, label: lab } = inp;
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const G = 2 * f;
  const GW0 = Math.ceil(w / G);
  const GH = Math.ceil(h / G);
  // 东西相连:粗网格左右各多接 PAD 列(另一头的列),距离算完只用中间那段 —— 离边界的距离左右相通。
  // 浓淡查表最远 64 像素,接的长度够用就行;不相连时 PAD = 0
  const PAD = inp.wrap ? Math.ceil(LUT_N / 4 / G) + 2 : 0;
  const GW = GW0 + 2 * PAD;
  let sc: EdgeField;
  if (out && out.GW === GW && out.GH === GH && out.G === G) sc = out;
  else if (out) sc = { G, GW, GH, PAD, label: new Int16Array(GW * GH), dist: new Float32Array(GW * GH) };
  else {
    const key = `${GW}x${GH}x${G}`;
    let s0 = scratch.get(key);
    if (!s0) scratch.set(key, (s0 = { G, GW, GH, PAD, label: new Int16Array(GW * GH), dist: new Float32Array(GW * GH) }));
    sc = s0;
  }
  sc.PAD = PAD;
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
  return sc;
}

/** 浓淡查表(按全分辨率像素距离,步长 1/4 像素):不透明度 0–1 */
export function washLut(style: CivStyle, polity: boolean): Float32Array {
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
  return lut;
}

/**
 * 把一层归属画成 RGBA(工作分辨率 ⌈w/f⌉ × ⌈h/f⌉,不预乘)。
 * 离边界的距离在更粗一倍的网格上算(两遍倒角距离,见 edgeField),再双线性插值。
 */
export function washPixels(inp: WashInput, out: Uint8ClampedArray): void {
  const { w, h, f, pixRegion, owner, colors, fade, style, label: lab, polity, ink } = inp;
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const { G, GW, GH, PAD, dist } = inp.edge ?? edgeField(inp);

  // ---- 浓淡查表(按全分辨率像素距离,步长 1/4 像素) ----
  const paint = style === 'fantasy';
  const lut = washLut(style, !!polity);
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

// ---- 放大后的细节层:按屏幕像素逐点上色(render/civ/detail.ts) ----

/**
 * 细节层的水痕、写实描边:紧贴界线最浓(× PEAK)、离线 D × pen 个全分辨率像素处淡到没有。
 * 整张图上这两样按粗网格的距离算(离线约 1 个像素起),峰值和宽度照它取,缩放 1.2 倍附近看上去一样
 */
const DETAIL_RIM_PEAK = 0.55;
const DETAIL_RIM_D = 1.25;
const DETAIL_LINE_PEAK = 0.5;
const DETAIL_LINE_D = 0.9;

/** 细节层的水痕 / 描边离界线最远多少(全分辨率像素,pen = 1 时) */
export const DETAIL_EDGE_D = Math.max(DETAIL_RIM_D, DETAIL_LINE_D);

/** 手绘:符号层的像素 → 让位遮罩(和整张图同一套分档,见 fantasy.ts 的 fantasyInkMask) */
export function inkFromSymbols(px: Uint8ClampedArray, N: number): InkMask {
  return inkFromPixels(px, N, SYM_FOREST, SYM_PAPER);
}

/**
 * 细节层的色块(和 washPixels 同一套画法,只是逐个工作格算,边按界线、海岸按岸线,放大多少倍都是顺滑的):
 *   - 归属:工作分辨率的归属图(washFields)取最近的那一格;离界线不远的(segs 网格里有线段的格)按在线的哪一侧判 ——
 *     色块的边就是画出来的那条界线
 *   - 海岸:水陆都有的像素块按岸线算覆盖度(landCover),边是抗锯齿的
 *   - 浓淡、纸纹、渐入:粗网格的距离、纸纹双线性插值(放大后是平滑的晕染,不是方块)
 *   - 水痕(手绘民族)、本色描边(写实民族):按离界线的真实距离,宽度 × pen(按屏幕大小)
 *   - 给符号让位(手绘):ink = 这一块按细节层同样的缩放画的符号层算出的遮罩(工作分辨率),和地形细节层的符号对得上
 * out = gw × gh 的 RGBA(不预乘)
 */
export function washDetail(
  out: Uint8ClampedArray,
  g: DetailGrid,
  r: Raster,
  mesh: Mesh,
  fl: WashFields,
  style: CivStyle,
  segs: SegIndex | null,
  ink: InkMask | null,
  pen: number,
): void {
  const { w, h, scale: S } = r;
  const W = w / S;
  const H = h / S;
  // 界线管不到的边(全分辨率归属图才做):按离哪个地块中心最近判(nearestCellPixel)
  const ks = new Int32Array(4);
  const blocks = coastBlocks(r);
  const { label: lab, W: LW, H: LH, f, fade, fading, colors, polity, pix, owner } = fl;
  const { G, GW, GH, PAD, dist } = fl.edge;
  const off = f >> 1;
  const paint = style === 'fantasy';
  const lut = washLut(style, polity);
  const gr = paint ? grain() : null;
  const hard = ink?.hard;
  const soft = ink?.soft;
  // 水痕 / 描边的宽度(世界单位)
  const rimW = (DETAIL_RIM_D * pen) / S;
  const lineW = (DETAIL_LINE_D * pen) / S;
  const side = new Int32Array(1);
  const { gw, gh } = g;
  // 归属图最近的一格:x = ⌊(rx + lxOff) / f⌋(像素中心对齐,同 labelImage 的取样点)
  const lxOff = f / 2 - off - 0.5;
  for (let j = 0; j < gh; j++) {
    const row = j * gw * 4;
    const i0 = g.i0[j];
    const i1 = g.i1[j];
    out.fill(0, row, row + i0 * 4);
    out.fill(0, row + i1 * 4, row + gw * 4);
    if (i1 <= i0) continue;
    const wy = g.wy[j];
    const ry = wy * S;
    // 双线性取样的上下两行(像素中心 = 整数 + 0.5)
    const vy = Math.min(h - 1, Math.max(0, ry - 0.5));
    const y0 = Math.min(h - 1, Math.floor(vy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = vy - y0;
    const row0 = y0 * w;
    const row1 = y1 * w;
    // 归属图(工作分辨率 f)最近的一行
    const lrow = Math.min(LH - 1, Math.max(0, Math.floor((ry + lxOff) / f))) * LW;
    // 粗网格(距离)
    const gyf = Math.min(GH - 1, Math.max(0, ry / G - 0.5));
    const gy0 = Math.floor(gyf);
    const gy1 = Math.min(GH - 1, gy0 + 1);
    const ty = gyf - gy0;
    const drow0 = gy0 * GW;
    const drow1 = gy1 * GW;
    // 纸纹(128² 平铺,按全分辨率像素)
    const gvy = ry - 0.5;
    const gyi = Math.floor(gvy);
    const gry0 = (gyi & (GRAIN_N - 1)) * GRAIN_N;
    const gry1 = ((gyi + 1) & (GRAIN_N - 1)) * GRAIN_N;
    const gty = gvy - gyi;
    // 界线索引:这一行在第几行格(不在网格里 = 不查)
    const scy = segs ? Math.floor((wy - segs.oy) / segs.cs) : -1;
    const segRow = segs && scy >= 0 && scy < segs.ny ? scy * segs.nx : -1;
    const rpp = g.u[j] * S;
    const b0 = g.b[j];
    const drx = b0 * S;
    const lat = Math.PI / 2 - (wy / H) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    let wx = g.a[j] + b0 * i0;
    let rx = wx * S;
    rx -= w * Math.floor(rx / w);
    for (let i = i0; i < i1; i++, wx += b0, rx += drx) {
      if (rx >= w) rx -= w;
      const o = row + i * 4;
      // 海岸:这一点所在的 2×2 像素块
      const vx = rx - 0.5;
      let x0 = Math.floor(vx);
      const fx = vx - x0;
      if (x0 < 0) x0 += w;
      const x1 = x0 + 1 < w ? x0 + 1 : 0;
      const blk = blocks[row0 + x0];
      if (blk === 2) {
        out[o + 3] = 0;
        continue;
      }
      let cov = 1;
      if (blk === 1) {
        cov = landCover(r, row0 + x0, row0 + x1, row1 + x0, row1 + x1, fx, fy, rpp);
        if (cov <= 0) {
          out[o + 3] = 0;
          continue;
        }
      }
      // 归属:最近的那一格;落在水里(岸边)就取旁边一格陆地的
      let lx = Math.floor((rx + lxOff) / f);
      if (lx >= LW) lx -= LW;
      else if (lx < 0) lx += LW;
      let c = lab[lrow + lx];
      if (c === -2) c = landNear(lab, LW, LH, lx, lrow / LW, (rx - off - 0.5) / f, (ry - off - 0.5) / f);
      // 离界线不远:按在线的哪一侧判,顺便量出离线多远
      let dl = Infinity;
      let byLine = false;
      if (segRow >= 0) {
        const scx = Math.floor((wx - segs!.ox) / segs!.cs);
        if (scx >= 0 && scx < segs!.nx) {
          const cell = segRow + scx;
          if (segs!.start[cell] !== segs!.start[cell + 1]) {
            dl = nearestSide(segs!, cell, wx, wy, side);
            if (dl < Infinity && side[0] !== KEEP) {
              c = side[0];
              byLine = true;
            }
          }
        }
      }
      if (!byLine && f === 1) {
        // 界线管不到、这一块里归属又不一样:按离哪个地块中心最近判
        const la = lab[row0 + x0];
        const lb = lab[row0 + x1];
        const lc = lab[row1 + x0];
        const ld = lab[row1 + x1];
        // 只管归属图按州原样的地方(海岸断头外面、借邻州的岸边像素):按界线改判过的(离线 BAND 以内)不动,免得在线边上起小斑点
        if (
          (la !== lb || la !== lc || la !== ld) &&
          la === rawLabel(pix, owner, row0 + x0) &&
          lb === rawLabel(pix, owner, row0 + x1) &&
          lc === rawLabel(pix, owner, row1 + x0) &&
          ld === rawLabel(pix, owner, row1 + x1)
        ) {
          ks[0] = row0 + x0;
          ks[1] = row0 + x1;
          ks[2] = row1 + x0;
          ks[3] = row1 + x1;
          const lon = (wx / W) * 2 * Math.PI - Math.PI;
          const v = lab[ks[nearestCellPixel(mesh, r.cell, ks, cl, sl, lon)]];
          if (v !== -2) c = v;
        }
      }
      if (c < 0) {
        out[o + 3] = 0;
        continue;
      }
      // 离边界的距离(粗网格双线性 → 全分辨率像素)
      let gxf = rx / G - 0.5 + PAD;
      if (gxf < 0) gxf = 0;
      else if (gxf > GW - 1) gxf = GW - 1;
      const gx0 = gxf | 0;
      const gx1 = gx0 + 1 < GW ? gx0 + 1 : gx0;
      const tx = gxf - gx0;
      const d0 = dist[drow0 + gx0] + (dist[drow0 + gx1] - dist[drow0 + gx0]) * tx;
      const d1 = dist[drow1 + gx0] + (dist[drow1 + gx1] - dist[drow1 + gx0]) * tx;
      const li = (d0 + (d1 - d0) * ty) * G * 4;
      const ii = li < LUT_N - 1 ? li | 0 : LUT_N - 1;
      let a = lut[ii];
      let cr = colors[c * 3];
      let cg = colors[c * 3 + 1];
      let cb = colors[c * 3 + 2];
      if (gr) {
        const gxi = Math.floor(vx);
        const grx0 = gxi & (GRAIN_N - 1);
        const grx1 = (gxi + 1) & (GRAIN_N - 1);
        const ga = gr[gry0 + grx0] + (gr[gry0 + grx1] - gr[gry0 + grx0]) * fx;
        const gb = gr[gry1 + grx0] + (gr[gry1 + grx1] - gr[gry1 + grx0]) * fx;
        a *= 1 - GRAIN / 2 + GRAIN * (ga + (gb - ga) * gty);
        if (!polity && dl < rimW) {
          // 边缘水痕:颜料积在晕染的边上,颜色深一点(宽度按屏幕大小)
          const t = DETAIL_RIM_PEAK * (1 - dl / rimW);
          const k = 1 - (1 - PAINT_RIM_DARK) * t;
          cr *= k;
          cg *= k;
          cb *= k;
          a += PAINT_RIM_ALPHA * t;
        }
      } else if (!polity && dl < lineW) {
        // 写实:紧贴边界一道细细的本色描边
        const t = DETAIL_LINE_PEAK * (1 - dl / lineW);
        a += (REAL_LINE_ALPHA - a) * t;
      }
      if (fading) {
        // 渐入按州,州和州之间双线性过渡(不在州界上起台阶)
        const ra = pix[row0 + x0];
        const rb = pix[row0 + x1];
        const rc = pix[row1 + x0];
        const rd = pix[row1 + x1];
        if (ra === rb && ra === rc && ra === rd) {
          if (ra >= 0) a *= fade[ra];
        } else {
          const wa = ra >= 0 ? (1 - fx) * (1 - fy) : 0;
          const wb = rb >= 0 ? fx * (1 - fy) : 0;
          const wc = rc >= 0 ? (1 - fx) * fy : 0;
          const wd = rd >= 0 ? fx * fy : 0;
          const sw = wa + wb + wc + wd;
          if (sw > 0) a *= ((ra >= 0 ? fade[ra] * wa : 0) + (rb >= 0 ? fade[rb] * wb : 0) + (rc >= 0 ? fade[rc] * wc : 0) + (rd >= 0 ? fade[rd] * wd : 0)) / sw;
        }
      }
      if (hard && soft) {
        const q = j * gw + i;
        const give = (hard[q] + soft[q] * (1 - SYM_KEEP[ii])) / 255;
        a *= give >= 1 ? 0 : 1 - give;
      }
      out[o] = cr;
      out[o + 1] = cg;
      out[o + 2] = cb;
      out[o + 3] = a * cov * 255;
    }
  }
}

/** 像素 k 按州原样的归属(水 = −2,同 labelImage 没改判时) */
function rawLabel(pix: Int16Array, owner: Int16Array, k: number): number {
  const r = pix[k];
  return r < 0 ? -2 : owner[r];
}

/**
 * 归属图上 (x, y) 是水(岸边的工作格):取周围 3×3 里离这一点最近的一格陆地。
 * (px, py) = 这一点在归属图上的坐标(格子中心 = 整数)
 */
function landNear(lab: Int16Array, W: number, H: number, x: number, y: number, px: number, py: number): number {
  let best = Infinity;
  let v = -2;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -1; dx <= 1; dx++) {
      let xx = x + dx;
      if (xx < 0) xx += W;
      else if (xx >= W) xx -= W;
      const l = lab[yy * W + xx];
      if (l === -2) continue;
      const ex = x + dx - px;
      const ey = yy - py;
      const d = ex * ex + ey * ey;
      if (d < best) {
        best = d;
        v = l;
      }
    }
  }
  return v;
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
  /** 归属图 + 离边界的距离,每种工作分辨率一份(见 washFields) */
  fields: Map<number, WashFields>;
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
      fields: new Map(),
    };
    caches.set(civ, c);
  }
  return c;
}

/** 像素 → 州(全分辨率,水 = −1;按 civ 缓存,和色块用的是同一份) */
export function regionPixels(world: CivDrawParams['world'], raster: Raster, civ: Civ): Int16Array {
  return cacheOf({ world, raster, civ } as CivDrawParams).pix;
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
    b = { f, img: new ImageData(W, H), canvas };
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

/**
 * 某一年、某一层铺色块要用的数据(整图的色块和放大后的细节层共用,按"层 + 年份 + 画风"缓存,每种工作分辨率一份):
 * 工作分辨率(⌈w/f⌉ × ⌈h/f⌉)的归属图(按界线改判过,见 labelImage)、离边界的距离(edgeField)、
 * 州 → 归属 / 渐入系数(拷贝,不怕别处改)、颜色、界线
 */
export interface WashFields {
  key: string;
  layer: Layer;
  f: number;
  /** 工作分辨率的归属图:−2 水、−1 无、≥ 0 归属 */
  label: Int16Array;
  W: number;
  H: number;
  edge: EdgeField;
  owner: Int16Array;
  fade: Float32Array;
  /** 有没有正在渐入的州(没有就不用逐点查) */
  fading: boolean;
  colors: Uint8Array;
  lines: SidedLine[];
  polity: boolean;
  /** 像素 → 州(全分辨率,水 = −1) */
  pix: Int16Array;
}

export function washFields(p: CivDrawParams, f: number): WashFields | null {
  const layer = washLayer(p);
  if (layer === null) return null;
  const { civ, raster } = p;
  const c = cacheOf(p);
  const key = `${layer}|${p.year}|${p.style}`;
  const old = c.fields.get(f);
  if (old?.key === key) return old;
  const W = Math.ceil(raster.w / f);
  const H = Math.ceil(raster.h / f);
  const own = ownersAt(civ, p.year, c.own);
  const owner = Int16Array.from(layer === Layer.Culture ? own.culture : own.polity);
  const look = c.looks[layer];
  const fade = Float32Array.from(fadeIn(civ, p.year, look.since, look.fade, layer));
  let fading = false;
  for (let r = 0; r < fade.length && !fading; r++) fading = fade[r] < 1;
  const wrap = meshWrap(p.world.mesh);
  const lines = borderLines(p, layer);
  const label = old && old.label.length === W * H ? old.label : new Int16Array(W * H);
  labelImage(raster.w, raster.h, f, raster.scale, c.pix, owner, lines, label, wrap);
  const edge = edgeField({ w: raster.w, h: raster.h, f, pixRegion: c.pix, owner, colors: look.colors, style: p.style, label, wrap: wrap > 0 }, old?.edge ?? {
    G: 0,
    GW: 0,
    GH: 0,
    PAD: 0,
    label: new Int16Array(0),
    dist: new Float32Array(0),
  });
  const out: WashFields = { key, layer, f, label, W, H, edge, owner, fade, fading, colors: look.colors, lines, polity: layer === Layer.Polity, pix: c.pix };
  c.fields.set(f, out);
  return out;
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
    const fl = washFields(p, f)!;
    washPixels(
      {
        w: raster.w,
        h: raster.h,
        f,
        pixRegion: c.pix,
        owner: fl.owner,
        colors: fl.colors,
        fade: fl.fade,
        style: p.style,
        label: fl.label,
        polity: fl.polity,
        ink: projInk ? null : globeInk ? fantasyGlobeInkMask(p.world, p.raster, SYM_FOREST, SYM_PAPER) : inkOf(p),
        wrap: fl.edge.PAD > 0,
        keepOut: projInk ? b.keep!.img.data : undefined,
        edge: fl.edge,
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
