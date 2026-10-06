/**
 * 作者标记的样子和摆放(数据格式见 gen/edits.ts 文件头"作者标记"):屏幕上的标记层(ui/MarkLayer.tsx)和导出的地图图片共用。
 *
 * - 一个点:水滴形图钉(24×32 像素,尖头就是那个点;选中 30×40),白边、白芯、淡投影;名字写在图钉右边
 *   (压着别的标记、出了屏幕换左边、下边;压着地图上的城名、地名、城镇符号也尽量换),字是标记的颜色压暗一点(× 0.72),白色光晕
 * - 几个州:这几州铺一层标记色(不透明度 0.3,选中 0.42),外圈先描一道白边(4.5 像素)再描一道实线(2 像素),
 *   海岸那一侧也描;名字写在这几州中间的白底圆角小牌上(选中时小牌外面一圈同色细环)
 * - 缩小到城名还没出来时(相当于平面主图不到 NAME_ZOOM 倍):不写名字;屏幕上挨得近(CLUSTER_PX 以内)的合成一个带数字的圆
 *   (颜色都一样就用那个颜色,不一样用深灰;几个州的标记按名字牌的位置算,铺色照画)
 * - 选中一个标记时,别的标记变淡(0.45)
 *
 * 位置都是世界坐标(主图像素,x 是经度、东西相连);画的时候经 MarkFrame.pt 换到画布上(平面主图、弯边投影、地球仪、导出各给各的)。
 * 只算、只往给定的画布上画,不碰 DOM。
 */
import type { Mesh } from '../gen/mesh';
import type { Regions } from '../gen/civ/types';
import type { MarkColor } from '../gen/edits';
import { sphereMean } from './civ/lines';
import { nearX } from './common';
import { placedMarkBox, type Placement } from './labels/draw';
import { glyphBox } from './labels/layout';

/** 六种颜色(和时间轴大事的颜色同一套) */
export const MARK_HEX: Record<MarkColor, string> = {
  red: '#e0443a',
  orange: '#c4870f',
  green: '#2e9a58',
  blue: '#3478d4',
  purple: '#8d5bcc',
  teal: '#1b97a6',
};

/** 名字的颜色:标记颜色压暗一点(和地图上墨色的地名分开) */
export function markInk(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  const k = 0.72;
  return `rgb(${Math.round((v >> 16) * k)},${Math.round(((v >> 8) & 255) * k)},${Math.round((v & 255) * k)})`;
}

const rgba = (hex: string, a: number) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
};

/** 放大到这么多倍(平面主图的缩放;和"城"一级的城名同一个门槛)才写名字,不合并 */
export const NAME_ZOOM = 2;
/** 缩小时,屏幕上离得这么近(像素)的合成一个圆 */
export const CLUSTER_PX = 64;
/** 别的标记变淡到多少 */
export const DIM_ALPHA = 0.45;
/** 混了几种颜色的圆用的深灰 */
const CLUSTER_MIXED = '#3a3a3c';
/** 字体(和界面的 --font-sans 一样) */
export const MARK_FONT = `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`;

// ---------------------------------------------------------------------------
// 几个州的形状

/** 几个州画出来的样子(世界坐标;x 按 ref 展开成连着的一片,可能伸出 [0, W)) */
export interface AreaShape {
  /** 每个地块一块多边形(相邻三角形的重心按角度连起来;拼在一起不留缝) */
  polys: Float32Array[];
  /** 外圈(这几州和别处 —— 别的州、海、湖 —— 的分界),每条是一个环 */
  loops: Float32Array[];
  /** 名字牌放在哪 */
  label: [number, number];
  /** 外接框 [x0, y0, x1, y1] */
  box: [number, number, number, number];
}

interface MeshIndex {
  /** 地块 → 三角形(CSR) */
  start: Int32Array;
  tris: Int32Array;
  /** 三角形重心(按球面算,x 在 [0, W)) */
  cen: Float32Array;
}

const meshIndexes = new WeakMap<Mesh, MeshIndex>();

function meshIndex(mesh: Mesh): MeshIndex {
  let ix = meshIndexes.get(mesh);
  if (ix) return ix;
  const { n, triangles } = mesh;
  const nt = triangles.length / 3;
  const start = new Int32Array(n + 1);
  for (let i = 0; i < triangles.length; i++) start[triangles[i] + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const tris = new Int32Array(triangles.length);
  for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) tris[fill[triangles[3 * t + j]]++] = t;
  const cen = new Float32Array(nt * 2);
  const out = [0, 0];
  for (let t = 0; t < nt; t++) {
    sphereMean(mesh, triangles[3 * t], triangles[3 * t + 1], triangles[3 * t + 2], out);
    cen[2 * t] = out[0];
    cen[2 * t + 1] = out[1];
  }
  ix = { start, tris, cen };
  meshIndexes.set(mesh, ix);
  return ix;
}

/** 两极附近的地块不画多边形(包着极点的多边形在主图上拉成一长条) */
const POLAR = 0.46;

/** 几个州(州号)画出来的样子;一个地块都没有(州号都不对)= null */
export function markAreaShape(mesh: Mesh, regions: Pick<Regions, 'count' | 'cellStart' | 'cells'>, ids: readonly number[]): AreaShape | null {
  const { x, y, adjStart, adj } = mesh;
  const W = mesh.width;
  const H = mesh.height;
  const ix = meshIndex(mesh);
  const inSet = new Uint8Array(mesh.n);
  const cells: number[] = [];
  for (const r of ids) {
    if (!(r >= 0 && r < regions.count)) continue;
    for (let k = regions.cellStart[r]; k < regions.cellStart[r + 1]; k++) {
      const c = regions.cells[k];
      if (inSet[c]) continue;
      inSet[c] = 1;
      cells.push(c);
    }
  }
  if (!cells.length) return null;
  const ref = x[cells[0]];
  // 外接框、中心
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let sx = 0;
  let sy = 0;
  for (const c of cells) {
    const cx = nearX(x[c], ref, W);
    if (cx < x0) x0 = cx;
    if (cx > x1) x1 = cx;
    if (y[c] < y0) y0 = y[c];
    if (y[c] > y1) y1 = y[c];
    sx += cx;
    sy += y[c];
  }
  // 名字牌:几州的中心;中心不在这几州里(月牙形、隔着海的几块)就换到离中心最近的地块
  let lx = sx / cells.length;
  let ly = sy / cells.length;
  let best = cells[0];
  let bd = Infinity;
  for (const c of cells) {
    const d = (nearX(x[c], lx, W) - lx) ** 2 + (y[c] - ly) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  if (bd > (mesh.spacing * 1.5) ** 2) {
    lx = nearX(x[best], ref, W);
    ly = y[best];
  }
  // 每个地块的多边形
  const polys: Float32Array[] = [];
  const pts: { a: number; x: number; y: number }[] = [];
  for (const c of cells) {
    if (Math.abs(y[c] - H / 2) > POLAR * H) continue;
    const cx = nearX(x[c], ref, W);
    pts.length = 0;
    for (let k = ix.start[c]; k < ix.start[c + 1]; k++) {
      const t = ix.tris[k];
      const px = nearX(ix.cen[2 * t], cx, W);
      const py = ix.cen[2 * t + 1];
      pts.push({ a: Math.atan2(py - y[c], px - cx), x: px, y: py });
    }
    if (pts.length < 3) continue;
    pts.sort((p, q) => p.a - q.a);
    const f = new Float32Array(pts.length * 2);
    pts.forEach((p, i) => {
      f[2 * i] = p.x;
      f[2 * i + 1] = p.y;
    });
    polys.push(f);
  }
  // 外圈:这几州的地块和外面的地块之间的每条边,连起两边三角形的重心;串成环
  const link = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    let la = link.get(a);
    if (!la) link.set(a, (la = []));
    la.push(b);
    let lb = link.get(b);
    if (!lb) link.set(b, (lb = []));
    lb.push(a);
  };
  for (const c of cells) {
    for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
      const q = adj[k];
      if (inSet[q]) continue;
      // 这条边两边的三角形:c 和 q 都是顶点的那两个
      let t1 = -1;
      let t2 = -1;
      for (let i = ix.start[c]; i < ix.start[c + 1]; i++) {
        const t = ix.tris[i];
        for (let j = ix.start[q]; j < ix.start[q + 1]; j++) {
          if (ix.tris[j] !== t) continue;
          if (t1 < 0) t1 = t;
          else t2 = t;
        }
      }
      if (t1 >= 0 && t2 >= 0) add(t1, t2);
    }
  }
  const loops: Float32Array[] = [];
  const used = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (const [s, nb] of link) {
    for (const first of nb) {
      if (used.has(ekey(s, first))) continue;
      const out: number[] = [];
      let prev = s;
      let cur = first;
      let px = nearX(ix.cen[2 * s], ref, W);
      out.push(px, ix.cen[2 * s + 1]);
      used.add(ekey(prev, cur));
      for (let guard = 0; guard < 1e6; guard++) {
        px = nearX(ix.cen[2 * cur], px, W);
        out.push(px, ix.cen[2 * cur + 1]);
        if (cur === s) break;
        const nx = (link.get(cur) ?? []).find((t) => t !== prev && !used.has(ekey(cur, t)));
        if (nx === undefined) break;
        used.add(ekey(cur, nx));
        prev = cur;
        cur = nx;
      }
      if (out.length >= 6) loops.push(Float32Array.from(out));
    }
  }
  return { polys, loops, label: [lx, ly], box: [x0, y0, x1, y1] };
}

// ---------------------------------------------------------------------------
// 画布上的摆放

/** 世界坐标 → 画布坐标(CSS 像素)的换算;画布的大小、看得见的左右范围 */
export interface MarkFrame {
  /** 世界坐标 → 画布坐标;x 按给的原样换算(平面主图不取模,见 period);算不出(在球背面)= null */
  pt(wx: number, wy: number): [number, number] | null;
  /** 平面等距圆柱:左右相连,x 加一整圈画布上挪多少像素;弯边投影、地球仪、导出 = 0(pt 自己处理) */
  period: number;
  /** 看得见的左右范围(画布坐标) */
  win: [number, number];
  /** 画布大小 */
  w: number;
  h: number;
  /** 相当于平面主图的几倍(写不写名字按它) */
  k: number;
  /** 弯边投影:一段线在画布上长过这么多就是跨了投影的切口(不连);0 = 不管 */
  cut: number;
}

/** 要画的一个标记(已经按年份挑过) */
export interface MarkItem {
  id: number;
  title: string;
  color: MarkColor;
  at?: [number, number];
  shape?: AreaShape | null;
  /** 选中 / 正在编辑的那个(画大一号,不合并) */
  selected?: boolean;
  /** 变淡:选了别的标记;选中的这个不在当前年份里 */
  dim?: boolean;
}

export type LabelSide = 'r' | 'l' | 'b';

export interface PlacedPin {
  id: number;
  /** 尖头的位置(画布坐标) */
  x: number;
  y: number;
  /** 图钉宽(高 = 宽 × 4 / 3) */
  w: number;
  hex: string;
  alpha: number;
  label: { text: string; x: number; y: number; side: LabelSide; size: number; w: number; ink: string } | null;
}

export interface PlacedArea {
  id: number;
  hex: string;
  alpha: number;
  selected: boolean;
  /** 每块多边形、外圈(画布坐标) */
  polys: Float32Array[];
  lines: Float32Array[];
  pill: { text: string; x: number; y: number; size: number; w: number; ink: string } | null;
}

export interface PlacedCluster {
  x: number;
  y: number;
  ids: number[];
  hex: string;
  w: number;
  /** 合进来的都变淡了(选了别的标记)= DIM_ALPHA */
  alpha: number;
}

/** 点得到的东西(画布坐标的矩形 [x0, y0, x1, y1]) */
export interface MarkHit {
  kind: 'pin' | 'label' | 'pill' | 'cluster';
  ids: number[];
  box: [number, number, number, number];
}

export interface MarkLayout {
  areas: PlacedArea[];
  pins: PlacedPin[];
  clusters: PlacedCluster[];
  /** 后画的在后面:点的时候倒着找 */
  hits: MarkHit[];
}

/** 名字的字号 */
const LABEL_SIZE = 14;
const LABEL_SIZE_SEL = 15;
const LINE = 1.25;
/** 图钉宽:平时 / 选中 / 缩小后单独一个 */
export const PIN_W = 24;
export const PIN_W_SEL = 30;
export const PIN_W_SMALL = 20;

/** 量字宽:measure 给了就用它(屏幕上用画布量),不给按每个字 1 em 估 */
export type Measure = (text: string, size: number) => number;
const roughMeasure: Measure = (t, size) => [...t].reduce((s, ch) => s + (ch.charCodeAt(0) < 0x2e80 ? 0.6 : 1), 0) * size;

/** 平面主图:把画布上的 x 挪整数圈,落到看得见的范围中间附近 */
function shiftOf(f: MarkFrame, x: number): number {
  if (!f.period) return 0;
  const c = (f.win[0] + f.win[1]) / 2;
  return f.period * Math.round((c - x) / f.period);
}

const MARGIN = 40;
const visible = (f: MarkFrame, x: number, y: number, m = MARGIN) => x >= f.win[0] - m && x <= f.win[1] + m && y >= -m && y <= f.h + m;
const overlap = (a: readonly number[], b: readonly number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** 一串世界坐标的点 → 画布坐标(给定挪的整圈);有点算不出 / 跨了投影切口 = 断开,返回几段 */
function projectRun(f: MarkFrame, pts: Float32Array, shift: number): Float32Array[] {
  const out: Float32Array[] = [];
  let cur: number[] = [];
  let px = NaN;
  let py = NaN;
  const flush = () => {
    if (cur.length >= 4) out.push(Float32Array.from(cur));
    cur = [];
  };
  for (let i = 0; i < pts.length; i += 2) {
    const p = f.pt(pts[i], pts[i + 1]);
    if (!p) {
      flush();
      px = NaN;
      continue;
    }
    const X = p[0] + shift;
    const Y = p[1];
    if (f.cut && cur.length && Math.hypot(X - px, Y - py) > f.cut) flush();
    cur.push(X, Y);
    px = X;
    py = Y;
  }
  flush();
  return out;
}

/** 一块多边形 → 画布坐标;有点算不出、跨了切口 = null(整块不画) */
function projectPoly(f: MarkFrame, pts: Float32Array, shift: number): Float32Array | null {
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const p = f.pt(pts[i], pts[i + 1]);
    if (!p) return null;
    out[i] = p[0] + shift;
    out[i + 1] = p[1];
    if (f.cut && i && Math.hypot(out[i] - out[i - 2], out[i + 1] - out[i - 1]) > f.cut) return null;
  }
  return out;
}

/**
 * 地图上已经排好的城名、地名、城镇符号占的地方(文字层画布像素的框):标记的名字尽量躲开。
 * 每个字按笔画大致占的地方算(比整个字格小一圈,挨着一点不算压);
 * 国名不算(字大、铺得开,躲它反而哪边都放不下);淡到看不清的字不算
 */
export function placedTextBoxes(placed: Placement): number[][] {
  const out: number[][] = placed.marks.map((m) => placedMarkBox(m));
  for (const l of placed.labels) {
    if (l.item.sizeWorld !== undefined || l.alpha < 0.3) continue;
    for (const g of l.glyphs) out.push(glyphBox(g, l.px, -0.12 * l.px));
  }
  return out;
}

/**
 * 摆好这一帧要画的标记:按缩放决定写不写名字、要不要合并;名字挑一边放(先右,压着别的标记就左、下);
 * 算出点得到的范围。items 按先后排,选中的放最后(画在最上面)。
 * avoid = 地图上的城名、地名、按钮面板占的地方(和画布同一套坐标):名字先找哪个都不压的一边,找不到再只躲开别的标记
 */
export function layoutMarks(items: readonly MarkItem[], f: MarkFrame, opts: { names?: boolean; measure?: Measure; avoid?: readonly number[][] } = {}): MarkLayout {
  const avoid = opts.avoid ?? [];
  const names = opts.names ?? f.k >= NAME_ZOOM * 0.92;
  const measure = opts.measure ?? roughMeasure;
  const areas: PlacedArea[] = [];
  const pins: PlacedPin[] = [];
  const clusters: PlacedCluster[] = [];
  const hits: MarkHit[] = [];
  const order = [...items.filter((m) => !m.selected), ...items.filter((m) => m.selected)];

  // 几个州:铺色、外圈(总要画);名字牌的位置
  const anchors: { m: MarkItem; x: number; y: number; area?: PlacedArea }[] = [];
  for (const m of order) {
    const sh = m.shape;
    if (!sh) continue;
    const lp = f.pt(sh.label[0], sh.label[1]);
    const base = lp ? shiftOf(f, lp[0]) : 0;
    const shifts = f.period ? [base - f.period, base, base + f.period] : [0];
    const hex = MARK_HEX[m.color];
    const area: PlacedArea = { id: m.id, hex, alpha: m.dim ? DIM_ALPHA : 1, selected: !!m.selected, polys: [], lines: [], pill: null };
    for (const s of shifts) {
      // 平面主图:外接框整个不在看得见的地方就不算这一份
      if (f.period) {
        const a = f.pt(sh.box[0], sh.box[1]);
        const b = f.pt(sh.box[2], sh.box[3]);
        if (a && b && (Math.max(a[0], b[0]) + s < f.win[0] - MARGIN || Math.min(a[0], b[0]) + s > f.win[1] + MARGIN || Math.max(a[1], b[1]) < -MARGIN || Math.min(a[1], b[1]) > f.h + MARGIN)) continue;
      }
      for (const p of sh.polys) {
        const q = projectPoly(f, p, s);
        if (q) area.polys.push(q);
      }
      for (const l of sh.loops) area.lines.push(...projectRun(f, l, s));
    }
    if (!area.polys.length && !area.lines.length) continue;
    areas.push(area);
    if (lp && visible(f, lp[0] + base, lp[1], 0)) anchors.push({ m, x: lp[0] + base, y: lp[1], area });
  }

  // 一个点:画布上的位置
  const points: { m: MarkItem; x: number; y: number }[] = [];
  for (const m of order) {
    if (!m.at) continue;
    const p = f.pt(m.at[0], m.at[1]);
    if (!p) continue;
    const x = p[0] + shiftOf(f, p[0]);
    if (!visible(f, x, p[1])) continue;
    points.push({ m, x, y: p[1] });
  }

  /** 已经占了的地方(名字牌、图钉、名字):后放的名字躲开它们 */
  const taken: number[][] = [];
  /** 名字点得到的范围:最后才加进 hits(名字画在图钉上面,点的时候也先认名字) */
  const labelHits: MarkHit[] = [];
  if (!names) {
    // 缩小了:不写名字;挨得近的合成一个圆(选中的单独画,不合)
    const all = [...points.map((p) => ({ ...p, area: false })), ...anchors.map((a) => ({ m: a.m, x: a.x, y: a.y, area: true }))];
    const free = all.filter((a) => !a.m.selected);
    const used = new Uint8Array(free.length);
    for (let i = 0; i < free.length; i++) {
      if (used[i]) continue;
      const grp = [i];
      used[i] = 1;
      for (let j = i + 1; j < free.length; j++) {
        if (used[j] || Math.hypot(free[j].x - free[i].x, free[j].y - free[i].y) >= CLUSTER_PX) continue;
        grp.push(j);
        used[j] = 1;
      }
      if (grp.length > 1) {
        const X = grp.reduce((s, k) => s + free[k].x, 0) / grp.length;
        const Y = grp.reduce((s, k) => s + free[k].y, 0) / grp.length;
        const c0 = free[grp[0]].m.color;
        const hex = grp.every((k) => free[k].m.color === c0) ? MARK_HEX[c0] : CLUSTER_MIXED;
        const text = String(grp.length);
        const w = Math.max(28, measure(text, 13) * 0.62 + 16);
        const alpha = grp.every((k) => free[k].m.dim) ? DIM_ALPHA : 1;
        clusters.push({ x: X, y: Y, ids: grp.map((k) => free[k].m.id), hex, w, alpha });
        hits.push({ kind: 'cluster', ids: grp.map((k) => free[k].m.id), box: [X - w / 2, Y - 14, X + w / 2, Y + 14] });
      } else if (!free[i].area) {
        const p = free[i];
        pins.push({ id: p.m.id, x: p.x, y: p.y, w: PIN_W_SMALL, hex: MARK_HEX[p.m.color], alpha: p.m.dim ? DIM_ALPHA : 1, label: null });
      } else {
        // 单独一个州的标记:只有铺色,名字牌的地方照样点得到(和合并的圆一样大)
        const p = free[i];
        hits.push({ kind: 'pill', ids: [p.m.id], box: [p.x - 14, p.y - 14, p.x + 14, p.y + 14] });
      }
    }
    // 选中的:大图钉 + 名字(缩小了也写它的名字,看得出选的是哪个;名字躲开合并的圆和小图钉)
    for (const c of clusters) taken.push([c.x - c.w / 2, c.y - 14, c.x + c.w / 2, c.y + 14]);
    for (const p of pins) taken.push([p.x - p.w / 2, p.y - (p.w * 4) / 3, p.x + p.w / 2, p.y]);
    for (const p of all.filter((a) => a.m.selected)) placeSelected(p, true);
    finishHits();
    return { areas, pins, clusters, hits };
  }

  // 放大了:每个都写名字。先放名字牌(几个州;压着前面的名字牌就往下、往上错开),再放图钉的名字:右边压着别的就换左边、下边
  for (const a of anchors) {
    const pill = keepIn(pillOf(a.m, a.x, a.y));
    const step = pill.size * LINE + 8;
    for (let k = 1; k <= 8 && taken.some((t) => overlap(pillBox(pill), t)); k++) {
      pill.y = a.y + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      keepIn(pill);
    }
    a.area!.pill = pill;
    const box = pillBox(pill);
    taken.push(box);
    hits.push({ kind: 'pill', ids: [a.m.id], box });
  }
  for (const p of points) {
    const w = p.m.selected ? PIN_W_SEL : PIN_W;
    taken.push([p.x - w / 2, p.y - (w * 4) / 3, p.x + w / 2, p.y]);
  }
  for (const p of points) placePin(p, p.m.selected ? PIN_W_SEL : PIN_W, true);
  finishHits();
  return { areas, pins, clusters, hits };

  function pillOf(m: MarkItem, x: number, y: number) {
    const size = m.selected ? LABEL_SIZE_SEL : LABEL_SIZE;
    return { text: m.title, x, y, size, w: measure(m.title, size) + 18, ink: markInk(MARK_HEX[m.color]) };
  }
  /** 名字牌整个留在画面里(州的中心贴着画面边上时往里挪) */
  function keepIn(p: ReturnType<typeof pillOf>) {
    const b = pillBox(p);
    const hh = (b[3] - b[1]) / 2;
    p.y = Math.min(Math.max(p.y, hh), Math.max(hh, f.h - hh));
    if (f.win[1] - f.win[0] >= p.w) p.x = Math.min(Math.max(p.x, f.win[0] + p.w / 2), f.win[1] - p.w / 2);
    return p;
  }
  function placeSelected(p: { m: MarkItem; x: number; y: number; area: boolean }, withName: boolean) {
    if (p.area) {
      const a = areas.find((q) => q.id === p.m.id);
      if (!a || !withName) return;
      a.pill = keepIn(pillOf(p.m, p.x, p.y));
      hits.push({ kind: 'pill', ids: [p.m.id], box: pillBox(a.pill) });
      return;
    }
    placePin(p, PIN_W_SEL, withName);
  }
  function placePin(p: { m: MarkItem; x: number; y: number }, w: number, withName: boolean) {
    const hex = MARK_HEX[p.m.color];
    const h = (w * 4) / 3;
    const pin: PlacedPin = { id: p.m.id, x: p.x, y: p.y, w, hex, alpha: p.m.dim ? DIM_ALPHA : 1, label: null };
    if (withName) {
      const size = p.m.selected ? LABEL_SIZE_SEL : LABEL_SIZE;
      const tw = measure(p.m.title, size);
      const th = size * LINE;
      const top = p.y - h + (p.m.selected ? 5 : 4);
      const cand: { side: LabelSide; box: number[]; x: number; y: number }[] = [
        { side: 'r', x: p.x + w / 2 + 1, y: top, box: [p.x + w / 2 + 1, top, p.x + w / 2 + 1 + tw, top + th] },
        { side: 'l', x: p.x - w / 2 - 1, y: top, box: [p.x - w / 2 - 1 - tw, top, p.x - w / 2 - 1, top + th] },
        { side: 'b', x: p.x, y: p.y + 3, box: [p.x - tw / 2, p.y + 3, p.x + tw / 2, p.y + 3 + th] },
      ];
      const fits = (c: (typeof cand)[number]) => c.box[0] >= f.win[0] && c.box[2] <= f.win[1] && c.box[1] >= 0 && c.box[3] <= f.h && !taken.some((t) => overlap(c.box, t));
      const clear = (c: (typeof cand)[number]) => fits(c) && !avoid.some((t) => overlap(c.box, t));
      const pick = cand.find(clear) ?? cand.find(fits) ?? cand[0];
      taken.push(pick.box);
      pin.label = { text: p.m.title, x: pick.x, y: pick.y, side: pick.side, size, w: tw, ink: markInk(hex) };
      labelHits.push({ kind: 'label', ids: [p.m.id], box: pick.box as [number, number, number, number] });
    }
    pins.push(pin);
  }
  /** 点得到的范围按画的先后排(合并的圆、名字牌 → 图钉 → 名字),hitMark 从后往前认 */
  function finishHits() {
    for (const p of pins) {
      const h = (p.w * 4) / 3;
      hits.push({ kind: 'pin', ids: [p.id], box: [p.x - p.w / 2 - 2, p.y - h - 2, p.x + p.w / 2 + 2, p.y + 2] });
    }
    hits.push(...labelHits);
  }
}

function pillBox(p: { x: number; y: number; size: number; w: number }): [number, number, number, number] {
  const h = p.size * LINE + 6;
  return [p.x - p.w / 2, p.y - h / 2, p.x + p.w / 2, p.y + h / 2];
}

/** 画布坐标上这一点点到了哪个标记(后画的先算;图钉、名字、名字牌、合并的圆);没点到 = null */
export function hitMark(layout: MarkLayout | null, x: number, y: number): MarkHit | null {
  if (!layout) return null;
  for (let i = layout.hits.length - 1; i >= 0; i--) {
    const h = layout.hits[i];
    if (x >= h.box[0] && x <= h.box[2] && y >= h.box[1] && y <= h.box[3]) return h;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 画

type Ctx = CanvasRenderingContext2D;

/** 图钉(水滴形,尖头朝下;viewBox 0 0 24 32,尖头在 (12, 31.2)) */
const PIN_PATH = 'M12 31.2C10.6 27 3 20.4 3 12.6a9 9 0 0 1 18 0c0 7.8-7.6 14.4-9 18.6z';

/** 画好的图钉(带投影):按颜色、宽、像素密度存一份 */
const sprites = new Map<string, { img: HTMLCanvasElement | OffscreenCanvas; pad: number }>();

function pinSprite(hex: string, w: number, dpr: number) {
  const key = `${hex}|${w}|${dpr}`;
  let s = sprites.get(key);
  if (s) return s;
  const pad = 4;
  const h = (w * 4) / 3;
  const cw = Math.ceil((w + pad * 2) * dpr);
  const ch = Math.ceil((h + pad * 2) * dpr);
  const img = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const g = img.getContext('2d') as Ctx;
  g.scale(dpr, dpr);
  g.translate(pad, pad);
  g.scale(w / 24, w / 24);
  const p = new Path2D(PIN_PATH);
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 1.5 * dpr;
  g.shadowOffsetY = 1 * dpr;
  g.fillStyle = hex;
  g.fill(p);
  g.shadowColor = 'transparent';
  g.lineWidth = 1.6;
  g.strokeStyle = '#fff';
  g.stroke(p);
  g.beginPath();
  g.arc(12, 12.4, 3.6, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  s = { img, pad };
  sprites.set(key, s);
  return s;
}

/** 一个图钉:尖头在 (x, y);w = 宽 */
export function drawPin(ctx: Ctx, x: number, y: number, hex: string, w: number, alpha = 1, dpr = 1) {
  const s = pinSprite(hex, w, dpr);
  const h = (w * 4) / 3;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.drawImage(s.img as CanvasImageSource, x - w / 2 - s.pad, y - (31.2 / 32) * h - s.pad, w + s.pad * 2, h + s.pad * 2);
  ctx.restore();
}

const font = (size: number, weight = 600) => `${weight} ${size}px ${MARK_FONT}`;

/** 量字宽(用画布) */
export function canvasMeasure(ctx: Ctx): Measure {
  const cache = new Map<string, number>();
  return (text, size) => {
    const k = `${size}|${text}`;
    let w = cache.get(k);
    if (w === undefined) {
      ctx.font = font(size);
      w = ctx.measureText(text).width;
      cache.set(k, w);
    }
    return w;
  };
}

/** 图钉旁的名字:白色光晕 + 压暗的标记色 */
function drawLabel(ctx: Ctx, l: NonNullable<PlacedPin['label']>, alpha: number) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = font(l.size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = l.side === 'r' ? 'left' : l.side === 'l' ? 'right' : 'center';
  const y = l.y + (l.size * LINE) / 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 4;
  ctx.strokeText(l.text, l.x, y);
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2.5;
  ctx.strokeText(l.text, l.x, y);
  ctx.fillStyle = l.ink;
  ctx.fillText(l.text, l.x, y);
  ctx.restore();
}

/** 几个州:铺色 + 白边 + 实线 */
function drawArea(ctx: Ctx, a: PlacedArea) {
  ctx.save();
  ctx.globalAlpha *= a.alpha;
  const fill = new Path2D();
  for (const p of a.polys) {
    fill.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) fill.lineTo(p[i], p[i + 1]);
    fill.closePath();
  }
  ctx.fillStyle = rgba(a.hex, a.selected ? 0.42 : 0.3);
  ctx.fill(fill);
  const line = new Path2D();
  for (const l of a.lines) {
    line.moveTo(l[0], l[1]);
    for (let i = 2; i < l.length; i += 2) line.lineTo(l[i], l[i + 1]);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = a.selected ? 5.5 : 4.5;
  ctx.stroke(line);
  ctx.strokeStyle = a.hex;
  ctx.lineWidth = a.selected ? 2.8 : 2;
  ctx.stroke(line);
  ctx.restore();
}

/** 几个州的名字牌:白底圆角,选中时外面一圈同色细环 */
function drawPill(ctx: Ctx, p: NonNullable<PlacedArea['pill']>, selected: boolean, alpha: number) {
  const [x0, y0, x1, y1] = pillBox(p);
  ctx.save();
  ctx.globalAlpha *= alpha;
  const r = new Path2D();
  roundRect(r, x0, y0, x1 - x0, y1 - y0, 7);
  ctx.shadowColor = selected ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = selected ? 4 : 3;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill(r);
  ctx.shadowColor = 'transparent';
  if (selected) {
    const o = new Path2D();
    roundRect(o, x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, 8);
    ctx.lineWidth = 2;
    ctx.strokeStyle = p.ink;
    ctx.stroke(o);
  }
  ctx.font = font(p.size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = p.ink;
  ctx.fillText(p.text, p.x, p.y + 0.5);
  ctx.restore();
}

function roundRect(p: Path2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.min(r, w / 2, h / 2);
  p.moveTo(x + q, y);
  p.arcTo(x + w, y, x + w, y + h, q);
  p.arcTo(x + w, y + h, x, y + h, q);
  p.arcTo(x, y + h, x, y, q);
  p.arcTo(x, y, x + w, y, q);
  p.closePath();
}

/** 合并的圆:数字 + 白边 */
function drawCluster(ctx: Ctx, c: PlacedCluster) {
  const h = 28;
  const r = new Path2D();
  roundRect(r, c.x - c.w / 2, c.y - h / 2, c.w, h, h / 2);
  ctx.save();
  ctx.globalAlpha *= c.alpha;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = c.hex;
  ctx.fill(r);
  ctx.shadowColor = 'transparent';
  const inner = new Path2D();
  roundRect(inner, c.x - c.w / 2 + 1, c.y - h / 2 + 1, c.w - 2, h - 2, h / 2 - 1);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.stroke(inner);
  ctx.font = font(13, 700);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(String(c.ids.length), c.x, c.y + 0.5);
  ctx.restore();
}

/** 把摆好的标记画到画布上(画布坐标 = CSS 像素;dpr = 画布像素密度,图钉按它预先画好) */
export function drawMarks(ctx: Ctx, layout: MarkLayout, dpr = 1) {
  for (const a of layout.areas) drawArea(ctx, a);
  // 合并的圆先画:选中的图钉和名字画在它上面(和点的时候先认选中的一样)
  for (const c of layout.clusters) drawCluster(ctx, c);
  for (const a of layout.areas) if (a.pill) drawPill(ctx, a.pill, a.selected, a.alpha);
  for (const p of layout.pins) drawPin(ctx, p.x, p.y, p.hex, p.w, p.alpha, dpr);
  for (const p of layout.pins) if (p.label) drawLabel(ctx, p.label, p.alpha);
}

/** 放标记时跟着鼠标的半透明图钉 + 十字 */
export function drawGhostPin(ctx: Ctx, x: number, y: number, hex: string, dpr = 1) {
  drawPin(ctx, x, y, hex, PIN_W, 0.55, dpr);
  ctx.save();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(x - 11, y);
  ctx.lineTo(x + 11, y);
  ctx.moveTo(x, y - 11);
  ctx.lineTo(x, y + 11);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#1d1d1f';
  ctx.stroke();
  ctx.restore();
}

/** 编辑几个州时鼠标停着的州:一圈虚线(画布坐标的外圈) */
export function drawHoverOutline(ctx: Ctx, lines: readonly Float32Array[]) {
  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(29,29,31,0.75)';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  for (const l of lines) {
    ctx.moveTo(l[0], l[1]);
    for (let i = 2; i < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]);
  }
  ctx.stroke();
  ctx.restore();
}

/** 一圈外圈(世界坐标)→ 画布坐标(给"鼠标停着的州"用) */
export function projectLoops(f: MarkFrame, sh: AreaShape): Float32Array[] {
  const lp = f.pt(sh.label[0], sh.label[1]);
  const s = lp ? shiftOf(f, lp[0]) : 0;
  const out: Float32Array[] = [];
  for (const l of sh.loops) out.push(...projectRun(f, l, s));
  return out;
}
