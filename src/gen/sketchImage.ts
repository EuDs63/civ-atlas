/**
 * 导入一张图当草图:认出图上哪是海、哪是陆地(高度图还能认出高低),铺成草图的格子图(sketch.ts 的 SketchImage)。
 * 纯计算,不碰 DOM:图片由界面解码成 RGBA 像素传进来;原图只在这里用一下,不存。
 *
 * 先把图缩到宽 PICTURE_W 左右(preparePicture),再按两种认法之一认:
 * - 点一下海(seaFromClicks):像魔棒。从点的地方往外走,走一步颜色差得不多、又不是描的线,就算海;
 *   颜色一点点变着(涂得深一块浅一块)也走得过去,碰到铅笔 / 钢笔描的海岸线就停。被陆地围住的内海、湖要再点一下。
 *   适合手画的地图、彩色地图、只描了海岸线的线稿。
 * - 按深浅(levelsFrom):比海平面亮的是陆地、暗的是海(也可以反过来);还可以按亮度分出丘陵、山地。适合高度图、黑白分明的图。
 * 认完按放法(placeOnLayer:铺满整张 / 保持比例)铺到 LAYER_W × LAYER_H 的格子图上,layerStats 看认得像不像样。
 */
import { clamp } from './util';
import { LAYER_H, LAYER_W, SKETCH_HILLS, SKETCH_LAND, SKETCH_MOUNTAIN, SKETCH_NONE, SKETCH_SEA, SKETCH_SHELF } from './sketch';

/** 解码好的图片:RGBA 逐行(和 canvas 的 ImageData 一样) */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** 缩小好、准备认的图 */
export interface Picture {
  w: number;
  h: number;
  /** 颜色(Lab,每格 3 个数:L、a、b),先糊过一下(不算线),把一笔笔的排线抹成一片 */
  lab: Float32Array;
  /** 1 = 这一格里有描的线(比周围暗得多的细线) */
  line: Uint8Array;
  /** 灰度 0–255 */
  gray: Float32Array;
  /** 是彩色的图(不是黑白 / 灰度图):「按深浅」认不准时提醒改用「点一下海」 */
  colorful: boolean;
}

/** 认图用的宽度:比它宽的图先按面积平均缩到这么宽 */
export const PICTURE_W = 640;
/** 一个像素比周围 7 × 7 里最亮的暗多少(max(R, G, B) 的差)就算描的线 */
const LINE_DROP = 50;
/** 一成像素的颜色饱和度(Lab 的 √(a² + b²))超过这么多算彩色的图:拍的纸有点泛黄也不算 */
const COLORFUL = 8;
/** 「点一下海」的范围:走一步颜色(Lab 距离)最多差多少;默认值和滑条两头 */
export const WAND_RANGE = 4;
export const WAND_RANGE_MIN = 1;
export const WAND_RANGE_MAX = 10;
/** 认完以后,比这小的一块陆地(格数,按 PICTURE_W 宽的图算)当作海:多半是海里的字、涂出来的笔道 */
const MIN_LAND_PIECE = 12;

// ---------------------------------------------------------------------------
// 准备

/**
 * 缩小、找线、转颜色。透明的地方当白纸。
 * 线在原图上找(细的铅笔线缩小以后就淡得看不出了):max(R, G, B) 比周围 7 × 7 里最亮的暗 LINE_DROP 以上的像素,缩小后它落在哪一格,那一格就算线
 */
export function preparePicture(px: Pixels): Picture {
  const W = Math.max(1, Math.floor(px.width));
  const H = Math.max(1, Math.floor(px.height));
  const d = px.data;
  const w = Math.min(W, PICTURE_W);
  const h = Math.max(1, Math.round((H * w) / W));
  const xs = new Int32Array(W);
  for (let x = 0; x < W; x++) xs[x] = Math.min(w - 1, Math.floor((x * w) / W));
  const ys = new Int32Array(H);
  for (let y = 0; y < H; y++) ys[y] = Math.min(h - 1, Math.floor((y * h) / H));
  // 按面积平均缩小;顺便记下每个像素最亮的那个通道
  const sum = new Float32Array(w * h * 3);
  const cnt = new Uint32Array(w * h);
  const V = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = ys[y] * w;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];
      const a = d[i + 3];
      if (a < 255) {
        const k = 255 - a;
        r = (r * a + 255 * k) / 255;
        g = (g * a + 255 * k) / 255;
        b = (b * a + 255 * k) / 255;
      }
      const j = row + xs[x];
      sum[3 * j] += r;
      sum[3 * j + 1] += g;
      sum[3 * j + 2] += b;
      cnt[j]++;
      V[y * W + x] = r > g ? (r > b ? r : b) : g > b ? g : b;
    }
  }
  const line = new Uint8Array(w * h);
  const mx = maxFilter7(V, W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mx[i] - V[i] > LINE_DROP) line[ys[y] * w + xs[x]] = 1;
    }
  }
  const rgb = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const gray = new Float32Array(w * h);
  for (let j = 0; j < w * h; j++) {
    const n = cnt[j] || 1;
    const r = sum[3 * j] / n;
    const g = sum[3 * j + 1] / n;
    const b = sum[3 * j + 2] / n;
    rgb[0][j] = r;
    rgb[1][j] = g;
    rgb[2][j] = b;
    gray[j] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  // 糊的时候不算线那几格,免得海岸线、海里的字把旁边的颜色染深(没有一格不是线的地方照原样)
  const keep = new Float32Array(w * h);
  for (let j = 0; j < w * h; j++) keep[j] = line[j] ? 0 : 1;
  const kept = boxBlur(keep, w, h, 2);
  const [R, G, B] = rgb.map((c) => {
    const m = new Float32Array(w * h);
    for (let j = 0; j < w * h; j++) m[j] = c[j] * keep[j];
    const b = boxBlur(m, w, h, 2);
    for (let j = 0; j < w * h; j++) b[j] = kept[j] > 0 ? b[j] / kept[j] : c[j];
    return b;
  });
  const lab = new Float32Array(w * h * 3);
  let vivid = 0;
  for (let j = 0; j < w * h; j++) {
    toLab(R[j], G[j], B[j], lab, 3 * j);
    if (lab[3 * j + 1] ** 2 + lab[3 * j + 2] ** 2 > COLORFUL * COLORFUL) vivid++;
  }
  return { w, h, lab, line, gray, colorful: vivid > 0.1 * w * h };
}

/**
 * 每个像素换成周围 7 × 7 里的最大值(先横后竖,边上只看图里面的)。
 * 每个方向:m4 = 往后连着 4 格的最大值(两两比两次),7 格的最大值 = max(往前 3 格那一格的 m4, 自己的 m4)
 */
function maxFilter7(src: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const m2 = new Uint8Array(n);
  const m4 = new Uint8Array(n);
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);
  for (let i = 0, x = 0; i < n; i++, x = x + 1 === w ? 0 : x + 1) m2[i] = x + 1 < w && src[i + 1] > src[i] ? src[i + 1] : src[i];
  for (let i = 0, x = 0; i < n; i++, x = x + 1 === w ? 0 : x + 1) m4[i] = x + 2 < w && m2[i + 2] > m2[i] ? m2[i + 2] : m2[i];
  for (let i = 0, x = 0; i < n; i++, x = x + 1 === w ? 0 : x + 1) {
    const b = m4[x >= 3 ? i - 3 : i - x];
    tmp[i] = b > m4[i] ? b : m4[i];
  }
  const w2 = 2 * w;
  const w3 = 3 * w;
  for (let i = 0; i < n; i++) m2[i] = i + w < n && tmp[i + w] > tmp[i] ? tmp[i + w] : tmp[i];
  for (let i = 0; i < n; i++) m4[i] = i + w2 < n && m2[i + w2] > m2[i] ? m2[i + w2] : m2[i];
  for (let i = 0; i < n; i++) {
    const b = m4[i >= w3 ? i - w3 : i % w];
    out[i] = b > m4[i] ? b : m4[i];
  }
  return out;
}

/** (2r + 1) × (2r + 1) 的均匀模糊(先横后竖,边上只平均图里面的) */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      const a = Math.max(0, x - r);
      const e = Math.min(w - 1, x + r);
      for (let k = a; k <= e; k++) s += src[o + k];
      tmp[o + x] = s / (e - a + 1);
    }
  }
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r);
    const e = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = a; k <= e; k++) s += tmp[k * w + x];
      out[y * w + x] = s / (e - a + 1);
    }
  }
  return out;
}

/** sRGB 0–255 → 线性 0–1:按 1/16 一档先算好查表 */
const LINEAR = Float32Array.from({ length: 255 * 16 + 1 }, (_, k) => {
  const c = k / 16 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const linear = (c: number) => LINEAR[Math.round(clamp(c, 0, 255) * 16)];
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB(0–255)→ Lab(D65),写进 out[o..o+2] */
function toLab(r: number, g: number, b: number, out: Float32Array, o: number) {
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);
  const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

// ---------------------------------------------------------------------------
// 点一下海

/**
 * 「点一下海」:clicks 是点的位置(图上的比例,0–1),range 是走一步颜色最多差多少(WAND_RANGE_MIN – WAND_RANGE_MAX)。
 * 从每个点往上下左右走,下一格不是线、颜色和这一格的 Lab 距离小于 range 就算海;几下各自走出来的合在一起。
 * 点在线上的,挪到附近不是线的地方再走。最后陆地里比 MIN_LAND_PIECE 小的碎块算海。
 * 返回每格的草图值(SKETCH_SEA / SKETCH_LAND);一下也没点 = 全是 SKETCH_NONE(还没认)
 */
export function seaFromClicks(pic: Picture, clicks: readonly (readonly [number, number])[], range: number): Uint8Array {
  const { w, h, lab, line } = pic;
  const out = new Uint8Array(w * h);
  if (!clicks.length) return out;
  const r2 = clamp(range, WAND_RANGE_MIN, WAND_RANGE_MAX) ** 2;
  const sea = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  for (const [cx, cy] of clicks) {
    const start = offLine(pic, Math.floor(clamp(cx, 0, 1 - 1e-9) * w), Math.floor(clamp(cy, 0, 1 - 1e-9) * h));
    if (start < 0 || sea[start]) continue;
    let head = 0;
    let tail = 0;
    sea[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (sea[j] || line[j]) continue;
        const dl = lab[3 * j] - lab[3 * i];
        const da = lab[3 * j + 1] - lab[3 * i + 1];
        const db = lab[3 * j + 2] - lab[3 * i + 2];
        if (dl * dl + da * da + db * db >= r2) continue;
        sea[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  dropSmallLand(sea, w, h, MIN_LAND_PIECE);
  for (let i = 0; i < out.length; i++) out[i] = sea[i] ? SKETCH_SEA : SKETCH_LAND;
  return out;
}

/** (x, y) 不是线就是它;是线的话找附近 4 格以内最近的不是线的格子;都是线 = -1 */
function offLine(pic: Picture, x: number, y: number): number {
  const { w, h, line } = pic;
  let best = -1;
  let bd = Infinity;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || line[ny * w + nx]) continue;
      const dd = dx * dx + dy * dy;
      if (dd < bd) {
        bd = dd;
        best = ny * w + nx;
      }
    }
  }
  return best;
}

/** sea 里没算海的(陆地)连成一块(上下左右相邻)比 min 格小的,改成海 */
function dropSmallLand(sea: Uint8Array, w: number, h: number, min: number) {
  const seen = new Uint8Array(w * h);
  const piece = new Int32Array(w * h);
  for (let s = 0; s < sea.length; s++) {
    if (sea[s] || seen[s]) continue;
    let head = 0;
    let tail = 0;
    seen[s] = 1;
    piece[tail++] = s;
    while (head < tail) {
      const i = piece[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && !sea[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (piece[tail++] = i - 1);
      if (x < w - 1 && !sea[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (piece[tail++] = i + 1);
      if (y > 0 && !sea[i - w] && !seen[i - w]) (seen[i - w] = 1), (piece[tail++] = i - w);
      if (y < h - 1 && !sea[i + w] && !seen[i + w]) (seen[i + w] = 1), (piece[tail++] = i + w);
    }
    if (tail < min) for (let k = 0; k < tail; k++) sea[piece[k]] = 1;
  }
}

// ---------------------------------------------------------------------------
// 按深浅

export interface LevelOptions {
  /** 海平面(灰度 0–255):比它亮的是陆地 */
  sea: number;
  /** 暗的是陆地(黑底白海那种反着画的):先把亮暗反过来 */
  dark?: boolean;
  /** 高低也照图:海平面往上按亮度分成陆地 / 丘陵 / 山地低中高,海平面往下一点是浅海;不给 = 只分海陆 */
  heights?: boolean;
}

/** 高低也照图时,(灰度 − 海平面) / (255 − 海平面) 不到这几个数的依次是陆地、丘陵、山地低、山地中,其余是山地高 */
const HEIGHT_STEPS = [0.22, 0.36, 0.5, 0.65];
/** 高低也照图时,海平面 × 这个数以上(还没到海平面)的是浅海 */
const SHELF_FROM = 0.8;

/** 认图前的灰度:3 × 3 糊一下(去掉零星的噪点);dark 时亮暗反过来 */
function levelGray(pic: Picture, dark?: boolean): Float32Array {
  const g = boxBlur(pic.gray, pic.w, pic.h, 1);
  if (dark) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
  return g;
}

/** 「按深浅」:返回每格的草图值 */
export function levelsFrom(pic: Picture, o: LevelOptions): Uint8Array {
  const g = levelGray(pic, o.dark);
  const t = clamp(o.sea, 1, 254);
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    if (v < t) out[i] = o.heights && v >= SHELF_FROM * t ? SKETCH_SHELF : SKETCH_SEA;
    else if (!o.heights) out[i] = SKETCH_LAND;
    else {
      const k = (v - t) / (255 - t);
      out[i] = k < HEIGHT_STEPS[0] ? SKETCH_LAND : k < HEIGHT_STEPS[1] ? SKETCH_HILLS : k < HEIGHT_STEPS[2] ? SKETCH_MOUNTAIN : k < HEIGHT_STEPS[3] ? SKETCH_MOUNTAIN + 1 : SKETCH_MOUNTAIN + 2;
    }
  }
  return out;
}

/**
 * 刚打开「按深浅」时海平面放哪:先按大津法把灰度分成暗、亮两堆,再在 [0.4 × 分界, 分界] 里找灰度分布最低的地方
 * (高度图常见的海陆分界:海是一大片暗的,陆地从海边往上慢慢变亮)。返回 1–254 的整数
 */
export function autoSeaLevel(pic: Picture, dark?: boolean): number {
  const g = levelGray(pic, dark);
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.round(clamp(g[i], 0, 255))]++;
  // 大津法:让暗、亮两堆的类间方差最大的分界
  const total = g.length;
  let sumAll = 0;
  for (let k = 0; k < 256; k++) sumAll += k * hist[k];
  let w0 = 0;
  let s0 = 0;
  let best = -1;
  let otsu = 128;
  for (let k = 0; k < 255; k++) {
    w0 += hist[k];
    s0 += k * hist[k];
    const w1 = total - w0;
    if (!w0 || !w1) continue;
    const m0 = s0 / w0;
    const m1 = (sumAll - s0) / w1;
    const between = w0 * w1 * (m0 - m1) ** 2;
    if (between > best) {
      best = between;
      otsu = k + 1;
    }
  }
  // 分布先抹平一点(前后各 4 格平均),再找低谷
  const sm = new Float64Array(256);
  for (let k = 0; k < 256; k++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, k - 4); j <= Math.min(255, k + 4); j++) (s += hist[j]), n++;
    sm[k] = s / n;
  }
  let level = otsu;
  for (let k = Math.floor(0.4 * otsu); k <= otsu; k++) if (sm[k] < sm[level]) level = k;
  return clamp(Math.round(level), 1, 254);
}

// ---------------------------------------------------------------------------
// 铺到格子图上

/** 放法:铺满整张(拉伸到整颗星球),或保持比例(x、y = 图中心在格子图上的位置,0–1;scale = 大小,1 = 正好放得下;不是有限数的当 0.5、1) */
export type Placement = { fit: 'fill' } | { fit: 'keep'; x: number; y: number; scale: number };

/** 保持比例时大小的范围(1 = 正好放得下,只能缩小) */
export const PLACE_SCALE: readonly [number, number] = [0.2, 1];

/** 图铺在格子图上的哪一块(格子坐标,左上角 x、y 和宽、高;可以超出格子图:左右超出的绕到另一边接上(星球东西相连),上下超出的切掉) */
export function placeRect(w: number, h: number, p: Placement): { x: number; y: number; w: number; h: number } {
  if (p.fit === 'fill') return { x: 0, y: 0, w: LAYER_W, h: LAYER_H };
  const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const s = Math.min(LAYER_W / w, LAYER_H / h) * clamp(fin(p.scale, 1), PLACE_SCALE[0], PLACE_SCALE[1]);
  const dw = w * s;
  const dh = h * s;
  return { x: fin(p.x, 0.5) * LAYER_W - dw / 2, y: fin(p.y, 0.5) * LAYER_H - dh / 2, w: dw, h: dh };
}

/**
 * 认出来的(w × h 格的草图值)按放法铺到 LAYER_W × LAYER_H 的格子图上:每一格取它中心落在图上那一格的值,没盖到的是 SKETCH_NONE。
 * 左右超出格子图的绕到另一边(图最宽和格子图一样宽,不会自己盖住自己)
 */
export function placeOnLayer(values: Uint8Array, w: number, h: number, p: Placement): Uint8Array {
  const out = new Uint8Array(LAYER_W * LAYER_H);
  const r = placeRect(w, h, p);
  for (let ly = 0; ly < LAYER_H; ly++) {
    const sy = Math.floor(((ly + 0.5 - r.y) / r.h) * h);
    if (sy < 0 || sy >= h) continue;
    for (let lx = 0; lx < LAYER_W; lx++) {
      const dx = (((lx + 0.5 - r.x) % LAYER_W) + LAYER_W) % LAYER_W;
      const sx = Math.floor((dx / r.w) * w);
      if (sx < 0 || sx >= w) continue;
      out[ly * LAYER_W + lx] = values[sy * w + sx];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 认得像不像样

export interface LayerStats {
  /** 盖到了格子图的几成(0–1) */
  covered: number;
  /** 盖到的里面陆地占几成(0–1) */
  land: number;
  /** 陆地连成几块(上下左右相邻算连着) */
  pieces: number;
  /** 其中只有 1–3 格的小碎块有几块 */
  specks: number;
}

/** 认出来的格子图有多少陆地、碎成几块 */
export function layerStats(layer: Uint8Array): LayerStats {
  let covered = 0;
  let land = 0;
  for (let i = 0; i < layer.length; i++) {
    if (layer[i] === SKETCH_NONE) continue;
    covered++;
    if (layer[i] >= SKETCH_LAND) land++;
  }
  const seen = new Uint8Array(layer.length);
  const piece = new Int32Array(layer.length);
  let pieces = 0;
  let specks = 0;
  const isLand = (i: number) => layer[i] >= SKETCH_LAND && !seen[i];
  for (let s = 0; s < layer.length; s++) {
    if (!isLand(s)) continue;
    let head = 0;
    let tail = 0;
    seen[s] = 1;
    piece[tail++] = s;
    while (head < tail) {
      const i = piece[head++];
      const x = i % LAYER_W;
      if (x > 0 && isLand(i - 1)) (seen[i - 1] = 1), (piece[tail++] = i - 1);
      if (x < LAYER_W - 1 && isLand(i + 1)) (seen[i + 1] = 1), (piece[tail++] = i + 1);
      if (i >= LAYER_W && isLand(i - LAYER_W)) (seen[i - LAYER_W] = 1), (piece[tail++] = i - LAYER_W);
      if (i + LAYER_W < layer.length && isLand(i + LAYER_W)) (seen[i + LAYER_W] = 1), (piece[tail++] = i + LAYER_W);
    }
    pieces++;
    if (tail <= 3) specks++;
  }
  return { covered: covered / layer.length, land: covered ? land / covered : 0, pieces, specks };
}

/**
 * 认不准的提醒:
 * - 'colorful' = 彩色的图用了「按深浅」,认出来几乎全是海 / 陆地或碎成很多小块:多半是彩色手画图,该用「点一下海」
 * - 'specks' = 碎成很多小块(上下左右都不挨着的 1–3 格小块超过 WARN_SPECKS 块)
 * - 'sea' / 'land' = 盖到的地方陆地不到 WARN_SHARE / 超过 1 − WARN_SHARE
 * 看着像样 = null
 */
export type ImportWarning = 'colorful' | 'specks' | 'sea' | 'land' | null;

const WARN_SHARE = 0.02;
const WARN_SPECKS = 150;

/** 认出来哪里不对:碎成很多小块 / 几乎全是海 / 几乎全是陆地;看着像样 = null(没盖到格子也是 null) */
export function layerTrouble(s: LayerStats): 'specks' | 'sea' | 'land' | null {
  if (!s.covered) return null;
  if (s.specks > WARN_SPECKS) return 'specks';
  return s.land < WARN_SHARE ? 'sea' : s.land > 1 - WARN_SHARE ? 'land' : null;
}

export function importWarning(s: LayerStats, mode: 'wand' | 'level', colorful: boolean): ImportWarning {
  const t = layerTrouble(s);
  return t && mode === 'level' && colorful ? 'colorful' : t;
}
