/**
 * 文明叠加层 · 地图高亮(阶段 3 编年史):点编年史的一条,事发的州、相关国家那一年的国土在地图上闪约两秒。
 *
 * - 事发州(浓):暖橙色罩染 + 亮金色描边;事发地在屏幕上很小时外面再套一个金色圆圈;
 *   相关国家的国土(淡):写实风一层米白 + 白色描边,手绘风朱砂描边;两国相接处也描一道(看得出谁是谁)。
 *   描边外面垫一道反差色,在浅色羊皮纸、深色森林上都看得清。
 * - 罩染按像素(Raster.cell → 州),半分辨率再放大,边缘略柔;描边沿州界(borders.ts 的链,平滑后)。
 *   州界的链只描"陆地 — 陆地"之间,海岸那一侧靠罩染看出来。
 * - 画在单独一张和地图一样大的画布上(CivLayer 的 canvas.civ-hl),闪烁用 CSS 动画(改不透明度),不重画。
 */
import type { World } from '../../gen/world';
import type { Raster } from '../../gen/raster';
import type { Civ, Year } from '../../gen/civ/types';
import { ownersAt } from '../../gen/civ/timeline';
import { pixelRegions } from './territory';
import { mergeChains, regionChains, type SidedLine } from './borders';
import { addToPath, chaikin, meshWrap, unwrapLine, type Polyline } from './lines';
import { nearX, wrapShifts } from '../common';
import type { CivStyle } from './overlay';
import type { LabelView, Placement } from '../labels/draw';
import { clipOutline, relShifts, reprojectImage, type Projector } from '../projection';

export interface CivHighlight {
  /** 事发的州(浓) */
  regions: readonly number[];
  /** 相关国家:画它们在 year 这一年的国土(淡) */
  polities: readonly number[];
  year: Year;
}

/** 每州的标记:2 = 事发州,1 = 相关国家的国土,0 = 不亮 */
export function highlightMarks(civ: Civ, h: CivHighlight): Uint8Array {
  return marksAndGroups(civ, h).marks;
}

/** 标记 + 描边分组(亮着的州:属于哪个相关国家;不属于的 = −3;不亮 = −1) */
function marksAndGroups(civ: Civ, h: CivHighlight): { marks: Uint8Array; group: Int32Array } {
  const R = civ.regions.count;
  const marks = new Uint8Array(R);
  const group = new Int32Array(R).fill(-1);
  if (h.polities.length) {
    const own = ownersAt(civ, h.year);
    const set = new Set(h.polities);
    for (let r = 0; r < R; r++) {
      if (!set.has(own.polity[r])) continue;
      marks[r] = 1;
      group[r] = own.polity[r];
    }
  }
  for (const r of h.regions) {
    if (!(r >= 0 && r < R)) continue;
    marks[r] = 2;
    if (group[r] < 0) group[r] = -3;
  }
  return { marks, group };
}

/**
 * 高亮范围的外框(世界坐标 [x0, y0, x1, y1]):有事发州就框事发州,没有就框相关国家的国土;什么都没亮 = null。
 * 地图平移(事发地不在视野里时)用。
 */
export function highlightBox(world: World, civ: Civ, marks: Uint8Array): [number, number, number, number] | null {
  // 跨 180° 经线的范围按连着的一片算:x 按离第一个地块最近的那一份算(可以超出地图,地图平移时再取离视窗中心最近的那一份)
  let want = 0;
  for (let r = 0; r < marks.length; r++) if (marks[r] > want) want = marks[r];
  if (!want) return null;
  const { cellStart, cells } = civ.regions;
  const { x, y } = world.mesh;
  const W = world.width;
  let ref = NaN;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let r = 0; r < marks.length; r++) {
    if (marks[r] !== want) continue;
    for (let k = cellStart[r]; k < cellStart[r + 1]; k++) {
      const c = cells[k];
      if (ref !== ref) ref = x[c];
      const cx = nearX(x[c], ref, W);
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (y[c] < y0) y0 = y[c];
      if (y[c] > y1) y1 = y[c];
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

const pixCache = new WeakMap<Civ, { raster: Raster; pix: Int16Array }>();

function pixOf(world: World, raster: Raster, civ: Civ): Int16Array {
  const hit = pixCache.get(civ);
  if (hit && hit.raster === raster) return hit.pix;
  const pix = pixelRegions(world.mesh, raster, civ.regions.of);
  pixCache.set(civ, { raster, pix });
  return pix;
}

type RGBA = [number, number, number, number];
/**
 * 两种画法:写实 / 数据图层上用亮色(米白 + 金),手绘羊皮纸上米白不显眼,相关国家改用朱砂描边(旧地图上圈地的红线)。
 * fill = 罩染 [相关国家, 事发州](RGBA 0–255);line = 描边 [垫底, 本色, 光晕]
 */
const LOOK: Record<'light' | 'ink', { fill: [RGBA, RGBA]; polLine: [string, string, string] }> = {
  light: {
    fill: [
      [255, 238, 196, 105],
      [255, 122, 40, 130],
    ],
    polLine: ['rgba(20,14,8,0.6)', 'rgba(255,251,240,1)', 'rgba(255,244,214,0.9)'],
  },
  ink: {
    fill: [
      [196, 52, 36, 46],
      [255, 122, 40, 140],
    ],
    polLine: ['rgba(255,248,228,0.85)', 'rgba(178,34,24,0.95)', 'rgba(255,240,200,0.6)'],
  },
};
/** 事发地在屏幕上很小(外框 × 缩放倍数不到地图宽的这么多)时,外面再画一个圆圈,整张地图上也一眼找得到 */
const RING_BELOW = 0.05;

/**
 * 画高亮。画布大小 = raster.w × raster.h(和文明底图一样)。返回每州的标记(见 highlightMarks)。
 */
export function drawHighlight(
  ctx: CanvasRenderingContext2D,
  world: World,
  raster: Raster,
  civ: Civ,
  hl: CivHighlight,
  style: CivStyle = 'realistic',
  /** 现在的缩放倍数(只影响圆圈) */
  zoom = 1,
  /** 弯边投影(按投影重画):画布是地图平面,罩染按行重投影,描边逐点投影、按画布像素定粗细 */
  proj: Projector | null = null,
  /** 只画罩染(地球仪:描边、圆圈每帧按投影画成矢量,见 highlightStrokes) */
  washOnly = false,
): Uint8Array {
  const { marks, group } = marksAndGroups(civ, hl);
  const look = LOOK[style === 'fantasy' ? 'ink' : 'light'];
  const FILL = look.fill;
  const { w, h, scale: S } = raster;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  let lit = 0;
  for (let r = 0; r < marks.length; r++) if (marks[r]) lit++;
  if (!lit) return marks;

  // 1. 罩染(半分辨率)
  const pix = pixOf(world, raster, civ);
  const f = 2;
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const img = new ImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, y * f + 1) * w;
    for (let x = 0; x < W; x++) {
      const r = pix[row + Math.min(w - 1, x * f + 1)];
      const m = r >= 0 ? marks[r] : 0;
      if (!m) continue;
      const c = FILL[m - 1];
      const o = (y * W + x) * 4;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = c[3];
    }
  }
  const buf =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
  (buf.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  if (proj) {
    reprojectImage(ctx, buf, W, H, proj.mp, { s: S, ox: 0, oy: 0 });
    clipOutline(ctx, proj.mp, { s: S, ox: 0, oy: 0 });
  } else ctx.drawImage(buf, 0, 0, w, h);
  if (washOnly) {
    ctx.restore();
    return marks;
  }

  // 2. 描边:相关国家的国界(各国分开,两国相接处也有一道),再是事发州的外框
  //    (界线的 x 已展开,伸出主图左右边的在另一边再画一份)
  const rc = regionChains(world.mesh, civ);
  const R = marks.length;
  const wrap = meshWrap(world.mesh);
  const path = (lines: SidedLine[]) => {
    const pa = new Path2D();
    addToPath(
      pa,
      lines.map((l) => chaikin(l, 2)),
      S,
      wrap,
      proj,
    );
    return pa;
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (marks.some((m) => m === 1)) {
    const pa = path(mergeChains(rc, group));
    const [under, line, glow] = look.polLine;
    ctx.strokeStyle = under;
    ctx.lineWidth = 7 * S;
    ctx.stroke(pa);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6 * S;
    ctx.strokeStyle = line;
    ctx.lineWidth = 3.2 * S;
    ctx.stroke(pa);
    ctx.shadowBlur = 0;
  }
  if (marks.some((m) => m === 2)) {
    const strong = new Int32Array(R);
    for (let r = 0; r < R; r++) strong[r] = marks[r] === 2 ? 1 : 0;
    const pa = path(mergeChains(rc, strong));
    ctx.strokeStyle = 'rgba(40,12,0,0.7)';
    ctx.lineWidth = 8 * S;
    ctx.stroke(pa);
    ctx.shadowColor = 'rgba(255,190,60,0.95)';
    ctx.shadowBlur = 8 * S;
    ctx.strokeStyle = 'rgba(255,200,70,1)';
    ctx.lineWidth = 3.8 * S;
    ctx.stroke(pa);
    ctx.shadowBlur = 0;
  }
  // 事发地(没有事发州就是相关国家)在屏幕上很小:外面套一个圆圈。圆圈按屏幕大小定,放大后不会大得离谱
  const b = highlightBox(world, civ, marks);
  const k = Math.max(1, zoom);
  if (b && Math.max(b[2] - b[0], b[3] - b[1]) * k < RING_BELOW * world.width) {
    const dx = b[2] - b[0];
    const dy = b[3] - b[1];
    const rad = Math.max(48 / k, Math.sqrt(dx * dx + dy * dy) / 2 + 24 / k) * S;
    ctx.beginPath();
    if (proj) {
      // 弯边投影:圆心投影过去,圆按画布大小画(挨着 ±180° 的在另一边再画一份)
      const mx = (b[0] + b[2]) / 2;
      const my = (b[1] + b[3]) / 2;
      const rel = proj.rel(mx);
      const K = proj.K(my);
      const cy = proj.Y(my) * S;
      for (const sh of relShifts(rel, rad / S / Math.max(1e-6, K))) {
        const cx = (proj.W / 2 + K * (rel + sh)) * S;
        ctx.moveTo(cx + rad, cy);
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      }
    } else {
      const cy = ((b[1] + b[3]) / 2) * S;
      // 挨着左右边的圆圈在另一边再画一份
      for (const sh of wrapShifts((b[0] + b[2]) / 2 - rad / S, (b[0] + b[2]) / 2 + rad / S, wrap)) {
        const cx = ((b[0] + b[2]) / 2 + sh) * S;
        ctx.moveTo(cx + rad, cy);
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      }
    }
    ctx.strokeStyle = 'rgba(40,12,0,0.6)';
    ctx.lineWidth = (7 / k) * S;
    ctx.stroke();
    ctx.shadowColor = 'rgba(255,190,60,0.95)';
    ctx.shadowBlur = (8 / k) * S;
    ctx.strokeStyle = 'rgba(255,200,70,1)';
    ctx.lineWidth = (3.2 / k) * S;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
  return marks;
}

/** 高亮的一道描边(地球仪每帧按投影画):线(世界坐标,平滑过)、颜色、线宽(世界单位)、光晕(世界单位 + 颜色) */
export interface HighlightStroke {
  lines: Polyline[];
  color: string;
  width: number;
  blur?: number;
  glow?: string;
}

/**
 * 地球仪用:高亮的描边(和 drawHighlight 的第 2 步同样的线、颜色、线宽),罩染另画(drawHighlight 的 washOnly);
 * 事发地在屏幕上很小时的圆圈由地球仪按屏幕大小画(ring = 圆圈的颜色)。什么都没亮 = []
 */
export function highlightStrokes(world: World, civ: Civ, hl: CivHighlight, style: CivStyle): { strokes: HighlightStroke[]; ring: [string, string, string] } {
  const { marks, group } = marksAndGroups(civ, hl);
  const look = LOOK[style === 'fantasy' ? 'ink' : 'light'];
  const out: HighlightStroke[] = [];
  const ring: [string, string, string] = ['rgba(40,12,0,0.6)', 'rgba(255,200,70,1)', 'rgba(255,190,60,0.95)'];
  if (!marks.some((m) => m)) return { strokes: out, ring };
  const rc = regionChains(world.mesh, civ);
  const smooth = (lines: SidedLine[]) => lines.map((l) => chaikin(l, 2));
  if (marks.some((m) => m === 1)) {
    const lines = smooth(mergeChains(rc, group));
    const [under, line, glow] = look.polLine;
    out.push({ lines, color: under, width: 7 }, { lines, color: line, width: 3.2, blur: 6, glow });
  }
  if (marks.some((m) => m === 2)) {
    const strong = new Int32Array(marks.length);
    for (let r = 0; r < marks.length; r++) strong[r] = marks[r] === 2 ? 1 : 0;
    const lines = smooth(mergeChains(rc, strong));
    out.push({ lines, color: 'rgba(40,12,0,0.7)', width: 8 }, { lines, color: 'rgba(255,200,70,1)', width: 3.8, blur: 8, glow: 'rgba(255,190,60,0.95)' });
  }
  return { strokes: out, ring };
}

// ---------------------------------------------------------------------------
// 选中(阶段 4 点选):常亮、低调,不闪。国家 / 州画在和地图一样大的画布上(CivLayer 的 canvas.civ-sel),
// 城的圆环、名字底下的光晕画在文字层上(随缩放重画,放大后也细)

/** 选中的东西(和 ui/civView.ts 的 MapSelection 同形) */
export interface SelectionTarget {
  kind: 'polity' | 'region' | 'settlement' | 'place';
  id: number;
}

/** 两种画法:写实 / 数据图层上用暖白,手绘羊皮纸上用朱砂(旧地图上圈地的红线)。fill = 罩染 RGBA;line / ring = [垫底, 本色] */
const SEL_LOOK: Record<'light' | 'ink', { fill: RGBA; line: [string, string]; glow: string; band: string; ring: [string, string] }> = {
  light: {
    fill: [255, 244, 214, 44],
    line: ['rgba(18,12,6,0.5)', 'rgba(255,238,196,0.96)'],
    glow: 'rgba(255,222,140,0.62)',
    band: 'rgba(255,232,168,0.6)',
    ring: ['rgba(18,12,6,0.55)', 'rgba(255,236,190,1)'],
  },
  ink: {
    fill: [178, 40, 26, 22],
    line: ['rgba(255,248,228,0.75)', 'rgba(164,34,22,0.88)'],
    glow: 'rgba(212,70,40,0.34)',
    band: 'rgba(196,52,32,0.42)',
    ring: ['rgba(255,248,228,0.85)', 'rgba(164,34,22,0.95)'],
  },
};

let selOwners: ReturnType<typeof ownersAt> | undefined;

/**
 * 画选中的国家(year 这一年的国土)/ 州:淡淡的罩染 + 一道细描边;大河、山脉:沿河道 / 山脊一道淡光。
 * 城、别的地理实体在这层上不画(见 drawSelectionLabels)。zoom = 现在的缩放倍数(描边按它变细,放大后不粗)。
 * 返回亮了几个州
 */
export function drawSelection(
  ctx: CanvasRenderingContext2D,
  world: World,
  raster: Raster,
  civ: Civ,
  sel: SelectionTarget | null,
  year: Year,
  style: CivStyle = 'realistic',
  zoom = 1,
  /** 弯边投影(按投影重画):画布是地图平面,罩染按行重投影,描边逐点投影 */
  proj: Projector | null = null,
): number {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!sel) return 0;
  const look = SEL_LOOK[style === 'fantasy' ? 'ink' : 'light'];
  const { w, h, scale: S } = raster;
  const thin = 1 / Math.sqrt(Math.max(1, zoom));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const wrap = meshWrap(world.mesh);
  const pv = { s: S, ox: 0, oy: 0 };
  if (proj && sel.kind === 'place') clipOutline(ctx, proj.mp, pv);
  if (sel.kind === 'place') {
    const p = civ.places[sel.id];
    if (p && (p.kind === 'river' || p.kind === 'mountains') && p.path.length >= 4) {
      const pa = new Path2D();
      // 路径的 x 展开成连续的,伸出主图左右边的在另一边再画一份
      const q = Float32Array.from(p.path.length & 1 ? p.path.slice(0, -1) : p.path);
      unwrapLine(q, wrap);
      addToPath(pa, [{ pts: q, closed: false }], S, wrap, proj);
      ctx.shadowColor = look.band;
      ctx.shadowBlur = 8 * S * thin;
      ctx.strokeStyle = look.band;
      ctx.lineWidth = (p.kind === 'river' ? 5 : 8) * S * thin;
      ctx.stroke(pa);
    }
    ctx.restore();
    return 0;
  }
  if (sel.kind !== 'polity' && sel.kind !== 'region') {
    ctx.restore();
    return 0;
  }
  const R = civ.regions.count;
  const group = new Int32Array(R).fill(-1);
  let lit = 0;
  if (sel.kind === 'region') {
    if (sel.id >= 0 && sel.id < R) {
      group[sel.id] = 1;
      lit = 1;
    }
  } else {
    selOwners = ownersAt(civ, year, selOwners);
    for (let r = 0; r < R; r++) {
      if (selOwners.polity[r] !== sel.id) continue;
      group[r] = 1;
      lit++;
    }
  }
  if (!lit) {
    ctx.restore();
    return 0;
  }
  // 罩染(半分辨率)
  const pix = pixOf(world, raster, civ);
  const f = 2;
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const img = new ImageData(W, H);
  const d = img.data;
  const c = look.fill;
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, y * f + 1) * w;
    for (let x = 0; x < W; x++) {
      const r = pix[row + Math.min(w - 1, x * f + 1)];
      if (r < 0 || group[r] !== 1) continue;
      const o = (y * W + x) * 4;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = c[3];
    }
  }
  const buf =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
  (buf.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (proj) {
    reprojectImage(ctx, buf, W, H, proj.mp, pv);
    clipOutline(ctx, proj.mp, pv);
  } else ctx.drawImage(buf, 0, 0, w, h);
  // 描边(沿州界,只描陆地之间;海岸那一侧靠罩染看出来)
  const pa = new Path2D();
  addToPath(
    pa,
    mergeChains(regionChains(world.mesh, civ), group).map((l) => chaikin(l, 2)),
    S,
    wrap,
    proj,
  );
  ctx.strokeStyle = look.line[0];
  ctx.lineWidth = 4.2 * S * thin;
  ctx.stroke(pa);
  ctx.strokeStyle = look.line[1];
  ctx.lineWidth = 1.8 * S * thin;
  ctx.stroke(pa);
  ctx.restore();
  return lit;
}

/**
 * 文字层上的选中记号(画在城镇符号、文字之前,字压在上面):
 * 选中的东西的名字 —— 每个字底下一团淡淡的光晕;选中的城 —— 符号外一圈细环
 * (符号这时没画出来,比如缩放不够、被别的字挤掉,就画在 at 处:它在画布上的位置)。
 * 名字旁边不画线:国名字距拉得很开(竖排时从北到南跨过整片国土),旁边的一道细线看上去像一条画错的国界
 */
export function drawSelectionLabels(
  ctx: CanvasRenderingContext2D,
  placed: Placement,
  view: LabelView,
  sel: SelectionTarget | null,
  style: CivStyle = 'realistic',
  at?: [number, number] | null,
): void {
  if (!sel || sel.kind === 'region') return;
  const look = SEL_LOOK[style === 'fantasy' ? 'ink' : 'light'];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const l of placed.labels) {
    const pk = l.item.pick;
    if (!pk || pk.kind !== sel.kind || pk.id !== sel.id) continue;
    ctx.globalAlpha = l.alpha;
    // 光晕
    ctx.fillStyle = look.glow;
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = l.px * 0.5;
    const pa = new Path2D();
    for (const g of l.glyphs) {
      const r = l.px * 0.62;
      pa.moveTo(g.x + r, g.y);
      pa.arc(g.x, g.y, r, 0, Math.PI * 2);
    }
    ctx.fill(pa);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
  // 城:符号外一圈细环
  if (sel.kind === 'settlement') {
    let cx = NaN;
    let cy = NaN;
    let rad = 0;
    for (const m of placed.marks) {
      if (m.mark.id !== sel.id) continue;
      const b = m.mark.box;
      cx = m.x;
      cy = m.y;
      rad = Math.max(b[0], b[1], b[2], b[3]) * m.s;
      break;
    }
    if (!(cx === cx) && at) {
      [cx, cy] = at;
      rad = 3 * view.dpr;
    }
    if (cx === cx) {
      const r = rad + 3.5 * view.dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = look.ring[0];
      ctx.lineWidth = 3.6 * view.dpr;
      ctx.stroke();
      ctx.strokeStyle = look.ring[1];
      ctx.lineWidth = 1.6 * view.dpr;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 地球仪用(render/globeLines.ts):选中的罩染画在贴图里,描边 / 淡光按屏幕逐帧画成矢量线

/** 选中的颜色(罩染、描边、名字底下的光晕、城外的细环) */
export function selectionLook(style: CivStyle): (typeof SEL_LOOK)['light'] {
  return SEL_LOOK[style === 'fantasy' ? 'ink' : 'light'];
}

/** 选中的国家(year 这一年)/ 州 → 每州的分组(亮 = 1,不亮 = −1)和亮了几个州;别的东西、一个州都没亮 = null */
function selectionGroup(civ: Civ, sel: SelectionTarget, year: Year): { group: Int32Array; lit: number } | null {
  if (sel.kind !== 'polity' && sel.kind !== 'region') return null;
  const R = civ.regions.count;
  const group = new Int32Array(R).fill(-1);
  let lit = 0;
  if (sel.kind === 'region') {
    if (sel.id >= 0 && sel.id < R) {
      group[sel.id] = 1;
      lit = 1;
    }
  } else {
    selOwners = ownersAt(civ, year, selOwners);
    for (let r = 0; r < R; r++) {
      if (selOwners.polity[r] !== sel.id) continue;
      group[r] = 1;
      lit++;
    }
  }
  return lit ? { group, lit } : null;
}

/**
 * 选中的东西在地图上的线(世界坐标,x 已展开):
 *   outline —— 国家 / 州的描边(沿州界,只描陆地之间;和 drawSelection 的描边是同一条线)
 *   band    —— 大河、山脉沿河道 / 山脊的一道淡光(width = 主图上的线宽,世界单位)
 * 城、别的地理实体没有线 = null
 */
export function selectionLines(
  world: World,
  civ: Civ,
  sel: SelectionTarget | null,
  year: Year,
): { kind: 'outline'; lines: Polyline[] } | { kind: 'band'; lines: Polyline[]; width: number } | null {
  if (!sel) return null;
  if (sel.kind === 'place') {
    const p = civ.places[sel.id];
    if (!p || (p.kind !== 'river' && p.kind !== 'mountains') || p.path.length < 4) return null;
    const q = Float32Array.from(p.path.length & 1 ? p.path.slice(0, -1) : p.path);
    unwrapLine(q, meshWrap(world.mesh));
    return { kind: 'band', lines: [{ pts: q, closed: false }], width: p.kind === 'river' ? 5 : 8 };
  }
  const g = selectionGroup(civ, sel, year);
  if (!g) return null;
  return { kind: 'outline', lines: mergeChains(regionChains(world.mesh, civ), g.group).map((l) => chaikin(l, 2)) };
}

/** 只画选中的国家 / 州的罩染(不描边,描边见 selectionLines)。画布大小 = raster.w × raster.h。返回亮了几个州 */
export function drawSelectionWash(
  ctx: CanvasRenderingContext2D,
  world: World,
  raster: Raster,
  civ: Civ,
  sel: SelectionTarget | null,
  year: Year,
  style: CivStyle = 'realistic',
): number {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const g = sel ? selectionGroup(civ, sel, year) : null;
  if (!g) return 0;
  const { group } = g;
  const c = selectionLook(style).fill;
  const { w, h } = raster;
  const pix = pixOf(world, raster, civ);
  const f = 2;
  const W = Math.ceil(w / f);
  const H = Math.ceil(h / f);
  const img = new ImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, y * f + 1) * w;
    for (let x = 0; x < W; x++) {
      const r = pix[row + Math.min(w - 1, x * f + 1)];
      if (r < 0 || group[r] !== 1) continue;
      const o = (y * W + x) * 4;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = c[3];
    }
  }
  const buf =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
  (buf.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, 0, 0, w, h);
  ctx.restore();
  return g.lit;
}
