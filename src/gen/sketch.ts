/**
 * 地形草图(新建世界时的「编辑地形」里"涂一片"的那几支笔):作者用陆地、丘陵、山地、高原、浅海、海、群岛几种笔粗涂,
 * 程序照着在板块上长出大陆、山脉(tectonics.ts 的 4b 步),之后的侵蚀、河流、气候照常跑。纯计算,不碰 DOM。
 * 格式见 edits.ts 文件头「地形草图」。
 *
 * 存的是笔画(SketchEdit.strokes):每一笔 = 笔的种类 + 半径 + 经过的点,坐标和改地形一样是主图的世界坐标(2048 × 1024);
 * 山地笔另带高低(h),"圈起来填满"画的一笔带 fill(首尾连起来,圈里涂满)。
 * 生成前(sketchGrid)按先后把笔画涂到一张等距圆柱的小格子图上(SKETCH_W × SKETCH_H,一格 = 世界坐标 2 × 2),后涂的盖住先涂的;
 * 格子值见下面的 SKETCH_*:0 = 没涂(照旧由程序定),值 ≥ SKETCH_LAND 的都是陆地。rest = 'sea' 时没涂的格子都当海。
 *
 * 导入的图片(SketchEdit.image):图片本身不存,只存认出来的格子图(sketchImage.ts 认,LAYER_W × LAYER_H,一格 = 草图格子 2 × 2),
 * 和笔画排在同一个先后里:前 at 笔先涂,再铺这张图(值是 0 的格子 = 没盖到,留着底下的),后面的笔画盖在它上面。
 */
import type { Mesh } from './mesh';
import { clamp } from './util';
import { TERRAIN_H, TERRAIN_W, nearLon, wrapLon } from './terrainEdits';

export const SKETCH_W = 1024;
export const SKETCH_H = 512;
/** 一格是世界坐标的几乘几 */
const CELL = TERRAIN_W / SKETCH_W;

/** 格子值:没涂 */
export const SKETCH_NONE = 0;
/** 海(深海) */
export const SKETCH_SEA = 1;
/** 浅海(大陆架那样的浅水) */
export const SKETCH_SHELF = 2;
/** 群岛:这一片撒满小岛 */
export const SKETCH_ISLES = 3;
/** 陆地(平原);这个值和比它大的都是陆地 */
export const SKETCH_LAND = 4;
/** 丘陵 */
export const SKETCH_HILLS = 5;
/** 高原 */
export const SKETCH_PLATEAU = 6;
/** 山地(低 / 中 / 高三档,依次 + 1) */
export const SKETCH_MOUNTAIN = 7;

/** 一张草图涂成的样子(生成用):格子图 SKETCH_W × SKETCH_H 格(逐行从北往南、每行从西往东)+ 海岸线参数 */
export interface Sketch {
  grid: Uint8Array;
  /** 海岸线:0 贴着画 – 1 曲折(SketchEdit.coast) */
  coast: number;
}

/** 笔:陆地、丘陵、山地、高原、浅海、海、群岛,擦掉 = 涂回"没涂" */
export type SketchKind = 'land' | 'hills' | 'mountain' | 'plateau' | 'shelf' | 'sea' | 'isles' | 'erase';

export interface SketchStroke {
  kind: SketchKind;
  /** 笔的半径(世界坐标) */
  r: number;
  /** 经过的点 [x0, y0, x1, y1, …](世界坐标,规则同改地形的折线;只有一个点 = 点了一下) */
  pts: number[];
  /** 山地的高低:0 低、1 中、2 高(只有山地笔有;不给 = 中) */
  h?: 0 | 1 | 2;
  /** 1 = 圈起来填满:首尾连起来,圈里整片涂上(不给 = 只涂笔走过的地方) */
  fill?: 1;
}

/** 导入的图片认出来的格子图 */
export interface SketchImage {
  /** 图片的文件名(只用来显示照的是哪张图;最多 SKETCH_IMAGE_NAME_MAX 个字) */
  name: string;
  /** 格子:LAYER_W × LAYER_H 格(逐行从北往南、每行从西往东),值同草图格子(0 = 没盖到);行程编码 [个数 1–255, 值]… 再 base64 */
  cells: string;
  /** 铺在第几笔之后:前 at 笔先涂,然后铺这张图,剩下的笔画盖在它上面(不给 = 0,在所有笔画底下) */
  at?: number;
}

export interface SketchEdit {
  /** 没涂的地方:'auto' = 照旧由程序定,'sea' = 都是海 */
  rest: 'auto' | 'sea';
  /** 海岸线:0 = 贴着画的走,1 = 曲折,像真实的海岸(不给 = SKETCH_COAST 适中) */
  coast?: number;
  /** 笔画,按先后 */
  strokes: SketchStroke[];
  /** 导入的图片(不给 = 没导入) */
  image?: SketchImage;
}

/** 最多多少笔、一笔最多多少个点 */
export const SKETCH_MAX_STROKES = 600;
export const SKETCH_MAX_PTS = 2000;
/** 笔的半径范围(世界坐标) */
export const SKETCH_R: readonly [number, number] = [2, 160];
/** 海岸线的默认值(适中) */
export const SKETCH_COAST = 0.6;
/** 导入图片的格子图多大:草图格子的一半,一格 = 草图 2 × 2 格 */
export const LAYER_W = SKETCH_W / 2;
export const LAYER_H = SKETCH_H / 2;
/** 图片文件名最多留几个字 */
export const SKETCH_IMAGE_NAME_MAX = 60;

const KINDS: readonly SketchKind[] = ['land', 'hills', 'mountain', 'plateau', 'shelf', 'sea', 'isles', 'erase'];
const VALUE: Record<SketchKind, number> = {
  land: SKETCH_LAND,
  hills: SKETCH_HILLS,
  mountain: SKETCH_MOUNTAIN,
  plateau: SKETCH_PLATEAU,
  shelf: SKETCH_SHELF,
  sea: SKETCH_SEA,
  isles: SKETCH_ISLES,
  erase: SKETCH_NONE,
};

/** 一笔涂上去的格子值(山地按高低) */
function valueOf(s: SketchStroke): number {
  return s.kind === 'mountain' ? SKETCH_MOUNTAIN + (s.h ?? 1) : VALUE[s.kind];
}

/** 草图的海岸线参数(0 贴着画 – 1 曲折) */
export function sketchCoast(edit: SketchEdit | null | undefined): number {
  return edit?.coast ?? SKETCH_COAST;
}

// ---------------------------------------------------------------------------
// 导入图片的格子图:行程编码

/** 存的字符串最长多少(每格单独一段时的长度) */
const LAYER_CELLS_B64_MAX = Math.ceil((LAYER_W * LAYER_H * 2) / 3) * 4;

/** 格子图(LAYER_W × LAYER_H,值 0–9)→ 存的字符串:连着的同一个值记成 [个数, 值](个数 1–255,长的拆开),字节再转 base64 */
export function encodeLayer(layer: Uint8Array): string {
  const bytes: number[] = [];
  for (let i = 0; i < layer.length; ) {
    const v = layer[i];
    let j = i + 1;
    while (j < layer.length && layer[j] === v && j - i < 255) j++;
    bytes.push(j - i, v);
    i = j;
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.slice(i, i + 4096));
  return btoa(bin);
}

/** 存的字符串 → 格子图;不是 base64、个数是 0、值超过 9、加起来不是正好 LAYER_W × LAYER_H 格的 = null */
export function decodeLayer(cells: string): Uint8Array | null {
  if (cells.length > LAYER_CELLS_B64_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(cells)) return null;
  let bin: string;
  try {
    bin = atob(cells);
  } catch {
    return null;
  }
  if (bin.length & 1) return null;
  const out = new Uint8Array(LAYER_W * LAYER_H);
  let k = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const n = bin.charCodeAt(i);
    const v = bin.charCodeAt(i + 1);
    if (!n || v > SKETCH_MOUNTAIN + 2 || k + n > out.length) return null;
    out.fill(v, k, k + n);
    k += n;
  }
  return k === out.length ? out : null;
}

// ---------------------------------------------------------------------------
// 清理(读档、加一笔时用)

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 清理一笔:种类不认识、半径或坐标不是有限数、一个点也没有的 = null。
 * 坐标取整,y 夹在两极之间,x 和改地形的折线一样(第一个点取模到 [0, TERRAIN_W),之后挪到离上一个点最近的那一圈);
 * 半径夹到 SKETCH_R(保留一位小数),最多 SKETCH_MAX_PTS 个点;高低只留山地笔的 0 / 1 / 2(1 是默认,不存),
 * fill 只认 1。本来就合格的原样返回(同一个对象)
 */
export function cleanSketchStroke(x: unknown): SketchStroke | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const kind = o.kind as SketchKind;
  if (!KINDS.includes(kind) || !Array.isArray(o.pts) || o.pts.length < 2) return null;
  const raw = o.pts as unknown[];
  const take = Math.min(raw.length, SKETCH_MAX_PTS * 2) & ~1;
  const pts: number[] = [];
  for (let i = 0; i < take; i += 2) {
    const px = num(raw[i]);
    const py = num(raw[i + 1]);
    if (px === null || py === null) return null;
    pts.push(i ? nearLon(px, pts[i - 2]) : wrapLon(px), Math.round(clamp(py, 0, TERRAIN_H)));
  }
  const r0 = num(o.r);
  if (r0 === null) return null;
  const r = Math.round(clamp(r0, SKETCH_R[0], SKETCH_R[1]) * 10) / 10;
  const out: SketchStroke = { kind, r, pts };
  if (kind === 'mountain' && (o.h === 0 || o.h === 2)) out.h = o.h;
  if (o.fill === 1 && pts.length >= 6) out.fill = 1;
  const same =
    Object.keys(o).length === Object.keys(out).length &&
    r === o.r &&
    out.h === o.h &&
    out.fill === o.fill &&
    raw.length === pts.length &&
    pts.every((v, i) => v === raw[i]);
  return same ? (x as SketchStroke) : out;
}

/**
 * 清理导入的图片:格子读不出来(decodeLayer)、或者一格也没盖到的 = null;文件名去掉控制字符、首尾空白,
 * 最多 SKETCH_IMAGE_NAME_MAX 个字;at 取整夹到 [0, 笔画数](0 是默认,不存;给了 at 参数就用它,不看图片里写的)。本来就合格的原样返回
 */
export function cleanSketchImage(x: unknown, strokes: number, at?: number): SketchImage | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.cells !== 'string') return null;
  const layer = decodeLayer(o.cells);
  if (!layer || !layer.some((v) => v !== SKETCH_NONE)) return null;
  // eslint-disable-next-line no-control-regex
  const name0 = typeof o.name === 'string' ? o.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  const name = [...name0].slice(0, SKETCH_IMAGE_NAME_MAX).join('');
  const a0 = at ?? num(o.at);
  const at1 = a0 === null ? 0 : Math.round(clamp(a0, 0, strokes));
  const out: SketchImage = at1 ? { name, cells: o.cells, at: at1 } : { name, cells: o.cells };
  const same = name === o.name && out.at === o.at && Object.keys(o).length === Object.keys(out).length;
  return same ? (x as SketchImage) : out;
}

/**
 * 清理一份草图:不是对象的 = null;笔画逐笔过 cleanSketchStroke(不合格的丢掉,最多 SKETCH_MAX_STROKES 笔);
 * rest 不认识的当 'auto';coast 夹到 [0, 1] 保留两位小数(SKETCH_COAST 是默认,不存);导入的图片过 cleanSketchImage(不合格的丢掉)。
 * 一笔也没有、没导入图片、没涂的又交给程序 = null(和没画一样)。本来就合格的原样返回
 */
export function cleanSketch(x: unknown): SketchEdit | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const rest = o.rest === 'sea' ? 'sea' : 'auto';
  const c0 = num(o.coast);
  const coast = c0 === null ? SKETCH_COAST : Math.round(clamp(c0, 0, 1) * 100) / 100;
  const list = Array.isArray(o.strokes) ? (o.strokes as unknown[]) : [];
  const strokes: SketchStroke[] = [];
  let same = rest === o.rest && list === o.strokes && list.length <= SKETCH_MAX_STROKES;
  same = same && (coast === SKETCH_COAST ? !('coast' in o) : coast === o.coast);
  // 导入的图铺在原来第几笔之后;丢掉了不合格的笔画时,换成它前面留下来的笔数(先后不变)
  const img = o.image && typeof o.image === 'object' ? (o.image as Record<string, unknown>) : null;
  const a0 = img ? num(img.at) : null;
  const at0 = a0 === null ? 0 : Math.round(clamp(a0, 0, list.length));
  let at = -1;
  for (let i = 0; i < list.length; i++) {
    if (i === at0) at = strokes.length;
    if (strokes.length >= SKETCH_MAX_STROKES) break;
    const v = cleanSketchStroke(list[i]);
    if (v) strokes.push(v);
    if (v !== list[i]) same = false;
  }
  if (at < 0) at = strokes.length;
  const image = o.image === undefined ? null : cleanSketchImage(o.image, strokes.length, at);
  same = same && (image ? image === o.image : !('image' in o));
  same = same && Object.keys(o).length === 2 + (coast === SKETCH_COAST ? 0 : 1) + (image ? 1 : 0);
  if (!strokes.length && !image && rest === 'auto') return null;
  if (same) return x as SketchEdit;
  return { rest, ...(coast === SKETCH_COAST ? {} : { coast }), strokes, ...(image ? { image } : {}) };
}

/** 两份草图是不是一样(逐笔逐字段比;都没有也算一样) */
export function sameSketch(a: SketchEdit | null | undefined, b: SketchEdit | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.rest !== b.rest || sketchCoast(a) !== sketchCoast(b) || a.strokes.length !== b.strokes.length) return false;
  const ia = a.image;
  const ib = b.image;
  if (ia !== ib && (!ia || !ib || ia.name !== ib.name || ia.cells !== ib.cells || (ia.at ?? 0) !== (ib.at ?? 0))) return false;
  return a.strokes.every((x, i) => {
    const y = b.strokes[i];
    return x.kind === y.kind && x.r === y.r && x.h === y.h && x.fill === y.fill && x.pts.length === y.pts.length && x.pts.every((v, j) => v === y.pts[j]);
  });
}

// ---------------------------------------------------------------------------
// 涂到格子上

/** 一笔涂到格子图上:离折线不超过半径的格子(按格子中心算)改成这支笔的值;fill 的再把圈里涂满。x 绕一圈取模 */
function paint(grid: Uint8Array, s: SketchStroke) {
  const v = valueOf(s);
  const r = s.r / CELL;
  const r2 = r * r;
  const n = s.pts.length >> 1;
  // 一段 a → b(格子坐标);只有一个点 = a、b 重合,涂一个圆
  const last = n - 1;
  const segs = s.fill ? n : Math.max(1, last);
  for (let k = 0; k < segs; k++) {
    // 圈起来填满的那一笔,最后一段从终点连回起点
    const kb = s.fill ? (k + 1) % n : Math.min(k + 1, last);
    const ax = s.pts[2 * k] / CELL;
    const ay = s.pts[2 * k + 1] / CELL;
    let bx = s.pts[2 * kb] / CELL;
    const by = s.pts[2 * kb + 1] / CELL;
    // 连回起点那一段:起点挪到离终点最近的那一圈
    if (kb < k) bx += Math.round((ax - bx) / SKETCH_W) * SKETCH_W;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const x0 = Math.floor(Math.min(ax, bx) - r);
    const x1 = Math.ceil(Math.max(ax, bx) + r);
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(SKETCH_H - 1, Math.ceil(Math.max(ay, by) + r));
    for (let gy = y0; gy <= y1; gy++) {
      const cy = gy + 0.5;
      for (let gx = x0; gx <= x1; gx++) {
        const cx = gx + 0.5;
        const t = len2 > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
        const ex = cx - (ax + t * dx);
        const ey = cy - (ay + t * dy);
        if (ex * ex + ey * ey > r2) continue;
        grid[gy * SKETCH_W + (((gx % SKETCH_W) + SKETCH_W) % SKETCH_W)] = v;
      }
    }
  }
  if (s.fill) fillPolygon(grid, s.pts, v);
}

/**
 * 把一圈折线(世界坐标,x 已经是连续展开的)围住的格子涂成 v:逐行求和各条边的交点,按奇偶规则两两之间涂上(格子中心在圈里才算)。
 * x 绕一圈取模
 */
function fillPolygon(grid: Uint8Array, pts: number[], v: number) {
  const n = pts.length >> 1;
  const xs: number[] = [];
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let k = 0; k < n; k++) {
    const y = pts[2 * k + 1] / CELL;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  const gy0 = Math.max(0, Math.floor(ymin));
  const gy1 = Math.min(SKETCH_H - 1, Math.ceil(ymax));
  // 终点连回起点:起点那一圈挪到终点附近
  const lastX = pts[2 * (n - 1)] / CELL;
  const firstX = pts[0] / CELL;
  const closeX = firstX + Math.round((lastX - firstX) / SKETCH_W) * SKETCH_W;
  for (let gy = gy0; gy <= gy1; gy++) {
    const cy = gy + 0.5;
    xs.length = 0;
    for (let k = 0; k < n; k++) {
      const ax = pts[2 * k] / CELL;
      const ay = pts[2 * k + 1] / CELL;
      const bx = k + 1 < n ? pts[2 * k + 2] / CELL : closeX;
      const by = k + 1 < n ? pts[2 * k + 3] / CELL : pts[1] / CELL;
      if (ay <= cy === by <= cy) continue;
      xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const a = Math.ceil(xs[q] - 0.5);
      const b = Math.floor(xs[q + 1] - 0.5);
      for (let gx = a; gx <= b; gx++) grid[gy * SKETCH_W + (((gx % SKETCH_W) + SKETCH_W) % SKETCH_W)] = v;
    }
  }
}

/** 导入图片的格子图铺到草图格子上:一格铺 2 × 2 格,值是 0(没盖到)的格子不动 */
function paintLayer(grid: Uint8Array, layer: Uint8Array) {
  for (let ly = 0; ly < LAYER_H; ly++) {
    for (let lx = 0; lx < LAYER_W; lx++) {
      const v = layer[ly * LAYER_W + lx];
      if (v === SKETCH_NONE) continue;
      const i = 2 * ly * SKETCH_W + 2 * lx;
      grid[i] = grid[i + 1] = grid[i + SKETCH_W] = grid[i + SKETCH_W + 1] = v;
    }
  }
}

/**
 * 草图涂成的格子图(生成用)。没有草图、或者涂完一格也没有(没涂的又交给程序)= null,和没画一样。
 * rest = 'sea' 时没涂的格子当海:什么也没画就是一颗全是海的星球
 */
export function sketchGrid(edit: SketchEdit | null | undefined): Sketch | null {
  if (!edit) return null;
  const grid = new Uint8Array(SKETCH_W * SKETCH_H);
  const layer = edit.image ? decodeLayer(edit.image.cells) : null;
  const at = layer ? Math.min(edit.image!.at ?? 0, edit.strokes.length) : edit.strokes.length;
  for (let k = 0; k < at; k++) paint(grid, edit.strokes[k]);
  if (layer) paintLayer(grid, layer);
  for (let k = at; k < edit.strokes.length; k++) paint(grid, edit.strokes[k]);
  if (edit.rest === 'sea') for (let i = 0; i < grid.length; i++) if (grid[i] === SKETCH_NONE) grid[i] = SKETCH_SEA;
  const out = { grid, coast: sketchCoast(edit) };
  return sketchUsed(out) ? out : null;
}

/** 世界坐标 (x, y)(主图 width × height)落在草图的哪一格,取那一格的值;x 绕一圈取模 */
export function sketchAt(grid: Uint8Array, x: number, y: number, width: number, height: number): number {
  let gx = Math.floor((x / width) * SKETCH_W);
  gx = ((gx % SKETCH_W) + SKETCH_W) % SKETCH_W;
  const gy = Math.min(SKETCH_H - 1, Math.max(0, Math.floor((y / height) * SKETCH_H)));
  return grid[gy * SKETCH_W + gx];
}

/** 每个地块中心落在草图的哪一格,取那一格的值 */
export function sketchCells(mesh: Mesh, grid: Uint8Array): Uint8Array {
  const { n, x, y, width, height } = mesh;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = sketchAt(grid, x[i], y[i], width, height);
  return out;
}

/** 草图上有没有涂过东西 */
export function sketchUsed(sketch: Sketch | null | undefined): sketch is Sketch {
  return !!sketch && sketch.grid.some((v) => v !== SKETCH_NONE);
}
