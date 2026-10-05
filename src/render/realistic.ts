/**
 * 写实地貌风格:类似卫星图 + 地形晕渲,按"世界地图"的尺度来画:
 * - 晕渲突出大尺度(整条山脉、高原边缘),平原上的小起伏压平 —— 大陆大半看着平缓,只有几条山脉醒目
 * - 海按深浅分层上色(大陆架浅、深海平原深、洋中脊略浅、海沟最深),再叠一层很淡的海底晕渲
 * - 河流是矢量层(drawRealisticRivers):全图时细、小河不画;放大后细节层(render/detail.ts)按缩放倍数重画,主干才显出粗
 * 像素层(不含河)单独缓存一份(realisticBase),细节层放大时拿它当底图。
 */
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import { BIOMES, classifyBiome } from '../gen/biomes';
import {
  bakedView,
  boxBlur,
  boxBlurWrap,
  cylinderNoise,
  drawRivers,
  hexRGB,
  hillshade,
  mix,
  ramp,
  riverLod,
  rowCos,
  valueNoiseP,
  wrapCells,
  wrapOf,
  type RGB,
  type RiverStyle,
  type VecView,
} from './common';
import { smoothstep } from '../gen/util';
import { reprojectImage, type Projector } from './projection';

/**
 * 海的颜色(按海底深度):0 ~ −200 米是大陆架(浅、亮),过了坡折很快变深;
 * −2000 米上下是洋中脊顶,−3500 ~ −4500 米是深海平原,再往下是海沟。
 */
const OCEAN: [number, RGB][] = [
  [-7000, hexRGB('#04112a')],
  [-5200, hexRGB('#081d3e')],
  [-4300, hexRGB('#0b2649')],
  [-3500, hexRGB('#0e2d55')],
  [-2600, hexRGB('#123a66')],
  [-1800, hexRGB('#174674')],
  [-900, hexRGB('#1c5282')],
  [-400, hexRGB('#236395')],
  [-200, hexRGB('#2f79a8')],
  [-100, hexRGB('#3b8ab3')],
  [0, hexRGB('#4a99ba')],
];
const OCEAN_MIN = -7000;
const OCEAN_N = -OCEAN_MIN / 10 + 1;
let oceanCache: Float32Array | null = null;
/** 海色查找表:−7000 ~ 0 米,每 10 米一格 */
function oceanLut(): Float32Array {
  if (oceanCache) return oceanCache;
  const t = new Float32Array(OCEAN_N * 3);
  for (let i = 0; i < OCEAN_N; i++) {
    const c = ramp(OCEAN, OCEAN_MIN + i * 10);
    t[i * 3] = c[0];
    t[i * 3 + 1] = c[1];
    t[i * 3 + 2] = c[2];
  }
  return (oceanCache = t);
}
const ROCK = hexRGB('#8a7d6c');
const SNOW = hexRGB('#f4f6f8');
const SEA_ICE = hexRGB('#dde8ee');
const ICE_PACK = hexRGB('#e8eef2');
const ICE_YOUNG = hexRGB('#a9bccb');
const SLUSH = hexRGB('#4d6b82');
const LAKE = hexRGB('#2f6690');
/** 暗面的天空散射光:阴影往冷灰蓝里混,而不是压成黑 */
const SKY_SHADOW = hexRGB('#3c465a');

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof document !== 'undefined'
    ? Object.assign(document.createElement('canvas'), { width: w, height: h })
    : new OffscreenCanvas(w, h);
}

/**
 * 当前这张地图的像素层(不含河;只留一份,换了世界就释放)。
 * raw = 水陆交界抗锯齿之前的像素(放大后的细节层拼水、陆两份要用,见 realisticShoreLayers;拼好就不留了)
 */
let base: { raster: Raster; canvas: AnyCanvas; raw: Uint8ClampedArray | null } | null = null;

/** 像素层(地貌、海、冰、晕渲,不含河):铺进地形图,也给放大后的细节层当底图 */
export function realisticBase(r: Raster): AnyCanvas {
  if (base?.raster === r) return base.canvas;
  if (base) base.canvas.width = base.canvas.height = 0;
  const cv = makeCanvas(r.w, r.h);
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  const raw = paintRealistic(ctx, r, undefined, true);
  base = { raster: r, canvas: cv, raw };
  return cv;
}

export function renderRealistic(ctx: CanvasRenderingContext2D, world: World, r: Raster) {
  ctx.drawImage(realisticBase(r), 0, 0);
  drawRealisticRivers(ctx, world, r, bakedView(r.scale));
}

// 等距圆柱主图(Raster.wrap)东西相连:所有邻域操作的列下标取模(左右接缝处无缝),
// 晕渲、陡坡的东西向坡度按纬度修正,纹理噪声左右首尾相接;河流跨 180° 经线时两边各画一份

/**
 * 河流的细节层级(k = 缩放倍数):
 * - 全图只画流量够大的河(小溪放大才出现);最粗的河约 2.4 个世界单位(全图约 1.5 个屏幕像素)
 * - 放大后细水那一份宽度按 k^−0.6 收(屏幕上几乎不变粗),大河的宽度几乎按世界单位(k^−0.12,屏幕上约按 k^0.88 变粗)→ 主干越放大越显得粗
 */
export function realisticRiverStyle(k: number, threshold: number): RiverStyle {
  const kk = Math.max(1, k);
  return {
    color: 'rgb(58, 124, 180)',
    minW: 0.55,
    maxW: 0.55 + 1.9 * Math.pow(kk, -0.12),
    fluxRef: 1400,
    thin: Math.pow(kk, -0.6),
    minFlux: threshold * riverLod(kk),
  };
}

/** 河流(矢量层):越往下游越宽,河口张开;深色河岸让细河在浅色地面上也看得清 */
export function drawRealisticRivers(ctx: CanvasRenderingContext2D, world: World, r: Raster, v: VecView) {
  const style = realisticRiverStyle(v.k, world.riverThreshold);
  drawRivers(ctx, world.rivers, { ...v, wrap: wrapOf(world) }, world.riverThreshold, style, {
    water: r.water,
    w: r.w,
    h: r.h,
    scale: r.scale,
    bank: { color: 'rgba(22, 40, 30, 0.34)', width: 0.45 * (style.thin ?? 1) },
    mouthFlare: 1.5,
    widthPower: 0.65,
  });
}

// ---------------------------------------------------------------------------
// 放大后的岸线(细节层,见 render/detail.ts):像素层放大后水陆之间是一条好几个屏幕像素宽的模糊带,
// 改成"水那一份 + 按岸线裁出来的陆地那一份"叠起来 —— 岸线按屏幕像素画,放大多少倍都是一条清楚的边

/** 岸线两侧各一份的像素层(只留一份,换了世界就释放) */
let shoreCache: { raster: Raster; water: AnyCanvas; land: AnyCanvas } | null = null;

/**
 * 水、陆各一份像素层(用抗锯齿之前的像素):对岸那几个像素换成离它最近的本侧颜色 ——
 * 放大后双线性插值不会把对岸的颜色带过来,两份按岸线拼起来时边上不发虚。
 * 放大到细节层时第一次用到才算(几十毫秒)
 */
export function realisticShoreLayers(r: Raster): { water: AnyCanvas; land: AnyCanvas } {
  if (shoreCache?.raster === r) return shoreCache;
  if (shoreCache) shoreCache.water.width = shoreCache.water.height = shoreCache.land.width = shoreCache.land.height = 0;
  realisticBase(r);
  const sides = shoreSides(base!.raw ?? paintRealistic(rawSink, r, undefined, true)!, r);
  base!.raw = null;
  const layer = (px: Uint8ClampedArray) => {
    const cv = makeCanvas(r.w, r.h);
    (cv.getContext('2d') as CanvasRenderingContext2D).putImageData(new ImageData(px, r.w, r.h), 0, 0);
    return cv;
  };
  shoreCache = { raster: r, water: layer(sides.water), land: layer(sides.land) };
  return shoreCache;
}

/**
 * 纯计算(单测用):抗锯齿之前的像素(RGBA)→ 水、陆两份(见 realisticShoreLayers)。
 * 只改岸边两圈:第 1 圈 = 水陆都有的 2×2 块里的像素(放大后双线性插值只用到这些),第 2 圈 = 它们的 8 邻域
 * (缩放倍数不大时,岸线抗锯齿的那一个屏幕像素可能取到隔壁一格)。每一份里,对岸的像素一圈一圈填上
 * 8 邻域里本侧(或已经填好的)像素的平均色;海和湖算一边
 */
export function shoreSides(px: Uint8ClampedArray, r: Pick<Raster, 'w' | 'h' | 'water'>): { water: Uint8ClampedArray; land: Uint8ClampedArray } {
  const { w, h, water } = r;
  const ring = new Uint8Array(w * h);
  const rings: number[][] = [[], []];
  const add = (j: number, n: number) => {
    if (ring[j]) return;
    ring[j] = n;
    rings[n - 1].push(j);
  };
  for (let y = 0; y < h; y++) {
    const r0 = y * w;
    const r1 = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const x1 = x < w - 1 ? x + 1 : 0;
      const l = water[r0 + x] === 0;
      if ((water[r0 + x1] === 0) === l && (water[r1 + x] === 0) === l && (water[r1 + x1] === 0) === l) continue;
      add(r0 + x, 1);
      add(r0 + x1, 1);
      add(r1 + x, 1);
      add(r1 + x1, 1);
    }
  }
  const nb = new Int32Array(8);
  for (const k of rings[0]) {
    const m = neighbours(k, w, h, nb);
    for (let q = 0; q < m; q++) add(nb[q], 2);
  }
  const side = (land: boolean) => {
    const out = new Uint8ClampedArray(px.length);
    out.set(px);
    // 对岸的像素:1 = 已填好(上一圈),2 = 这一圈刚填
    const done = new Uint8Array(w * h);
    for (const list of rings) {
      for (const k of list) {
        if ((water[k] === 0) === land) continue;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        const m = neighbours(k, w, h, nb);
        for (let q = 0; q < m; q++) {
          const j = nb[q];
          if ((water[j] === 0) !== land && done[j] !== 1) continue;
          sr += out[j * 4];
          sg += out[j * 4 + 1];
          sb += out[j * 4 + 2];
          n++;
        }
        if (!n) continue;
        out[k * 4] = sr / n;
        out[k * 4 + 1] = sg / n;
        out[k * 4 + 2] = sb / n;
        done[k] = 2;
      }
      for (const k of list) if (done[k] === 2) done[k] = 1;
    }
    return out;
  };
  return { water: side(false), land: side(true) };
}

/** 像素 k 的 8 邻域(东西相连,上下到边为止)写进 out,返回几个 */
function neighbours(k: number, w: number, h: number, out: Int32Array): number {
  const x = k % w;
  const y = (k - x) / w;
  const lf = x > 0 ? -1 : w - 1;
  const rt = x < w - 1 ? 1 : 1 - w;
  let n = 0;
  for (let dy = y > 0 ? -1 : 0; dy <= (y < h - 1 ? 1 : 0); dy++) {
    const row = k + dy * w;
    out[n++] = row + lf;
    if (dy) out[n++] = row;
    out[n++] = row + rt;
  }
  return n;
}

/** 只借用 createImageData / putImageData(不碰画布):重算一遍抗锯齿之前的像素用 */
const rawSink = {
  createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: () => {},
} as unknown as CanvasRenderingContext2D;

/**
 * 画路径用到的两个方法(Path2D、画布都有;单测里可以换成记录点的对象)。
 * 每一块不调 closePath:填充、裁剪时没闭合的小块自动按闭合算,而 Chromium 里 closePath 的耗时随路径里已有的块数增长
 * (几万块要几秒)
 */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

/**
 * 方格 → 画布:第 y 行方格夹在像素行 y、y + 1 的中心之间(y = −1 … h − 1;最上、最下一行把图边那半个像素也盖上),
 * 第 i 列夹在像素列 i、i + 1 的中心之间(i 展开的,取像素时取模)。
 *   at(世界 y) = 这条纬线上像素列 i(可以是小数)画在画布的 x = a + b·i,y = c(写进 out = [a, b, c])
 *   cols(y) = 第 y 行方格要走哪几列 [i0, i1](null = 这一行不在画布上)
 */
export interface CellMap {
  rows: [number, number];
  cols(y: number): [number, number] | null;
  at(wy: number, out: Float64Array): void;
}

/**
 * 陆地的范围(加进 path):逐个方格(四角是相邻四个像素的中心)取陆地那一块 —— 四角里陆地的角、水陆不同的边上的交点依次连起来
 * (两个对角是陆地的方格,两块陆地连着,和手绘风海岸墨线的走法一样)。交点:海岸按海拔过零处插值(和海岸墨线同一个位置),
 * 湖岸按模糊过的湖泊掩膜过 0.5 处(和像素层的湖岸抗锯齿一样)。整格都是陆地的,一行里连着的合成一块。
 * 所有小块都是同一个转向、只在边上相接:按非零规则填充 / 裁剪就是整块陆地,块与块之间没有缝
 */
export function addLandCells(path: PathSink, r: Raster, m: CellMap): void {
  const { w, h, water, scale: S } = r;
  const T = new Float64Array(3);
  const B = new Float64Array(3);
  const M = new Float64Array(3);
  // 一块陆地的下一个点(第一个点 moveTo)
  let first = true;
  const pt = (x: number, y: number) => {
    if (first) path.moveTo(x, y);
    else path.lineTo(x, y);
    first = false;
  };
  // 竖边上的交点:世界 y 在上下两行像素中心之间,第 i 列
  const sidePt = (wy: number, i: number) => {
    m.at(wy, M);
    pt(M[0] + M[1] * i, M[2]);
  };
  for (let y = Math.max(-1, m.rows[0]); y <= Math.min(h - 1, m.rows[1]); y++) {
    const cr = m.cols(y);
    if (!cr) continue;
    const rowA = (y < 0 ? 0 : y) * w;
    const rowB = (y + 1 > h - 1 ? h - 1 : y + 1) * w;
    const wy0 = (y + 0.5) / S;
    m.at(wy0, T);
    m.at((y + 1.5) / S, B);
    const [i0, i1] = cr;
    let x0 = i0 % w;
    if (x0 < 0) x0 += w;
    let run = NaN;
    for (let i = i0; i <= i1 + 1; i++, x0 = x0 + 1 === w ? 0 : x0 + 1) {
      const x1 = x0 + 1 === w ? 0 : x0 + 1;
      const ka = rowA + x0;
      const kb = rowA + x1;
      const kc = rowB + x1;
      const kd = rowB + x0;
      const a = water[ka] === 0;
      const b = water[kb] === 0;
      const c = water[kc] === 0;
      const d = water[kd] === 0;
      const full = i <= i1 && a && b && c && d;
      if (full) {
        if (run !== run) run = i;
        continue;
      }
      if (run === run) {
        // 连着的整格陆地:一个四边形(弯边投影里上下两条纬线长短不同)
        path.moveTo(T[0] + T[1] * run, T[2]);
        path.lineTo(T[0] + T[1] * i, T[2]);
        path.lineTo(B[0] + B[1] * i, B[2]);
        path.lineTo(B[0] + B[1] * run, B[2]);
        run = NaN;
      }
      if (i > i1 || !(a || b || c || d)) continue;
      // 水陆都有的方格:左上 → 右上 → 右下 → 左下(和整格的转向一样)
      first = true;
      if (a) pt(T[0] + T[1] * i, T[2]);
      if (a !== b) pt(T[0] + T[1] * (i + shoreT(r, ka, kb)), T[2]);
      if (b) pt(T[0] + T[1] * (i + 1), T[2]);
      if (b !== c) sidePt(wy0 + shoreT(r, kb, kc) / S, i + 1);
      if (c) pt(B[0] + B[1] * (i + 1), B[2]);
      if (c !== d) pt(B[0] + B[1] * (i + shoreT(r, kd, kc)), B[2]);
      if (d) pt(B[0] + B[1] * i, B[2]);
      if (d !== a) sidePt(wy0 + shoreT(r, ka, kd) / S, i);
    }
  }
}

/**
 * 水陆不同的两个相邻像素 ka(左 / 上)、kb(右 / 下)之间,岸线在哪(从 ka 量起的比例):
 * 海岸 = 海拔过零处(同手绘风的海岸墨线);湖岸 = 模糊过的湖泊掩膜过 0.5 处(同像素层的湖岸抗锯齿),对不上像素的归类就取中点
 */
export function shoreT(r: Raster, ka: number, kb: number): number {
  const { water, elev, w, h } = r;
  if (water[ka] === 2 || water[kb] === 2) {
    const fa = lakeField(water, w, h, ka % w, Math.floor(ka / w)) - 0.5;
    const fb = lakeField(water, w, h, kb % w, Math.floor(kb / w)) - 0.5;
    if (fa > 0 !== (water[ka] === 2) || fb > 0 !== (water[kb] === 2) || fa === fb) return 0.5;
    return Math.max(0.1, Math.min(0.9, fa / (fa - fb)));
  }
  const ea = elev[ka];
  const eb = elev[kb];
  return ea < 0 !== eb < 0 && ea !== eb ? Math.max(0.02, Math.min(0.98, ea / (ea - eb))) : 0.5;
}

/** 整张图的陆地范围(等距圆柱;只留一份,换了世界就重建) */
let landPathCache: { raster: Raster; path: Path2D } | null = null;

/**
 * 整张图的陆地范围,坐标是像素层的像素(第 i 列像素中心在 x = i + 0.5)。列取 −2 … w:细节层画布按 180° 经线
 * 分段画(ui/TerrainDetail.tsx),每一段用到的方格都在这里面
 */
function wholeLandPath(r: Raster): Path2D {
  if (landPathCache?.raster === r) return landPathCache.path;
  const path = new Path2D();
  const S = r.scale;
  addLandCells(path, r, {
    rows: [-1, r.h - 1],
    cols: () => [-2, r.w],
    at: (wy, out) => {
      out[0] = 0.5;
      out[1] = 1;
      out[2] = wy * S;
    },
  });
  landPathCache = { raster: r, path };
  return path;
}

/** 等距圆柱的细节层画布(画布 = 世界 × v.s + (v.ox, v.oy))上的方格范围 */
function flatCells(r: Raster, v: { s: number; ox: number; oy: number }, cw: number, ch: number): CellMap {
  const S = r.scale;
  const ps = v.s / S;
  const iA = Math.floor(((0 - v.ox) / v.s) * S - 1.5);
  const iB = Math.ceil(((cw - v.ox) / v.s) * S - 0.5);
  return {
    rows: [Math.floor(((0 - v.oy) / v.s) * S - 1.5), Math.ceil(((ch - v.oy) / v.s) * S - 0.5)],
    cols: () => [iA, iB],
    at: (wy, out) => {
      out[0] = v.ox + 0.5 * ps;
      out[1] = ps;
      out[2] = wy * v.s + v.oy;
    },
  };
}

/** 弯边投影的细节层画布(画布 = 地图平面 × v.s + (v.ox, v.oy))上的方格范围:每一行按这条纬线反算看得见的经度 */
function projectedCells(r: Raster, pj: Projector, v: { s: number; ox: number; oy: number }, cw: number, ch: number): CellMap {
  const { w, scale: S } = r;
  const { W } = pj;
  const lam0 = (pj.mp.lon0 * Math.PI) / 180;
  // 第 i 列像素中心的经度差(展开的):rel = i·du + r0
  const du = (2 * Math.PI) / w;
  const r0 = 0.5 * du - Math.PI - lam0;
  const mxL = (0 - v.ox) / v.s;
  const mxR = (cw - v.ox) / v.s;
  const myT = (0 - v.oy) / v.s;
  const myB = (ch - v.oy) / v.s;
  return {
    rows: [-1, r.h - 1],
    cols: (y) => {
      const wa = (y + 0.5) / S;
      const wb = (y + 1.5) / S;
      if (pj.Y(wb) < myT || pj.Y(wa) > myB) return null;
      const K = Math.min(pj.K(wa), pj.K(wb));
      const relA = K > 1e-9 ? Math.max(-Math.PI, (mxL - W / 2) / K) : -Math.PI;
      const relB = K > 1e-9 ? Math.min(Math.PI, (mxR - W / 2) / K) : Math.PI;
      if (relB < relA) return null;
      return [Math.floor((relA - r0) / du) - 1, Math.ceil((relB - r0) / du)];
    },
    at: (wy, out) => {
      const K = pj.K(wy);
      out[0] = (W / 2 + K * r0) * v.s + v.ox;
      out[1] = K * du * v.s;
      out[2] = pj.Y(wy) * v.s + v.oy;
    },
  };
}

/**
 * 一个像素层像素放大到不足这么多个画布像素时,直接铺像素层:放大插值的过渡不比岸线抗锯齿宽多少,
 * 拼两份(全图几十万个路径点)不划算
 */
const SHORE_MIN_PS = 2.5;

/**
 * 放大后的实景像素层(细节层):先铺水那一份,再按陆地范围(addLandCells)裁出陆地那一份铺上 —— 岸线按屏幕像素画,不发虚。
 * 等距圆柱:像素层按视口变换放大贴上(双线性);弯边投影(v.proj):按行重投影(reprojectImage)
 */
export function drawRealisticShores(ctx: CanvasRenderingContext2D, r: Raster, v: VecView): void {
  const pj = v.proj;
  const ps = v.s / r.scale;
  const put = (img: AnyCanvas) => {
    if (pj) reprojectImage(ctx, img, r.w, r.h, pj.mp, v, 'low');
    else ctx.drawImage(img, v.ox, v.oy, r.w * ps, r.h * ps);
  };
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  if (ps < SHORE_MIN_PS) put(realisticBase(r));
  else {
    const { water, land } = realisticShoreLayers(r);
    put(water);
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const cells = pj ? projectedCells(r, pj, v, cw, ch) : flatCells(r, v, cw, ch);
    const cols = pj ? null : cells.cols(0)!;
    if (cols && (cols[1] - cols[0]) * (cells.rows[1] - cells.rows[0]) * 8 > r.w * r.h) {
      // 等距圆柱、视口里的方格多(放大不到三倍左右):用整张图的那一份(缓存的)按视口变换裁剪,省得每次重画重算几十万个点
      const m = ctx.getTransform();
      ctx.transform(ps, 0, 0, ps, v.ox, v.oy);
      ctx.clip(wholeLandPath(r));
      ctx.setTransform(m);
    } else {
      const path = new Path2D();
      addLandCells(path, r, cells);
      ctx.clip(path);
    }
    put(land);
  }
  ctx.restore();
}

/**
 * 地球仪用的两张图(见 realisticGlobeMaps):不打光的底色(RGBA),和每个像素的坡度(RGBA 四个通道,见 encodeSlope):
 *   - RG:细节晕渲的坡度(东、南;已乘上平原压平、软阈值那两个系数),着色器里权重 RELIEF_DETAIL_W
 *   - BA:大尺度晕渲的坡度(陆地是地面、海是海底;海冰按冰的多少压平),权重陆地 RELIEF_MACRO_W、开阔水面 RELIEF_SEA_W
 *     (着色器按水面蒙版挑;蒙版挑的和这里不一样的,坡度先按两个权重的比换算好)
 * 平面主图的明暗 s = 1 + Σ 权重 × (这一样的晕渲 − 1),每样晕渲按固定的西北光算;着色器按同样的公式、只是光换成
 * "屏幕左上方"算 —— 地球仪正中、北在上时和平面主图一样,转到两极也不会光从背后来
 */
interface GlobeCapture {
  albedo: Uint8ClampedArray;
  slope: Uint8Array;
}

/** 坡度编码到 0–255 的上限(再陡按它算) */
export const SLOPE_MAX = 12;
/** 着色器里几样晕渲的权重(和 paintRealistic 的 DETAIL_W、MACRO_W、SEA_RELIEF 一样) */
export const RELIEF_DETAIL_W = 0.85;
export const RELIEF_MACRO_W = 0.8;
export const RELIEF_SEA_W = 0.45;

/** 坡度 → 一个字节:128 = 平;按平方根压缩(缓坡的精度高,陡坡粗一点) */
function encodeSlope(g: number): number {
  const v = g >= 0 ? Math.sqrt(Math.min(1, g / SLOPE_MAX)) : -Math.sqrt(Math.min(1, -g / SLOPE_MAX));
  return Math.round(127.5 + 127.5 * v);
}

/** 字节 → 坡度(单测、CPU 画法用;着色器里是同样的公式) */
export function decodeSlope(b: number): number {
  const v = (b / 255) * 2 - 1;
  return (v < 0 ? -v * v : v * v) * SLOPE_MAX;
}

/** 平面图的光:西北来(x 东、y 南、z 上),和 hillshade 一样 */
const LIGHT_XY = Math.SQRT2 / Math.hypot(1, 1, 1.3);
const LIGHT_Z = 1.3 / Math.hypot(1, 1, 1.3);

/**
 * 地球仪的写实贴图:不打光的底色(含河流)+ 坡度(RGBA,和像素图一样大,见 GlobeCapture)。
 * 着色器按屏幕方向(光从左上)重新打光,明暗的曲线和平面主图一样(见 render/globe.ts 的 relief)。
 * 要把整张图的明暗重算一遍(主图那么大约 0.3 秒),在后台线程里画(globeWorker.ts)
 */
export function realisticGlobeMaps(world: World, r: Raster): { albedo: AnyCanvas; slope: Uint8Array } {
  const cv = makeCanvas(r.w, r.h);
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  const px = realisticGlobePixels(r);
  ctx.putImageData(new ImageData(px.albedo, r.w, r.h), 0, 0);
  drawRealisticRivers(ctx, world, r, bakedView(r.scale));
  return { albedo: cv, slope: px.slope };
}

/**
 * 纯计算(Node 里也能跑,单测用):平面主图的像素(打好光的,和 realisticBase 一样)、地球仪的不打光底色、坡度(RGBA 交错,见 GlobeCapture)
 */
export function realisticGlobePixels(r: Raster): { shaded: Uint8ClampedArray; albedo: Uint8ClampedArray; slope: Uint8Array } {
  let shaded: Uint8ClampedArray | null = null;
  // 只借用 createImageData / putImageData 两个方法(不碰画布)
  const sink = {
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img: { data: Uint8ClampedArray }) => {
      shaded = img.data;
    },
  } as unknown as CanvasRenderingContext2D;
  const cap: GlobeCapture = { albedo: new Uint8ClampedArray(r.w * r.h * 4), slope: new Uint8Array(r.w * r.h * 4) };
  paintRealistic(sink, r, cap);
  antialiasShores(cap.albedo, r);
  return { shaded: shaded!, albedo: cap.albedo, slope: cap.slope };
}


/**
 * cap:地球仪要的底色和等效坡度也顺手记下来(不给 = 只画平面主图,画出来的一样)。
 * keepRaw:返回水陆交界抗锯齿之前的像素(一份拷贝)
 */
function paintRealistic(ctx: CanvasRenderingContext2D, r: Raster, cap?: GlobeCapture, keepRaw = false): Uint8ClampedArray | null {
  const { w, h, elev, water, temp, precip, ice: iceCover, iceConc, iceTone } = r;
  // 细节晕渲(沟壑纹理)+ 大尺度晕渲(整条山脉的明暗面)+ 海底晕渲
  const shade = hillshade(r, 0.012, 0);
  const { shade: macro, level, gx: mgx, gy: mgy } = macroShade(r, !!cap);
  const zd = 0.012 * r.scale;
  const alb = cap?.albedo;
  const slo = cap?.slope;
  const lut = biomePalette();
  const ocean = oceanLut();
  const slopeZ = 0.5 * 0.012 * r.scale; // 中心差分 / 2,与细节晕渲同一夸张系数
  // 东西相连:纹理噪声的格数取整,左右两边的格点对上
  const n6 = wrapCells(w, 6);
  // 雪线的抖动:平滑噪声(高纬度大片地方气温都在雪线附近,值噪声会露出一格一格)
  const snowN = cylinderNoise(11, w, 5);

  const img = ctx.createImageData(w, h);
  const d = img.data;
  const col: RGB = [0, 0, 0];
  for (let py = 0; py < h; py++) {
    // 东西向坡度按纬度修正
    const gxk = 1 / Math.max(rowCos(py, h), 0.01);
    for (let px = 0; px < w; px++) {
      const k = py * w + px;
      const e = elev[k];
      let c: RGB;
      let s = shade[k];
      // 地球仪:这个像素的细节坡度、大尺度坡度(东、南两个方向;见 GlobeCapture)
      let dgx = 0;
      let dgy = 0;
      let mgxk = 0;
      let mgyk = 0;
      if (water[k] === 1) {
        // 海色查表(每 10 米一格)
        const oi = e <= OCEAN_MIN ? 0 : e >= 0 ? OCEAN_N - 1 : ((e - OCEAN_MIN) / 10 + 0.5) | 0;
        col[0] = ocean[oi * 3];
        col[1] = ocean[oi * 3 + 1];
        col[2] = ocean[oi * 3 + 2];
        c = col;
        // 海底晕渲:只看大尺度(洋中脊、海沟、大陆坡),很淡
        s = 1 + (macro[k] - 1) * SEA_RELIEF;
        if (slo) {
          mgxk = mgx![k];
          mgyk = mgy![k];
        }
        // 海冰:铺像素时算好的(和群落分类同一份),画成冰的地方悬停也是"海冰"
        const conc = iceConc[k] / 255;
        if (conc > 0) {
          // 冰区里的开阔水面:碎冰、冰泥让海面发灰
          c = mix(c, SLUSH, 0.5 * smoothstep(0.03, 0.9, conc));
          const ice = iceCover[k];
          if (ice > 0) {
            // 越靠冰缘越是薄薄的新冰(灰蓝),冰盖深处是厚冰(白)
            const tex = 0.955 + 0.06 * (iceTone[k] / 255);
            const ic = mix(ICE_YOUNG, ICE_PACK, smoothstep(0.05, 0.7, conc));
            c = mix(c, [ic[0] * tex, ic[1] * tex, ic[2] * tex], ice);
            s = 1 + (s - 1) * (1 - ice);
            mgxk *= 1 - ice;
            mgyk *= 1 - ice;
          }
        }
        // 着色器按水面蒙版(有冰的一半以上算陆地)挑权重:挑成陆地的,坡度按两个权重的比换算
        if (slo && iceCover[k] >= 0.5) {
          mgxk *= SEA_RELIEF / MACRO_W;
          mgyk *= SEA_RELIEF / MACRO_W;
        }
      } else if (water[k] === 2) {
        c = temp[k] < -6 ? SEA_ICE : LAKE;
        s = 1;
      } else {
        // 1. 生物群落底色:按 温度 × 降水 查连续调色板,群落之间自然渐变
        paletteColor(lut, temp[k], precip[k], col);
        // 同一群落内的明暗变化:降水多更深
        const vn = valueNoiseP((px * n6) / w, py / 6, 3, n6);
        const v = 1.03 - Math.min(0.12, precip[k] / 25000) + 0.05 * (vn - 0.5);
        let cr = col[0] * v;
        let cg = col[1] * v;
        let cb = col[2] * v;
        // 高山 / 陡坡:裸岩。坡度直接按海拔梯度算(和光照方向无关),
        // 不再用"明暗偏离平地多少"来估计 —— 那样背光面一律被当成陡坡,暗面会发灰
        const gx = (elev[px < w - 1 ? k + 1 : k - w + 1] - elev[px > 0 ? k - 1 : k + w - 1]) * gxk;
        const gy = elev[py < h - 1 ? k + w : k] - elev[py > 0 ? k - w : k];
        const steep = Math.sqrt(gx * gx + gy * gy) * slopeZ;
        const rock = Math.min(0.85, smoothstep(1600, 3600, e) * 0.75 + smoothstep(0.9, 2.2, steep) * 0.45);
        cr += (ROCK[0] - cr) * rock;
        cg += (ROCK[1] - cg) * rock;
        cb += (ROCK[2] - cb) * rock;
        // 积雪:按像素温度(已含海拔递减)
        const sn = 0.5 + 0.5 * snowN(px, py);
        const snow = smoothstep(-2, -7, temp[k] + 3 * (sn - 0.5));
        cr += (SNOW[0] - cr) * snow;
        cg += (SNOW[1] - cg) * snow;
        cb += (SNOW[2] - cb) * snow;
        col[0] = cr;
        col[1] = cg;
        col[2] = cb;
        c = col;
        // 细节晕渲:平原上的小起伏压平(按大范围平均海拔:低地只留一成多,山地全留),
        // 再把很小的明暗起伏软阈值掉(平原上的"皱纹"),陡坡的沟壑照样清楚
        const dd = s - 1;
        const ad = dd < 0 ? -dd : dd;
        const keep = DETAIL_FLAT + (1 - DETAIL_FLAT) * smoothstep(DETAIL_E0, DETAIL_E1, level[k]);
        s = 1 + dd * DETAIL_W * keep * smoothstep(0.02, 0.16, ad) + (macro[k] - 1) * MACRO_W;
        if (slo) {
          // 细节晕渲的坡度(和 hillshade 同一个算法),乘上平原压平、软阈值两个系数(软阈值按坡度大小算,和光从哪边来无关)
          const dx = gx * 0.5 * zd;
          const dy = gy * 0.5 * zd;
          const wd = keep * smoothstep(0.02, 0.16, (Math.sqrt(dx * dx + dy * dy) * LIGHT_XY) / LIGHT_Z);
          dgx = dx * wd;
          dgy = dy * wd;
          mgxk = mgx![k];
          mgyk = mgy![k];
        }
      }
      if (alb) {
        const o = k * 4;
        alb[o] = c[0];
        alb[o + 1] = c[1];
        alb[o + 2] = c[2];
        alb[o + 3] = 255;
        slo![o] = encodeSlope(dgx);
        slo![o + 1] = encodeSlope(dgy);
        slo![o + 2] = encodeSlope(mgxk);
        slo![o + 3] = encodeSlope(mgyk);
      }
      // 2. 晕渲:亮面提亮;暗面柔和压暗(下限约 0.55)并混入天空的冷色,不发黑
      let f: number;
      let cool = 0;
      if (s >= 1) {
        f = Math.min(1.4, 1 + (s - 1) * 0.7);
      } else {
        const a = 1 - Math.exp((s - 1) / SHADOW_DEPTH); // 0..1,软过渡到下限
        f = 1 - SHADOW_DEPTH * a;
        cool = SHADOW_COOL * a;
      }
      const o = k * 4;
      d[o] = c[0] * f + (SKY_SHADOW[0] - c[0] * f) * cool;
      d[o + 1] = c[1] * f + (SKY_SHADOW[1] - c[1] * f) * cool;
      d[o + 2] = c[2] * f + (SKY_SHADOW[2] - c[2] * f) * cool;
      d[o + 3] = 255;
    }
  }
  const raw = keepRaw ? d.slice() : null;
  // 3. 水陆交界抗锯齿
  antialiasShores(d, r);
  ctx.putImageData(img, 0, 0);
  return raw;
}

/** 暗面最多压暗多少(1 - 下限) */
const SHADOW_DEPTH = 0.45;
/** 最暗处往天空冷色里混多少 */
const SHADOW_COOL = 0.4;
/** 细节晕渲 / 大尺度晕渲的权重 */
const DETAIL_W = 0.85;
const MACRO_W = 0.8;
/** 细节晕渲按大范围平均海拔保留多少:低于 DETAIL_E0 米只留 DETAIL_FLAT,高过 DETAIL_E1 米全留 */
const DETAIL_FLAT = 0.2;
const DETAIL_E0 = 300;
const DETAIL_E1 = 1400;
/** 海底晕渲的权重 */
const SEA_RELIEF = 0.45;

// ---------------------------------------------------------------------------
// 群落连续调色板:温度 × 降水(对数)二维查找表
// 从 BIOMES[].real 出发,按 classifyBiome 的阈值铺满 Whittaker 图,再做高斯模糊,
// 这样群落交界处是连续渐变;群落内部仍是 BIOMES 表里的颜色,和数据图层的分区对得上。

const PT0 = -16; // °C
const PT1 = 34;
const PNT = 51; // 每格 1°C
const PP0 = Math.log(60); // mm(对数刻度:群落阈值大致按倍数分布)
const PP1 = Math.log(6000);
const PNP = 47; // 每格 ln 0.1(约 10%)
let paletteCache: Float32Array | null = null;

function biomePalette(): Float32Array {
  if (paletteCache) return paletteCache;
  const n = PNT * PNP;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let j = 0; j < PNP; j++) {
    const p = Math.exp(PP0 + (j / (PNP - 1)) * (PP1 - PP0));
    for (let i = 0; i < PNT; i++) {
      const t = PT0 + (i / (PNT - 1)) * (PT1 - PT0);
      // 冰原的白色交给积雪层(按像素温度),表里按苔原 / 寒漠处理,免得白色被模糊进苔原带
      const c = BIOMES[classifyBiome(Math.max(t, -8.9), p, 0)].real;
      for (let q = 0; q < 3; q++) ch[q][j * PNT + i] = c[q];
    }
  }
  // 三次盒式模糊 ≈ 高斯(σ ≈ 3 格:温度 ±3°C、降水 ±30% 的过渡带)
  for (const a of ch) for (let it = 0; it < 3; it++) boxBlur(a, PNT, PNP, 2);
  const lut = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    lut[i * 3] = ch[0][i];
    lut[i * 3 + 1] = ch[1][i];
    lut[i * 3 + 2] = ch[2][i];
  }
  paletteCache = lut;
  return lut;
}

/** 双线性查表,结果写进 out */
function paletteColor(lut: Float32Array, t: number, p: number, out: RGB) {
  let fx = ((t - PT0) / (PT1 - PT0)) * (PNT - 1);
  let fy = ((Math.log(p) - PP0) / (PP1 - PP0)) * (PNP - 1);
  // !(x > 0) 同时挡住 NaN / -Infinity
  fx = !(fx > 0) ? 0 : fx > PNT - 1.0001 ? PNT - 1.0001 : fx;
  fy = !(fy > 0) ? 0 : fy > PNP - 1.0001 ? PNP - 1.0001 : fy;
  const ix = fx | 0;
  const iy = fy | 0;
  const ax = fx - ix;
  const ay = fy - iy;
  const i00 = (iy * PNT + ix) * 3;
  const i01 = i00 + PNT * 3;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  out[0] = lut[i00] * w00 + lut[i00 + 3] * w10 + lut[i01] * w01 + lut[i01 + 3] * w11;
  out[1] = lut[i00 + 1] * w00 + lut[i00 + 4] * w10 + lut[i01 + 1] * w01 + lut[i01 + 4] * w11;
  out[2] = lut[i00 + 2] * w00 + lut[i00 + 5] * w10 + lut[i01 + 2] * w01 + lut[i01 + 5] * w11;
}

// ---------------------------------------------------------------------------

/**
 * 大尺度晕渲:把海拔模糊掉十几个像素再算明暗,只保留山脉 / 高原的整体形状,
 * 让整条山脉有向光面、背光面的体积感。陆地、海底各算一份(同一遍降采样):
 * - 陆地:海面按 0 米算,海岸只剩平缓的坡;海拔先"加重"(emphasize),山里的坡显得陡、平原上的缓坡几乎看不出
 * - 海底:陆地按 0 米算,只看大陆坡、洋中脊、海沟的整体起伏(更平滑、更淡)
 * 返回:shade(陆地像素是陆地的、海面像素是海底的明暗,平地 = 1)、level(陆地的大范围平均海拔,细节晕渲按它决定平原压多少)。
 * 只要低频信息,所以在 1/4 分辨率上算,再双线性放大回来(省时间)。
 */
function macroShade(r: Raster, grad = false): { shade: Float32Array; level: Float32Array; gx?: Float32Array; gy?: Float32Array } {
  const { w, h, elev, water } = r;
  const F = 4;
  const mw = Math.ceil(w / F);
  const mh = Math.ceil(h / F);
  const M = mw * mh;
  // 1) 降采样:每 F×F 块取平均(陆地海拔、海底深度分开累加)
  const P = new Float32Array(M); // 陆地平均海拔(水面按 0)
  const D = new Float32Array(M); // 海底平均深度(负数;陆地按 0)
  const cnt = new Float32Array(M);
  for (let py = 0; py < h; py++) {
    const row = ((py / F) | 0) * mw;
    for (let px = 0; px < w; px++) {
      const k = py * w + px;
      const j = row + ((px / F) | 0);
      const e = elev[k];
      if (water[k] === 1) {
        if (e < 0) D[j] += e;
      } else if (e > 0) P[j] += e;
      cnt[j]++;
    }
  }
  const E = new Float32Array(M);
  for (let j = 0; j < M; j++) {
    P[j] /= cnt[j];
    D[j] /= cnt[j];
    E[j] = emphasize(P[j]);
  }
  // 2) 模糊:两次盒式 ≈ 帐篷形(随分辨率缩放);海底更平滑。
  //    东西相连:列下标取模,东西向半径按纬度放宽(同样的地面宽度,高纬度占更多像素)
  const RL = Math.max(1, Math.round((7 * r.scale) / F));
  const RS = Math.max(1, Math.round((12 * r.scale) / F));
  const stretch = Float32Array.from({ length: mh }, (_, y) => 1 / Math.max(rowCos(y, mh), 1e-3));
  for (let it = 0; it < 2; it++) {
    boxBlurWrap(E, mw, mh, RL, stretch);
    boxBlurWrap(P, mw, mh, RL, stretch);
    boxBlurWrap(D, mw, mh, RS, stretch);
  }
  // 3) 晕渲(和 hillshade 同一个西北来光,平地 = 1)
  const SL = lowShade(E, mw, mh, (MACRO_EXAG * r.scale) / F, stretch);
  const SS = lowShade(D, mw, mh, (SEA_EXAG * r.scale) / F, stretch);
  // 地球仪:同样的坡度也放大回来(见 GlobeCapture)
  const GL = grad ? lowGrad(E, mw, mh, (MACRO_EXAG * r.scale) / F, stretch) : null;
  const GS = grad ? lowGrad(D, mw, mh, (SEA_EXAG * r.scale) / F, stretch) : null;
  const gx = grad ? new Float32Array(w * h) : undefined;
  const gy = grad ? new Float32Array(w * h) : undefined;
  // 4) 双线性放大回原分辨率:海面像素取海底的明暗,其余取陆地的
  const shade = new Float32Array(w * h);
  const level = new Float32Array(w * h);
  const cx0 = new Int32Array(w);
  const cx1 = new Int32Array(w);
  const cax = new Float32Array(w);
  for (let px = 0; px < w; px++) {
    const fx = (px + 0.5) / F - 0.5;
    // 左右边的像素插在最后一格和第一格之间
    const x0 = Math.floor(fx);
    cax[px] = fx - x0;
    cx0[px] = x0 < 0 ? x0 + mw : x0;
    cx1[px] = x0 + 1 >= mw ? x0 + 1 - mw : x0 + 1;
  }
  for (let py = 0; py < h; py++) {
    let fy = (py + 0.5) / F - 0.5;
    fy = fy < 0 ? 0 : fy > mh - 1 ? mh - 1 : fy;
    const y0 = Math.max(0, Math.min(mh - 2, fy | 0));
    const ay = mh > 1 ? fy - y0 : 0;
    const r0 = y0 * mw;
    const r1 = Math.min(mh - 1, y0 + 1) * mw;
    for (let px = 0; px < w; px++) {
      const k = py * w + px;
      const a = r0 + cx0[px];
      const b = r0 + cx1[px];
      const c = r1 + cx0[px];
      const d = r1 + cx1[px];
      const ax = cax[px];
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      const src = water[k] === 1 ? SS : SL;
      shade[k] = src[a] * w00 + src[b] * w10 + src[c] * w01 + src[d] * w11;
      level[k] = P[a] * w00 + P[b] * w10 + P[c] * w01 + P[d] * w11;
      if (gx) {
        const G = water[k] === 1 ? GS! : GL!;
        gx[k] = G[0][a] * w00 + G[0][b] * w10 + G[0][c] * w01 + G[0][d] * w11;
        gy![k] = G[1][a] * w00 + G[1][b] * w10 + G[1][c] * w01 + G[1][d] * w11;
      }
    }
  }
  return { shade, level, gx, gy };
}

/** 粗网格上的坡度(东、南两个方向;和 lowShade 同一个算法,只是不打光):地球仪按屏幕方向重新打光用 */
function lowGrad(E: Float32Array, mw: number, mh: number, z: number, stretch: Float32Array): [Float32Array, Float32Array] {
  const GX = new Float32Array(mw * mh);
  const GY = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const up = y > 0 ? y - 1 : y;
    const dn = y < mh - 1 ? y + 1 : y;
    const zx = z * stretch[y];
    for (let x = 0; x < mw; x++) {
      const lf = x > 0 ? x - 1 : mw - 1;
      const rt = x < mw - 1 ? x + 1 : 0;
      GX[y * mw + x] = ((E[y * mw + rt] - E[y * mw + lf]) / 2) * zx;
      GY[y * mw + x] = ((E[dn * mw + x] - E[up * mw + x]) / (dn - up || 1)) * z;
    }
  }
  return [GX, GY];
}

/**
 * 粗网格上的晕渲(西北来光,平地 = 1);z = 每格的高度夸张系数。
 * stretch:每行东西向坡度的放大倍数 1 / cos(纬度),左右邻居列下标取模(主图东西相连)
 */
function lowShade(E: Float32Array, mw: number, mh: number, z: number, stretch: Float32Array): Float32Array {
  let lx = -1;
  let ly = -1;
  let lz = 1.3;
  const ll = Math.hypot(lx, ly, lz);
  lx /= ll;
  ly /= ll;
  lz /= ll;
  const S = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const up = y > 0 ? y - 1 : y;
    const dn = y < mh - 1 ? y + 1 : y;
    const zx = z * stretch[y];
    for (let x = 0; x < mw; x++) {
      const lf = x > 0 ? x - 1 : mw - 1;
      const rt = x < mw - 1 ? x + 1 : 0;
      const dx = ((E[y * mw + rt] - E[y * mw + lf]) / 2) * zx;
      const dy = ((E[dn * mw + x] - E[up * mw + x]) / (dn - up || 1)) * z;
      S[y * mw + x] = (-dx * lx - dy * ly + lz) / Math.sqrt(dx * dx + dy * dy + 1) / lz;
    }
  }
  return S;
}
const MACRO_EXAG = 0.018;
const SEA_EXAG = 0.02;

/**
 * 陆地晕渲用的"加重"海拔:e × (e / 1500)^EMPH_POW。高处的坡被放大、低处的坡被压小 ——
 * 同样的高差,在山里显得陡、在平原上几乎看不出(世界地图上平原的缓坡本来就看不见)。
 */
function emphasize(e: number): number {
  return e > 0 ? e * Math.pow(e / EMPH_REF, EMPH_POW) : 0;
}
const EMPH_REF = 1500;
const EMPH_POW = 1.1;

/** 5×5 帐篷核(两次 3×3 盒式模糊)下的湖泊占比:湖岸的平滑场 */
const TENT5 = [1, 2, 3, 2, 1];
function lakeField(water: Uint8Array, w: number, h: number, px: number, py: number): number {
  let s = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const y = Math.max(0, Math.min(h - 1, py + dy));
    for (let dx = -2; dx <= 2; dx++) {
      const xx = px + dx;
      const x = xx < 0 ? xx + w : xx >= w ? xx - w : xx;
      if (water[y * w + x] === 2) s += TENT5[dy + 2] * TENT5[dx + 2];
    }
  }
  return s / 81;
}

/**
 * 水陆交界抗锯齿:只处理紧挨着另一类的像素,按"这个像素里有多少是陆地"把两边的颜色混合。
 * - 海岸:海拔过零点就是岸线,亚像素距离 sd = 海拔 / |海拔梯度|(同手绘风的墨线)
 * - 湖岸:没有连续的场,用模糊过的湖泊掩膜代替,0.5 等值线当岸线
 * 先算出所有要改的像素,最后一起写回,读到的邻居颜色都是改之前的。
 */
function antialiasShores(d: Uint8ClampedArray, r: Raster) {
  const { w, h, elev, water } = r;
  const upd: number[] = [];
  for (let py = 0; py < h; py++) {
    const up = py > 0 ? -w : 0;
    const dn = py < h - 1 ? w : 0;
    for (let px = 0; px < w; px++) {
      const k = py * w + px;
      // 左右邻居的偏移:东西相连,图边上取另一头
      const lf = px > 0 ? -1 : w - 1;
      const rt = px < w - 1 ? 1 : 1 - w;
      const hx = 2;
      const wk = water[k];
      // 四邻域都是同一类:不在交界上
      if (water[k + lf] === wk && water[k + rt] === wk && water[k + up] === wk && water[k + dn] === wk) continue;

      // 这个像素属于哪种交界、对面是哪一类(湖海相接的少见情况不管)
      let other: number;
      if (wk !== 0) other = 0;
      else {
        const hasSea = water[k + lf] === 1 || water[k + rt] === 1 || water[k + up] === 1 || water[k + dn] === 1;
        other = hasSea ? 1 : 2;
      }
      const lakeEdge = wk === 2 || other === 2;

      // 对面一类的颜色:8 邻域里同类像素取平均
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let cnt = 0;
      for (let dy = up; dy <= dn; dy += w) {
        for (let i = 0; i < 3; i++) {
          // 左、中、右三列
          const dx = i === 0 ? lf : i === 1 ? 0 : rt;
          const j = k + dy + dx;
          if (water[j] !== other) continue;
          sr += d[j * 4];
          sg += d[j * 4 + 1];
          sb += d[j * 4 + 2];
          cnt++;
        }
      }
      if (cnt === 0) continue;

      // 亚像素距离(像素为单位):场的正侧 —— 海岸是陆地,湖岸是湖泊
      let sd: number;
      if (lakeEdge) {
        const m = lakeField(water, w, h, px, py);
        const gx = (lakeField(water, w, h, px + rt, py) - lakeField(water, w, h, px + lf, py)) / hx;
        const gy = (lakeField(water, w, h, px, py + dn / w) - lakeField(water, w, h, px, py + up / w)) / ((dn - up) / w || 1);
        sd = (m - 0.5) / (Math.sqrt(gx * gx + gy * gy) || 1e-6);
      } else {
        const gx = (elev[k + rt] - elev[k + lf]) / hx;
        const gy = (elev[k + dn] - elev[k + up]) / ((dn - up) / w || 1);
        sd = elev[k] / (Math.sqrt(gx * gx + gy * gy) || 1e-6);
      }
      const cov = Math.max(0, Math.min(1, 0.5 + sd)); // 正侧占这个像素的比例
      const ownPositive = lakeEdge ? wk === 2 : wk === 0;
      // 对面一类占的比例;最多一半,保证像素本身的归类不变(一两个像素的小湖不会被抹掉)
      const a = Math.min(0.5, ownPositive ? 1 - cov : cov);
      if (a <= 0) continue;
      const o = k * 4;
      upd.push(
        k,
        d[o] + (sr / cnt - d[o]) * a,
        d[o + 1] + (sg / cnt - d[o + 1]) * a,
        d[o + 2] + (sb / cnt - d[o + 2]) * a,
      );
    }
  }
  for (let i = 0; i < upd.length; i += 4) {
    const o = upd[i] * 4;
    d[o] = upd[i + 1];
    d[o + 1] = upd[i + 2];
    d[o + 2] = upd[i + 3];
  }
}
