/**
 * 奇幻手绘风格:羊皮纸、墨线海岸、波纹、手绘山峰与树林符号 —— 按"世界地图集"的尺度画:
 * 全图时符号小而密(山脉读成一条山链、树林读成一片林区),放大后符号逐级变大、细节变多(render/detail.ts 按视口重画)。
 *
 * 分两层:
 * - 像素层(fantasyBase):纸、水彩、海(按深浅)、海冰、海岸墨线;每张地图算一次。
 *   放大后细节层拿不带海岸墨线、湖岸描边的那一份(fantasyBaseNoInk)当底图,这两样改画成矢量线(drawFantasyCoasts)
 * - 矢量层(drawFantasyVectors):林块、河流、山 / 丘陵 / 沙丘 / 草丛 / 火山。
 *   铺进地形图的是缩放 1 倍的那一份(fantasySymbolLayer,单独一张透明画布);放大后按视口、按缩放倍数重画
 * 文明层按符号层的形状给水彩"让位"(fantasyInkMask),国土、民族色块不把墨线和树林染脏。
 * 作者放的火山(阶段 4 改地形,world.volcanoes)在峰顶画一座冒烟的火山,周围不再放普通的山。
 *
 * 弯边投影(罗宾森、摩尔威德……)按投影重画:像素层换成不带海岸墨线的那一份(fantasyBaseNoInk)按行重投影,
 * 海岸墨线、湖岸改成逐点投影的矢量线(fantasyCoastLines、drawFantasyCoasts);矢量层按这种投影的符号规划(间距按投影后的距离留)
 * 在投影后的位置上正立、按屏幕大小画(drawFantasyVectors 的 v.proj);文明层按投影后的符号层"让位"(fantasyInkProj)。
 * 主图是等距圆柱投影、东西相连:像素层的邻域操作(距离变换、模糊、墨线梯度、冰缘)列下标取模,
 * 纸纹、水彩斑驳的噪声左右首尾相接;挨着左右边的符号、林块、河在另一边再画一份,树林的分块左右相接;
 * 符号的规划(间距、走向、坡度)按左右相连算。主图是一整圈星球、不是一页纸,所以纸边做旧和图框罗盘不烤进地形图,
 * 画在视窗上(drawFrame / drawPaperEdge,见 ui/MapDecor.tsx、导出)。
 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import { BIOMES, Biome } from '../gen/biomes';
import {
  bakedView,
  boxBlurWrap,
  distanceTo,
  drawRivers,
  hash2,
  hexRGB,
  hillshade,
  nearX,
  riverLod,
  rowCos,
  valueNoiseP,
  wrapCells,
  wrapOf,
  wrapShifts,
  type RGB,
  type RiverStyle,
  type VecView,
} from './common';
import { keyed, smoothstep, subSeed } from '../gen/util';
import { geometryOf } from '../gen/geometry';
import { addProjectedLine, clipOutline, glyphMetric, insideProj, outlineOnCanvas, projectLinePts, projector, relShifts, reprojectImage, type GlyphMetric, type MapProj, type Projector, type ProjectionId } from './projection';

const PAPER = hexRGB('#efe2c2');
const PAPER_EDGE = hexRGB('#c9ae7c');
const SEA = hexRGB('#8fabb0');
/** 大陆架(浅海):偏浅、偏绿一点的海色 */
const SEA_SHELF = hexRGB('#a8c2bd');
/** 海沟:最深的海色 */
const SEA_DEEP = hexRGB('#6f8f99');
const INK = hexRGB('#3a2d22');
const INK_CSS = 'rgba(58,45,34,';
/** 山 / 丘陵符号的底色(和 drawSymbols 里的 paper 一致) */
const GLYPH_PAPER: RGB = [236, 224, 193];
/** 雪:像羊皮纸上的留白,略带一点冷调(和纸色混合后接近符号底色) */
const SNOW_PAINT = hexRGB('#ebe6d8');
/** 雪地背光面的淡蓝灰晕染 */
const SNOW_SHADOW = hexRGB('#aebbc3');
/** 海冰:纸色上再提亮一点、略偏冷的淡灰白 */
const ICE_PAPER = hexRGB('#eef1ec');
/** 冰缘墨线:比海岸墨线偏冷、偏淡,一眼能和陆地岸线分开 */
const ICE_INK = hexRGB('#44525a');
/** 海冰背光边的排线色(淡蓝灰) */
const ICE_SHADOW = hexRGB('#8c9ea8');

/**
 * 缩放 k 倍时,符号(山、丘陵、树冠、墨线粗细)在世界坐标里的大小倍数。
 * k ≤ GLYPH_K0 时为 1(和全图铺进地形图的那一份一样大);之后按 (k / GLYPH_K0)^−GLYPH_SHRINK 收 ——
 * 屏幕上符号比地图放大得慢(放大 4 倍,符号约大 3 倍),空出来的地方由更高一级的符号补上。
 */
export const GLYPH_K0 = 1.35;
/** 放大后符号在世界坐标里收多快:屏幕上约按 k^(1 − 0.22) ≈ k^0.78 变大 */
const GLYPH_SHRINK = 0.22;
export function glyphScale(k: number): number {
  return k <= GLYPH_K0 ? 1 : Math.pow(k / GLYPH_K0, -GLYPH_SHRINK);
}
/** 符号分几级出现:第 t 级的符号从缩放 GLYPH_TIERS[t] 倍起画(第 0 级 = 全图就有) */
export const GLYPH_TIERS = [1, 2, 3.5, 6];

export function renderFantasy(ctx: CanvasRenderingContext2D, world: World, r: Raster) {
  ctx.drawImage(fantasyBase(world, r), 0, 0);
  ctx.drawImage(fantasySymbolLayer(world, r), 0, 0);
}

/**
 * 一批像素的原色(像素下标 + r, g, b):只记少数像素(约占全图百分之几到二十),要用时再拼回去(见 InkPatch)。
 * 颜色存成 0–255(写进去时和写进 ImageData 一样取整)
 */
export class PixelPatch {
  k = new Int32Array(4096);
  c = new Uint8ClampedArray(3 * 4096);
  n = 0;
  push(k: number, r: number, g: number, b: number): void {
    if (this.n === this.k.length) {
      const k2 = new Int32Array(this.n * 2);
      k2.set(this.k);
      const c2 = new Uint8ClampedArray(this.n * 6);
      c2.set(this.c);
      this.k = k2;
      this.c = c2;
    }
    const o = this.n * 3;
    this.k[this.n] = k;
    this.c[o] = r;
    this.c[o + 1] = g;
    this.c[o + 2] = b;
    this.n++;
  }
  /** 把这些像素写进 d(RGBA),不透明 */
  putInto(d: Uint8ClampedArray): void {
    const { k, c } = this;
    for (let i = 0; i < this.n; i++) {
      const o = k[i] * 4;
      d[o] = c[i * 3];
      d[o + 1] = c[i * 3 + 1];
      d[o + 2] = c[i * 3 + 2];
      d[o + 3] = 255;
    }
  }
}

/**
 * 墨线、波纹盖掉的像素原来是什么颜色。按投影重画、放大后的细节层要"不带墨线"的像素层(墨线改成矢量线,线宽处处一致、
 * 放大多少倍都顺滑):只记这些像素,要用时再拼出那一张(fantasyBaseNoInk、fantasyBaseClean)
 */
interface InkPatch {
  /** 海岸墨线(原色已乘纸纹;波纹、排线还在) */
  coast: PixelPatch;
  /** 湖岸描边 */
  lake: PixelPatch;
  /** 岸线外的波纹、近岸排线盖到的海面:这两样都没画时的颜色(海岸墨线也没画) */
  sea: PixelPatch;
  /**
   * 海冰:放大后冰缘改画成矢量线、冰面按这条线填色(drawFantasyIce),底图里不要冰缘墨线、背光边排线,
   * 冰缘带(iceBand)里的像素一律是没结冰的海色 —— 冰面那一侧另从 iceI 拼出的那一张取色。
   * 这里记下这些像素在这样的底图里的颜色(冰缘带 + 带背光边的冰面;墨线、波纹都没画)
   */
  iceW: PixelPatch;
  /** 冰缘带里的像素当冰面时的颜色(冰面色,不带背光边) */
  iceI: PixelPatch;
}

/**
 * 放大后按矢量画波纹、近岸排线要用的两张场(铺像素时顺带记下;画法见 drawFantasySeaLines)
 */
interface SeaFields {
  /** 每个像素离最近陆地的距离(像素,× DIST_Q / scale 存成整数,封顶约 16 格;陆地、湖 = 0) */
  dist: Uint16Array;
  /** 波纹、排线的浓淡倍数(0–255):冰区淡出(附近结冰越多越淡)× 没被海冰盖住的比例;陆地、湖、冰面 = 0 */
  fade: Uint8Array;
}
/** SeaFields.dist 的精度:每格分成多少份 */
export const DIST_Q = 4096;

/** 当前这张地图的像素层(只留一份,换了世界就释放) */
let base: { raster: Raster; canvas: AnyCanvas; patch: InkPatch; sea: SeaFields } | null = null;

/** 像素层:纸、水彩、海、海冰、海岸墨线、湖岸(不含符号、河流、图框) */
export function fantasyBase(world: World, r: Raster): AnyCanvas {
  if (base?.raster === r) return base.canvas;
  if (base) base.canvas.width = base.canvas.height = 0;
  const cv = makeCanvas(r.w, r.h);
  const patch: InkPatch = { coast: new PixelPatch(), lake: new PixelPatch(), sea: new PixelPatch(), iceW: new PixelPatch(), iceI: new PixelPatch() };
  const sea: SeaFields = { dist: new Uint16Array(r.w * r.h), fade: new Uint8Array(r.w * r.h) };
  paintBase(cv.getContext('2d') as CanvasRenderingContext2D, world, r, patch, sea);
  base = { raster: r, canvas: cv, patch, sea };
  return cv;
}

/** 像素层 src 上把 patches 记下的像素依次换回原色,拼成一张新画布 */
function patchedBase(src: AnyCanvas, r: Raster, patches: PixelPatch[]): AnyCanvas {
  const cv = makeCanvas(r.w, r.h);
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(src, 0, 0);
  const img = new ImageData(r.w, r.h);
  for (const p of patches) p.putInto(img.data);
  const tmp = makeCanvas(r.w, r.h);
  (tmp.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  tmp.width = tmp.height = 0;
  return cv;
}

/** 不带海岸墨线、湖岸描边的像素层(弯边投影的地形图按投影重画时用;墨线另外按投影画成矢量线,见 drawFantasyCoasts) */
let noInk: { raster: Raster; canvas: AnyCanvas } | null = null;

export function fantasyBaseNoInk(world: World, r: Raster): AnyCanvas {
  const src = fantasyBase(world, r);
  if (noInk?.raster === r) return noInk.canvas;
  if (noInk) noInk.canvas.width = noInk.canvas.height = 0;
  // 先湖岸、再海岸(两样都描过的像素,海岸记下的是两样都没描时的颜色)
  const { lake, coast } = base!.patch;
  noInk = { raster: r, canvas: patchedBase(src, r, [lake, coast]) };
  return noInk.canvas;
}

/**
 * 不带海岸墨线、湖岸描边、岸线外波纹、近岸排线、冰缘墨线、冰面背光边的像素层(放大后的细节层用:这几样都改画成矢量线,
 * 见 drawFantasyCoasts、drawFantasySeaLines、drawFantasyIce);冰缘带里是没结冰的海色。第一次放大时拼出来
 */
let clean: { raster: Raster; canvas: AnyCanvas } | null = null;

export function fantasyBaseClean(world: World, r: Raster): AnyCanvas {
  const src = fantasyBase(world, r);
  if (clean?.raster === r) return clean.canvas;
  if (clean) clean.canvas.width = clean.canvas.height = 0;
  // 波纹、排线盖到的像素后换:记下的颜色连海岸墨线也没画;冰缘带最后换(颜色里墨线、波纹、冰缘都没有)
  const { lake, coast, sea, iceW } = base!.patch;
  clean = { raster: r, canvas: patchedBase(src, r, [lake, coast, sea, iceW]) };
  return clean.canvas;
}

/** 冰面色那一张:fantasyBaseClean 上冰缘带换成冰面色(放大后按冰缘线围成的范围取这一张的颜色,见 drawFantasyIce) */
let iceFace: { raster: Raster; canvas: AnyCanvas } | null = null;

function fantasyIceFace(world: World, r: Raster): AnyCanvas {
  const src = fantasyBaseClean(world, r);
  if (iceFace?.raster === r) return iceFace.canvas;
  if (iceFace) iceFace.canvas.width = iceFace.canvas.height = 0;
  iceFace = { raster: r, canvas: patchedBase(src, r, [base!.patch.iceI]) };
  return iceFace.canvas;
}

function paintBase(ctx: CanvasRenderingContext2D, world: World, r: Raster, patch: InkPatch, sea: SeaFields) {
  const { w, h, water, biome } = r;
  const N = w * h;
  const S = r.scale;

  // 符号先规划(纯计算):像素层要知道山符号底边在哪,好把雪地和符号羽化到一起
  const plan = planOf(world);

  const landMask = new Uint8Array(N);
  const seaMask = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (water[k] === 1) seaMask[k] = 1;
    else landMask[k] = 1;
  }
  const dLand = distanceTo(landMask, w, h); // 海面像素 → 最近陆地
  const dSea = distanceTo(seaMask, w, h); // 陆地像素 → 最近海
  const shade = hillshade(r, 0.008, 0);
  const calm = glyphSkirts(world, plan.glyphs, w, h, S);

  const { mask: iceM, near: iceNear } = seaIceField(r);
  const band = iceBand(r, iceM, iceNear);

  const pr = new Float32Array(N);
  const pg = new Float32Array(N);
  const pb = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const c = biome[k] === Biome.Ice ? SNOW_PAINT : BIOMES[biome[k]].paint;
    pr[k] = c[0];
    pg[k] = c[1];
    pb[k] = c[2];
  }
  const br = Math.round(3 * S);
  boxBlurWrap(pr, w, h, br);
  boxBlurWrap(pg, w, h, br);
  boxBlurWrap(pb, w, h, br);

  const img = ctx.createImageData(w, h);
  const d = img.data;
  paintPixels(r, d, { dLand, dSea, shade, calm, iceM, iceNear, band, pr, pg, pb, patch, sea });
  // 湖岸描边(东西相连,左右两列也描:邻居在另一头)
  for (let py = 1; py < h - 1; py++) {
    for (let px = 0; px < w; px++) {
      const k = py * w + px;
      if (water[k] !== 2) continue;
      const lf = px > 0 ? k - 1 : k + w - 1;
      const rt = px < w - 1 ? k + 1 : k - w + 1;
      if (water[lf] !== 2 || water[rt] !== 2 || water[k - w] !== 2 || water[k + w] !== 2) {
        const o = k * 4;
        patch.lake.push(k, d[o], d[o + 1], d[o + 2]);
        d[o] = d[o] * 0.35 + INK[0] * 0.65;
        d[o + 1] = d[o + 1] * 0.35 + INK[1] * 0.65;
        d[o + 2] = d[o + 2] * 0.35 + INK[2] * 0.65;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** 每个世界的符号规划:像素层、符号层都要用;文明层先要符号层时也不用再算一遍 */
const plans = new WeakMap<World, Plan>();
/** 弯边投影各一份(符号间距按投影后的距离留,见 glyphMetric;和中央经线无关) */
const projPlans = new WeakMap<World, Map<ProjectionId, Plan>>();
function planOf(world: World, proj?: ProjectionId): Plan {
  if (proj && proj !== 'equirect') {
    let m = projPlans.get(world);
    if (!m) projPlans.set(world, (m = new Map()));
    let q = m.get(proj);
    if (!q) m.set(proj, (q = planGlyphs(world, glyphMetric(proj, world.width, world.height))));
    return q;
  }
  let p = plans.get(world);
  if (!p) plans.set(world, (p = planGlyphs(world)));
  return p;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof document !== 'undefined'
    ? Object.assign(document.createElement('canvas'), { width: w, height: h })
    : new OffscreenCanvas(w, h);
}

/**
 * 矢量层:林块(在河流下面,河从林中穿过)→ 河流 → 山 / 丘陵 / 沙丘 / 草丛(从上到下排序遮挡)。
 * v.k 决定细节层级:符号大小按 glyphScale(k),只画出现门槛 ≤ k 的符号;河流按流量分级。
 */
export function drawFantasyVectors(ctx: CanvasRenderingContext2D, world: World, v: VecView) {
  if (v.proj) {
    // 弯边投影(按投影重画):这种投影的符号规划;林块、符号在投影后的位置上按屏幕大小画,河逐点投影
    const pj = v.proj;
    const pp = planOf(world, pj.mp.def.id);
    drawForests(ctx, world, pp.forest, v, v.k > 1 ? 256 : FOREST_TILE, projCells(world, pj));
    drawRivers(ctx, world.rivers, v, world.riverThreshold, fantasyRiverStyle(v.k, world.riverThreshold));
    drawSymbols(ctx, pp.glyphs, v);
    return;
  }
  const plan = planOf(world);
  // 东西相连:挨着左右边的林块、河、符号在另一边再画一份。图框不画在这里(主图是一整圈星球,不是一页纸;
  // 纸边、外框画在视窗上,见 ui/MapDecor.tsx、导出)
  const vw = { ...v, wrap: wrapOf(world) };
  drawForests(ctx, world, plan.forest, vw, v.k > 1 ? 256 : FOREST_TILE);
  drawRivers(ctx, world.rivers, vw, world.riverThreshold, fantasyRiverStyle(v.k, world.riverThreshold));
  drawSymbols(ctx, plan.glyphs, vw);
}

// ---------------------------------------------------------------------------
// 弯边投影(按投影重画)

/** 地块中心在投影里的位置(地图平面)、经度差、纬线比例 K、局部间距倍数 sig(林块的圆按它放缩) */
interface ProjCells {
  X: Float32Array;
  Y: Float32Array;
  rel: Float32Array;
  K: Float32Array;
  sig: Float32Array;
}
let projCellCache: { world: World; key: string; cells: ProjCells } | null = null;

function projCells(world: World, pj: Projector): ProjCells {
  if (projCellCache && projCellCache.world === world && projCellCache.key === pj.mp.key) return projCellCache.cells;
  const { n, x, y, adjStart, adj, spacing } = world.mesh;
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const rel = new Float32Array(n);
  const K = new Float32Array(n);
  const sig = new Float32Array(n);
  const half = pj.W / 2;
  for (let i = 0; i < n; i++) {
    rel[i] = pj.rel(x[i]);
    K[i] = pj.K(y[i]);
    X[i] = half + K[i] * rel[i];
    Y[i] = pj.Y(y[i]);
  }
  // 局部间距:到相邻地块的平均距离(地图平面;跨 ±180° 的邻居按连着的那边量)÷ 等距圆柱赤道附近的平均距离
  // (等距圆柱在赤道附近横竖不变形,林块的圆在那里的大小就是设计的大小;平均邻距约 1.4 个 spacing)
  const D0 = equatorNeighborDist(world) || spacing;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      let dr = rel[j] - rel[i];
      if (dr > Math.PI) dr -= 2 * Math.PI;
      else if (dr < -Math.PI) dr += 2 * Math.PI;
      const dx = half + K[j] * (rel[i] + dr) - X[i];
      const dy = Y[j] - Y[i];
      sum += Math.sqrt(dx * dx + dy * dy);
      cnt++;
    }
    sig[i] = cnt ? Math.max(0.35, Math.min(4, sum / cnt / D0)) : 1;
  }
  const cells = { X, Y, rel, K, sig };
  projCellCache = { world, key: pj.mp.key, cells };
  return cells;
}

/** 赤道 ±5° 以内的地块到相邻地块的平均距离(世界单位,等距圆柱主图上量) */
function equatorNeighborDist(world: World): number {
  const { n, x, y, adjStart, adj } = world.mesh;
  const W = world.width;
  const band = world.height / 36;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(y[i] - world.height / 2) > band) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const dx = nearX(x[j], x[i], W) - x[i];
      const dy = y[j] - y[i];
      sum += Math.sqrt(dx * dx + dy * dy);
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

/** 山脊走向(世界坐标里的角度)换算到投影后的画面上:按这一点的局部拉伸 / 斜切变换方向,再收回 (−90°, 90°] */
function projectedAngle(pj: Projector, g: Glyph, rel: number): number {
  const jxx = (pj.K(g.y) * 2 * Math.PI) / pj.W;
  const jxy = pj.dK(g.y) * rel;
  const jyy = pj.dY(g.y);
  const c = Math.cos(g.a);
  const s = Math.sin(g.a);
  let a = Math.atan2(jyy * s, jxx * c + jxy * s);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** 海岸线、湖岸线(世界坐标折线,x 展开成连续的);每张像素图算一次 */
const coastCache = new WeakMap<Raster, { sea: Float32Array[]; lake: Float32Array[] }>();

/**
 * 海岸 / 湖岸的矢量线(按投影重画时代替像素层里的墨线):在像素水陆图上走方格(marching squares),
 * 海岸的交点按海拔过零处插值(和像素层画墨线的位置一样),湖岸取像素边中点再抹平两遍。东西相连:最右一列和第一列之间也走
 */
export function fantasyCoastLines(r: Raster): { sea: Float32Array[]; lake: Float32Array[] } {
  let c = coastCache.get(r);
  if (c) return c;
  const { w, h, water } = r;
  const sea = new Uint8Array(w * h);
  const lake = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    if (water[k] === 1) sea[k] = 1;
    else if (water[k] === 2) lake[k] = 1;
  }
  c = {
    sea: traceMask(r, sea, elevCross(r.elev)),
    lake: traceMask(r, lake).map((p) => chaikinPts(chaikinPts(p))),
  };
  coastCache.set(r, c);
  return c;
}

/** 折线(x, y 交错)Chaikin 抹平一遍,两端不动(首尾相同的环照样首尾相同) */
function chaikinPts(p: Float32Array): Float32Array {
  const m = p.length / 2;
  if (m < 3) return p;
  const closed = p[0] === p[p.length - 2] && p[1] === p[p.length - 1];
  const out: number[] = [];
  if (!closed) out.push(p[0], p[1]);
  for (let i = 0; i < m - 1; i++) {
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const bx = p[i * 2 + 2];
    const by = p[i * 2 + 3];
    out.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
  }
  if (!closed) out.push(p[p.length - 2], p[p.length - 1]);
  else out.push(out[0], out[1]);
  return Float32Array.from(out);
}

/**
 * 方格里"从哪条边进、从哪条边出"(边:0 上 1 右 2 下 3 左;−1 = 这条边不过线)。
 * 两个对角在里面的方格(5、10),里面的两角各自圈开
 */
const MS_EXIT = new Int8Array(16 * 4).fill(-1);
{
  const pair = (c: number, a: number, b: number) => {
    MS_EXIT[c * 4 + a] = b;
    MS_EXIT[c * 4 + b] = a;
  };
  for (const c of [1, 14]) pair(c, 3, 2);
  for (const c of [2, 13]) pair(c, 2, 1);
  for (const c of [3, 12]) pair(c, 3, 1);
  for (const c of [4, 11]) pair(c, 0, 1);
  pair(5, 0, 1);
  pair(5, 3, 2);
  for (const c of [6, 9]) pair(c, 0, 2);
  for (const c of [7, 8]) pair(c, 0, 3);
  pair(10, 0, 3);
  pair(10, 2, 1);
}

/** 相邻两个像素 ka、kb 之间海拔过零处(从 ka 量起的比例;不过零 = 中点):海岸线、像素层画海岸墨线都按它 */
function elevCross(elev: ArrayLike<number>): (ka: number, kb: number) => number {
  return (ka, kb) => {
    const ea = elev[ka];
    const eb = elev[kb];
    return ea < 0 !== eb < 0 && ea !== eb ? Math.max(0.02, Math.min(0.98, ea / (ea - eb))) : 0.5;
  };
}

/** traceMask 只用到像素图的这几样 */
export type GridLike = Pick<Raster, 'w' | 'h' | 'scale'>;

/**
 * 在二值图 inside 上走方格(marching squares 沿线追踪),描出里外的分界折线(世界坐标,x 展开成连续的)。
 * 方格 (x, y) 的四角是像素 (x, y)、(x+1, y)、(x+1, y+1)、(x, y+1) 的中心(x 东西相连);
 * 线过像素之间的边:交点在 cross(两头的像素)处(从前一个像素量起的比例),不给 = 中点。
 * 边编号:横边 (x, y)—(x+1, y) = 2(y·w + x),竖边 (x, y)—(x, y+1) = 2(y·w + x) + 1
 */
function traceMask(r: GridLike, inside: Uint8Array, cross?: (ka: number, kb: number) => number): Float32Array[] {
  const { w, h, scale: S } = r;
  const W = w / S;
  const visited = new Uint8Array(2 * w * h);
  const caseAt = (x: number, y: number) => {
    const x1 = x + 1 === w ? 0 : x + 1;
    return (inside[y * w + x] << 3) | (inside[y * w + x1] << 2) | (inside[(y + 1) * w + x1] << 1) | inside[(y + 1) * w + x];
  };
  /** 方格 (x, y) 的第 side 条边的编号 */
  const edgeOf = (x: number, y: number, side: number) =>
    side === 0 ? (y * w + x) * 2 : side === 2 ? ((y + 1) * w + x) * 2 : side === 3 ? (y * w + x) * 2 + 1 : (y * w + (x + 1 === w ? 0 : x + 1)) * 2 + 1;
  const pos = (id: number, out: number[]) => {
    const e = id >> 1;
    const x = e % w;
    const y = (e - x) / w;
    const vert = id & 1;
    const ka = y * w + x;
    const kb = vert ? ka + w : y * w + (x + 1 === w ? 0 : x + 1);
    const t = cross ? cross(ka, kb) : 0.5;
    out.push(vert ? (x + 0.5) / S : (x + 0.5 + t) / S, vert ? (y + 0.5 + t) / S : (y + 0.5) / S);
  };
  const out: Float32Array[] = [];
  /** 从边 id 进方格 (x, y)(从它的第 side 条边进),一路走到回到起点或碰到上下边 */
  const walk = (id: number, x: number, y: number, side: number) => {
    const pts: number[] = [];
    pos(id, pts);
    visited[id] = 1;
    const start = id;
    for (;;) {
      const ex = MS_EXIT[caseAt(x, y) * 4 + side];
      if (ex < 0) break;
      const e = edgeOf(x, y, ex);
      if (e === start) {
        pos(e, pts);
        break;
      }
      if (visited[e]) break;
      visited[e] = 1;
      pos(e, pts);
      // 走到这条边另一侧的方格
      if (ex === 0) {
        if (y === 0) break;
        y--;
        side = 2;
      } else if (ex === 2) {
        if (y + 1 >= h - 1) break;
        y++;
        side = 0;
      } else if (ex === 1) {
        x = x + 1 === w ? 0 : x + 1;
        side = 3;
      } else {
        x = x === 0 ? w - 1 : x - 1;
        side = 1;
      }
    }
    for (let i = 2; i < pts.length; i += 2) pts[i] = nearX(pts[i], pts[i - 2], W);
    if (pts.length >= 4) out.push(Float32Array.from(pts));
  };
  // 先从碰到上下边的线头出发(最上一行、最下一行的横边),再走剩下的环
  for (const y of [0, h - 1]) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const id = k * 2;
      if (visited[id] || inside[k] === inside[y * w + (x + 1 === w ? 0 : x + 1)]) continue;
      if (y === 0) walk(id, x, 0, 0);
      else walk(id, x, h - 2, 2);
    }
  }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      // 横边:进下面的方格(从它的上边进);竖边:进右边的方格(从它的左边进)
      const hid = k * 2;
      if (!visited[hid] && inside[k] !== inside[y * w + (x + 1 === w ? 0 : x + 1)]) walk(hid, x, y, 0);
      const vid = k * 2 + 1;
      if (!visited[vid] && inside[k] !== inside[k + w]) walk(vid, x, y, 3);
    }
  }
  return out;
}

/** 海岸墨线、湖岸描边的投影路径(地图平面坐标,画的时候按视口变换;每个投影 + 中心一份) */
let coastPaths: { raster: Raster; key: string; sea: Path2D; lake: Path2D } | null = null;

/** 海岸墨线、湖岸描边的线宽(世界单位,缩放 GLYPH_K0 倍以下;放大后乘 glyphScale) */
const COAST_LW = 1.45;
const LAKE_LW = 1.05;

/**
 * 放大后的海岸墨线、湖岸描边(代替像素层里的那两样:像素层放大后是一格一格的台阶,矢量线放大多少倍都顺滑),按屏幕宽度描。
 * 放大后跟着符号一起按 glyphScale 变粗(比地图放大得慢)。
 *   弯边投影(v.proj):逐点投影,整张图一条路径(每个投影 + 中心算一次)
 *   等距圆柱:世界坐标的折线 × v.s + (v.ox, v.oy);只画画布附近的那几段(coastChunks),
 *            东西相连,伸出左右边的段在另一边再画一份
 */
export function drawFantasyCoasts(ctx: CanvasRenderingContext2D, r: Raster, v: VecView): void {
  const gs = glyphScale(v.k);
  let sea: Path2D;
  let lake: Path2D;
  const pj = v.proj;
  if (pj) {
    if (!coastPaths || coastPaths.raster !== r || coastPaths.key !== pj.mp.key) {
      const lines = fantasyCoastLines(r);
      const unit = { s: 1, ox: 0, oy: 0 };
      const sea = new Path2D();
      const lake = new Path2D();
      for (const p of lines.sea) addProjectedLine(sea, p, 2, pj, unit);
      for (const p of lines.lake) addProjectedLine(lake, p, 2, pj, unit);
      coastPaths = { raster: r, key: pj.mp.key, sea, lake };
    }
    ({ sea, lake } = coastPaths);
  } else {
    if (flatCoasts?.raster !== r) {
      const lines = fantasyCoastLines(r);
      flatCoasts = { raster: r, sea: coastChunks(lines.sea), lake: coastChunks(lines.lake) };
    }
    // 抽稀到哪一档:偏差不到 COAST_TOL 个画布像素的最粗一档
    let lod = 0;
    while (lod + 1 < COAST_LOD.length && COAST_LOD[lod + 1] * v.s <= COAST_TOL) lod++;
    // 画布盖住的世界坐标范围(外加一个线宽)
    const pad = COAST_LW * gs + COAST_LOD[lod];
    const x0 = -v.ox / v.s - pad;
    const y0 = -v.oy / v.s - pad;
    const x1 = (ctx.canvas.width - v.ox) / v.s + pad;
    const y1 = (ctx.canvas.height - v.oy) / v.s + pad;
    const W = r.w / r.scale;
    sea = chunkPath(flatCoasts.sea, lod, W, x0, y0, x1, y1);
    lake = chunkPath(flatCoasts.lake, lod, W, x0, y0, x1, y1);
  }
  ctx.save();
  ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK_CSS + '0.65)';
  ctx.lineWidth = LAKE_LW * gs;
  ctx.stroke(lake);
  ctx.strokeStyle = INK_CSS + '0.9)';
  ctx.lineWidth = COAST_LW * gs;
  ctx.stroke(sea);
  ctx.restore();
}

/** 等距圆柱的海岸、湖岸(切成小段,世界坐标;每张像素图一份,换了世界就换掉) */
let flatCoasts: { raster: Raster; sea: CoastChunks; lake: CoastChunks } | null = null;

/** 一段最多几条线段:段越短,只看一小块时多画的越少;太短了段数多,挑段反而慢 */
const COAST_CHUNK = 48;
/**
 * 折线抽稀的几档容差(世界单位;0 = 不抽稀)。放大不多时一屏里是整圈的海岸,点数(约四万)决定描线的耗时;
 * 偏差不到 COAST_TOL 个画布像素(看不出来)的点去掉,放大 1.5 倍时点数减到四到六成
 */
const COAST_LOD = [0, 0.05, 0.12, 0.3];
const COAST_TOL = 0.35;

/**
 * 海岸 / 湖岸折线切成的小段(世界坐标,x 和折线一样是展开的,可能伸出左右边):
 * 放大后只看一小块,只要把视口附近的几段拼起来画。每段的路径第一次画到时才建
 */
export interface CoastChunks {
  /** 每段的折线(x, y 交错;相邻两段共用接头那一点) */
  pts: Float32Array[];
  /** 每段的外框(x0, y0, x1, y1 交错) */
  box: Float32Array;
  /** 每段的路径(世界坐标),COAST_LOD 每一档各一份 */
  path: (Path2D | undefined)[][];
}

export function coastChunks(lines: Float32Array[]): CoastChunks {
  const pts: Float32Array[] = [];
  const box: number[] = [];
  for (const p of lines) {
    const m = p.length / 2;
    for (let a = 0; a < m - 1; a += COAST_CHUNK) {
      const b = Math.min(m - 1, a + COAST_CHUNK);
      const q = p.subarray(a * 2, b * 2 + 2);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < q.length; i += 2) {
        if (q[i] < x0) x0 = q[i];
        if (q[i] > x1) x1 = q[i];
        if (q[i + 1] < y0) y0 = q[i + 1];
        if (q[i + 1] > y1) y1 = q[i + 1];
      }
      pts.push(q);
      box.push(x0, y0, x1, y1);
    }
  }
  return { pts, box: Float32Array.from(box), path: COAST_LOD.map(() => new Array(pts.length)) };
}

/** 折线(x, y 交错)抽稀(Douglas–Peucker):去掉离留下的折线不到 tol 的点,两端不动 */
export function simplifyLine(p: Float32Array, tol: number): Float32Array {
  const m = p.length / 2;
  if (m < 3 || tol <= 0) return p;
  const keep = new Uint8Array(m);
  keep[0] = keep[m - 1] = 1;
  const stack = [0, m - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = p[a * 2];
    const ay = p[a * 2 + 1];
    const dx = p[b * 2] - ax;
    const dy = p[b * 2 + 1] - ay;
    const L2 = dx * dx + dy * dy;
    let worst = tol;
    let wi = -1;
    for (let i = a + 1; i < b; i++) {
      const qx = p[i * 2] - ax;
      const qy = p[i * 2 + 1] - ay;
      // 到弦(线段,不是整条直线)的距离:折回去、伸出弦两头的点也按真实偏差算(首尾重合的环:到起点的距离)
      const t = L2 > 1e-18 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / L2)) : 0;
      const d = Math.hypot(qx - t * dx, qy - t * dy);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (wi < 0) continue;
    keep[wi] = 1;
    stack.push(a, wi, wi, b);
  }
  const out: number[] = [];
  for (let i = 0; i < m; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return Float32Array.from(out);
}

/**
 * 范围 [x0, x1] × [y0, y1](世界坐标,x 可以伸出左右边)里有哪些段:每一份调一次 fn(段号, 横向平移量)。
 * 东西相连(周期 W):一段平移整圈后落进范围的也算(挨着左右边的段在另一边再出一份;范围比一整圈宽时可能出好几份)。
 * W = 0:不相连(弯边投影的地图平面),只看外框和范围有没有交叠
 */
export function forChunksIn(c: CoastChunks, W: number, x0: number, y0: number, x1: number, y1: number, fn: (j: number, dx: number) => void): void {
  const b = c.box;
  for (let j = 0; j < c.pts.length; j++) {
    const o = j * 4;
    if (b[o + 1] > y1 || b[o + 3] < y0) continue;
    if (!W) {
      if (b[o] <= x1 && b[o + 2] >= x0) fn(j, 0);
      continue;
    }
    // 从刚好不在范围左边的那一份起,往右一份一份地挪
    for (let dx = Math.ceil((x0 - b[o + 2]) / W) * W; b[o] + dx <= x1; dx += W) fn(j, dx);
  }
}

/** 范围里的段(按第 lod 档抽稀)拼成一条路径(世界坐标;一次描完,接头、接缝处不会叠深) */
function chunkPath(c: CoastChunks, lod: number, W: number, x0: number, y0: number, x1: number, y1: number): Path2D {
  const out = new Path2D();
  const cache = c.path[lod];
  forChunksIn(c, W, x0, y0, x1, y1, (j, dx) => {
    let p = cache[j];
    if (!p) {
      const q = simplifyLine(c.pts[j], COAST_LOD[lod]);
      p = cache[j] = new Path2D();
      p.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) p.lineTo(q[i], q[i + 1]);
    }
    if (dx) out.addPath(p, { e: dx });
    else out.addPath(p);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 放大后的岸线外波纹、近岸排线(矢量线)

/**
 * 放大后矢量画的波纹、近岸排线(代替像素层里的那两样;每张像素图一份,第一次放大时算):
 *   波纹 = 离陆地距离场的等值线(RIPPLE_D 格;走方格、交点按距离插值,和像素层的位置一样),切成小段(同海岸);
 *   排线 = 每隔几行、离陆地 HATCH_D 格以内的海面横线段,靠岸那一头停在海岸线上(按海拔过零处插值)。
 * 浓淡(离岸越远越淡、冰区淡出、被海冰盖住的地方不画)不写进线里:线的颜色取一张按像素算好的浓度图
 * (画布图案,放大时双线性插值)—— 线是锐的,淡出是平滑的,和像素层逐像素的浓淡一致
 */
interface SeaLines {
  raster: Raster;
  /** 三圈波纹(世界坐标折线,x 展开成连续的) */
  rings: Float32Array[][];
  /** 同上,切成小段(等距圆柱只画视口附近的段) */
  ringChunks: CoastChunks[];
  /** 排线:(x0, x1, y) 交错,世界坐标,按 y 从小到大 */
  hatch: Float32Array;
  /** 浓度图(颜色 = 墨色,透明度 = 浓度;和像素图一样大):波纹 / 排线 */
  rippleFade: AnyCanvas;
  hatchFade: AnyCanvas;
  pats: { ripple: CanvasPattern; hatch: CanvasPattern } | null;
}
let seaLines: SeaLines | null = null;

/** 波纹、排线只用到像素图的这几样 */
export type SeaGrid = Pick<Raster, 'w' | 'h' | 'scale' | 'water' | 'elev'>;

/**
 * 三圈波纹的等值线:dist(见 SeaFields)上 RIPPLE_D 格处走方格,再抹平一遍。浓度为 0 的地方(冰面、冰区深处)那几截不要
 */
export function seaRippleLines(r: SeaGrid, dist: Uint16Array, fade: Uint8Array): Float32Array[][] {
  const N = r.w * r.h;
  const inside = new Uint8Array(N);
  return RIPPLE_D.map((D) => {
    const L = D * DIST_Q;
    for (let k = 0; k < N; k++) inside[k] = dist[k] < L ? 1 : 0;
    const lines = traceMask(r, inside, (ka, kb) => (L - dist[ka]) / (dist[kb] - dist[ka]));
    // 交点一格一个,放大很多倍时看得出折角:抹平一遍
    return dropFaded(lines.map(chaikinPts), r, fade);
  });
}

/** 折线上浓度为 0 的那几截去掉(两头的点四周四个像素的浓度都是 0 的线段),剩下的断成几条 */
function dropFaded(lines: Float32Array[], r: GridLike, fade: Uint8Array): Float32Array[] {
  const { w, h, scale: S } = r;
  const on = (x: number, y: number) => {
    const fx = Math.floor(x * S - 0.5);
    const fy = Math.floor(y * S - 0.5);
    for (let j = 0; j < 2; j++) {
      const yy = Math.min(h - 1, Math.max(0, fy + j));
      for (let i = 0; i < 2; i++) if (fade[yy * w + ((((fx + i) % w) + w) % w)]) return true;
    }
    return false;
  };
  const out: Float32Array[] = [];
  for (const p of lines) {
    const m = p.length / 2;
    const ok = new Uint8Array(m);
    let all = true;
    for (let i = 0; i < m; i++) {
      ok[i] = on(p[i * 2], p[i * 2 + 1]) ? 1 : 0;
      if (!ok[i]) all = false;
    }
    if (all) {
      out.push(p);
      continue;
    }
    // 线段 i → i+1 留下:两头有一头有浓度
    let a = -1;
    for (let i = 0; i < m; i++) {
      const keep = i < m - 1 && (ok[i] || ok[i + 1]);
      if (keep && a < 0) a = i;
      if (!keep && a >= 0) {
        out.push(p.slice(a * 2, i * 2 + 2));
        a = -1;
      }
    }
  }
  return out;
}

/**
 * 近岸排线:每隔 hatchRowOf(scale) 行,离陆地 HATCH_D 格以内、浓度不为 0 的海面像素连成横线段(x0, x1, y,世界坐标)。
 * 挨着陆地的一头停在海岸线上(两个像素之间海拔过零处);另一头伸到下一个像素的中心(那里浓度已经是 0,淡出看不出头)。
 * 东西相连:跨过左右边的那一段 x 展开成连续的(可能伸出右边)
 */
export function seaHatchSegments(r: SeaGrid, dist: Uint16Array, fade: Uint8Array): Float32Array {
  const { w, h, water, scale: S } = r;
  const L = HATCH_D * DIST_Q;
  const cross = elevCross(r.elev);
  const ok = (k: number) => water[k] === 1 && dist[k] < L && fade[k] > 0;
  const out: number[] = [];
  for (let py = 0; py < h; py += hatchRowOf(S)) {
    const row = py * w;
    const y = (py + 0.5) / S;
    // 从一个不画的像素起扫一整圈(跨过左右边的线段不断开)
    let x0 = 0;
    while (x0 < w && ok(row + x0)) x0++;
    if (x0 === w) {
      out.push(0, w / S, y);
      continue;
    }
    let a = -1;
    for (let u = x0 + 1; u <= x0 + w; u++) {
      const on = u < x0 + w && ok(row + (u % w));
      if (on && a < 0) a = u;
      if (!on && a >= 0) {
        // 线段:像素 a … u − 1(展开的列号)
        const ka = row + (a % w);
        const kl = row + ((a - 1) % w);
        const kb = row + ((u - 1) % w);
        const kr = row + (u % w);
        const xa = water[kl] === 1 ? a - 0.5 : a - 0.5 + cross(kl, ka);
        const xb = water[kr] === 1 ? u + 0.5 : u - 0.5 + cross(kb, kr);
        out.push(xa / S, xb / S, y);
        a = -1;
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * 排线的浓度图(0–255):浓淡倍数 × 离岸越远越淡(1 − 距离 / HATCH_D 格)。
 * 挨着海面的陆地像素取相邻海面像素里最大的那个 —— 排线一直画到海岸线上,浓度图在岸边不往下掉
 */
export function seaHatchAlpha(r: SeaGrid, dist: Uint16Array, fade: Uint8Array): Uint8Array {
  const { w, h, water } = r;
  const N = w * h;
  const L = HATCH_D * DIST_Q;
  const a = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (water[k] === 1 && fade[k] && dist[k] < L) a[k] = Math.round(fade[k] * (1 - dist[k] / L));
  // 离陆地不到 1.5 格的海面像素把自己的浓度推给四周的陆地像素(取最大)
  const near = 1.5 * DIST_Q;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const v = a[k];
      if (!v || water[k] !== 1 || dist[k] > near) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const q = yy * w + (x + dx < 0 ? x + dx + w : x + dx >= w ? x + dx - w : x + dx);
          if (water[q] !== 1 && a[q] < v) a[q] = v;
        }
      }
    }
  }
  return a;
}

/**
 * 范围 [x0, x1] × [y0, y1](世界坐标,x 可以伸出左右边)里有哪些排线:每一份调一次 fn(第几条, 横向平移量)。
 * 东西相连(周期 W;W = 0 不相连),同 forChunksIn
 */
export function forHatchIn(seg: Float32Array, W: number, x0: number, y0: number, x1: number, y1: number, fn: (i: number, dx: number) => void): void {
  const n = seg.length / 3;
  // 按 y 排好的:先二分找到第一条 y ≥ y0 的
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (seg[m * 3 + 2] < y0) lo = m + 1;
    else hi = m;
  }
  for (let i = lo; i < n && seg[i * 3 + 2] <= y1; i++) {
    const a = seg[i * 3];
    const b = seg[i * 3 + 1];
    if (!W) {
      if (a <= x1 && b >= x0) fn(i, 0);
      continue;
    }
    for (let dx = Math.ceil((x0 - b) / W) * W; a + dx <= x1; dx += W) fn(i, dx);
  }
}

/** 浓度图:颜色 = 墨色,透明度 = alpha */
function inkAlphaCanvas(alpha: Uint8Array, w: number, h: number): AnyCanvas {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let k = 0; k < w * h; k++) {
    if (!alpha[k]) continue;
    const o = k * 4;
    d[o] = INK[0];
    d[o + 1] = INK[1];
    d[o + 2] = INK[2];
    d[o + 3] = alpha[k];
  }
  const cv = makeCanvas(w, h);
  (cv.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  return cv;
}

function seaLinesOf(world: World, r: Raster): SeaLines {
  fantasyBase(world, r);
  if (seaLines?.raster === r) return seaLines;
  if (seaLines) seaLines.rippleFade.width = seaLines.rippleFade.height = seaLines.hatchFade.width = seaLines.hatchFade.height = 0;
  const { dist, fade } = base!.sea;
  const rings = seaRippleLines(r, dist, fade);
  seaLines = {
    raster: r,
    rings,
    ringChunks: rings.map((ls) => coastChunks(ls)),
    hatch: seaHatchSegments(r, dist, fade),
    rippleFade: inkAlphaCanvas(fade, r.w, r.h),
    hatchFade: inkAlphaCanvas(seaHatchAlpha(r, dist, fade), r.w, r.h),
    pats: null,
  };
  return seaLines;
}

/**
 * 弯边投影:波纹、排线投影到地图平面(每个投影 + 中心一份)。波纹逐点投影后照样切成小段(只画视口附近的、按画布像素抽稀,
 * 同等距圆柱);排线:纬线投影后还是水平线,横线段投影后还是横线段(伸出 ±180° 的那截在另一边再出一份),按 y 排好。
 * 浓度图按投影重铺一张(和地图平面一样大)
 */
let seaPaths: { raster: Raster; key: string; rings: CoastChunks[]; hatch: Float32Array; rippleFade: AnyCanvas; hatchFade: AnyCanvas; pats: { ripple: CanvasPattern; hatch: CanvasPattern } | null } | null = null;

/** 排线 (x0, x1, y) 投影到地图平面,按 y 排好 */
export function projectHatch(seg: Float32Array, pj: Projector): Float32Array {
  const unit = { s: 1, ox: 0, oy: 0 };
  const out: number[] = [];
  for (let i = 0; i < seg.length; i += 3)
    for (const p of projectLinePts([seg[i], seg[i + 2], seg[i + 1], seg[i + 2]], 2, pj, unit)) {
      const xa = p[0];
      const xb = p[p.length - 2];
      out.push(Math.min(xa, xb), Math.max(xa, xb), p[1]);
    }
  const n = out.length / 3;
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => out[i * 3 + 2] - out[j * 3 + 2]);
  const res = new Float32Array(out.length);
  order.forEach((i, j) => res.set(out.slice(i * 3, i * 3 + 3), j * 3));
  return res;
}

/** 浓度图当线的颜色:图案按像素图的像素 → 世界(地图平面)坐标摆放 */
function fadePatterns(ctx: CanvasRenderingContext2D, ripple: AnyCanvas, hatch: AnyCanvas, S: number, rep: 'repeat' | 'no-repeat') {
  const m = new DOMMatrix([1 / S, 0, 0, 1 / S, 0, 0]);
  const make = (cv: AnyCanvas) => {
    const p = ctx.createPattern(cv, rep)!;
    p.setTransform(m);
    return p;
  };
  return { ripple: make(ripple), hatch: make(hatch) };
}

/**
 * 放大后的岸线外波纹、近岸排线(代替像素层里的那两样,像素层放大后是一格一格的方块),位置、浓淡和像素层一样,
 * 线宽跟着符号一起按 glyphScale 收(和海岸墨线同一套)。画在海岸墨线之前。
 * 只画画布附近的波纹段、排线,波纹按画布像素抽稀(同 drawFantasyCoasts 的等距圆柱)。
 *   弯边投影(v.proj):地图平面上的段、排线(见 seaPaths),浓度图按投影重铺
 *   等距圆柱:世界坐标;东西相连,伸出左右边的在另一边再画一份,浓度图左右平铺
 */
export function drawFantasySeaLines(ctx: CanvasRenderingContext2D, world: World, r: Raster, v: VecView): void {
  const sl = seaLinesOf(world, r);
  const S = r.scale;
  const gs = glyphScale(v.k);
  let chunks: CoastChunks[];
  let seg: Float32Array;
  let W: number;
  let pats: { ripple: CanvasPattern; hatch: CanvasPattern };
  const pj = v.proj;
  if (pj) {
    if (!seaPaths || seaPaths.raster !== r || seaPaths.key !== pj.mp.key) {
      if (seaPaths) seaPaths.rippleFade.width = seaPaths.rippleFade.height = seaPaths.hatchFade.width = seaPaths.hatchFade.height = 0;
      const unit = { s: 1, ox: 0, oy: 0 };
      const rings = sl.rings.map((ls) => coastChunks(ls.flatMap((q) => projectLinePts(q, 2, pj, unit).map((p) => Float32Array.from(p)))));
      const reproj = (src: AnyCanvas) => {
        const cv = makeCanvas(r.w, r.h);
        reprojectImage(cv.getContext('2d') as CanvasRenderingContext2D, src, r.w, r.h, pj.mp, { s: S, ox: 0, oy: 0 }, 'low');
        return cv;
      };
      seaPaths = { raster: r, key: pj.mp.key, rings, hatch: projectHatch(sl.hatch, pj), rippleFade: reproj(sl.rippleFade), hatchFade: reproj(sl.hatchFade), pats: null };
    }
    seaPaths.pats ??= fadePatterns(ctx, seaPaths.rippleFade, seaPaths.hatchFade, S, 'no-repeat');
    ({ rings: chunks, hatch: seg, pats } = seaPaths);
    W = 0;
  } else {
    sl.pats ??= fadePatterns(ctx, sl.rippleFade, sl.hatchFade, S, 'repeat');
    ({ ringChunks: chunks, hatch: seg, pats } = sl);
    W = r.w / S;
  }
  // 抽稀、范围同 drawFantasyCoasts
  let lod = 0;
  while (lod + 1 < COAST_LOD.length && COAST_LOD[lod + 1] * v.s <= COAST_TOL) lod++;
  const pad = RIPPLE_SIG * gs + COAST_LOD[lod];
  const x0 = -v.ox / v.s - pad;
  const y0 = -v.oy / v.s - pad;
  const x1 = (ctx.canvas.width - v.ox) / v.s + pad;
  const y1 = (ctx.canvas.height - v.oy) / v.s + pad;
  const rings = chunks.map((c) => chunkPath(c, lod, W, x0, y0, x1, y1));
  const hatch = new Path2D();
  forHatchIn(seg, W, x0, y0, x1, y1, (i, dx) => {
    hatch.moveTo(seg[i * 3] + dx, seg[i * 3 + 2]);
    hatch.lineTo(seg[i * 3 + 1] + dx, seg[i * 3 + 2]);
  });
  ctx.save();
  ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  // 排线:一个像素高(放大后按 glyphScale 收)
  ctx.strokeStyle = pats.hatch;
  ctx.globalAlpha = HATCH_A;
  ctx.lineCap = 'butt';
  ctx.lineWidth = gs / S;
  ctx.stroke(hatch);
  // 波纹:墨量和像素层的高斯剖面一样的实线
  ctx.strokeStyle = pats.ripple;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = RIPPLE_SIG * Math.sqrt(Math.PI) * gs;
  for (let i = 0; i < rings.length; i++) {
    ctx.globalAlpha = RIPPLE_A[i];
    ctx.stroke(rings[i]);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 放大后的冰缘(矢量线)与冰面(按冰缘线填色)

/** 冰缘线上一点所在像素边的另一头(冰的外面)是什么 */
const EDGE_SEA = 0;
const EDGE_LAND = 1;
/** 地图上下边以外(追踪时上下各垫的一行) */
const EDGE_PAD = 2;

/**
 * 有方向的方格追踪的走向表:MS_OUT[情形 × 4 + 从哪条边进] = 从哪条边出(−1 = 不从这条边进)。
 * 里面永远在走向的左手边(画布坐标 y 朝下,看上去的左边);两个对角在里面时各自圈开(同 MS_EXIT)
 */
const MS_OUT = new Int8Array(16 * 4).fill(-1);
{
  const mid = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  // 左上、右上、右下、左下(情形里的位 8、4、2、1)
  const corner = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const bit = [8, 4, 2, 1];
  // 每条边的两个角
  const ends = [[0, 1], [1, 2], [3, 2], [0, 3]];
  for (let c = 0; c < 16; c++)
    for (let a = 0; a < 4; a++) {
      const b = MS_EXIT[c * 4 + a];
      if (b < a) continue;
      // 边 a 上在里面的那个角,要在 a → b 的左手边((dy, −dx) 那一侧)
      const ca = ends[a][c & bit[ends[a][0]] ? 0 : 1];
      const dx = mid[b][0] - mid[a][0];
      const dy = mid[b][1] - mid[a][1];
      if ((corner[ca][0] - mid[a][0]) * dy - (corner[ca][1] - mid[a][1]) * dx > 0) MS_OUT[c * 4 + a] = b;
      else MS_OUT[c * 4 + b] = a;
    }
}

/**
 * 一条有方向的分界线(世界坐标,x 展开成连续的),里面在走向的左手边。首点不重复:
 * 环(wrap = 0)最后一点接回第一点;绕地球一圈的(wrap = ±1,往东 / 往西)接回"第一点平移 wrap × 世界宽度"
 */
export interface OrientedLine {
  pts: Float32Array;
  /** 每一段(第 i 点 → 下一点,最后一段接回去)要不要描冰缘墨线 */
  ink: Uint8Array;
  wrap: number;
}

/**
 * 在二值图 inside 上走方格(有方向):每条分界线里面在左手边。上下各垫一行"外面"(地图上下边以外,
 * 交点正好在地图上下边上),所以每条线都首尾相接 —— 环,或绕地球一圈(东西相连)。
 * cross(ka, kb):相邻两个像素之间交点的位置(从 ka 量起的比例);kind(ka, kb):这一点的种类(EDGE_*,给描线用)。
 * 方格、边的编号同 traceMask(行号按垫过的算)
 */
export function traceOriented(
  r: GridLike,
  inside: Uint8Array,
  cross: (ka: number, kb: number) => number,
  kind: (ka: number, kb: number) => number,
): { pts: Float32Array; kind: Uint8Array; wrap: number }[] {
  const { w, h, scale: S } = r;
  const W = w / S;
  const R = h + 2;
  const at = (x: number, rr: number) => (rr === 0 || rr === R - 1 ? 0 : inside[(rr - 1) * w + x]);
  const nx = (x: number) => (x + 1 === w ? 0 : x + 1);
  const caseAt = (x: number, rr: number) => {
    const x1 = nx(x);
    return (at(x, rr) << 3) | (at(x1, rr) << 2) | (at(x1, rr + 1) << 1) | at(x, rr + 1);
  };
  const edgeOf = (x: number, rr: number, side: number) =>
    side === 0 ? (rr * w + x) * 2 : side === 2 ? ((rr + 1) * w + x) * 2 : side === 3 ? (rr * w + x) * 2 + 1 : (rr * w + nx(x)) * 2 + 1;
  const visited = new Uint8Array(2 * w * R);
  const out: { pts: Float32Array; kind: Uint8Array; wrap: number }[] = [];
  const pts: number[] = [];
  const kinds: number[] = [];
  const add = (id: number) => {
    const e = id >> 1;
    const x = e % w;
    const rr = (e - x) / w;
    const vert = id & 1;
    const rb = vert ? rr + 1 : rr;
    let t = 0.5;
    let kd = EDGE_PAD;
    if (rr > 0 && rr < R - 1 && rb > 0 && rb < R - 1) {
      const ka = (rr - 1) * w + x;
      const kb = vert ? ka + w : (rr - 1) * w + nx(x);
      t = cross(ka, kb);
      kd = kind(ka, kb);
    }
    pts.push(vert ? (x + 0.5) / S : (x + 0.5 + t) / S, vert ? (rr - 0.5 + t) / S : (rr - 0.5) / S);
    kinds.push(kd);
  };
  const walk = (x: number, rr: number, side: number) => {
    pts.length = 0;
    kinds.length = 0;
    const start = edgeOf(x, rr, side);
    visited[start] = 1;
    add(start);
    for (let guard = visited.length; guard > 0; guard--) {
      const ex = MS_OUT[caseAt(x, rr) * 4 + side];
      if (ex < 0) break; // 不会发生(进来的边一定有出去的边)
      const e = edgeOf(x, rr, ex);
      if (e === start) break;
      visited[e] = 1;
      add(e);
      if (ex === 0) {
        rr--;
        side = 2;
      } else if (ex === 2) {
        rr++;
        side = 0;
      } else if (ex === 1) {
        x = nx(x);
        side = 3;
      } else {
        x = x === 0 ? w - 1 : x - 1;
        side = 1;
      }
    }
    for (let i = 2; i < pts.length; i += 2) pts[i] = nearX(pts[i], pts[i - 2], W);
    const n = pts.length;
    // 最后一点接回去的是起点的哪一份(差几圈)
    const wrap = Math.round((nearX(pts[0], pts[n - 2], W) - pts[0]) / W);
    if (n >= 6 || wrap) out.push({ pts: Float32Array.from(pts), kind: Uint8Array.from(kinds), wrap });
  };
  for (let rr = 0; rr < R - 1; rr++) {
    for (let x = 0; x < w; x++) {
      const c = caseAt(x, rr);
      if (c === 0 || c === 15) continue;
      for (let side = 0; side < 4; side++) if (MS_OUT[c * 4 + side] >= 0 && !visited[edgeOf(x, rr, side)]) walk(x, rr, side);
    }
  }
  return out;
}

/**
 * 首尾相接的折线(最后一点接回第一点 + (shift, 0))Chaikin 抹平一遍。段标记跟着走:
 * 原来第 i 段中间那一截照旧,拐角切出来的那一小截两边有一边描就描
 */
function chaikinLoop(p: Float32Array, seg: Uint8Array, shift: number): { pts: Float32Array; seg: Uint8Array } {
  const n = p.length / 2;
  if (n < 3) return { pts: p, seg };
  const out = new Float32Array(n * 4);
  const os = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const bx = p[j * 2] + (j === 0 ? shift : 0);
    const by = p[j * 2 + 1];
    out[i * 4] = 0.75 * ax + 0.25 * bx;
    out[i * 4 + 1] = 0.75 * ay + 0.25 * by;
    out[i * 4 + 2] = 0.25 * ax + 0.75 * bx;
    out[i * 4 + 3] = 0.25 * ay + 0.75 * by;
    os[i * 2] = seg[i];
    os[i * 2 + 1] = seg[i] | seg[j];
  }
  return { pts: out, seg: os };
}

/**
 * 两个相邻海面像素(一个结冰、一个没结)之间冰缘的位置(从 ka 量起的比例):在"冰像素 + 3×3 结冰比例(只数海面,同像素层的 B)"
 * 的场上取 0.5 处 —— 直的冰缘正好在两个像素中间(像素层冰缘墨线最浓的地方),凸角往里收一点、凹角往外鼓一点
 */
function iceCross(r: Pick<Raster, 'w' | 'h' | 'water'>, iceM: Uint8Array): (ka: number, kb: number) => number {
  const { w, h, water } = r;
  const f = (k: number) => {
    const x = k % w;
    const y = (k - x) / w;
    let sum = 0;
    let cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const q = yy * w + (x + dx < 0 ? x + dx + w : x + dx >= w ? x + dx - w : x + dx);
        if (water[q] !== 1) continue;
        sum += iceM[q];
        cnt++;
      }
    }
    return (iceM[k] + (cnt ? sum / cnt : iceM[k])) / 2;
  };
  return (ka, kb) => {
    const fa = f(ka);
    const fb = f(kb);
    return Math.max(0.02, Math.min(0.98, (0.5 - fa) / (fb - fa)));
  };
}

/** 二值图往外扩 R 格(切比雪夫距离;东西相连,上下不出图) */
function dilateWrap(m: Uint8Array, w: number, h: number, R: number): Uint8Array {
  // 先横着扩(窗口里数有几格,滑过去加一格减一格),再竖着扩(每列数窗口里那几行)
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (2 * R + 1 >= w) {
      let any = 0;
      for (let x = 0; x < w; x++) any |= m[row + x];
      tmp.fill(any, row, row + w);
      continue;
    }
    let cnt = 0;
    for (let dx = -R; dx <= R; dx++) cnt += m[row + ((dx + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = cnt ? 1 : 0;
      cnt += m[row + ((x + R + 1) % w)] - m[row + ((x - R + w) % w)];
    }
  }
  const out = new Uint8Array(w * h);
  const cnt = new Int32Array(w);
  for (let y = 0; y < Math.min(R, h); y++) for (let x = 0; x < w; x++) cnt[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    if (y + R < h) for (let x = 0, o = (y + R) * w; x < w; x++) cnt[x] += tmp[o + x];
    if (y - R - 1 >= 0) for (let x = 0, o = (y - R - 1) * w; x < w; x++) cnt[x] -= tmp[o + x];
    for (let x = 0, o = y * w; x < w; x++) out[o + x] = cnt[x] ? 1 : 0;
  }
  return out;
}

/**
 * 冰的分界线(冰在左手边),抹平两遍。像素图上冰 / 水之间的交点按"冰像素 + 3×3 结冰比例"的场插值
 * (和像素层冰缘墨线的位置一致:直的冰缘正好在两个像素中间,凸角往里收一点;零星的一两格浮冰照样圈出来),
 * 冰 / 陆地之间取中点(那几段不描线,冰面填色在陆地那一侧的海岸墨线底下收住)
 */
export function iceLines(r: Pick<Raster, 'w' | 'h' | 'scale' | 'water'>, iceM: Uint8Array): OrientedLine[] {
  const { w, water } = r;
  const iceAt = iceCross(r, iceM);
  const cross = (ka: number, kb: number) => (water[ka] !== 1 || water[kb] !== 1 ? 0.5 : iceAt(ka, kb));
  const kind = (ka: number, kb: number) => (water[iceM[ka] ? kb : ka] === 1 ? EDGE_SEA : EDGE_LAND);
  return traceOriented(r, iceM, cross, kind).map(({ pts, kind: kd, wrap }) => {
    const n = kd.length;
    let seg = new Uint8Array(n);
    // 一段两头有一头挨着没结冰的海面就描(冰缘线一直描到海岸线上)
    for (let i = 0; i < n; i++) seg[i] = kd[i] === EDGE_SEA || kd[(i + 1) % n] === EDGE_SEA ? 1 : 0;
    let p = pts;
    const shift = wrap * (w / r.scale);
    for (let pass = 0; pass < 2; pass++) ({ pts: p, seg } = chaikinLoop(p, seg, shift));
    return { pts: p, ink: seg, wrap };
  });
}

/** 折线外框(x0, y0, x1, y1;绕一圈的线算一个周期,含接回去的那一点) */
function lineBox(l: Pick<OrientedLine, 'pts' | 'wrap'>, W: number): [number, number, number, number] {
  const p = l.pts;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const ex = p[0] + l.wrap * W;
  return [Math.min(x0, ex), y0, Math.max(x1, ex), y1];
}

/**
 * 多边形(x, y 交错,首尾自动相连)按一条直线(axis = 0:x = lim;1:y = lim)裁剪,留 ≥ lim(ge)或 ≤ lim 那一边
 * (Sutherland–Hodgman 的一步:留下的那一边里每一点的环绕数不变,伸出去的部分换成沿直线走,来回重叠的边互相抵消)。
 * 沿直线走的每一段都在多边形和这条直线的所有交点处断开(两边裁出来的一样):同一条线切开的两半,沿线的边一小段一小段
 * 端点完全相同、方向相反 —— 拼在一起填色时正好抵消,投影成弯的以后也一样(见 projTilePolys)
 */
function clipHalf(cur: ArrayLike<number>, axis: number, lim: number, ge: boolean): number[] {
  const n = cur.length / 2;
  const out: number[] = [];
  if (n < 3) return out;
  const o = 1 - axis;
  const sgn = ge ? 1 : -1;
  // 第 h 点 → 第 i 点这一段和直线的交点(沿直线的那个坐标;端点正好在线上就是那个端点)
  const cross = (h: number, i: number) => {
    const da = cur[h * 2 + axis] - lim;
    const db = cur[i * 2 + axis] - lim;
    if (da === 0) return cur[h * 2 + o];
    if (db === 0) return cur[i * 2 + o];
    return cur[h * 2 + o] + (cur[i * 2 + o] - cur[h * 2 + o]) * (da / (da - db));
  };
  // 直线上的点:跨过去的交点、正好在线上的顶点(和留哪一边无关),沿直线排好
  const on: number[] = [];
  for (let i = 0, h = n - 1; i < n; h = i++) {
    const da = cur[h * 2 + axis] - lim;
    const db = cur[i * 2 + axis] - lim;
    if (db === 0) on.push(cur[i * 2 + o]);
    else if (da !== 0 && da < 0 !== db < 0) on.push(cross(h, i));
  }
  on.sort((p, q) => p - q);
  const push = (u: number) => out.push(axis === 0 ? lim : u, axis === 1 ? lim : u);
  // 沿直线从 u0 走到 u1:中间经过的交点都补上
  const along = (u0: number, u1: number) => {
    if (u0 < u1) {
      for (const u of on) if (u > u0 && u < u1) push(u);
    } else for (let k = on.length - 1; k >= 0; k--) if (on[k] < u0 && on[k] > u1) push(on[k]);
  };
  let exit = NaN;
  let first = NaN;
  let bi = sgn * (cur[(n - 1) * 2 + axis] - lim) >= 0;
  for (let i = 0, h = n - 1; i < n; h = i++) {
    const ai = bi;
    bi = sgn * (cur[i * 2 + axis] - lim) >= 0;
    // 第 h 点 → 第 i 点这一段:跨过直线就补交点(出去时记下,回来时沿直线接上),第 i 点在留下的一边就留
    if (ai !== bi) {
      const u = cross(h, i);
      if (bi) {
        if (!Number.isNaN(exit)) along(exit, u);
        else if (Number.isNaN(first)) first = u;
        exit = NaN;
        push(u);
      } else {
        push(u);
        exit = u;
      }
    }
    if (bi) out.push(cur[i * 2], cur[i * 2 + 1]);
  }
  // 最后一次出去、绕回开头第一次回来的那一段
  if (!Number.isNaN(exit) && !Number.isNaN(first)) along(exit, first);
  return out;
}

/** 多边形按矩形 [x0, x1] × [y0, y1] 裁剪:矩形里每一点的环绕数不变(见 clipHalf) */
export function clipLoopRect(p: ArrayLike<number>, x0: number, y0: number, x1: number, y1: number): number[] {
  return clipHalf(clipHalf(clipHalf(clipHalf(p, 0, x0, true), 0, x1, false), 1, y0, true), 1, y1, false);
}

/**
 * 填色范围拼成闭合多边形(世界坐标;按非零环绕规则填 = 在 lines 的左手边),整体平移 (ddx, ddy):
 * 环摆几份,盖住一圈 [0, W];绕地球一圈的线(冰盖边,以及冰挨着地图上下边时的那条边)按走向接上几份、盖住 [−W, 2W],
 * 再从地图下边以外绕回来 —— 每条就是"线以下"的一整片(往东、往西的正负相反),几条叠起来正好是冰的范围。
 * 之后按格子裁到地图里(见 tileLoops)
 */
export function fillLoops(lines: Pick<OrientedLine, 'pts' | 'wrap'>[], W: number, H: number, ddx = 0, ddy = 0): Float64Array[] {
  const out: Float64Array[] = [];
  for (const l of lines) {
    const [bx0, by0, bx1] = lineBox(l, W);
    const p = l.pts;
    const n = p.length / 2;
    if (!l.wrap) {
      for (let dx = Math.ceil((-ddx - bx1) / W) * W; bx0 + dx + ddx <= W; dx += W) {
        const loop = new Float64Array(p.length);
        for (let i = 0; i < n; i++) {
          loop[i * 2] = p[i * 2] + dx + ddx;
          loop[i * 2 + 1] = p[i * 2 + 1] + ddy;
        }
        out.push(loop);
      }
      continue;
    }
    if (by0 + ddy > H) continue;
    const kLo = Math.ceil((-W - ddx - bx1) / W);
    const kHi = Math.floor((2 * W - ddx - bx0) / W);
    const order: number[] = [];
    for (let k = kLo; k <= kHi; k++) order.push(k);
    if (l.wrap < 0) order.reverse();
    const loop: number[] = [];
    for (const k of order) for (let i = 0; i < n; i++) loop.push(p[i * 2] + k * W + ddx, p[i * 2 + 1] + ddy);
    const last = order[order.length - 1];
    loop.push(p[0] + (last + l.wrap) * W + ddx, p[1] + ddy);
    const ex = loop[loop.length - 2];
    loop.push(ex, H + 1, loop[0], H + 1);
    out.push(Float64Array.from(loop));
  }
  return out;
}

/** 填色多边形按格子切开(世界坐标):格子 (c, r) 是 [x0 + c·tw, x0 + (c + 1)·tw] × [y0 + r·th, …] */
export interface TileGrid {
  x0: number;
  y0: number;
  tw: number;
  th: number;
  nc: number;
  nr: number;
}

/** 抽稀时一段多少个点:一段一段做 Douglas–Peucker(接头的点留着);整条长线一起做要慢很多 */
const SIMPLIFY_RUN = 128;

/**
 * 首尾相接的线按 tol 抽稀(同 simplifyLine,每 SIMPLIFY_RUN 个点一段)。首点留着、最后接回去的还是首点(绕一圈的平移一整圈),
 * 所以绕一圈的线抽稀后一份一份照样接得上
 */
export function simplifyOriented(l: Pick<OrientedLine, 'pts' | 'wrap'>, W: number, tol: number): Pick<OrientedLine, 'pts' | 'wrap'> {
  if (tol <= 0) return l;
  const q = closedPts(l, W);
  const m = q.length / 2;
  const out: number[] = [];
  for (let a = 0; a < m - 1; a += SIMPLIFY_RUN) {
    const b = Math.min(m - 1, a + SIMPLIFY_RUN);
    const s = simplifyLine(q.subarray(a * 2, b * 2 + 2), tol);
    // 末点是下一段的首点(最后一段的末点 = 接回去的首点),不重复
    for (let i = 0; i < s.length - 2; i++) out.push(s[i]);
  }
  // 一格的零星浮冰圈得很小(直径不到半格),容差大时会抽成一个点:这种小环照原样留着,不抽没
  if (!l.wrap && out.length < 6) return l;
  return { pts: Float32Array.from(out), wrap: l.wrap };
}

/**
 * 多边形切进格子:每格一批多边形,格子里每一点的环绕数和原来一样(Sutherland–Hodgman,对半切下去),
 * 伸出整个格子范围的部分不要。相邻两格共用的那条格子边上,两边各有一段方向相反的边,拼进同一条路径填色时互相抵消
 */
export function tileLoops(loops: ArrayLike<number>[], g: TileGrid): number[][][] {
  const out: number[][][] = Array.from({ length: g.nc * g.nr }, () => []);
  const rec = (p: number[], c0: number, c1: number, r0: number, r1: number) => {
    if (p.length < 6) return;
    if (c1 - c0 === 1 && r1 - r0 === 1) {
      out[r0 * g.nc + c0].push(p);
      return;
    }
    if (c1 - c0 >= r1 - r0) {
      const cm = (c0 + c1) >> 1;
      const lim = g.x0 + cm * g.tw;
      rec(clipHalf(p, 0, lim, false), c0, cm, r0, r1);
      rec(clipHalf(p, 0, lim, true), cm, c1, r0, r1);
    } else {
      const rm = (r0 + r1) >> 1;
      const lim = g.y0 + rm * g.th;
      rec(clipHalf(p, 1, lim, false), c0, c1, r0, rm);
      rec(clipHalf(p, 1, lim, true), c0, c1, rm, r1);
    }
  };
  for (const q of loops) {
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (let i = 0; i < q.length; i += 2) {
      if (q[i] < bx0) bx0 = q[i];
      if (q[i] > bx1) bx1 = q[i];
      if (q[i + 1] < by0) by0 = q[i + 1];
      if (q[i + 1] > by1) by1 = q[i + 1];
    }
    const clampC = (x: number) => Math.max(0, Math.min(g.nc - 1, Math.floor((x - g.x0) / g.tw)));
    const clampR = (y: number) => Math.max(0, Math.min(g.nr - 1, Math.floor((y - g.y0) / g.th)));
    if (bx1 < g.x0 || by1 < g.y0 || bx0 > g.x0 + g.nc * g.tw || by0 > g.y0 + g.nr * g.th) continue;
    const c0 = clampC(bx0);
    const c1 = clampC(bx1) + 1;
    const r0 = clampR(by0);
    const r1 = clampR(by1) + 1;
    // 先裁到这几格的范围(也就裁掉了伸出格子范围的部分)
    rec(clipLoopRect(q, g.x0 + c0 * g.tw, g.y0 + r0 * g.th, g.x0 + c1 * g.tw, g.y0 + r1 * g.th), c0, c1, r0, r1);
  }
  return out;
}

/**
 * 范围 [x0, x1] × [y0, y1] 挨着哪些格子:每一份调一次 fn(格子号, 横向平移量)。
 * W > 0:东西相连(等距圆柱,格子正好铺满一圈 x0 = 0、nc·tw = W),伸出左右边的取另一头的格子平移整圈;W = 0:不相连
 */
export function forTilesIn(g: TileGrid, W: number, x0: number, y0: number, x1: number, y1: number, fn: (i: number, dx: number) => void): void {
  const r0 = Math.max(0, Math.floor((y0 - g.y0) / g.th));
  const r1 = Math.min(g.nr - 1, Math.floor((y1 - g.y0) / g.th));
  let ca = Math.floor((x0 - g.x0) / g.tw);
  let cb = Math.floor((x1 - g.x0) / g.tw);
  if (!W) {
    ca = Math.max(0, ca);
    cb = Math.min(g.nc - 1, cb);
  }
  for (let c = ca; c <= cb; c++) {
    const cc = W ? ((c % g.nc) + g.nc) % g.nc : c;
    const dx = (c - cc) * g.tw;
    for (let r = r0; r <= r1; r++) fn(r * g.nc + cc, dx);
  }
}

/**
 * 填色范围的格子(世界坐标,东西相连;每格一批多边形、一条路径)。按 COAST_LOD 每档一份,用到时才做:
 * 分界线先抽稀,再拼成多边形(见 fillLoops)、切进格子
 */
interface FillTiles {
  /** 分界线(填色在左手边)和整体平移(见 fillLoops) */
  lines: OrientedLine[];
  ddx: number;
  ddy: number;
  g: TileGrid;
  /** 世界宽、高 */
  W: number;
  H: number;
  polys: (number[][][] | undefined)[];
  paths: ((Path2D | null)[] | undefined)[];
  /** 弯边投影:按纬度加密好的多边形(每种投影一份,见 projTileGeom) */
  proj: ({ key: string; geom: Float64Array[][] } | undefined)[];
}

/** 格子大约多大(世界单位):放大后视口里只有几格到十几格 */
const FILL_TILE = 128;

function fillTiles(lines: OrientedLine[], W: number, H: number, ddx = 0, ddy = 0): FillTiles {
  const nc = Math.max(1, Math.round(W / FILL_TILE));
  const nr = Math.max(1, Math.round(H / FILL_TILE));
  return { lines, ddx, ddy, g: { x0: 0, y0: 0, tw: W / nc, th: H / nr, nc, nr }, W, H, polys: COAST_LOD.map(() => undefined), paths: COAST_LOD.map(() => undefined), proj: COAST_LOD.map(() => undefined) };
}

function tilePolys(t: FillTiles, lod: number): number[][][] {
  let p = t.polys[lod];
  if (!p) {
    const lines = t.lines.map((l) => simplifyOriented(l, t.W, COAST_LOD[lod]));
    p = t.polys[lod] = tileLoops(fillLoops(lines, t.W, t.H, t.ddx, t.ddy), t.g);
  }
  return p;
}

/** 范围里的填色路径(第 lod 档;世界坐标) */
function tilePathIn(t: FillTiles, lod: number, x0: number, y0: number, x1: number, y1: number): Path2D {
  const ps = (t.paths[lod] ??= tilePolys(t, lod).map((polys) => {
    if (!polys.length) return null;
    const p = new Path2D();
    for (const q of polys) {
      p.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) p.lineTo(q[i], q[i + 1]);
      p.closePath();
    }
    return p;
  }));
  const out = new Path2D();
  forTilesIn(t.g, t.W, x0, y0, x1, y1, (i, dx) => {
    const p = ps[i];
    if (!p) return;
    if (dx) out.addPath(p, { e: dx });
    else out.addPath(p);
  });
  return out;
}

/**
 * 弯边投影:格子里的填色多边形每点记下世界 x、y 和投影里只看纬度的两样:K(y)·2π/W、地图平面 Y ——
 * 和中央经线无关,每种投影算一次;换中心时 x 方向只差一次乘加(见 projTilePolys)。
 * 格子边上的长段不加密:投影后是直的,和真正的经线不重合,但相邻两格沿这条边的那几小段端点完全相同、方向相反
 * (见 clipHalf),拼在一起正好抵消,不露缝;冰缘线本身每段都很短
 */
export function projTileGeom(polys: number[][][], pj: Projector): Float64Array[][] {
  const k2 = (2 * Math.PI) / pj.W;
  return polys.map((ps) =>
    ps.map((c) => {
      const o = new Float64Array(c.length * 2);
      for (let j = 0, k = 0; j < c.length; j += 2) {
        const y = c[j + 1];
        o[k++] = c[j];
        o[k++] = y;
        o[k++] = pj.K(y) * k2;
        o[k++] = pj.Y(y);
      }
      return o;
    }),
  );
}

/**
 * 弯边投影:投影到地图平面后挨着 V = [x0, x1] × [y0, y1] 的填色多边形(geom = projTileGeom 的结果;R = V 从世界上哪一块投过来),
 * 画进 out。挑 R 里的格子,挪到中央经线两边各半圈那一圈;格子投影后的外框碰不到 V 的不要。整格在这一圈里的直接乘加;
 * 碰到这一圈左右边(中央经线对面)的格子先裁掉伸出去的部分,外框上的边加密后投影
 */
export function projTilePolys(geom: Float64Array[][], g: TileGrid, W: number, pj: Projector, R: WorldWindow, x0: number, y0: number, x1: number, y1: number, out: PathSink): void {
  const xc = (pj.mp.lon0 / 360 + 0.5) * W;
  const xa = xc - W / 2;
  const xb = xc + W / 2;
  const k2 = (2 * Math.PI) / W;
  // 地图外框上的边按这个步长加密(两极附近弯得厉害)
  const step = pj.step / 16;
  forTilesIn(g, W, R.x0, R.y0, R.x1, R.y1, (i, dx) => {
    const ps = geom[i];
    if (!ps.length) return;
    const c = i % g.nc;
    const r = (i - c) / g.nc;
    const ta = Math.max(xa, g.x0 + c * g.tw + dx);
    const tb = Math.min(xb, g.x0 + (c + 1) * g.tw + dx);
    if (tb <= ta) return;
    // 格子投影后的外框:Y 随纬度单调;K 两头最小、赤道最大
    const ty0 = g.y0 + r * g.th;
    const ty1 = ty0 + g.th;
    if (pj.Y(ty1) < y0 || pj.Y(ty0) > y1) return;
    const ks = [pj.K(ty0), pj.K(ty1)];
    if (ty0 < pj.H / 2 && ty1 > pj.H / 2) ks.push(pj.K(pj.H / 2));
    let bx0 = Infinity;
    let bx1 = -Infinity;
    for (const K of ks)
      for (const x of [ta, tb]) {
        const X = W / 2 + K * (x - xc) * k2;
        if (X < bx0) bx0 = X;
        if (X > bx1) bx1 = X;
      }
    if (bx1 < x0 - 1 || bx0 > x1 + 1) return;
    // 碰到这一圈左右边(也就是地图外框)的格子要裁、要加密,其余的直接乘加
    const inside = ta > xa && tb < xb;
    for (const q of ps) {
      if (inside) {
        out.moveTo(W / 2 + q[2] * (q[0] + dx - xc), q[3]);
        for (let j = 4; j < q.length; j += 4) out.lineTo(W / 2 + q[j + 2] * (q[j] + dx - xc), q[j + 3]);
        out.closePath();
        continue;
      }
      const p: number[] = [];
      for (let j = 0; j < q.length; j += 4) p.push(q[j] + dx, q[j + 1]);
      const cl = clipHalf(clipHalf(p, 0, xa, true), 0, xb, false);
      const n = cl.length / 2;
      if (n < 3) continue;
      for (let j = 0; j < n; j++) {
        const h = j * 2;
        const e = j + 1 === n ? 0 : h + 2;
        const px = cl[h];
        const py = cl[h + 1];
        // 其余的点和整格的算法一样(同样的乘加顺序),和相邻格子的点完全相同
        const edge = (px === xa && cl[e] === xa) || (px === xb && cl[e] === xb);
        const m = edge ? Math.max(1, Math.ceil(Math.abs(cl[e + 1] - py) / step)) : 1;
        for (let s = 0; s < m; s++) {
          const y = s ? py + ((cl[e + 1] - py) * s) / m : py;
          const X = W / 2 + pj.K(y) * k2 * (px - xc);
          if (j || s) out.lineTo(X, pj.Y(y));
          else out.moveTo(X, pj.Y(y));
        }
      }
      out.closePath();
    }
  });
}

/** 路径的那几样画法(Path2D;测试里记下各点) */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

/** 弯边投影:地图平面 [x0, x1] × [y0, y1] 附近的填色路径(第 lod 档,见 projTilePolys) */
function projFillIn(t: FillTiles, lod: number, pj: Projector, R: WorldWindow, x0: number, y0: number, x1: number, y1: number): Path2D {
  const key = pj.mp.def.id;
  let pre = t.proj[lod];
  if (!pre || pre.key !== key) pre = t.proj[lod] = { key, geom: projTileGeom(tilePolys(t, lod), pj) };
  const out = new Path2D();
  projTilePolys(pre.geom, t.g, t.W, pj, R, x0, y0, x1, y1, out);
  return out;
}

/** 世界上的一块(中央经线两边各半圈以内),和它投影后最多拉长几倍 */
export interface WorldWindow {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stretch: number;
}

/**
 * 弯边投影:地图平面上 [mx0, mx1] × [my0, my1] 这一块是从世界上哪一块投过来的(往外留 1 格),
 * 以及那一块里投影最多把世界上的长度拉长几倍(在世界坐标里抽稀时容差要除以它)。
 * 投影都是"纬线投影后是水平直线":地图平面 y 只看纬度,x = 中线 + K(纬度) × 经度差
 */
export function worldWindow(pj: Projector, mx0: number, my0: number, mx1: number, my1: number): WorldWindow {
  const { W, H } = pj;
  const xc = (pj.mp.lon0 / 360 + 0.5) * W;
  const k2 = (2 * Math.PI) / W;
  const yOf = (my: number) => {
    let a = 0;
    let b = H;
    for (let i = 0; i < 32; i++) {
      const m = (a + b) / 2;
      if (pj.Y(m) < my) a = m;
      else b = m;
    }
    return a;
  };
  const y0 = Math.max(0, yOf(my0) - 1);
  const y1 = Math.min(H, yOf(my1) + 1);
  // 这条纬度带里横向最多拉长、压扁多少:K 两头最小、赤道最大
  const rows = [y0, y1];
  for (let i = 1; i < 32; i++) rows.push(y0 + ((y1 - y0) * i) / 32);
  if (y0 < H / 2 && y1 > H / 2) rows.push(H / 2);
  let rLo = Infinity;
  let rHi = -Infinity;
  for (const y of rows) {
    const K = Math.max(1e-9, pj.K(y));
    for (const mx of [mx0, mx1]) {
      const rel = (mx - W / 2) / K;
      if (rel < rLo) rLo = rel;
      if (rel > rHi) rHi = rel;
    }
  }
  rLo = Math.max(-Math.PI, rLo);
  rHi = Math.min(Math.PI, rHi);
  // 拉长倍数 = 投影导数矩阵 [[K·2π/W, K′·经度差], [0, Y′]] 的最大奇异值
  const relMax = Math.max(Math.abs(rLo), Math.abs(rHi));
  let stretch = 1;
  for (const y of rows) {
    const a = pj.K(y) * k2;
    const b = pj.dK(y) * relMax;
    const d = pj.dY(y);
    const t = a * a + b * b + d * d;
    stretch = Math.max(stretch, Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * a * a * d * d))) / 2));
  }
  return {
    x0: Math.max(xc - W / 2, xc + rLo / k2 - 1),
    y0,
    x1: Math.min(xc + W / 2, xc + rHi / k2 + 1),
    y1,
    stretch,
  };
}

/** 冰缘墨线:比海岸墨线细一点、淡一点;线宽(格,放大后乘 glyphScale)、最浓多少(墨量和像素层那两格宽的冰缘线一样) */
const ICE_LW = 1.5;
const ICE_INK_A = 0.62;
/** 墨线浓淡图的像素比像素图粗几倍(附近结冰比例本来就是粗网格插出来的,平滑) */
const ICE_FADE_STEP = 4;
/**
 * 弯边投影里冰面、背光边范围抽稀的容差(画布像素):冰面的边压在冰缘墨线底下(线宽好几个像素),
 * 比墨线本身(COAST_TOL)松一倍也看不出来,点数少很多(转中心时每次都要重新投影)
 */
const ICE_FILL_TOL = 2 * COAST_TOL;

/** 冰面东南侧背光边:宽几格、排线间隔几格(同像素层;间隔取图宽的约数,左右对得上) */
const iceRimOf = (S: number) => Math.max(2, Math.round(2.5 * S));
function iceHatchOf(w: number, S: number): number {
  let n = Math.max(3, Math.round(3 * S));
  while (w % n) n++;
  return n;
}

interface IceGeo {
  raster: Raster;
  /** 冰的分界线(冰在左手边) */
  fill: OrientedLine[];
  /** 冰面填色范围按格子切(世界坐标,一圈;用到哪一档才切哪一档) */
  fillT: FillTiles;
  /** 冰缘墨线(要描的那几截),切成小段 */
  ink: CoastChunks;
  /** 背光边排线要躲开的范围:冰 + 冰附近的陆地(往西北挪一个背光边宽后,冰面里没被它盖住的那一条就是背光边) */
  shade: OrientedLine[];
  /** 同上,往西北挪一个背光边宽、按格子切 */
  shadeT: FillTiles;
  /** 背光边的斜排线:shade 的每一小段附近一批(x0, y0, x1, y1 交错,世界坐标),切成小段 */
  hatch: CoastChunks;
  /** 墨线浓淡图(颜色 = 冰缘墨色,透明度 = 浓淡;比像素图粗 ICE_FADE_STEP 倍) */
  inkFade: AnyCanvas;
  pats: { face: CanvasPattern; ink: CanvasPattern } | null;
}
let iceGeo: IceGeo | null = null;

/** 一条首尾相接的线展开成一段折线(首点重复在末尾,绕一圈的末点平移一整圈) */
function closedPts(l: Pick<OrientedLine, 'pts' | 'wrap'>, W: number): Float32Array {
  const p = l.pts;
  const q = new Float32Array(p.length + 2);
  q.set(p);
  q[p.length] = p[0] + l.wrap * W;
  q[p.length + 1] = p[1];
  return q;
}

/** 线上要描墨线的那几截(连续的段;x 接着展开) */
export function inkRuns(l: OrientedLine, W: number): Float32Array[] {
  const n = l.ink.length;
  const p = closedPts(l, W);
  let s = 0;
  while (s < n && l.ink[s]) s++;
  if (s === n) return [p];
  // 从一段不描的后面起转一圈(跨过首尾的那一截不断开:转过一圈的点平移 wrap 圈)
  const out: Float32Array[] = [];
  let run: number[] | null = null;
  for (let u = s + 1; u <= s + n; u++) {
    const i = u % n;
    if (l.ink[i]) {
      const dx = Math.floor(u / n) * l.wrap * W;
      if (!run) run = [p[i * 2] + dx, p[i * 2 + 1]];
      run.push(p[i * 2 + 2] + dx, p[i * 2 + 3]);
    } else if (run) {
      out.push(Float32Array.from(run));
      run = null;
    }
  }
  if (run) out.push(Float32Array.from(run));
  return out;
}

/** 斜排线(x + y = 常数,间隔 gap)落在框 [x0, x1] × [y0, y1] 里的那几截,追加到 out(x0, y0, x1, y1 交错) */
function diagonalsIn(out: number[], x0: number, y0: number, x1: number, y1: number, gap: number, phase: number): void {
  for (let c = Math.ceil((x0 + y0 - phase) / gap) * gap + phase; c <= x1 + y1; c += gap) {
    // 线 y = c − x 和框的交:x 在 [max(x0, c − y1), min(x1, c − y0)]
    const a = Math.max(x0, c - y1);
    const b = Math.min(x1, c - y0);
    if (b > a) out.push(a, c - a, b, c - b);
  }
}

function iceGeoOf(world: World, r: Raster): IceGeo | null {
  fantasyBase(world, r);
  if (iceGeo?.raster === r) return iceGeo;
  if (iceGeo) iceGeo.inkFade.width = iceGeo.inkFade.height = 0;
  iceGeo = null;
  const { w, h, water, scale: S } = r;
  const { mask: iceM, near } = seaIceField(r);
  let any = false;
  for (let k = 0; k < w * h && !any; k++) if (iceM[k]) any = true;
  if (!any) return null;
  const W = w / S;
  const fill = iceLines(r, iceM);
  // 背光边要躲开的:冰 + 冰附近(背光边宽 + 1 格以内)的陆地、湖。冰 / 水之间同冰缘线,陆地 / 水之间同海岸线(海拔过零处)
  const rimD = iceRimOf(S);
  const nearIce = dilateWrap(iceM, w, h, rimD + 1);
  const shadeM = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) shadeM[k] = iceM[k] || (water[k] !== 1 && nearIce[k]) ? 1 : 0;
  const iceAt = iceCross(r, iceM);
  const coastAt = elevCross(r.elev);
  const shadeRaw = traceOriented(
    r,
    shadeM,
    (ka, kb) => {
      const sa = water[ka] === 1;
      const sb = water[kb] === 1;
      return sa && sb ? iceAt(ka, kb) : sa !== sb ? coastAt(ka, kb) : 0.5;
    },
    () => EDGE_LAND,
  );
  const shade: OrientedLine[] = shadeRaw.map(({ pts, kind, wrap }) => {
    let p = pts;
    let seg = new Uint8Array(kind.length);
    for (let pass = 0; pass < 2; pass++) ({ pts: p, seg } = chaikinLoop(p, seg, wrap * W));
    return { pts: p, ink: seg, wrap };
  });
  // 背光边排线:shade 每一小段的外框往西北扩一个背光边宽,框里的斜线(x + y = 间隔 × m + 1 格,同像素层);
  // 离地图下边不到一个背光边宽的不画(像素层那里往东南挪就出图了,没有背光边)
  const d = rimD / S;
  const H = h / S;
  const gap = iceHatchOf(w, S) / S;
  const shadeChunks = coastChunks(shade.map((l) => closedPts(l, W)));
  const hatchSegs: Float32Array[] = [];
  for (let j = 0; j < shadeChunks.pts.length; j++) {
    const o = j * 4;
    const b = shadeChunks.box;
    const segs: number[] = [];
    diagonalsIn(segs, b[o] - d, b[o + 1] - d, b[o + 2], Math.min(b[o + 3], H - d), gap, 1 / S);
    if (segs.length) hatchSegs.push(Float32Array.from(segs));
  }
  // 排线按"线段"切小段:每批一段(外框就是那个框)
  const hatch = segChunks(hatchSegs);
  // 墨线浓淡:附近结冰比例小的零星碎冰处淡(同像素层)
  const fw = Math.ceil(w / ICE_FADE_STEP);
  const fh = Math.ceil(h / ICE_FADE_STEP);
  const img = new ImageData(fw, fh);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const px = Math.min(w - 1, Math.floor(((x + 0.5) * w) / fw));
      const py = Math.min(h - 1, Math.floor(((y + 0.5) * h) / fh));
      const nq = near[py * w + px];
      const conc = nq > 0 ? (nq - 1) / 254 : 0;
      const o = (y * fw + x) * 4;
      img.data[o] = ICE_INK[0];
      img.data[o + 1] = ICE_INK[1];
      img.data[o + 2] = ICE_INK[2];
      img.data[o + 3] = Math.round(255 * (0.4 + 0.6 * smoothstep(0.1, 0.6, conc)));
    }
  const inkFade = makeCanvas(fw, fh);
  (inkFade.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  iceGeo = {
    raster: r,
    fill,
    fillT: fillTiles(fill, W, H),
    ink: coastChunks(fill.flatMap((l) => inkRuns(l, W))),
    shade,
    shadeT: fillTiles(shade, W, H, -d, -d),
    hatch,
    inkFade,
    pats: null,
  };
  return iceGeo;
}

/** 一批批线段(x0, y0, x1, y1 交错)当小段:外框按线段算(用 forChunksIn 挑) */
function segChunks(batches: Float32Array[]): CoastChunks {
  const box: number[] = [];
  for (const s of batches) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < s.length; i += 2) {
      if (s[i] < x0) x0 = s[i];
      if (s[i] > x1) x1 = s[i];
      if (s[i + 1] < y0) y0 = s[i + 1];
      if (s[i + 1] > y1) y1 = s[i + 1];
    }
    box.push(x0, y0, x1, y1);
  }
  return { pts: batches, box: Float32Array.from(box), path: COAST_LOD.map(() => new Array(batches.length)) };
}

/** 斜排线小段拼成一条路径(范围里一段都没有:null) */
function hatchPathIn(c: CoastChunks, W: number, x0: number, y0: number, x1: number, y1: number): Path2D | null {
  const out = new Path2D();
  let any = false;
  forChunksIn(c, W, x0, y0, x1, y1, (j, dx) => {
    any = true;
    const s = c.pts[j];
    for (let i = 0; i < s.length; i += 4) {
      out.moveTo(s[i] + dx, s[i + 1]);
      out.lineTo(s[i + 2] + dx, s[i + 3]);
    }
  });
  return any ? out : null;
}

/**
 * 弯边投影:视口附近的冰面范围、背光边要躲开的范围、墨线、排线投影到地图平面,冰面色、浓淡图按投影重铺那一块
 * (按投影 + 中心 + 那一块地图平面范围一份;拖动时转中心每次都换,所以只投影看得见的那一块)
 */
let iceProj: {
  raster: Raster;
  key: string;
  /** 墨线、填色范围的抽稀档 */
  lod: number;
  lodF: number;
  /** 盖住的地图平面范围 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill: Path2D;
  /** 背光边要躲开的范围(视口里有排线才要,用到时才投影) */
  shade: () => Path2D;
  ink: Path2D;
  hatch: Path2D | null;
  /** 冰面色、浓淡图重铺的那一块(左上角在地图平面上的位置) */
  face: { cv: AnyCanvas; ox: number; oy: number };
  inkFade: { cv: AnyCanvas; ox: number; oy: number };
  pats: { face: CanvasPattern; ink: CanvasPattern } | null;
} | null = null;

function releaseIceProj(): void {
  if (!iceProj) return;
  iceProj.face.cv.width = iceProj.face.cv.height = iceProj.inkFade.cv.width = iceProj.inkFade.cv.height = 0;
  iceProj = null;
}

/**
 * 弯边投影:铺满世界的图 src(sw × sh)按投影重铺到地图平面 [x0, x1] × [y0, y1] 这一块(往外对齐到像素),
 * 一个像素 = 地图平面 1 / px;返回画布和它左上角在地图平面上的位置
 */
function reprojWindow(src: AnyCanvas, sw: number, sh: number, mp: MapProj, px: number, x0: number, y0: number, x1: number, y1: number): { cv: AnyCanvas; ox: number; oy: number } {
  const gx = Math.floor(x0 * px);
  const gy = Math.floor(y0 * px);
  const cv = makeCanvas(Math.max(1, Math.ceil(x1 * px) - gx), Math.max(1, Math.ceil(y1 * px) - gy));
  reprojectImage(cv.getContext('2d') as CanvasRenderingContext2D, src, sw, sh, mp, { s: px, ox: -gx, oy: -gy }, 'low');
  return { cv, ox: gx / px, oy: gy / px };
}

/** 弯边投影:地图平面 [x0, x1] × [y0, y1] 这一块里的冰(墨线按第 lod 档、冰面范围按第 lodF 档抽稀;R = 它从世界上哪一块投过来) */
function iceProjOf(world: World, r: Raster, g: IceGeo, pj: Projector, lod: number, lodF: number, R: WorldWindow, x0: number, y0: number, x1: number, y1: number): NonNullable<typeof iceProj> {
  const S = r.scale;
  const W = r.w / S;
  const H = r.h / S;
  const unit = { s: 1, ox: 0, oy: 0 };
  // 冰面色、浓淡图:只重铺这一块(地图平面裁到地图里)
  const mx0 = Math.max(0, x0);
  const my0 = Math.max(0, y0);
  const mx1 = Math.min(W, Math.max(mx0, x1));
  const my1 = Math.min(H, Math.max(my0, y1));
  const face = reprojWindow(fantasyIceFace(world, r), r.w, r.h, pj.mp, S, mx0, my0, mx1, my1);
  const fw = g.inkFade.width;
  const fade = reprojWindow(g.inkFade, fw, g.inkFade.height, pj.mp, fw / W, mx0, my0, mx1, my1);
  // 墨线、排线:挑出挨着 R 的小段逐点投影(一小段可能伸出 R 好几份,只投一次)
  const tol = COAST_LOD[lod];
  const ink = new Path2D();
  const seen = new Uint8Array(g.ink.pts.length);
  forChunksIn(g.ink, W, R.x0, R.y0, R.x1, R.y1, (j) => {
    if (seen[j]) return;
    seen[j] = 1;
    for (const q of projectLinePts(simplifyLine(g.ink.pts[j], tol), 2, pj, unit)) {
      ink.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) ink.lineTo(q[i], q[i + 1]);
    }
  });
  let hatch: Path2D | null = null;
  const seenH = new Uint8Array(g.hatch.pts.length);
  forChunksIn(g.hatch, W, R.x0, R.y0, R.x1, R.y1, (j) => {
    if (seenH[j]) return;
    seenH[j] = 1;
    const s = g.hatch.pts[j];
    // 斜线投影后是弯的:加密得比岸线细一些
    for (let i = 0; i < s.length; i += 4)
      for (const q of projectLinePts([s[i], s[i + 1], s[i + 2], s[i + 3]], 2, pj, unit, pj.step / 4)) {
        hatch ??= new Path2D();
        hatch.moveTo(q[0], q[1]);
        for (let k = 2; k < q.length; k += 2) hatch.lineTo(q[k], q[k + 1]);
      }
  });
  let shade: Path2D | undefined;
  return {
    raster: r,
    key: pj.mp.key,
    lod,
    lodF,
    x0,
    y0,
    x1,
    y1,
    fill: projFillIn(g.fillT, lodF, pj, R, x0, y0, x1, y1),
    shade: () => (shade ??= projFillIn(g.shadeT, lodF, pj, R, x0, y0, x1, y1)),
    ink,
    hatch,
    face,
    inkFade: fade,
    pats: null,
  };
}

/**
 * 放大后的海冰(代替像素层里的冰缘墨线、冰面填色、背光边排线;像素层放大后是一格一格的台阶):
 * 冰面按冰缘线围成的范围取冰面色那一张(底图在冰缘带里是没结冰的海色)—— 冰、水正好在线下分界,不从线两边露出格子;
 * 背光边 = 冰面里、往东南挪一个背光边宽就到了开阔海面的那一条:淡蓝灰斜排线;
 * 最后描冰缘墨线(浓淡按附近结冰比例,零星碎冰处淡)。线宽、排线宽放大后按 glyphScale 收。画在波纹之后、海岸墨线之前。
 * 填色范围事先按格子切好(世界坐标,见 tileLoops),每次只拼视口附近的几格(整圈的冰盖边很长,整条填一遍很费):
 *   等距圆柱:世界坐标;东西相连,伸出左右边的在另一边再画一份
 *   弯边投影(v.proj):视口附近的格子、墨线、排线逐点投影(见 iceProjOf)
 */
export function drawFantasyIce(ctx: CanvasRenderingContext2D, world: World, r: Raster, v: VecView): void {
  const g = iceGeoOf(world, r);
  if (!g) return;
  const S = r.scale;
  const gs = glyphScale(v.k);
  const pj = v.proj;
  const W = r.w / S;
  let lod = 0;
  while (lod + 1 < COAST_LOD.length && COAST_LOD[lod + 1] * v.s <= COAST_TOL) lod++;
  const pad = ICE_LW * gs + COAST_LOD[lod] + 1;
  const x0 = -v.ox / v.s - pad;
  const y0 = -v.oy / v.s - pad;
  const x1 = (ctx.canvas.width - v.ox) / v.s + pad;
  const y1 = (ctx.canvas.height - v.oy) / v.s + pad;
  let fill: Path2D;
  let shade: () => Path2D;
  let ink: Path2D;
  let hatch: Path2D | null;
  let pats: { face: CanvasPattern; ink: CanvasPattern };
  if (pj) {
    // 世界坐标里抽稀:容差按投影拉长的倍数收
    const R = worldWindow(pj, x0, y0, x1, y1);
    const lodOf = (tol: number) => {
      let l = 0;
      while (l + 1 < COAST_LOD.length && COAST_LOD[l + 1] * v.s * R.stretch <= tol) l++;
      return l;
    };
    const lw = lodOf(COAST_TOL);
    const lf = lodOf(ICE_FILL_TOL);
    const c = iceProj;
    if (!c || c.raster !== r || c.key !== pj.mp.key || c.lod > lw || c.lodF > lf || c.x0 > x0 || c.y0 > y0 || c.x1 < x1 || c.y1 < y1) {
      releaseIceProj();
      iceProj = iceProjOf(world, r, g, pj, lw, lf, R, x0, y0, x1, y1);
    }
    const p = iceProj!;
    p.pats ??= {
      face: fadePattern(ctx, p.face.cv, 1 / S, 'no-repeat', p.face.ox, p.face.oy),
      ink: fadePattern(ctx, p.inkFade.cv, W / g.inkFade.width, 'no-repeat', p.inkFade.ox, p.inkFade.oy),
    };
    ({ fill, ink, hatch, pats } = p);
    shade = p.shade;
  } else {
    g.pats ??= {
      face: fadePattern(ctx, fantasyIceFace(world, r), 1 / S, 'repeat-x'),
      ink: fadePattern(ctx, g.inkFade, W / g.inkFade.width, 'repeat'),
    };
    pats = g.pats;
    fill = tilePathIn(g.fillT, lod, x0, y0, x1, y1);
    shade = () => tilePathIn(g.shadeT, lod, x0, y0, x1, y1);
    ink = chunkPath(g.ink, lod, W, x0, y0, x1, y1);
    hatch = hatchPathIn(g.hatch, W, x0, y0, x1, y1);
  }
  ctx.save();
  ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  // 冰面
  ctx.fillStyle = pats.face;
  ctx.fill(fill);
  if (hatch) {
    // 背光边:冰面里、减去"往西北挪一个背光边宽的冰 + 附近陆地"
    ctx.save();
    ctx.clip(fill);
    const outside = new Path2D();
    outside.rect(x0, y0, x1 - x0, y1 - y0);
    outside.addPath(shade());
    ctx.clip(outside, 'evenodd');
    ctx.strokeStyle = `rgba(${ICE_SHADOW[0]},${ICE_SHADOW[1]},${ICE_SHADOW[2]},0.42)`;
    ctx.lineWidth = (0.6 * gs) / S;
    ctx.lineCap = 'butt';
    ctx.stroke(hatch);
    ctx.restore();
  }
  // 冰缘墨线
  ctx.strokeStyle = pats.ink;
  ctx.globalAlpha = ICE_INK_A;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = (ICE_LW * gs) / S;
  ctx.stroke(ink);
  ctx.restore();
}

/** 一张图当填色 / 描线的图案:图的一个像素 = 世界(地图平面)px 个单位,左上角在 (ox, oy) */
function fadePattern(ctx: CanvasRenderingContext2D, cv: AnyCanvas, px: number, rep: 'repeat' | 'repeat-x' | 'no-repeat', ox = 0, oy = 0): CanvasPattern {
  const p = ctx.createPattern(cv, rep)!;
  p.setTransform(new DOMMatrix([px, 0, 0, px, ox, oy]));
  return p;
}

/** 弯边投影的符号层(缩放 1 倍,和地图平面一样大;林块、河、山……,不含海岸):地形图贴它,文明层按它的形状"让位" */
let projSym: { raster: Raster; key: string; canvas: AnyCanvas; ink: { key: string; hard: AnyCanvas; soft: AnyCanvas } | null } | null = null;

export function fantasySymbolLayerProj(world: World, r: Raster, mp: MapProj): AnyCanvas {
  if (projSym && projSym.raster === r && projSym.key === mp.key) return projSym.canvas;
  const cv = projSym && projSym.canvas.width === r.w && projSym.canvas.height === r.h ? projSym.canvas : makeCanvas(r.w, r.h);
  if (projSym && projSym.canvas !== cv) {
    projSym.canvas.width = projSym.canvas.height = 0;
  }
  if (projSym?.ink) projSym.ink.hard.width = projSym.ink.hard.height = projSym.ink.soft.width = projSym.ink.soft.height = 0;
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, r.w, r.h);
  const v = { s: r.scale, ox: 0, oy: 0, k: 1, proj: projector(mp) };
  ctx.save();
  clipOutline(ctx, mp, v);
  drawFantasyVectors(ctx, world, v);
  ctx.restore();
  projSym = { raster: r, key: mp.key, canvas: cv, ink: null };
  return cv;
}

/**
 * 弯边投影下文明层的"让位"遮罩(和 fantasyInkMask 同一套分档,只是按投影后的符号层算):
 * 两张和地图平面一样大的画布,透明度 = hard / soft(见 InkMask)。文明层拿它们在显卡上合成(render/civ/territory.ts)
 */
export function fantasyInkProj(world: World, r: Raster, mp: MapProj, forest: number, paper: number): { hard: AnyCanvas; soft: AnyCanvas } {
  const cv = fantasySymbolLayerProj(world, r, mp);
  const key = `${forest}|${paper}`;
  if (projSym!.ink?.key === key) return projSym!.ink;
  const px = (cv.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, r.w, r.h).data;
  const hi = new ImageData(r.w, r.h);
  const si = new ImageData(r.w, r.h);
  const hd = hi.data;
  const sd = si.data;
  const N = r.w * r.h;
  for (let k = 0; k < N; k++) {
    const o = k * 4;
    const a = px[o + 3];
    if (!a) continue;
    const lum = 0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2];
    const tInk = lum <= 95 ? 1 : lum >= 125 ? 0 : (125 - lum) / 30;
    const wgt = lum <= 165 ? forest : lum >= 205 ? paper : forest + ((paper - forest) * (lum - 165)) / 40;
    hd[o + 3] = a * tInk;
    sd[o + 3] = a * (1 - tInk) * wgt;
  }
  const hard = makeCanvas(r.w, r.h);
  const soft = makeCanvas(r.w, r.h);
  (hard.getContext('2d') as CanvasRenderingContext2D).putImageData(hi, 0, 0);
  (soft.getContext('2d') as CanvasRenderingContext2D).putImageData(si, 0, 0);
  if (projSym!.ink) projSym!.ink.hard.width = projSym!.ink.hard.height = projSym!.ink.soft.width = projSym!.ink.soft.height = 0;
  projSym!.ink = { key, hard, soft };
  return projSym!.ink;
}

/**
 * 回到等距圆柱时释放按投影重画用的缓存(符号层、遮罩、不带墨线的像素层、投影后的波纹浓度图,几十 MB 显存)。
 * 等距圆柱放大后的细节层用的是 fantasyBaseClean,不用不带墨线的那一份
 */
export function releaseFantasyProjCaches(): void {
  if (projSym) {
    projSym.canvas.width = projSym.canvas.height = 0;
    if (projSym.ink) projSym.ink.hard.width = projSym.ink.hard.height = projSym.ink.soft.width = projSym.ink.soft.height = 0;
    projSym = null;
  }
  if (noInk) {
    noInk.canvas.width = noInk.canvas.height = 0;
    noInk = null;
  }
  if (seaPaths) {
    seaPaths.rippleFade.width = seaPaths.rippleFade.height = seaPaths.hatchFade.width = seaPaths.hatchFade.height = 0;
    seaPaths = null;
  }
  releaseIceProj();
  coastPaths = null;
  projCellCache = null;
}

/** 手绘风的河:全图细、小河不画;放大后大河按世界单位变粗,小溪不跟着变粗(见 realisticRiverStyle) */
function fantasyRiverStyle(k: number, threshold: number): RiverStyle {
  const kk = Math.max(1, k);
  return {
    color: 'rgba(48,82,110,0.9)',
    minW: 0.5,
    maxW: 0.5 + 1.5 * Math.pow(kk, -0.2),
    fluxRef: 900,
    thin: Math.pow(kk, -0.6),
    minFlux: threshold * riverLod(kk),
  };
}

/** 文明层的"让位"遮罩,见 fantasyInkMask */
export interface InkMask {
  /** 墨线、河流(0–255):水彩在这里总是让开,墨色不被染 */
  hard: Uint8Array;
  /** 林块、山的纸色底(0–255):国土内部让开,紧贴边界的一道色带照样上色(林多的国家也认得出疆域) */
  soft: Uint8Array;
}

/** 当前这张地图的符号层和遮罩(只留一份:换了世界就把旧画布清掉,尽快释放显存) */
let sym: { raster: Raster; canvas: AnyCanvas; mask: { key: string; ink: InkMask } | null } | null = null;

/**
 * 符号层(缩放 1 倍):林块、河流、山 / 丘陵 / 沙丘 / 草丛,画在一张和地图一样大的透明画布上(每张地图只画一次)。
 * 手绘地图把它贴在像素层上;文明层按它的形状给水彩"让位"(fantasyInkMask),颜料不把符号染脏。
 */
export function fantasySymbolLayer(world: World, r: Raster): AnyCanvas {
  if (sym?.raster === r) return sym.canvas;
  if (sym) sym.canvas.width = sym.canvas.height = 0;
  const cv = makeCanvas(r.w, r.h);
  drawFantasyVectors(cv.getContext('2d') as CanvasRenderingContext2D, world, bakedView(r.scale));
  sym = { raster: r, canvas: cv, mask: null };
  return cv;
}

/** 地球仪的地形贴图、它的符号层和让位遮罩(只留一份,换了像素图就重画) */
let globeBase: { raster: Raster; canvas: AnyCanvas; sym: AnyCanvas; mask: { key: string; ink: InkMask } | null } | null = null;

/**
 * 地球仪的地形贴图(手绘,等距圆柱):像素层 + 林块(按纬度横向拉宽,包到球上是圆)+ 河流,
 * 不含山 / 丘陵 / 沙丘 / 草丛 / 火山 —— 这几样在地球仪上每帧正立着画(render/globeGlyphs.ts),
 * 不跟着贴图在高纬度被压扁。平面主图不用它
 */
export function fantasyGlobeBase(world: World, r: Raster): AnyCanvas {
  if (globeBase?.raster === r) return globeBase.canvas;
  releaseFantasyGlobeBase();
  // 符号(林块、河)先画在一张透明画布上(文明贴图的让位遮罩按它算,见 fantasyGlobeInkMask),再叠到像素层上
  const symCv = makeCanvas(r.w, r.h);
  const sctx = symCv.getContext('2d') as CanvasRenderingContext2D;
  const v = { ...bakedView(r.scale), wrap: wrapOf(world) };
  drawForests(sctx, world, planOf(world).forest, v, FOREST_TILE, undefined, true);
  drawRivers(sctx, world.rivers, v, world.riverThreshold, fantasyRiverStyle(1, world.riverThreshold));
  const cv = makeCanvas(r.w, r.h);
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(fantasyBase(world, r), 0, 0);
  ctx.drawImage(symCv, 0, 0);
  globeBase = { raster: r, canvas: cv, sym: symCv, mask: null };
  return cv;
}

/** 地球仪关掉时释放它的地形贴图 */
export function releaseFantasyGlobeBase(): void {
  if (!globeBase) return;
  globeBase.canvas.width = globeBase.canvas.height = 0;
  globeBase.sym.width = globeBase.sym.height = 0;
  globeBase = null;
}

/**
 * 文明层的"让位"遮罩(全分辨率,每张地图算一次):水彩在符号的像素上减淡多少。
 * 把符号层读回来,按像素深浅分档:墨线 / 河流(深)→ hard;林块(中)→ soft × forest;
 * 山 / 丘陵的纸色底(浅)→ soft × paper;之间线性过渡。乘上符号的覆盖度,抗锯齿的边也是软的。
 */
export function fantasyInkMask(world: World, r: Raster, forest: number, paper: number): InkMask {
  const cv = fantasySymbolLayer(world, r);
  const key = `${forest}|${paper}`;
  if (sym!.mask?.key === key) return sym!.mask.ink;
  const ink = inkFromPixels((cv.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, r.w, r.h).data, r.w * r.h, forest, paper);
  sym!.mask = { key, ink };
  return ink;
}

/** 符号层的像素 → 让位遮罩(见 fantasyInkMask) */
function inkFromPixels(px: Uint8ClampedArray, N: number, forest: number, paper: number): InkMask {
  const hard = new Uint8Array(N);
  const soft = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const o = k * 4;
    const a = px[o + 3];
    if (!a) continue;
    const lum = 0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2];
    // 墨 ≤ 95 → hard;林 125–165 → forest;纸 ≥ 205 → paper
    const tInk = lum <= 95 ? 1 : lum >= 125 ? 0 : (125 - lum) / 30;
    const wgt = lum <= 165 ? forest : lum >= 205 ? paper : forest + ((paper - forest) * (lum - 165)) / 40;
    hard[k] = a * tInk;
    soft[k] = a * (1 - tInk) * wgt;
  }
  return { hard, soft };
}

/**
 * 地球仪的文明贴图用的让位遮罩(和 fantasyInkMask 同一套分档):按地球仪贴图的符号(按纬度拉宽的林块、河流;
 * 山丘等符号不在贴图里,正立着画在上面)算 —— 水彩的"让位"和球上的林块对得上
 */
export function fantasyGlobeInkMask(world: World, r: Raster, forest: number, paper: number): InkMask {
  fantasyGlobeBase(world, r);
  const g = globeBase!;
  const key = `${forest}|${paper}`;
  if (g.mask?.key === key) return g.mask.ink;
  const ink = inkFromPixels((g.sym.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, r.w, r.h).data, r.w * r.h, forest, paper);
  g.mask = { key, ink };
  return ink;
}

/** 像素层用到的预先算好的场 */
interface PixelFields {
  dLand: Float32Array;
  dSea: Float32Array;
  shade: Float32Array;
  calm: Uint8Array;
  iceM: Uint8Array;
  iceNear: Uint8Array;
  /** 冰缘带(见 iceBand) */
  band: Uint8Array;
  pr: Float32Array;
  pg: Float32Array;
  pb: Float32Array;
  /** 记下墨线、波纹盖掉的像素原色(见 InkPatch) */
  patch: InkPatch;
  /** 记下放大后画矢量波纹、排线要用的场 */
  sea: SeaFields;
}

/**
 * 岸线外的三圈波纹:离最近陆地几格(× raster.scale)、浓度。像素层里剖面是高斯 exp(−(Δ / (RIPPLE_SIG 格))²);
 * 放大后的矢量线取墨量相同的实线(宽 RIPPLE_SIG·√π 格)
 */
const RIPPLE_D = [4, 9, 15];
const RIPPLE_A = [0, 1, 2].map((i) => 0.42 - i * 0.12);
const RIPPLE_SIG = 0.55;
/** 近岸排线:离陆地几格以内画、最浓多少(离岸越远越淡) */
const HATCH_D = 9;
const HATCH_A = 0.16;
/** 近岸排线隔几行画一道(像素) */
const hatchRowOf = (S: number) => Math.max(2, Math.round(3 * S));
/** 波纹浓度低于这个就算没画(差不到半个色阶) */
const RIPPLE_EPS = 1e-3;

/** 逐像素铺纸色、水彩、海冰、海岸墨线(单独成函数:热循环单独编译优化,快一些) */
function paintPixels(r: Raster, d: Uint8ClampedArray, f: PixelFields) {
  const { w, h, elev, water, temp } = r;
  const N = w * h;
  const S = r.scale;
  const { dLand, dSea, shade, calm, iceM, iceNear, band, pr, pg, pb, patch } = f;
  const { dist: seaDist, fade: seaFade } = f.sea;
  const distQ = DIST_Q / S;
  const snowR = Math.max(1, Math.round(3 * S)); // 雪地明暗的柔化半径
  const rimD = Math.max(2, Math.round(2.5 * S)); // 冰块东南侧背光边的宽度
  let iceHatch = Math.max(3, Math.round(3 * S));
  const ripples = RIPPLE_D.map((v) => v * S);
  const hatchRow = hatchRowOf(S);
  // 东西相连:纸纹、水彩斑驳的噪声格数取整,冰面排线的间距取图宽的约数 —— 左右两边对得上;
  // 主图是一整圈星球,不是一页纸,这里不做纸边做旧(画在视窗上,见 drawPaperEdge)
  while (w % iceHatch) iceHatch++;
  const n90 = wrapCells(w, 90);
  const n23 = wrapCells(w, 23);
  const n14 = wrapCells(w, 14);
  // 颜色都用标量 r/g/b 算(不建临时数组);整张图一个平铺循环(嵌套的行 / 列循环会让 V8 每行退出一次优化代码)
  let px = -1;
  let py = 0;
  for (let k = 0; k < N; k++) {
    if (++px === w) {
      px = 0;
      py++;
    }
    // 纸:低频斑驳 + 高频纤维
    const mott = valueNoiseP((px * n90) / w, py / 90, 1, n90) * 0.6 + valueNoiseP((px * n23) / w, py / 23, 2, n23) * 0.4;
    const fiber = hash2(px, py, 5);
    const tp = 0.18 * (mott - 0.5);
    const p0 = PAPER[0] + (PAPER_EDGE[0] - PAPER[0]) * tp;
    const p1 = PAPER[1] + (PAPER_EDGE[1] - PAPER[1]) * tp;
    const p2 = PAPER[2] + (PAPER_EDGE[2] - PAPER[2]) * tp;
    let cr = p0;
    let cg = p1;
    let cb = p2;
    let t: number;
    const grain = 1 + 0.035 * (fiber - 0.5);
    // 波纹、排线画上之前的颜色(放大后的细节层另外画成矢量线,底图要一份没画这两样的,见 InkPatch.sea)
    let touched = false;
    let qr = 0;
    let qg = 0;
    let qb = 0;
    const dk = dLand[k];
    seaDist[k] = dk * distQ < 65535 ? Math.round(dk * distQ) : 65535;

    if (water[k] === 1) {
      const nq = iceNear[k];
      const nearIce = nq > 0; // 附近有海冰
      const conc = nearIce ? (nq - 1) / 254 : 0; // 附近海面的结冰比例
      // 3×3 邻域里海冰像素的比例 B(只数海面,陆地另有海岸墨线):0 开阔水面 / 1 冰面内部 / 之间 = 冰缘
      let B = 0;
      if (nearIce) {
        const m0 = iceM[k];
        // 左右邻居(东西相连时第 0 列 / 最后一列的邻居在另一头)
        const kl = px > 0 ? k - 1 : k + w - 1;
        const kr = px < w - 1 ? k + 1 : k - w + 1;
        if (
          py > 0 &&
          py < h - 1 &&
          (iceM[kl] !== m0 || iceM[kr] !== m0 || iceM[k - w] !== m0 || iceM[k + w] !== m0)
        ) {
          let sum = 0;
          let cnt = 0;
          for (let dy = -w; dy <= w; dy += w)
            for (let i = 0; i < 3; i++) {
              const q = (i === 0 ? kl : i === 1 ? k : kr) + dy;
              if (water[q] !== 1) continue;
              sum += iceM[q];
              cnt++;
            }
          B = sum / cnt;
        } else B = m0; // 上下左右都和自己一样:冰面内部或开阔水面(斜角的零星差别忽略)
      }
      let fo = 0; // 波纹、排线的浓淡倍数(SeaFields.fade)
      // 冰缘带:放大后的底图要一份没结冰的海色、一份冰面色(见 InkPatch.iceW / iceI;像素层本身照旧)
      const edge = band[k] === 1;
      let wr = 0;
      let wg = 0;
      let wb = 0;
      if (B < 1 || edge) {
        // 海色按海底深浅(铺像素时的海深本来就平滑,直接用):
        // 大陆架(< 200 米)浅、偏绿,过了坡折渐深,深海平原是本来的海色,洋中脊略浅,海沟最深
        const dm = -elev[k];
        const dep = dm < 200 ? (dm > 0 ? dm / 200 : 0) * 0.15 : 0.15 + 0.55 * smoothstep(200, 3800, dm) + 0.3 * smoothstep(3800, 5600, dm);
        let sr: number;
        let sg: number;
        let sb: number;
        if (dep < 0.7) {
          const q = dep / 0.7;
          sr = SEA_SHELF[0] + (SEA[0] - SEA_SHELF[0]) * q;
          sg = SEA_SHELF[1] + (SEA[1] - SEA_SHELF[1]) * q;
          sb = SEA_SHELF[2] + (SEA[2] - SEA_SHELF[2]) * q;
        } else {
          const q = (dep - 0.7) / 0.3;
          sr = SEA[0] + (SEA_DEEP[0] - SEA[0]) * q;
          sg = SEA[1] + (SEA_DEEP[1] - SEA[1]) * q;
          sb = SEA[2] + (SEA_DEEP[2] - SEA[2]) * q;
        }
        t = 0.52 + 0.16 * dep;
        wr = cr + (sr - cr) * t;
        wg = cg + (sg - cg) * t;
        wb = cb + (sb - cb) * t;
        let open = 1; // 1 = 开阔水面;冰区里淡出波纹和排线
        if (nearIce) {
          // 冰区里的水面:碎冰、冰泥让海色发浅
          t = 0.28 * smoothstep(0.05, 0.9, conc);
          wr += (p0 - wr) * t;
          wg += (p1 - wg) * t;
          wb += (p2 - wb) * t;
          open = 1 - smoothstep(0.02, 0.3, conc);
        }
        if (B < 1) {
          cr = wr;
          cg = wg;
          cb = wb;
        } else open = 0; // 冰面内部(只为冰缘带算一份海色)
        const dl = dLand[k];
        if (open > 0) {
          qr = cr;
          qg = cg;
          qb = cb;
          // 近岸排线
          if (dl < HATCH_D * S && py % hatchRow === 0) {
            t = HATCH_A * (1 - dl / (HATCH_D * S)) * open;
            cr += (INK[0] - cr) * t;
            cg += (INK[1] - cg) * t;
            cb += (INK[2] - cb) * t;
            touched = t > 0;
          }
          // 岸线外的波纹
          let a = 0;
          for (let i = 0; i < ripples.length; i++) {
            const u = (dl - ripples[i]) / (RIPPLE_SIG * S);
            a = Math.max(a, Math.exp(-u * u) * RIPPLE_A[i]);
          }
          t = a * open;
          cr += (INK[0] - cr) * t;
          cg += (INK[1] - cg) * t;
          cb += (INK[2] - cb) * t;
          if (t > RIPPLE_EPS) touched = true;
          fo = open;
        }
      }
      // 冰面色(不带背光边)
      const ir0 = p0 + (ICE_PAPER[0] - p0) * 0.7;
      const ig0 = p1 + (ICE_PAPER[1] - p1) * 0.7;
      const ib0 = p2 + (ICE_PAPER[2] - p2) * 0.7;
      let shaded = false;
      if (B > 0) {
        // 冰面:纸色平涂;东南侧一窄条背光边,画淡蓝灰短排线(和林块的阴影排线同一个方向)
        const ice = B >= 1 ? 1 : Math.min(1, Math.max(0, (B - 0.5) * 1.5 + 0.5));
        let ir = ir0;
        let ig = ig0;
        let ib = ib0;
        const qx = px + rimD >= w ? px + rimD - w : px + rimD;
        const qy = py + rimD;
        if (qy < h) {
          const q = qy * w + qx;
          const rim = water[q] === 1 ? ice - iceM[q] : 0;
          if (rim > 0) {
            shaded = true;
            t = rim * ((px + py) % iceHatch === 0 ? 0.52 : 0.12);
            ir += (ICE_SHADOW[0] - ir) * t;
            ig += (ICE_SHADOW[1] - ig) * t;
            ib += (ICE_SHADOW[2] - ib) * t;
          }
        }
        cr += (ir - cr) * ice;
        cg += (ig - cg) * ice;
        cb += (ib - cb) * ice;
        fo *= 1 - ice;
        if (touched) {
          qr += (ir - qr) * ice;
          qg += (ig - qg) * ice;
          qb += (ib - qb) * ice;
        }
        // 冰缘墨线(B≈0.5);冰区稀疏处(零星碎冰)线条更淡
        const e = 4 * B * (1 - B);
        if (e > 0.3) {
          t = 0.62 * smoothstep(0.3, 0.95, e) * (0.4 + 0.6 * smoothstep(0.1, 0.6, conc));
          cr += (ICE_INK[0] - cr) * t;
          cg += (ICE_INK[1] - cg) * t;
          cb += (ICE_INK[2] - cb) * t;
          if (touched) {
            qr += (ICE_INK[0] - qr) * t;
            qg += (ICE_INK[1] - qg) * t;
            qb += (ICE_INK[2] - qb) * t;
          }
        }
      }
      if (edge) {
        patch.iceW.push(k, wr * grain, wg * grain, wb * grain);
        patch.iceI.push(k, ir0 * grain, ig0 * grain, ib0 * grain);
      } else if (shaded || (B > 0 && B < 1)) {
        // 带外:背光边去掉;(冰、水只隔着陆地斜着挨的零星像素)冰缘墨线去掉
        if (iceM[k]) patch.iceW.push(k, ir0 * grain, ig0 * grain, ib0 * grain);
        else patch.iceW.push(k, wr * grain, wg * grain, wb * grain);
      }
      seaFade[k] = Math.round(fo * 255);
    } else if (water[k] === 2) {
      cr += (SEA[0] - cr) * 0.55;
      cg += (SEA[1] - cg) * 0.55;
      cb += (SEA[2] - cb) * 0.55;
    } else {
      const wn = valueNoiseP((px * n14) / w, py / 14, 9, n14);
      const wash = 0.66 + 0.22 * (wn - 0.5);
      cr += (pr[k] - cr) * wash;
      cg += (pg[k] - cg) * wash;
      cb += (pb[k] - cb) * wash;
      // 水彩在岸边积色
      const ds = dSea[k];
      if (ds < 5 * S) {
        t = 0.5 * (1 - ds / (5 * S));
        cr += (cr * 0.8 - cr) * t;
        cg += (cg * 0.78 - cg) * t;
        cb += (cb * 0.7 - cb) * t;
      }
      let s = shade[k];
      // 纸上的起伏晕染:平原上的小起伏压淡(世界地图上平原看着平),丘陵、山地照旧
      const el = elev[k];
      let relief = 0.22 * (el >= 1200 ? 1 : el <= 150 ? 0.3 : 0.3 + 0.7 * smoothstep(150, 1200, el));
      // 高山雪地:明暗压淡、换成柔化过的明暗(大片晕染,不要细碎斑驳),背光面用淡蓝灰;
      // 山符号底边下渐变成符号底色,不留横向硬边
      const tk = temp[k];
      const sn = tk < -7.5 ? smoothstep(-7.5, -10.5, tk) : 0;
      if (sn > 0) {
        s += (boxAvg(shade, w, h, px, py, snowR) - s) * sn;
        const cm = (calm[k] / 255) * sn;
        relief *= (1 - 0.75 * sn - 0.25 * cm) * (s > 1 ? 1 - 0.6 * sn : 1); // 向光面几乎不再提亮:雪就是纸的留白
        if (s < 1) {
          t = sn * (1 - cm) * Math.min(0.3, (1 - s) * 0.9);
          cr += (SNOW_SHADOW[0] - cr) * t;
          cg += (SNOW_SHADOW[1] - cg) * t;
          cb += (SNOW_SHADOW[2] - cb) * t;
        }
        if (cm > 0) {
          t = 0.9 * cm;
          cr += (GLYPH_PAPER[0] - cr) * t;
          cg += (GLYPH_PAPER[1] - cg) * t;
          cb += (GLYPH_PAPER[2] - cb) * t;
        }
      }
      const f = 1 + (s - 1) * relief;
      cr *= f;
      cg *= f;
      cb *= f;
    }

    // 墨线海岸:用海拔过零点的亚像素距离做抗锯齿(东西相连,左右邻居在图边上取另一头)
    if (dLand[k] <= 2 * S && dSea[k] <= 2 * S) {
      const e = elev[k];
      const gx = (elev[px < w - 1 ? k + 1 : k - w + 1] - elev[px > 0 ? k - 1 : k + w - 1]) / 2;
      const gy = (elev[Math.min(N - 1, k + w)] - elev[Math.max(0, k - w)]) / 2;
      const g = Math.sqrt(gx * gx + gy * gy) || 1;
      const sd = Math.abs(e / g);
      const a = Math.max(0, Math.min(1, (1.15 * S - sd) / (0.8 * S)));
      t = a * 0.95;
      if (t > 0) patch.coast.push(k, cr * grain, cg * grain, cb * grain);
      cr += (INK[0] - cr) * t;
      cg += (INK[1] - cg) * t;
      cb += (INK[2] - cb) * t;
    }
    if (touched) patch.sea.push(k, qr * grain, qg * grain, qb * grain);
    const o = k * 4;
    d[o] = cr * grain;
    d[o + 1] = cg * grain;
    d[o + 2] = cb * grain;
    d[o + 3] = 255;
  }
}

/** (px, py) 周围 (2R+1)² 方块里的平均值(方块超出上下边的部分不算;东西相连,左右超出的部分取另一头) */
function boxAvg(f: Float32Array, w: number, h: number, px: number, py: number, R: number) {
  const x0 = px - R;
  const x1 = px + R;
  const y0 = Math.max(0, py - R);
  const y1 = Math.min(h - 1, py + R);
  let sum = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) sum += f[row + (x < 0 ? x + w : x >= w ? x - w : x)];
  }
  return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
}

/**
 * 海冰像素场。铺像素时已经把每个海面像素分成"海冰 / 海洋"(r.ice 覆盖 ≥ 0.5 算冰,
 * 见 raster.ts / seaice.ts),这里直接读这张分类图:画成冰的地方和群落图层、悬停信息逐像素一致,
 * 又不用把冰区重新取样一遍(整片重算要多花 150 ms 以上)。冰缘的抗锯齿交给 3×3 邻域平均 + 墨线。
 * mask:1 = 海冰像素。
 * near:方圆约 20 像素内结冰的比例,0 = 附近没冰,1–255 对应比例 0–1(平滑,当"冰区程度"用)。
 */
function seaIceField(r: Raster) {
  const { w, h, biome } = r;
  const mask = new Uint8Array(w * h);
  const near = new Uint8Array(w * h);
  // 粗网格:每块数结冰像素
  const G = Math.max(4, Math.round(8 * r.scale));
  const gw = Math.ceil(w / G);
  const gh = Math.ceil(h / G);
  const gIce = new Float32Array(gw * gh);
  let any = false;
  for (let py = 0; py < h; py++) {
    const row = py * w;
    const grow = Math.floor(py / G) * gw;
    for (let px = 0; px < w; px++) {
      if (biome[row + px] !== Biome.SeaIce) continue;
      mask[row + px] = 1;
      gIce[grow + Math.floor(px / G)]++;
      any = true;
    }
  }
  if (!any) return { mask, near };
  boxBlurWrap(gIce, gw, gh, 2);
  // 比例 = 冰像素 / 块面积(陆地也算在分母里,海岸边偏低一点,不影响观感)
  const inv = 1 / (G * G);
  const colX0 = new Int32Array(w);
  const colX1 = new Int32Array(w);
  const colT = new Float32Array(w);
  for (let px = 0; px < w; px++) {
    // 东西相连:左右边的像素插在最后一格和第一格之间
    const fx = (px + 0.5) / G - 0.5;
    const x0 = Math.floor(fx);
    colX0[px] = x0 < 0 ? x0 + gw : x0;
    colX1[px] = x0 + 1 >= gw ? x0 + 1 - gw : x0 + 1;
    colT[px] = fx - x0;
  }
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      if (gIce[by * gw + bx] < 1e-3) continue; // 附近两块内都没冰
      const x0 = bx * G;
      const y0 = by * G;
      const x1 = Math.min(w, x0 + G);
      const y1 = Math.min(h, y0 + G);
      for (let py = y0; py < y1; py++) {
        // 粗网格双线性插值
        const fy = Math.min(gh - 1, Math.max(0, (py + 0.5) / G - 0.5));
        const gy0 = Math.floor(fy);
        const ty = fy - gy0;
        const r0 = gy0 * gw;
        const r1 = Math.min(gh - 1, gy0 + 1) * gw;
        for (let px = x0; px < x1; px++) {
          const a = colX0[px];
          const b = colX1[px];
          const tx = colT[px];
          const v =
            ((gIce[r0 + a] * (1 - tx) + gIce[r0 + b] * tx) * (1 - ty) + (gIce[r1 + a] * (1 - tx) + gIce[r1 + b] * tx) * ty) *
            inv;
          near[py * w + px] = 1 + Math.round(Math.min(1, v) * 254);
        }
      }
    }
  }
  return { mask, near };
}

/** 冰缘带的半宽(像素,切比雪夫距离):冰缘线落在冰 / 水像素之间,放大后双线性取色只碰到线两边各一格,多留一格余量 */
const ICE_BAND = 2;

/**
 * 冰缘带:离"冰 / 水"分界(上下左右相邻的两个海面像素一个结冰、一个没结)不到 ICE_BAND 格的海面像素(东西相连)。
 * 放大后冰面、海面按冰缘线分界填色,带里的像素要两份颜色:没结冰的海色(底图)、冰面色(另一张),见 InkPatch.iceW / iceI
 */
export function iceBand(r: Pick<Raster, 'w' | 'h' | 'water'>, iceM: Uint8Array, near: Uint8Array): Uint8Array {
  const { w, h, water } = r;
  const out = new Uint8Array(w * h);
  const R = ICE_BAND;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (water[k] !== 1 || !near[k]) continue;
      const m = iceM[k];
      const kl = x > 0 ? k - 1 : k + w - 1;
      const kr = x < w - 1 ? k + 1 : k - w + 1;
      if (
        (water[kl] === 1 && iceM[kl] !== m) ||
        (water[kr] === 1 && iceM[kr] !== m) ||
        (y > 0 && water[k - w] === 1 && iceM[k - w] !== m) ||
        (y < h - 1 && water[k + w] === 1 && iceM[k + w] !== m)
      ) {
        // 往外扩 ICE_BAND 格,只留海面
        for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
          const row = yy * w;
          for (let dx = -R; dx <= R; dx++) {
            const q = row + (x + dx < 0 ? x + dx + w : x + dx >= w ? x + dx - w : x + dx);
            if (water[q] === 1) out[q] = 1;
          }
        }
      }
    }
  }
  return out;
}

/**
 * a = 山脊走向角(弧度,-90°..90°),c = 走向的可信度 0..1;s = 缩放 1 倍时的大小(世界单位);
 * z = 从缩放几倍起画(GLYPH_TIERS 里的一级:1 = 全图就有)
 */
export type Glyph = { x: number; y: number; kind: number; s: number; v: number; a: number; c: number; cell: number; z: number };
export const G_MOUNTAIN = 0;
export const G_HILL = 1;
export const G_DUNE = 5;
export const G_TUFT = 6;
export const G_VOLCANO = 7;

/** 林块种类:0 无 / 1 阔叶 / 2 针叶 / 3 雨林 */
const F_BROAD = 1;
const F_PINE = 2;
const F_JUNGLE = 3;
const FOREST_OF: Record<number, [kind: number, threshold: number]> = {
  [Biome.TemperateForest]: [F_BROAD, 0.43],
  [Biome.TropicalDryForest]: [F_BROAD, 0.52],
  [Biome.Taiga]: [F_PINE, 0.44],
  [Biome.TemperateRainforest]: [F_PINE, 0.36],
  [Biome.Rainforest]: [F_JUNGLE, 0.32],
};

export type Plan = { glyphs: Glyph[]; forest: Uint8Array };

/** 山符号的半宽(世界单位):东西走向的脊宽一点,南北走向的窄一点(a = 画面上的山脊走向,弯边投影里是换算过的) */
function mountainHalfWidth(g: Glyph, a = g.a) {
  const cos2 = Math.cos(a) ** 2;
  return g.s * (1 + g.c * (0.18 * cos2 - 0.14 * (1 - cos2)));
}

/**
 * 山 / 丘陵符号底边下的"羽化带"(0–255):底边处为 255,往下约 3/4 个符号高度内渐变到 0,
 * 两端在底角附近收掉。像素层用它把雪地颜色过渡成符号底色。
 */
function glyphSkirts(world: World, glyphs: Glyph[], w: number, h: number, S: number) {
  const out = new Uint8Array(w * h); // 0–255
  const wrap = w;
  for (const g of glyphs) {
    // 只管全图就有的符号(铺进地形图的那一份);放大后才出现的小符号不羽化
    if ((g.kind !== G_MOUNTAIN && g.kind !== G_HILL) || g.z > 1) continue;
    // 只有雪地上才用得到:符号所在地块明显不冷就跳过(留几度余量,像素温度带细节起伏)
    if (world.temperature[g.cell] > -2) continue;
    const hw = (g.kind === G_MOUNTAIN ? mountainHalfWidth(g) : g.s) * S;
    // 挨着左右边的符号(东西相连),另一边也羽化一份
    for (const sh of wrapShifts(g.x * S - hw, g.x * S + hw, wrap)) skirt(out, g, g.x * S + sh, w, h, S, hw);
  }
  return out;
}

/** 一个符号(画在像素横坐标 gx 处)的羽化带,取最大值写进 out */
function skirt(out: Uint8Array, g: Glyph, gx: number, w: number, h: number, S: number, hw: number) {
  const gy = g.y * S;
  const s = g.s * S;
  const depth = s * (g.kind === G_MOUNTAIN ? 0.75 : 0.55);
  const x0 = Math.max(0, Math.floor(gx - hw));
  const x1 = Math.min(w - 1, Math.ceil(gx + hw));
  const y0 = Math.max(0, Math.floor(gy - s * 0.25));
  const y1 = Math.min(h - 1, Math.ceil(gy + depth));
  for (let py = y0; py <= y1; py++) {
    const t = (py + 0.5 - gy) / depth;
    const wy = t <= 0 ? 1 : 1 - smoothstep(0, 1, t);
    if (wy <= 0) continue;
    const row = py * w;
    for (let px = x0; px <= x1; px++) {
      const u = Math.abs(px + 0.5 - gx) / hw;
      if (u >= 1) continue;
      const v = Math.round(255 * wy * smoothstep(1, 0.55, u));
      if (v > out[row + px]) out[row + px] = v;
    }
  }
}

/** 只在陆地内部做邻居平均(海当作"没有数据",避免海岸被误判成山脊)。 */
function landBlur(world: World, f: Float32Array, land: Uint8Array, passes: number) {
  const { n, adjStart, adj } = world.mesh;
  let a = f.slice();
  let b = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      if (!land[i]) {
        b[i] = a[i];
        continue;
      }
      let s = a[i];
      let c = 1;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (land[j]) {
          s += a[j];
          c++;
        }
      }
      b[i] = s / c;
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

/**
 * 大范围"基准面":方圆几十像素内陆地的平均海拔(在粗网格上盒式模糊,很便宜)。
 * 海拔减基准面 = 比周围的大地形高出多少 —— 真正的山脉很突出,起伏的高原不突出。
 */
function baseLevel(world: World, e0: Float32Array, land: Uint8Array, radius: number) {
  const { n, x, y } = world.mesh;
  const G = 8;
  // 东西相连:网格左右首尾相接(列下标取模),东西向半径按纬度放宽(按地面距离平均)
  const gw = Math.ceil(world.width / G);
  const gh = Math.ceil(world.height / G) + 1;
  const sum = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const k = Math.floor(y[i] / G) * gw + Math.floor(x[i] / G);
    sum[k] += e0[i];
    cnt[k] += 1;
  }
  const R = Math.max(1, Math.round(radius / G));
  const stretch = Float32Array.from({ length: gh }, (_, r) => 1 / Math.max(1e-3, rowCos(r, gh - 1)));
  for (let pass = 0; pass < 2; pass++) {
    boxBlurWrap(sum, gw, gh, R, stretch);
    boxBlurWrap(cnt, gw, gh, R, stretch);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const fx = x[i] / G - 0.5;
    const fy = Math.min(gh - 1.001, Math.max(0, y[i] / G - 0.5));
    const xa = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - xa;
    const ty = fy - y0;
    const x0 = xa < 0 ? xa + gw : xa;
    const x1 = xa + 1 >= gw ? xa + 1 - gw : xa + 1;
    let s = 0;
    let c = 0;
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        const k = (y0 + dy) * gw + (dx ? x1 : x0);
        s += sum[k] * wgt;
        c += cnt[k] * wgt;
      }
    out[i] = c > 1e-6 ? s / c : e0[i];
  }
  return out;
}

/**
 * 符号的随机数"用途"编号(keyed 的第二个参数)。每个符号的抖动、大小、取舍 = keyed(种子, 地块, 用途):
 * 按"哪个地块、做什么"直接算出来,和规划的先后无关 —— 改地形后哪里多了 / 少了一个符号,
 * 别处的符号一个都不挪(原来用一条按先后取的随机数,多取一个,后面所有符号都跟着变)。
 * 地块网格只由种子决定,改地形也不变(见 gen/civ/rand.ts)。
 */
const R_MTN_LEAN = 1; // 山:峰顶左右偏一点
const R_FOREST_DROP = 2; // 太小的林块去不去掉(按这块林子编号最小的地块)
const R_HILL_PICK = 3; // 丘陵:放不放
const R_HILL_SIZE = 4; // 丘陵:大小
const R_HILL_LEAN = 5;
const R_DOT_PICK = 6; // 沙丘 / 草丛:放不放
const R_DOT_X = 7; // 沙丘 / 草丛:在地块里的位置
const R_DOT_Y = 8;
const R_DOT_LEAN = 9;

/**
 * 决定每个符号放哪、多大(纯计算,不画;导出给单测用)。
 * metric:弯边投影按投影重画时的"尺子"(render/projection.ts 的 glyphMetric)—— 符号之间的距离按投影后的地图平面量,
 * 符号按屏幕大小画时在那种投影里也不挤成一团、不稀稀拉拉;不给 = 等距圆柱(世界坐标就是地图平面)
 */
export function planGlyphs(world: World, metric?: GlyphMetric): Plan {
  const { mesh, elevation, water, biome, maxElevation } = world;
  // 东西相连:间距、走向、噪声都按左右相连算
  const WR = wrapOf(world);
  const geo = geometryOf(mesh);
  const { n, x, y, spacing, adjStart, adj } = mesh;
  const gSeed = subSeed(world.params.seed, 'glyphs');
  /** 地块 cell 上、做 use 这件事的随机数 [0, 1)(见上面的 R_*) */
  const rnd = (cell: number, use: number) => keyed(gSeed, cell, use);
  const glyphs: Glyph[] = [];

  // ---- 地形量:脊度(比周围高多少)、坡度 ----
  const land = new Uint8Array(n);
  const e0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i] === 0) {
      land[i] = 1;
      e0[i] = Math.max(0, elevation[i]);
    }
  }
  const b4 = landBlur(world, e0, land, 4);
  const b1 = landBlur(world, e0, land, 1);
  const ridge = new Float32Array(n);
  const slope = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    ridge[i] = e0[i] - b4[i];
    let m = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (!land[j]) continue;
      // 两地块的地面距离(跨 180° 经线的邻居在主图上隔着整张图)
      const g = Math.abs(b1[i] - b1[j]) / geo.dist(i, j);
      if (g > m) m = g;
    }
    slope[i] = m;
  }

  const base = baseLevel(world, e0, land, 40);
  const maxE = Math.max(1, maxElevation);
  const mtnMin = Math.max(900, maxE * 0.16);
  const mtnBase = mtnMin * 0.8;
  const ridgeMin = Math.max(70, maxE * 0.022);
  const hillMin = Math.max(260, maxE * 0.045);
  const promMin = Math.max(150, maxE * 0.042);

  // ---- 山脊:脊线、主脊 / 侧脊、走向(候选,按分数排好) ----
  // 脊线 = 平滑后的地形上"两侧都更低"的地块。平滑得狠 → 只剩主脊;平滑得轻 → 还有侧脊。
  // 主脊先占位、画得大;侧脊后占位、画得小;山坡和高原不放山。
  const bMain = landBlur(world, e0, land, 9);
  const bSpur = landBlur(world, e0, land, 2);
  const crest = (bf: Float32Array, i: number) => {
    let lo = 0;
    let deg = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (!land[j]) continue;
      deg++;
      if (bf[j] < bf[i]) lo++;
    }
    return deg > 0 && lo / deg >= 0.66;
  };
  // 另外要比方圆几十像素的"基准面"高出一截:起伏的高原上那些小脊不算山
  const level = new Uint8Array(n); // 0 非脊 / 1 侧脊 / 2 主脊
  const mCand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || e0[i] < mtnBase) continue;
    const prom = e0[i] - base[i];
    if (crest(bMain, i) && e0[i] - bMain[i] > ridgeMin && prom > promMin * 0.8) level[i] = 2;
    else if (crest(bSpur, i) && ridge[i] > ridgeMin * 0.6 && prom > promMin) level[i] = 1;
    else continue;
    mCand.push(i);
  }
  const mScore = (i: number) => (level[i] === 2 ? 1e5 + e0[i] : e0[i] + ridge[i]);
  mCand.sort((a, b) => mScore(b) - mScore(a));
  const stamp = new Int32Array(n).fill(-1);
  const ring: number[] = [];
  /** 山脊走向:周围两圈内同级脊点的加权主方向 → [角度, 可信度] */
  const ridgeAxis = (i: number): [number, number] => {
    ring.length = 0;
    stamp[i] = i;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (stamp[j] !== i) {
        stamp[j] = i;
        ring.push(j);
      }
    }
    const r1 = ring.length;
    for (let q = 0; q < r1; q++) {
      const j0 = ring[q];
      for (let k = adjStart[j0]; k < adjStart[j0 + 1]; k++) {
        const j = adj[k];
        if (stamp[j] !== i) {
          stamp[j] = i;
          ring.push(j);
        }
      }
    }
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const j of ring) {
      if (level[j] < level[i]) continue;
      const dx = nearX(x[j], x[i], WR) - x[i];
      const dy = y[j] - y[i];
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const tr = sxx + syy;
    if (tr <= 0) return [0, 0];
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const conf = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy) / tr;
    return [ang, conf];
  };
  // ---- 林块:群落 + 低频噪声 → 一团团连通的林地 ----
  const forest = new Uint8Array(n);
  const nSalt = gSeed & 0xffff; // 每个种子一张不同的林块分布
  const n85 = wrapCells(world.width, 85);
  const n26 = wrapCells(world.width, 26);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const f = FOREST_OF[biome[i]];
    if (!f) continue;
    const nz = 0.62 * valueNoiseP((x[i] * n85) / WR, y[i] / 85, nSalt, n85) + 0.38 * valueNoiseP((x[i] * n26) / WR, y[i] / 26, nSalt + 1, n26);
    if (nz > f[1]) forest[i] = f[0];
  }
  // 太小的林块(1–2 个地块)大多去掉,留一点零星树丛(按地块顺序找连通块:i = 这块林子编号最小的地块,拿它定去留)
  const comp = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  const members: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!forest[i] || comp[i] >= 0) continue;
    const kind = forest[i];
    members.length = 0;
    stack.push(i);
    comp[i] = i;
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        if (forest[j] === kind && comp[j] < 0) {
          comp[j] = i;
          stack.push(j);
        }
      }
    }
    if (members.length <= 2 && rnd(i, R_FOREST_DROP) < 0.6) for (const c of members) forest[c] = 0;
  }

  // ---- 丘陵候选:山脚下坡度中等的小鼓包;高原(高但平)只放零星几个 ----
  const hCand: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || forest[i]) continue;
    if (e0[i] < hillMin || ridge[i] <= 0) continue;
    hCand.push(i);
  }
  hCand.sort((a, b) => e0[b] + ridge[b] - (e0[a] + ridge[a]));

  // ---- 沙丘 / 草丛候选:荒漠、草原、苔原里(不在林子里)的地块 ----
  const dCand: number[] = [];
  const dKind = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i] || forest[i]) continue;
    const b = biome[i];
    if (b === Biome.HotDesert || b === Biome.TemperateDesert) dKind[i] = G_DUNE;
    else if (b === Biome.Steppe || b === Biome.Savanna || b === Biome.Tundra) dKind[i] = G_TUFT;
    else continue;
    dCand.push(i);
  }

  // ---- 占位网格:符号互相保持距离 ----
  // 分级放(GLYPH_TIERS):第 t 级按这一级的符号大小(glyphScale)占位 —— 先把前几级已放的符号按这一级的大小占上,
  // 再在空当里放这一级新的。放大到这一级时,老符号在世界坐标里变小,新符号正好补进空出来的地方,
  // 所以越放大越密、不会一放大就稀;全图(第 0 级)的符号也照样在,只是更小。
  const placed: { x: number; y: number; r: number }[] = [];
  const cellSize = 24;
  const gw = Math.ceil(world.width / cellSize);
  let grid = new Map<number, number[]>();
  const near = (px: number, py: number, rad: number) => {
    const gx = Math.floor(px / cellSize);
    const gy = Math.floor(py / cellSize);
    if (metric) return nearM(px, py, rad, gx, gy, metric);
    for (let yy = gy - 2; yy <= gy + 2; yy++)
      for (let x0 = gx - 2; x0 <= gx + 2; x0++) {
        // 东西相连:格子列号取模,距离按短的那边
        const xx = x0 < 0 ? x0 + gw : x0 >= gw ? x0 - gw : x0;
        const l = grid.get(yy * gw + xx);
        if (!l) continue;
        for (const id of l) {
          const q = placed[id];
          const need = Math.max(rad, q.r) * tf;
          if ((nearX(q.x, px, WR) - px) ** 2 + (q.y - py) ** 2 < need * need) return true;
        }
      }
    return false;
  };
  /** 按投影后的距离查(横向、纵向各乘这一带的倍数;倍数小的地方多查几格) */
  const nearM = (px: number, py: number, rad: number, gx: number, gy: number, m: GlyphMetric) => {
    const rx = Math.min((gw - 1) >> 1, Math.max(2, Math.ceil(2 / m.fx(py))));
    const ry = Math.max(2, Math.ceil(2 / m.fy(py)));
    for (let yy = gy - ry; yy <= gy + ry; yy++)
      for (let x0 = gx - rx; x0 <= gx + rx; x0++) {
        const xx = ((x0 % gw) + gw) % gw;
        const l = grid.get(yy * gw + xx);
        if (!l) continue;
        for (const id of l) {
          const q = placed[id];
          const need = Math.max(rad, q.r) * tf;
          const my = (q.y + py) / 2;
          const dx = (nearX(q.x, px, WR) - px) * m.fx(my);
          const dy = (q.y - py) * m.fy(my);
          if (dx * dx + dy * dy < need * need) return true;
        }
      }
    return false;
  };
  const index = (id: number) => {
    const q = placed[id];
    const key = Math.floor(q.y / cellSize) * gw + Math.floor(q.x / cellSize);
    const l = grid.get(key);
    if (l) l.push(id);
    else grid.set(key, [id]);
  };
  /** rad = 缩放 1 倍时的占位半径;比较时乘这一级的大小倍数 tf */
  const add = (px: number, py: number, rad: number) => {
    placed.push({ x: px, y: py, r: rad });
    index(placed.length - 1);
  };
  let tf = 1;
  const used = new Uint8Array(n); // 已经有符号的地块
  const mtnCell = new Uint8Array(n);

  for (let tier = 0; tier < GLYPH_TIERS.length; tier++) {
    const z = GLYPH_TIERS[tier];
    tf = glyphScale(z);
    if (tier > 0) {
      grid = new Map();
      for (let id = 0; id < placed.length; id++) index(id);
    }

    // ---- 火山(阶段 4 改地形):作者放的火山,峰顶画一座冒烟的山;先占位,周围不再放普通的山 ----
    if (tier === 0) {
      for (const i of world.volcanoes ?? []) {
        if (!land[i]) continue;
        const tE = Math.min(1, Math.max(0, e0[i] / maxE));
        const s = 6 + 7 * Math.sqrt(tE);
        add(x[i], y[i], s * 1.15);
        used[i] = 1;
        glyphs.push({ x: x[i], y: y[i], kind: G_VOLCANO, s, v: 0.5, a: 0, c: 0, cell: i, z });
      }
    }

    // ---- 山:只放在山脊上。全图只放主脊和够大的侧脊,放大后侧脊补齐 ----
    for (const i of mCand) {
      if (used[i]) continue;
      // 大小 = 海拔 + 突出程度:主峰大、侧峰小
      const tE = Math.min(1, Math.max(0, (e0[i] - mtnBase) / Math.max(1, maxE - mtnBase)));
      const tP = Math.min(1, Math.max(0, (e0[i] - base[i]) / (maxE * 0.3)));
      const tR = Math.min(1, Math.max(0, ridge[i] / (maxE * 0.12)));
      const main = level[i] === 2;
      const s = main ? 4.6 + 8.4 * Math.sqrt(0.6 * tE + 0.4 * tP) : 3.5 + 4.2 * Math.sqrt(0.6 * tE + 0.4 * tP) * (0.55 + 0.45 * tR);
      if (tier === 0 && !main && s < 5.3) continue;
      const rad = main ? s * 0.62 : s * 0.9;
      if (near(x[i], y[i], rad)) continue;
      add(x[i], y[i], rad);
      used[i] = mtnCell[i] = 1;
      const [a, c] = ridgeAxis(i);
      glyphs.push({ x: x[i], y: y[i], kind: G_MOUNTAIN, s, v: rnd(i, R_MTN_LEAN), a, c, cell: i, z });
    }

    // ---- 丘陵:每升一级,放的概率高一点 ----
    const boost = 0.55 + 0.45 * tier;
    for (const i of hCand) {
      if (used[i]) continue;
      const e = e0[i];
      const sl = slope[i];
      const plateau = e > mtnBase && !level[i];
      let p: number;
      let spread: number;
      if (plateau) {
        // 高原:又高又平 → 很稀疏
        p = sl > 18 ? 0.35 : 0.12;
        spread = 4;
      } else if (level[i]) {
        // 山脊上没轮到山的空当,补小丘
        p = 0.5;
        spread = 1.8;
      } else {
        // 山脚 / 丘陵地:坡度中等最密,太平的不放
        const tS = Math.min(1, Math.max(0, (sl - 8) / 30));
        p = 0.75 * tS;
        spread = 2;
      }
      if (rnd(i, R_HILL_PICK) >= Math.min(0.95, p * boost)) continue;
      const s = 2.8 + rnd(i, R_HILL_SIZE) * 1.1 + Math.min(0.9, ridge[i] / 450);
      const rad = s * spread;
      if (near(x[i], y[i], rad)) continue;
      add(x[i], y[i], rad);
      used[i] = 1;
      glyphs.push({ x: x[i], y: y[i], kind: G_HILL, s, v: rnd(i, R_HILL_LEAN), a: 0, c: 0, cell: i, z });
    }

    // ---- 沙漠 / 草原:稀疏点缀,每升一级密一点 ----
    for (const i of dCand) {
      if (used[i]) continue;
      const kind = dKind[i];
      const dens = kind === G_DUNE ? 0.14 : 0.16;
      if (rnd(i, R_DOT_PICK) > dens * (1 + 0.9 * tier)) continue;
      let px = x[i] + (rnd(i, R_DOT_X) - 0.5) * spacing * 1.2;
      const py = y[i] + (rnd(i, R_DOT_Y) - 0.5) * spacing * 1.2;
      // 东西相连:挪出左右边的放回图里(画的时候挨着边的会在另一边再画一份)
      px = px < 0 ? px + WR : px >= WR ? px - WR : px;
      const rad = kind === G_DUNE ? 5 : 2.6;
      if (near(px, py, rad)) continue;
      add(px, py, rad);
      used[i] = 1;
      glyphs.push({ x: px, y: py, kind, s: 1, v: rnd(i, R_DOT_LEAN), a: 0, c: 0, cell: i, z });
    }
  }

  glyphs.sort((a, b) => a.y - b.y);
  return { glyphs, forest };
}

const CANOPY: Record<number, string> = {
  [F_BROAD]: 'rgb(150,165,108)',
  [F_PINE]: 'rgb(118,140,104)',
  [F_JUNGLE]: 'rgb(118,145,90)',
};

/** 林块分块画的方格边长(像素,整数:方格边落在像素边上,相邻两格的裁剪不重叠、不留缝) */
const FOREST_TILE = 128;
/** 林块的墨线半宽、阴影排线间距(世界单位,缩放 1 倍时;放大后按 glyphScale 收) */
const FOREST_LW = 0.55;
const FOREST_HATCH = 1.7;

/**
 * 林块:扇贝边轮廓 + 平涂树冠色 + 东南侧阴影排线 + 内部一片小树冠。
 * 全图时树冠小而密(一片林区的质感);放大后树冠按 glyphScale 收、每个地块多长几棵(GLYPH_TIERS),越放大越细密。
 * 按整张图的固定方格分块画:每一格只用它附近的地块拼路径、裁在自己的格子里。
 * 整片林子拼成一条大路径时,浏览器(GPU)栅格化的抗锯齿会随整条路径的范围变一点 ——
 * 别处多出一块林子,这里的边缘也跟着差几个色阶;分块后远处的格子路径一模一样,画出来逐像素不变。
 * v = 画布变换(铺进地形图时是整张图;细节层是视口,画布外的地块不画)。
 * sphere:地球仪的贴图(等距圆柱,包到球上以后纬度 φ 处横向被压成 cos φ):每个地块的圆、树冠按 1 / cos φ 横向拉宽成椭圆,
 * 包到球上正好是圆 —— 高纬度的林块、树冠在球上不扁(平面主图不用这个)
 */
function drawForests(ctx: CanvasRenderingContext2D, world: World, forest: Uint8Array, v: VecView, T: number, pc?: ProjCells, sphere = false) {
  const { mesh, water } = world;
  const { n, x, y, spacing, adjStart, adj } = mesh;
  const seed = subSeed(world.params.seed, 'glyphs');
  const S = v.s;
  const gs = glyphScale(v.k);
  const lw = FOREST_LW * gs * S;
  const shadeD = spacing * 0.42 * gs * S;
  let hatchGap = FOREST_HATCH * gs * S;
  // 东西相连:排线间距微调到一整圈正好是整数条,左右接缝处排线对得上
  if (v.wrap) hatchGap = (v.wrap * S) / Math.max(1, Math.round((v.wrap * S) / hatchGap));
  /** 每个内部地块画几棵树冠:全图 1 棵(一部分地块),每升一级多一棵 */
  let crownsPer = 1;
  for (let t = 1; t < GLYPH_TIERS.length; t++) if (v.k >= GLYPH_TIERS[t] * 0.95) crownsPer++;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const tw = Math.ceil(W / T);
  const th = Math.ceil(H / T);
  // 一个地块的林子最远画到中心外多远:针叶尖顶(1.55 × 0.94 个间距)、内部的大圆(1.35),
  // 加墨线半宽、往西北平移的阴影(shadeD)、留一点余量
  const reach = spacing * 1.8 * S + shadeD + lw + 2;

  // 每一格、每种林子一组路径:shape = 每个地块一个小圆(边界上的圆大小、位置随机 → 扇贝边;
  // 内部的圆大一些,保证连成一片不漏纸色),crown* = 内部的树冠
  type Paths = { shape: Path2D; crowns: Path2D; crownShade: Path2D; crownFill: Path2D };
  const tiles = new Map<number, (Paths | null)[]>(); // 格子编号 → [无, 阔叶, 针叶, 雨林]
  const hit: Paths[] = [];
  /** (cx, cy) 处的林子会画到的格子(这种林子的路径组,没有就建);横向够得着的范围 rch × ax */
  const tilesNear = (cx: number, cy: number, kind: number, rch = reach, ax = 1) => {
    hit.length = 0;
    const tx0 = Math.max(0, Math.floor((cx - rch * ax) / T));
    const tx1 = Math.min(tw - 1, Math.floor((cx + rch * ax) / T));
    const ty0 = Math.max(0, Math.floor((cy - rch) / T));
    const ty1 = Math.min(th - 1, Math.floor((cy + rch) / T));
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = ty * tw + tx;
        let t = tiles.get(key);
        if (!t) tiles.set(key, (t = [null, null, null, null]));
        let g = t[kind];
        if (!g) t[kind] = g = { shape: new Path2D(), crowns: new Path2D(), crownShade: new Path2D(), crownFill: new Path2D() };
        hit.push(g);
      }
    return hit;
  };
  // 东西相连:挨着左右边的地块在另一边再铺一份(平移一整圈),两边的格子各裁各的,拼起来左右相接
  const wrap = v.wrap ?? 0;
  const reachW = reach / S;
  if (pc) {
    // 弯边投影:地块中心投影过去;林块的圆按这一带地块在投影里的间距放缩(sig,连成一片不漏纸色),
    // 树冠、墨线、阴影、排线按屏幕大小。挨着 ±180° 的地块在另一边再铺一份(落在外轮廓外的那半由外轮廓裁掉)
    for (let i = 0; i < n; i++) {
      const kind = forest[i];
      if (!kind) continue;
      const sg = pc.sig[i];
      const rch = spacing * 1.8 * S * sg + shadeD + lw + 2;
      const K = pc.K[i];
      for (const sh of relShifts(pc.rel[i], rch / (Math.max(1e-6, K) * S))) forestCell(i, kind, (pc.X[i] + sh * K) * S + v.ox, pc.Y[i] * S + v.oy, sg, rch);
    }
  } else if (sphere) {
    // 地球仪贴图:按这个地块所在纬度横向拉宽 1 / cos φ(包到球上是圆)
    for (let i = 0; i < n; i++) {
      const kind = forest[i];
      if (!kind) continue;
      const ax = sphereStretch(y[i], world.height);
      for (const sh of wrapShifts(x[i] - reachW * ax, x[i] + reachW * ax, wrap)) forestCell(i, kind, (x[i] + sh) * S + v.ox, y[i] * S + v.oy, 1, reach, ax);
    }
  } else
    for (let i = 0; i < n; i++) {
      const kind = forest[i];
      if (!kind) continue;
      for (const sh of wrapShifts(x[i] - reachW, x[i] + reachW, wrap)) forestCell(i, kind, (x[i] + sh) * S + v.ox, y[i] * S + v.oy);
    }
  /** ax = 横向拉宽倍数(地球仪贴图;平面 = 1,乘 1 不改变任何数) */
  function forestCell(i: number, kind: number, X: number, Y: number, sg = 1, rch = reach, ax = 1) {
    if (X < -rch * ax || Y < -rch || X > W + rch * ax || Y > H + rch) return;
    let boundary = false;
    let coast = false;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (forest[j] !== kind) boundary = true;
      if (water[j] !== 0) coast = true;
    }
    const pointy = kind === F_PINE;
    const h1 = hash2(i, 1, seed);
    if (boundary) {
      let R = spacing * (0.62 + 0.32 * h1) * S * sg;
      if (coast) R *= 0.62;
      const cx = X + (hash2(i, 2, seed) - 0.5) * spacing * 0.6 * S * sg * ax;
      const cy = Y + (hash2(i, 3, seed) - 0.5) * spacing * 0.6 * S * sg;
      for (const g of tilesNear(cx, cy, kind, rch, ax)) {
        if (ax !== 1) {
          if (pointy) addPineTopX(g.shape, cx, cy, R, ax);
          else addEllipse(g.shape, cx, cy, R, ax);
        } else if (pointy) addPineTop(g.shape, cx, cy, R);
        else addCircle(g.shape, cx, cy, R);
      }
      return;
    }
    const gs0 = tilesNear(X, Y, kind, rch, ax);
    for (const g of gs0) {
      if (ax !== 1) addEllipse(g.shape, X, Y, spacing * 1.35 * S * sg, ax);
      else addCircle(g.shape, X, Y, spacing * 1.35 * S * sg);
    }
    // 内部树冠:东南侧一弯阴影 + 顶上一道墨弧(针叶是小尖角)。第一棵只长在一部分地块上,之后每级每个地块多一棵
    for (let c = 0; c < crownsPer; c++) {
      if (c === 0 && hash2(i, 4, seed) >= (kind === F_JUNGLE ? 0.72 : 0.6)) continue;
      const jx = c === 0 ? hash2(i, 2, seed) : hash2(i, 10 + c * 2, seed);
      const jy = c === 0 ? hash2(i, 3, seed) : hash2(i, 11 + c * 2, seed);
      const spread = c === 0 ? 0.6 : 1.05;
      const tx = X + (jx - 0.5) * spacing * spread * S * sg * ax;
      const ty = Y + (jy - 0.5) * spacing * spread * S * sg;
      const rr = spacing * (0.3 + 0.14 * (c === 0 ? h1 : hash2(i, 20 + c, seed))) * gs * S;
      const off = rr * 0.32;
      for (const g of gs0) {
        if (ax !== 1) {
          if (pointy) {
            addChevronX(g.crownShade, tx + off * ax, ty + off, rr, ax, true);
            addChevronX(g.crownFill, tx, ty, rr, ax, true);
            addChevronX(g.crowns, tx, ty, rr, ax, false);
          } else {
            addEllipse(g.crownShade, tx + off * ax, ty + off, rr, ax);
            addEllipse(g.crownFill, tx, ty, rr, ax);
            g.crowns.moveTo(tx - rr * ax, ty);
            g.crowns.ellipse(tx, ty, rr * ax, rr, 0, Math.PI, Math.PI * 2);
          }
        } else if (pointy) {
          addChevron(g.crownShade, tx + off, ty + off, rr, true);
          addChevron(g.crownFill, tx, ty, rr, true);
          addChevron(g.crowns, tx, ty, rr, false);
        } else {
          addCircle(g.crownShade, tx + off, ty + off, rr);
          addCircle(g.crownFill, tx, ty, rr);
          g.crowns.moveTo(tx - rr, ty);
          g.crowns.arc(tx, ty, rr, Math.PI, Math.PI * 2);
        }
      }
    }
  }

  // 排线的相位跟着世界坐标走(细节层平移后排线不"游动")
  const phase = v.ox + v.oy;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [key, t] of tiles) {
    const X0 = (key % tw) * T;
    const Y0 = Math.floor(key / tw) * T;
    const X1 = Math.min(W, X0 + T);
    const Y1 = Math.min(H, Y0 + T);
    // 地球仪贴图:往西北的阴影平移量也按这一格的纬度横向拉宽(平面 = 1)
    const tax = sphere ? sphereStretch(((Y0 + Y1) / 2 - v.oy) / S, world.height) : 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(X0, Y0, X1 - X0, Y1 - Y0);
    ctx.clip();
    for (const kind of [F_BROAD, F_JUNGLE, F_PINE]) {
      const g = t[kind];
      if (!g) continue;
      const canopy = CANOPY[kind];
      // 1. 轮廓:所有小圆先描一道粗墨线,再用树冠色填满 → 内部的线全被盖住,只剩外圈的扇贝边
      ctx.strokeStyle = INK_CSS + '0.85)';
      ctx.lineWidth = lw * 2;
      ctx.stroke(g.shape);
      ctx.fillStyle = canopy;
      ctx.fill(g.shape);
      // 2. 东南侧阴影:林块内部、且往西北平移后盖不到的一圈 → 背光的边
      ctx.save();
      ctx.clip(g.shape);
      ctx.fillStyle = INK_CSS + '0.10)';
      ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
      ctx.beginPath();
      // 排线:线 x + y = c(方向"/"),c = 第几条 × 间距 + 相位(整张图一套),每条画满这一格
      for (let q = Math.ceil((X0 + Y0 - phase) / hatchGap), qEnd = (X1 + Y1 - phase) / hatchGap; q < qEnd; q++) {
        const c = q * hatchGap + phase;
        const ax = Math.max(X0 - 2, c - Y1 - 2);
        const bx = Math.min(X1 + 2, c - Y0 + 2);
        if (ax >= bx) continue;
        ctx.moveTo(ax, c - ax);
        ctx.lineTo(bx, c - bx);
      }
      ctx.strokeStyle = INK_CSS + '0.42)';
      ctx.lineWidth = 0.55 * gs * S;
      ctx.stroke();
      ctx.translate(-shadeD * tax, -shadeD);
      ctx.fillStyle = canopy;
      ctx.fill(g.shape);
      ctx.restore();
      // 3. 内部树冠
      ctx.fillStyle = INK_CSS + '0.22)';
      ctx.fill(g.crownShade);
      ctx.fillStyle = canopy;
      ctx.fill(g.crownFill);
      ctx.strokeStyle = INK_CSS + '0.6)';
      ctx.lineWidth = 0.55 * gs * S;
      ctx.stroke(g.crowns);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** 地球仪贴图横向拉宽多少(世界 y 处的 1 / cos 纬度;两极附近封顶,极点本身是奇点) */
export const SPHERE_STRETCH_MAX = 24;
export function sphereStretch(wy: number, H: number): number {
  const c = Math.cos(Math.PI / 2 - (wy / H) * Math.PI);
  return c > 1 / SPHERE_STRETCH_MAX ? 1 / c : SPHERE_STRETCH_MAX;
}

/** 横向拉宽 ax 倍的圆(椭圆) */
function addEllipse(p: Path2D, cx: number, cy: number, R: number, ax: number) {
  p.moveTo(cx + R * ax, cy);
  p.ellipse(cx, cy, R * ax, R, 0, 0, Math.PI * 2);
}

/** 横向拉宽 ax 倍的针叶小尖角 */
function addChevronX(p: Path2D, cx: number, cy: number, r: number, ax: number, closed: boolean) {
  p.moveTo(cx - r * 0.75 * ax, cy + r * 0.35);
  p.lineTo(cx, cy - r * 0.95);
  p.lineTo(cx + r * 0.75 * ax, cy + r * 0.35);
  if (closed) p.closePath();
}

/** 横向拉宽 ax 倍的"尖头扇贝" */
function addPineTopX(p: Path2D, cx: number, cy: number, R: number, ax: number) {
  p.moveTo(cx, cy - R * 1.55);
  p.quadraticCurveTo(cx + R * 0.35 * ax, cy - R * 0.45, cx + R * ax, cy + R * 0.3);
  p.quadraticCurveTo(cx, cy + R * 1.15, cx - R * ax, cy + R * 0.3);
  p.quadraticCurveTo(cx - R * 0.35 * ax, cy - R * 0.45, cx, cy - R * 1.55);
  p.closePath();
}

/** 针叶树冠的小尖角(closed = 封闭三角形,否则只画 ∧ 两笔) */
function addChevron(p: Path2D, cx: number, cy: number, r: number, closed: boolean) {
  p.moveTo(cx - r * 0.75, cy + r * 0.35);
  p.lineTo(cx, cy - r * 0.95);
  p.lineTo(cx + r * 0.75, cy + r * 0.35);
  if (closed) p.closePath();
}

function addCircle(p: Path2D, cx: number, cy: number, R: number) {
  p.moveTo(cx + R, cy);
  p.arc(cx, cy, R, 0, Math.PI * 2);
}

/** 针叶林的"尖头扇贝":上尖下圆的小树顶 */
function addPineTop(p: Path2D, cx: number, cy: number, R: number) {
  p.moveTo(cx, cy - R * 1.55);
  p.quadraticCurveTo(cx + R * 0.35, cy - R * 0.45, cx + R, cy + R * 0.3);
  p.quadraticCurveTo(cx, cy + R * 1.15, cx - R, cy + R * 0.3);
  p.quadraticCurveTo(cx - R * 0.35, cy - R * 0.45, cx, cy - R * 1.55);
  p.closePath();
}

/**
 * 山 / 丘陵 / 沙丘 / 草丛 / 火山。v = 画布变换;只画出现门槛 g.z ≤ v.k 的符号(细节层级),
 * 符号本身按 S = glyphScale(k) × v.s 画(位置按 v.s:符号钉在世界坐标上,大小比地图放大得慢)。
 */
function drawSymbols(ctx: CanvasRenderingContext2D, glyphs: Glyph[], v: VecView) {
  const S = glyphScale(v.k) * v.s;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const pad = 30 * S;
  const kz = v.k * 1.0001;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 东西相连:挨着左右边的符号在另一边再画一份(各被画布裁掉一半,拼起来是一整个)
  const wrap = v.wrap ?? 0;
  const padW = pad / v.s;
  const pj = v.proj;
  for (const g of glyphs) {
    if (g.z > kz) continue;
    if (pj) {
      // 弯边投影:符号钉在投影后的位置上,正立、按屏幕大小画;山脊走向按投影换算。
      // 挨着 ±180° 的在另一边再画一份(外轮廓外的那半由外轮廓裁掉)
      const rel = pj.rel(g.x);
      const K = pj.K(g.y);
      const mx = pj.W / 2 + K * rel;
      const gy = pj.Y(g.y) * v.s + v.oy;
      const a = g.kind === G_MOUNTAIN ? projectedAngle(pj, g, rel) : g.a;
      for (const sh of relShifts(rel, pad / (Math.max(1e-6, K) * v.s))) glyph(g, (mx + sh * K) * v.s + v.ox, gy, a);
      continue;
    }
    for (const sh of wrapShifts(g.x - padW, g.x + padW, wrap)) glyph(g, (g.x + sh) * v.s + v.ox, g.y * v.s + v.oy, g.a);
  }
  function glyph(g: Glyph, gx: number, gy: number, ga: number) {
    if (gx < -pad || gy < -pad || gx > W + pad || gy > H + pad) return;
    drawGlyph(ctx, g, gx, gy, ga, S);
  }
}

/**
 * 画一个符号(山 / 丘陵 / 沙丘 / 草丛 / 火山):(gx, gy) = 符号底边中点(画布像素),ga = 画面上的山脊走向(弧度),
 * S = 一个世界单位的符号尺寸(画布像素;符号多大按 g.s × S)。调用前设好 lineCap / lineJoin = 'round'。
 * 平面主图(drawSymbols)和地球仪(render/globeGlyphs.ts:每帧在球上正立着画)共用这一份画法
 */
export function drawGlyph(ctx: CanvasRenderingContext2D, g: Glyph, gx: number, gy: number, ga: number, S: number): void {
  const paper = 'rgb(236,224,193)';
  const s = g.s * S;
  switch (g.kind) {
    case G_MOUNTAIN: {
      // 沿山脊走向微微倾斜:东北—西南走向的脊,峰顶偏右;西北—东南走向偏左
      const sin2 = Math.sin(2 * ga);
      const lean = (-sin2 * 0.32 * g.c + (g.v - 0.5) * 0.22) * s;
      // 东西走向的脊符号宽一点,南北走向的窄一点(叠成一列)
      const ws = mountainHalfWidth(g, ga) * S;
      const px = gx + lean;
      const py = gy - s * 1.15;
      const lx = gx - ws;
      const rx = gx + ws;
      // 底色遮挡后面的符号
      ctx.beginPath();
      ctx.moveTo(lx, gy);
      ctx.quadraticCurveTo(gx - ws * 0.5 + lean * 0.5, gy - s * 0.55, px, py);
      ctx.quadraticCurveTo(gx + ws * 0.45 + lean * 0.5, gy - s * 0.6, rx, gy);
      ctx.quadraticCurveTo(gx, gy + s * 0.12, lx, gy);
      ctx.fillStyle = paper;
      ctx.fill();
      // 背光面
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(gx + ws * 0.05 + lean * 0.3, gy - s * 0.45, gx + ws * 0.12, gy + s * 0.04);
      ctx.quadraticCurveTo(gx + ws * 0.6, gy + s * 0.06, rx, gy);
      ctx.quadraticCurveTo(gx + ws * 0.45 + lean * 0.5, gy - s * 0.6, px, py);
      ctx.fillStyle = 'rgba(128,104,76,0.48)';
      ctx.fill();
      // 轮廓
      ctx.beginPath();
      ctx.moveTo(lx, gy);
      ctx.quadraticCurveTo(gx - ws * 0.5 + lean * 0.5, gy - s * 0.55, px, py);
      ctx.quadraticCurveTo(gx + ws * 0.45 + lean * 0.5, gy - s * 0.6, rx, gy);
      ctx.strokeStyle = INK_CSS + '0.95)';
      ctx.lineWidth = (0.7 + 0.035 * g.s) * S;
      ctx.stroke();
      // 山脊线 + 排线
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(gx + ws * 0.05 + lean * 0.3, gy - s * 0.45, gx + ws * 0.12, gy - s * 0.05);
      const hatch = Math.max(2, Math.round(g.s / 2.6));
      for (let hI = 1; hI <= hatch; hI++) {
        const t = hI / (hatch + 1);
        const ax = px + (rx - px) * t;
        const ay = py + (gy - py) * t;
        ctx.moveTo(ax - s * 0.05, ay + s * 0.02);
        ctx.lineTo(ax - s * 0.22, ay + s * 0.26);
      }
      ctx.lineWidth = 0.5 * S;
      ctx.strokeStyle = INK_CSS + '0.7)';
      ctx.stroke();
      break;
    }
    case G_VOLCANO:
      drawVolcano(ctx, gx, gy, s, S);
      break;
    case G_HILL: {
      ctx.beginPath();
      ctx.moveTo(gx - s, gy);
      ctx.quadraticCurveTo(gx, gy - s * 1.1, gx + s, gy);
      ctx.fillStyle = paper;
      ctx.fill();
      ctx.strokeStyle = INK_CSS + '0.85)';
      ctx.lineWidth = 0.7 * S;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gx + s * 0.25, gy - s * 0.35);
      ctx.lineTo(gx + s * 0.55, gy - s * 0.05);
      ctx.lineWidth = 0.5 * S;
      ctx.stroke();
      break;
    }
    case G_DUNE: {
      ctx.beginPath();
      ctx.moveTo(gx - 3 * S, gy);
      ctx.quadraticCurveTo(gx - 0.75 * S, gy - 1.95 * S, gx + 2.6 * S, gy - 0.22 * S);
      ctx.strokeStyle = INK_CSS + '0.5)';
      ctx.lineWidth = 0.55 * S;
      ctx.stroke();
      break;
    }
    case G_TUFT: {
      ctx.beginPath();
      ctx.moveTo(gx - 1.25 * S, gy - 1.25 * S);
      ctx.lineTo(gx - 0.45 * S, gy);
      ctx.moveTo(gx, gy - 1.85 * S);
      ctx.lineTo(gx, gy);
      ctx.moveTo(gx + 1.25 * S, gy - 1.25 * S);
      ctx.lineTo(gx + 0.45 * S, gy);
      ctx.strokeStyle = INK_CSS + '0.45)';
      ctx.lineWidth = 0.45 * S;
      ctx.stroke();
      break;
    }
  }
}

/** 火山:平顶的锥(山口一圈椭圆)、背光面排线、山口冒出的一缕烟(几团往上飘、往右偏的烟卷) */
function drawVolcano(ctx: CanvasRenderingContext2D, gx: number, gy: number, s: number, S: number) {
  const paper = 'rgb(236,224,193)';
  const hw = s * 1.05; // 山脚半宽
  const top = gy - s * 1.05; // 山口高度
  const cw = s * 0.26; // 山口半宽
  const flankL = (p: Path2D | CanvasRenderingContext2D) => {
    p.moveTo(gx - hw, gy);
    p.quadraticCurveTo(gx - hw * 0.42, gy - s * 0.3, gx - cw, top);
  };
  const flankR = (p: Path2D | CanvasRenderingContext2D) => {
    p.moveTo(gx + cw, top);
    p.quadraticCurveTo(gx + hw * 0.42, gy - s * 0.3, gx + hw, gy);
  };
  // 底色遮挡后面的符号
  ctx.beginPath();
  flankL(ctx);
  ctx.lineTo(gx + cw, top);
  ctx.quadraticCurveTo(gx + hw * 0.42, gy - s * 0.3, gx + hw, gy);
  ctx.quadraticCurveTo(gx, gy + s * 0.12, gx - hw, gy);
  ctx.fillStyle = paper;
  ctx.fill();
  // 背光面
  ctx.beginPath();
  ctx.moveTo(gx + cw * 0.3, top + s * 0.06);
  ctx.quadraticCurveTo(gx + s * 0.08, gy - s * 0.4, gx + hw * 0.14, gy + s * 0.04);
  ctx.quadraticCurveTo(gx + hw * 0.6, gy + s * 0.06, gx + hw, gy);
  ctx.quadraticCurveTo(gx + hw * 0.42, gy - s * 0.3, gx + cw, top);
  ctx.closePath();
  ctx.fillStyle = 'rgba(128,104,76,0.42)';
  ctx.fill();
  // 顺坡流下的几道岩浆冷凝的沟(淡赭色)
  ctx.beginPath();
  ctx.moveTo(gx - cw * 0.35, top + s * 0.08);
  ctx.quadraticCurveTo(gx - s * 0.2, gy - s * 0.45, gx - s * 0.34, gy - s * 0.08);
  ctx.moveTo(gx + cw * 0.1, top + s * 0.1);
  ctx.quadraticCurveTo(gx + s * 0.02, gy - s * 0.5, gx - s * 0.04, gy - s * 0.18);
  ctx.strokeStyle = 'rgba(150,72,42,0.55)';
  ctx.lineWidth = 0.75 * S;
  ctx.stroke();
  // 轮廓
  ctx.beginPath();
  flankL(ctx);
  flankR(ctx);
  ctx.strokeStyle = INK_CSS + '0.95)';
  ctx.lineWidth = (0.8 + 0.02 * s / S) * S;
  ctx.stroke();
  // 山口
  ctx.beginPath();
  ctx.ellipse(gx, top, cw, cw * 0.36, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(96,70,50,0.75)';
  ctx.fill();
  ctx.lineWidth = 0.7 * S;
  ctx.strokeStyle = INK_CSS + '0.9)';
  ctx.stroke();
  // 排线
  ctx.beginPath();
  const hatch = Math.max(2, Math.round(s / (3 * S)));
  for (let k = 1; k <= hatch; k++) {
    const t = k / (hatch + 1);
    const ax = gx + cw + (hw - cw) * t * 0.9;
    const ay = top + (gy - top) * t;
    ctx.moveTo(ax - s * 0.04, ay + s * 0.02);
    ctx.lineTo(ax - s * 0.2, ay + s * 0.24);
  }
  ctx.lineWidth = 0.7 * S;
  ctx.strokeStyle = INK_CSS + '0.7)';
  ctx.stroke();
  // 烟:三团烟卷,越往上越大、越往右飘
  const puffs: [number, number, number][] = [
    [gx + s * 0.06, top - s * 0.34, s * 0.2],
    [gx + s * 0.3, top - s * 0.78, s * 0.26],
    [gx + s * 0.7, top - s * 1.18, s * 0.3],
  ];
  for (let k = puffs.length - 1; k >= 0; k--) {
    const [px, py, pr] = puffs[k];
    ctx.beginPath();
    // 一团烟 = 三个挨着的小弧(上沿起伏),底边平一点
    ctx.moveTo(px - pr, py + pr * 0.35);
    ctx.arc(px - pr * 0.45, py, pr * 0.62, Math.PI * 0.85, Math.PI * 1.75);
    ctx.arc(px + pr * 0.2, py - pr * 0.25, pr * 0.62, Math.PI * 1.15, Math.PI * 1.95);
    ctx.arc(px + pr * 0.62, py + pr * 0.05, pr * 0.5, Math.PI * 1.35, Math.PI * 2.3);
    ctx.quadraticCurveTo(px, py + pr * 0.62, px - pr, py + pr * 0.35);
    ctx.fillStyle = 'rgba(236,228,206,0.92)';
    ctx.fill();
    ctx.lineWidth = 0.65 * S;
    ctx.strokeStyle = INK_CSS + '0.6)';
    ctx.stroke();
  }
}

/**
 * 图框(双线)和左下角的罗盘:外框 = 世界坐标 [0, w] × [0, h] 经 v 变换到画布上。
 * 主图是一整圈星球,图框画在视窗上(ui/MapDecor.tsx、导出),不随地图左右平移
 */
export function drawFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, v: VecView) {
  const S = v.s;
  const ox = v.ox;
  const oy = v.oy;
  ctx.save();
  ctx.strokeStyle = INK_CSS + '0.9)';
  ctx.lineWidth = 3 * S;
  ctx.strokeRect(6 * S + ox, 6 * S + oy, (w - 12) * S, (h - 12) * S);
  ctx.lineWidth = 1 * S;
  ctx.strokeRect(13 * S + ox, 13 * S + oy, (w - 26) * S, (h - 26) * S);
  ctx.restore();
  drawCompass(ctx, 95 * S + ox, (h - 95) * S + oy, S);
}

/**
 * 弯边投影的图框:外轮廓一道细墨线(盖住轮廓边缘),往外一点再一道粗线(双线);罗盘在外框左下角(轮廓外面的纸上)。
 * 地图平面 [0, W] × [0, H] 经 v 变换到画布上
 */
export function drawProjFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, mp: MapProj, v: VecView) {
  const S = v.s;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK_CSS + '0.9)';
  outlineOnCanvas(ctx, mp, S, v.ox, v.oy, 0);
  ctx.lineWidth = 1.2 * S;
  ctx.stroke();
  outlineOnCanvas(ctx, mp, S, v.ox, v.oy, 7);
  ctx.lineWidth = 3 * S;
  ctx.stroke();
  ctx.restore();
  const [cx, cy] = compassSpot(mp);
  drawCompass(ctx, cx * S + v.ox, cy * S + v.oy, S);
}

/** 弯边投影时罗盘放哪(地图平面坐标):外框左下角,离轮廓(和外面那道粗线)够远;挪不开就缩到更靠角 */
export function compassSpot(mp: MapProj): [number, number] {
  for (const d of [95, 80, 66]) {
    const x = d;
    const y = mp.H - d;
    let clear = true;
    for (let a = 0; a < 16 && clear; a++) {
      const t = (a / 16) * Math.PI * 2;
      if (insideProj(mp, x + Math.cos(t) * 64, y + Math.sin(t) * 64, -12)) clear = false;
    }
    if (clear) return [x, y];
  }
  return [66, mp.H - 66];
}

/** 罗盘(手绘风):中心 (cx, cy)(画布像素),S = 世界单位 → 画布像素 */
function drawCompass(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, cx: number, cy: number, S: number) {
  ctx.save();
  ctx.strokeStyle = INK_CSS + '0.9)';
  const R = 46 * S;
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.72, 0, Math.PI * 2);
  ctx.lineWidth = 0.9 * S;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.78, 0, Math.PI * 2);
  ctx.lineWidth = 0.6 * S;
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2;
    const long = i % 2 === 0;
    const L = long ? R : R * 0.58;
    const wv = long ? R * 0.14 : R * 0.1;
    const tx = Math.cos(a) * L;
    const ty = Math.sin(a) * L;
    const nx = -Math.sin(a) * wv;
    const ny = Math.cos(a) * wv;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tx, ty);
    ctx.lineTo(nx, ny);
    ctx.closePath();
    ctx.fillStyle = INK_CSS + '0.9)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tx, ty);
    ctx.lineTo(-nx, -ny);
    ctx.closePath();
    ctx.fillStyle = 'rgb(240,228,198)';
    ctx.fill();
    ctx.lineWidth = 0.7 * S;
    ctx.stroke();
  }
  ctx.fillStyle = INK_CSS + '0.95)';
  ctx.font = `600 ${14 * S}px "Songti SC", "STSong", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('北', 0, -R - 3 * S);
  ctx.restore();
}

/**
 * 纸边做旧:越靠边、越靠四角纸色越深(以外框中心为圆心的椭圆,外框四边处 r = 1,纸色往 PAPER_EDGE 调 0.55 × vig(r))。
 * 画在视窗上(ui/MapDecor.tsx、导出),不随地图左右平移。外框 = [0, w] × [0, h] 经 v 变换
 */
export function drawPaperVignette(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, v: VecView) {
  const R = Math.SQRT2;
  ctx.save();
  ctx.translate(v.ox + (w / 2) * v.s, v.oy + (h / 2) * v.s);
  ctx.scale((w / 2) * v.s, (h / 2) * v.s);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const r = (R * i) / N;
    const vr = 0.9 * r - 0.55;
    const vig = vr > 0 ? Math.min(1, Math.pow(vr * 1.9, 1.6)) : 0;
    g.addColorStop(i / N, `rgba(${PAPER_EDGE[0]},${PAPER_EDGE[1]},${PAPER_EDGE[2]},${(0.55 * vig).toFixed(3)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}
