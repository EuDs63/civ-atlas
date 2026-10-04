/**
 * 文明叠加层 · 战事:地图上画出正在打的仗。数据全是推演记下的史事(civ.annals:宣战、攻占、战役、洗劫、议和、亡国),不改推演。
 *
 *   - 战线:交战两国相接的国界,红线 + 朝守方的短齿(军事地图上阵线的画法)
 *   - 易手的州:这场仗里被攻占过的州画红色斜线;仗打完(议和、一方亡国)就收掉
 *   - 双剑:这场仗里每一仗(攻占、没打下来的战役、洗劫)的地方;越早的越淡,仗打完以后 AFTER 年淡完。
 *     没放大时每场仗只画最近的一仗,放大后画每一仗
 *
 * 斜线是"面",和国土色块一样画在文明底图上(drawWarHatch;地球仪画进文明贴图);
 * 战线、双剑画在文字层上(drawWarfare:按画布像素画成矢量,放大后依然清晰),地球仪上每帧按正射投影画(globeLines.ts)。
 * 大小按世界单位定(缩放 1 倍时和国界同一把尺);放大以后线宽按 k^LINE_GROW、齿距按 k、双剑按 k^SWORD_GROW 长
 * (放大 3 倍时线宽 2 倍、齿距 3 倍、双剑约 1.46 倍):战线盖得住一起放大的国界,双剑不会大得离谱。
 * 只在开着"国家"和"战事"时画。
 */
import type { Civ, Year } from '../../gen/civ/types';
import { Layer } from '../../gen/civ/types';
import { borderLines, type SidedLine } from './borders';
import { pixOf } from './highlight';
import type { Polyline } from './lines';
import type { CivDrawParams, CivStyle } from './overlay';
import { toCanvas, type LabelView } from '../labels/draw';
import { clipOutline, projectLinePts, reprojectImage, type Projector } from '../projection';

// ---------------------------------------------------------------------------
// 1. 数据:按史事整理每一场战争

/** 一仗:哪一年、在哪个州 */
export interface Fight {
  year: Year;
  region: number;
}

/** 一场战争 */
export interface WarSpan {
  id: number;
  /** 攻方、守方(国家编号) */
  atk: number;
  def: number;
  start: Year;
  /** 打完的那一刻(议和、一方亡国或不在了);还在打 = Infinity */
  end: Year;
  /** 每一仗(按时间排):攻占、没打下来的战役、洗劫;议和时割让、亡国时残部一并归过去的不算 */
  fights: Fight[];
  /** 打下来(换了主人)的州 */
  taken: Fight[];
}

const spanCache = new WeakMap<Civ, WarSpan[]>();

/** 这个世界里所有的战争(按宣战先后) */
export function warSpans(civ: Civ): WarSpan[] {
  const hit = spanCache.get(civ);
  if (hit) return hit;
  const A = civ.annals;
  // 不是打出来的攻占:议和时划界割让的(peace 的 region = 紧挨在它前面的几条)、
  // 丢了国都撑不下去、残部一并归攻方的(亡国前同一刻连着的几条攻占,最早的那条是打下国都的那一仗,算)
  const notFought = new Set<number>();
  for (let i = 0; i < A.length; i++) {
    const e = A[i];
    if (e.kind === 'peace' && e.region > 0) {
      for (let j = Math.max(0, i - e.region); j < i; j++) if (A[j].kind === 'conquer' && A[j].war === e.war) notFought.add(j);
    } else if (e.kind === 'fall' && e.war >= 0) {
      const run: number[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const c = A[j];
        if (c.kind !== 'conquer' || c.war !== e.war || c.year !== e.year || c.a !== e.b || c.b !== e.a) break;
        run.push(j);
      }
      run.pop();
      for (const j of run) notFought.add(j);
    }
  }
  const byId = new Map<number, WarSpan>();
  const out: WarSpan[] = [];
  for (let i = 0; i < A.length; i++) {
    const e = A[i];
    if (e.war < 0) continue;
    if (e.kind === 'war') {
      if (byId.has(e.war)) continue;
      const w: WarSpan = { id: e.war, atk: e.a, def: e.b, start: e.year, end: Infinity, fights: [], taken: [] };
      byId.set(e.war, w);
      out.push(w);
      continue;
    }
    const w = byId.get(e.war);
    if (!w) continue;
    if (e.kind === 'peace') w.end = Math.min(w.end, e.year);
    else if (e.kind === 'fall' && (e.a === w.atk || e.a === w.def)) w.end = Math.min(w.end, e.year);
    else if ((e.kind === 'conquer' || e.kind === 'battle' || e.kind === 'sack') && e.region >= 0) {
      if (e.kind === 'conquer') w.taken.push({ year: e.year, region: e.region });
      if (notFought.has(i)) continue;
      // 洗劫和攻占同一刻记在同一个州:算一仗
      const last = w.fights[w.fights.length - 1];
      if (last && last.region === e.region && Math.abs(last.year - e.year) <= 0.5) continue;
      w.fights.push({ year: e.year, region: e.region });
    }
  }
  // 交战的一方在别的事里不在了(并入、分裂……),仗也就打完了
  for (const w of out) {
    for (const id of [w.atk, w.def]) {
      const ended = civ.polities[id]?.ended;
      if (ended !== undefined && ended < w.end) w.end = Math.max(w.start, ended);
    }
  }
  spanCache.set(civ, out);
  return out;
}

/** 双剑:哪场仗、哪个州、多浓、是不是这场仗到这一年最近的一仗 */
export interface WarMark {
  war: number;
  region: number;
  alpha: number;
  latest: boolean;
}

/** 某一年地图上的战事 */
export interface WarScene {
  year: Year;
  /** 正在打的仗 */
  live: WarSpan[];
  /** 正在打的仗里易手过的州(从小到大) */
  taken: number[];
  /** 双剑(正在打的仗、刚打完还没淡完的仗) */
  marks: WarMark[];
}

/** 仗打完以后,双剑多少年淡完 */
export const AFTER = 12;
/** 一仗过去多少年以内最浓、多少年以内次一档 */
const FRESH = 6;
const RECENT = 20;

const sceneCache = new WeakMap<Civ, WarScene>();

/** 某一年的战事(按 civ 缓存最近的一年:回放时每帧一年,画底图、文字层、地球仪共用) */
export function warScene(civ: Civ, year: Year): WarScene {
  const hit = sceneCache.get(civ);
  if (hit && hit.year === year) return hit;
  const live: WarSpan[] = [];
  const taken = new Set<number>();
  const marks: WarMark[] = [];
  for (const w of warSpans(civ)) {
    if (w.start > year || year >= w.end + AFTER) continue;
    const on = year < w.end;
    if (on) {
      live.push(w);
      for (const t of w.taken) if (t.year <= year) taken.add(t.region);
    }
    const fade = on ? 1 : 1 - (year - w.end) / AFTER;
    let n = 0;
    while (n < w.fights.length && w.fights[n].year <= year) n++;
    for (let i = 0; i < n; i++) {
      const f = w.fights[i];
      const age = year - f.year;
      marks.push({ war: w.id, region: f.region, alpha: (age < FRESH ? 1 : age < RECENT ? 0.75 : 0.5) * fade, latest: i === n - 1 });
    }
  }
  const scene: WarScene = { year, live, taken: [...taken].sort((a, b) => a - b), marks };
  sceneCache.set(civ, scene);
  return scene;
}

/** 开着"国家"和"战事" */
export function warsShown(p: CivDrawParams): boolean {
  return !!p.show.polities && !!p.show.wars && p.civ.polities.length > 0;
}

const NO_LINES: Polyline[] = [];
const frontCache = new WeakMap<SidedLine[], { key: string; lines: Polyline[] }>();

/**
 * 战线:正在交战的两国相接的国界(borders.ts 的 borderLines,已平滑)。
 * 每条都排成"守方在左边"(画布上沿线前进方向的左手边,法线 (dy, −dx)),短齿统一朝左画。
 * borderLines 的 left / right 是按 y 朝上的坐标说的,画在 y 朝下的画布上左右正好反过来:守方是 right 的那条照原样,
 * 是 left 的倒过来
 */
export function warFront(p: CivDrawParams): Polyline[] {
  const scene = warScene(p.civ, p.year);
  if (!scene.live.length) return NO_LINES;
  const lines = borderLines(p, Layer.Polity);
  const key = scene.live.map((w) => w.id).join(',');
  const hit = frontCache.get(lines);
  if (hit && hit.key === key) return hit.lines;
  const out: Polyline[] = [];
  for (const l of lines) {
    if (l.left < 0 || l.right < 0) continue;
    const w = scene.live.find((w) => (l.left === w.atk && l.right === w.def) || (l.left === w.def && l.right === w.atk));
    if (!w) continue;
    if (l.right === w.def) out.push({ pts: l.pts, closed: l.closed });
    else {
      const n = l.pts.length >> 1;
      const r = new Float32Array(l.pts.length);
      for (let i = 0; i < n; i++) {
        r[2 * i] = l.pts[2 * (n - 1 - i)];
        r[2 * i + 1] = l.pts[2 * (n - 1 - i) + 1];
      }
      out.push({ pts: r, closed: l.closed });
    }
  }
  frontCache.set(lines, { key, lines: out });
  return out;
}

/** 放大到这个倍数起画每一仗(以下每场仗只画最近一仗) */
export const ALL_FIGHTS_K = 2;

/** 要画的双剑(世界坐标:州治所在的地块;同一个州只画最浓的那个) */
export function warMarkPoints(p: CivDrawParams, all: boolean): { x: number; y: number; alpha: number }[] {
  const scene = warScene(p.civ, p.year);
  const best = new Map<number, number>();
  for (const m of scene.marks) {
    if (!all && !m.latest) continue;
    if (m.alpha > (best.get(m.region) ?? 0)) best.set(m.region, m.alpha);
  }
  const { x, y } = p.world.mesh;
  const seat = p.civ.regions.seat;
  const out: { x: number; y: number; alpha: number }[] = [];
  for (const [r, a] of best) {
    const c = seat[r];
    if (c >= 0) out.push({ x: x[c], y: y[c], alpha: a });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 画法

/** 线宽、齿距、双剑大小(世界单位,缩放 1 倍时;画的时候 × 一个世界单位是几个画布像素) */
export const WAR_SIZE = {
  /** 战线:垫底的纸色、红线 */
  frontPaper: 8.4,
  front: 3.6,
  /** 短齿:间距、长度、垫底、红线 */
  toothStep: 6.5,
  toothLen: 3.45,
  toothPaper: 5.4,
  tooth: 1.95,
  /** 双剑的半长 */
  sword: 7,
  /** 斜线:线宽、间距(画在文明底图上,和国土色块一起随地图放大) */
  hatch: 1.1,
  hatchGap: 4.2,
};
/** 放大 k 倍时线宽、齿长 × k^LINE_GROW(3 倍时 2 倍);齿距 × k */
const LINE_GROW = Math.log(2) / Math.log(3);
/** 放大 k 倍时双剑 × k^SWORD_GROW(3 倍时约 1.46 倍) */
const SWORD_GROW = Math.log(10.2 / 7) / Math.log(3);
/** 双剑至少这么大(半长,CSS 像素):手机上没放大时也认得出 */
const SWORD_MIN_CSS = 2.5;

/** 颜色:和编年史、时间轴里"战争"同一个红(手绘风略偏朱砂);底下垫一道纸色,压在深色树林上也看得清 */
export function warLook(style: CivStyle): { red: string; paper: string; hatch: string } {
  const fantasy = style === 'fantasy';
  const c = fantasy ? '168,38,26' : '196,40,32';
  return {
    red: `rgba(${c},0.95)`,
    paper: fantasy ? 'rgba(250,242,222,0.85)' : 'rgba(255,255,255,0.9)',
    hatch: `rgba(${c},${fantasy ? 0.5 : 0.55})`,
  };
}

/** 只要 moveTo / lineTo(Path2D、单测里的记录器都行) */
export interface WarPathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

/**
 * 沿一条折线(画布像素,x, y 交错)每隔 step 画一个短齿,朝前进方向的左边伸出 len(画布 y 朝下:左边 = (dy, −dx))。
 * 第一个齿在 step / 2 处
 */
export function frontTeeth(sink: WarPathSink, pts: ArrayLike<number>, step: number, len: number): void {
  const n = pts.length >> 1;
  if (n < 2 || !(step > 0)) return;
  let acc = step / 2;
  for (let j = 1; j < n; j++) {
    const x0 = pts[2 * j - 2];
    const y0 = pts[2 * j - 1];
    const dx = pts[2 * j] - x0;
    const dy = pts[2 * j + 1] - y0;
    const sl = Math.sqrt(dx * dx + dy * dy);
    if (!(sl > 0)) continue;
    const nx = (dy / sl) * len;
    const ny = (-dx / sl) * len;
    while (acc <= sl) {
      const t = acc / sl;
      const x = x0 + dx * t;
      const y = y0 + dy * t;
      sink.moveTo(x, y);
      sink.lineTo(x + nx, y + ny);
      acc += step;
    }
    acc -= sl;
  }
}

/**
 * 画战线(画布像素的折线):纸色垫底 → 红线 → 短齿(同样先垫纸色)。
 * u = 线宽、齿长的单位,step = 齿距的单位(都是"一个世界单位是几个画布像素",见 LINE_GROW)
 */
export function strokeFront(ctx: CanvasRenderingContext2D, polys: readonly ArrayLike<number>[], u: number, step: number, style: CivStyle, lineToo = true): void {
  if (!polys.length) return;
  const look = warLook(style);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (lineToo) {
    const line = new Path2D();
    for (const p of polys) {
      if (p.length < 4) continue;
      line.moveTo(p[0], p[1]);
      for (let i = 2; i + 1 < p.length; i += 2) line.lineTo(p[i], p[i + 1]);
    }
    ctx.strokeStyle = look.paper;
    ctx.lineWidth = WAR_SIZE.frontPaper * u;
    ctx.stroke(line);
    ctx.strokeStyle = look.red;
    ctx.lineWidth = WAR_SIZE.front * u;
    ctx.stroke(line);
  }
  const teeth = new Path2D();
  for (const p of polys) frontTeeth(teeth, p, WAR_SIZE.toothStep * step, WAR_SIZE.toothLen * u);
  ctx.strokeStyle = look.paper;
  ctx.lineWidth = WAR_SIZE.toothPaper * u;
  ctx.stroke(teeth);
  ctx.strokeStyle = look.red;
  ctx.lineWidth = WAR_SIZE.tooth * u;
  ctx.stroke(teeth);
  ctx.restore();
}

/** 双剑(两把剑交叉,剑柄在下):x, y = 中心,h = 半长(画布像素),a = 不透明度 */
export function drawSwords(ctx: CanvasRenderingContext2D, swords: readonly { x: number; y: number; h: number; a: number }[], style: CivStyle): void {
  if (!swords.length) return;
  const look = warLook(style);
  ctx.save();
  ctx.lineCap = 'round';
  for (const { x, y, h, a } of swords) {
    const pa = new Path2D();
    for (const s of [1, -1]) {
      // 剑身:从左下(右下)到右上(左上)
      const x0 = x - s * h;
      const y0 = y + h;
      const x1 = x + s * h;
      const y1 = y - h;
      pa.moveTo(x0, y0);
      pa.lineTo(x1, y1);
      // 护手:离剑柄 28% 处,垂直剑身
      const gx = x0 + (x1 - x0) * 0.28;
      const gy = y0 + (y1 - y0) * 0.28;
      const g = h * 0.42 * Math.SQRT1_2;
      pa.moveTo(gx - g, gy - s * g);
      pa.lineTo(gx + g, gy + s * g);
    }
    ctx.globalAlpha = a;
    ctx.strokeStyle = look.paper;
    ctx.lineWidth = h * 0.95;
    ctx.stroke(pa);
    ctx.strokeStyle = look.red;
    ctx.lineWidth = h * 0.42;
    ctx.stroke(pa);
  }
  ctx.restore();
}

/** 双剑的半长(画布像素):u = 缩放 1 倍时一个世界单位是几个画布像素,k = 缩放倍数 */
export function swordHalf(u: number, k: number, dpr: number): number {
  return Math.max(SWORD_MIN_CSS * dpr, WAR_SIZE.sword * u * Math.max(1, k) ** SWORD_GROW);
}

/** 东西相连的主图:世界 x 在 [lo, hi] 的东西挪几圈落在画布里(视口展开,见 LabelView.wrap) */
function shiftsIn(lo: number, hi: number, lv: LabelView, pad: number): number[] {
  const P = lv.proj ? 0 : (lv.wrap ?? 0);
  if (!P) return [0];
  const cw = lv.canvasW;
  if (cw === undefined) return [-P, 0, P];
  const out: number[] = [];
  const n0 = Math.ceil(((-pad - lv.ox) / lv.scale - hi) / P);
  const n1 = Math.floor(((cw + pad - lv.ox) / lv.scale - lo) / P);
  for (let n = n0; n <= n1; n++) out.push(n * P);
  return out;
}

/**
 * 战线、双剑画在文字层上(画布像素;CivLayer 的文字层、导出图片的文字那一步)。
 * pj = 弯边投影(和 lv.proj 同一个投影;不出外轮廓)。返回画了几段战线、几个双剑
 */
export function drawWarfare(ctx: CanvasRenderingContext2D, p: CivDrawParams, lv: LabelView, pj: Projector | null): { lines: number; marks: number } {
  const none = { lines: 0, marks: 0 };
  if (!warsShown(p)) return none;
  const scene = warScene(p.civ, p.year);
  if (!scene.live.length && !scene.marks.length) return none;
  // 缩放 1 倍时一个世界单位是几个画布像素
  const k = Math.max(1, lv.k);
  const u1 = lv.scale / k;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (pj) clipOutline(ctx, pj.mp, { s: lv.scale, ox: lv.ox, oy: lv.oy });
  // 战线:折线换成画布像素(弯边投影逐点投影;等距圆柱伸出画布的在另一圈再画一份)
  const polys: ArrayLike<number>[] = [];
  const u = u1 * k ** LINE_GROW;
  const pad = WAR_SIZE.frontPaper * u + 2;
  for (const l of warFront(p)) {
    const P = l.pts;
    if (pj) {
      polys.push(...projectLinePts(P, 2, pj, { s: lv.scale, ox: lv.ox, oy: lv.oy }));
      continue;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < P.length; i += 2) {
      if (P[i] < lo) lo = P[i];
      if (P[i] > hi) hi = P[i];
    }
    for (const sh of shiftsIn(lo, hi, lv, pad)) {
      const out = new Float64Array(P.length);
      for (let i = 0; i < P.length; i += 2) {
        out[i] = (P[i] + sh) * lv.scale + lv.ox;
        out[i + 1] = P[i + 1] * lv.scale + lv.oy;
      }
      polys.push(out);
    }
  }
  strokeFront(ctx, polys, u, u1 * k, p.style);
  // 双剑:州治往右上挪一点(不压城镇符号)
  const h = swordHalf(u1, k, lv.dpr);
  const swords: { x: number; y: number; h: number; a: number }[] = [];
  for (const m of warMarkPoints(p, lv.k >= ALL_FIGHTS_K)) {
    const shifts = pj ? [0] : shiftsIn(m.x, m.x, lv, 3 * h);
    for (const sh of shifts) {
      const [x, y] = toCanvas(lv, m.x + sh, m.y);
      const cx = x + 0.9 * h;
      const cy = y - 0.9 * h;
      if (lv.canvasW !== undefined && (cx < -2 * h || cx > lv.canvasW + 2 * h)) continue;
      if (lv.canvasH !== undefined && (cy < -2 * h || cy > lv.canvasH + 2 * h)) continue;
      swords.push({ x: cx, y: cy, h, a: m.alpha });
    }
  }
  drawSwords(ctx, swords, p.style);
  ctx.restore();
  return { lines: polys.length, marks: swords.length };
}

// ---------------------------------------------------------------------------
// 3. 易手的州:斜线(画在文明底图 / 地球仪的文明贴图上)

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
const hatchCache = new WeakMap<Civ, { raster: unknown; key: string; canvas: AnyCanvas }>();

function makeCanvas(w: number, h: number): AnyCanvas {
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/**
 * 易手的州画斜线(和国土色块一样是"面",画布 = raster.w × raster.h;弯边投影按行重投影)。
 * 范围按半分辨率的像素算(和编年史高亮一样),斜线按全分辨率画;州没变就用上次画好的
 */
export function drawWarHatch(ctx: CanvasRenderingContext2D, p: CivDrawParams): void {
  if (!warsShown(p)) return;
  const { taken } = warScene(p.civ, p.year);
  if (!taken.length) return;
  const { raster, civ, world } = p;
  const { w, h, scale: S } = raster;
  const key = `${p.style}|${taken.join(',')}`;
  let hit = hatchCache.get(civ);
  if (!hit || hit.raster !== raster || hit.key !== key) {
    const pix = pixOf(world, raster, civ);
    const set = new Uint8Array(civ.regions.count);
    for (const r of taken) set[r] = 1;
    const f = 2;
    const W = Math.ceil(w / f);
    const H = Math.ceil(h / f);
    const img = new ImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const row = Math.min(h - 1, y * f + 1) * w;
      for (let x = 0; x < W; x++) {
        const r = pix[row + Math.min(w - 1, x * f + 1)];
        if (r >= 0 && set[r]) d[(y * W + x) * 4 + 3] = 255;
      }
    }
    const mask = makeCanvas(W, H);
    (mask.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
    const canvas = hit && hit.raster === raster ? hit.canvas : makeCanvas(w, h);
    const hx = canvas.getContext('2d') as CanvasRenderingContext2D;
    hx.globalCompositeOperation = 'source-over';
    hx.clearRect(0, 0, w, h);
    hx.strokeStyle = warLook(p.style).hatch;
    hx.lineWidth = WAR_SIZE.hatch * S;
    const gap = WAR_SIZE.hatchGap * S;
    hx.beginPath();
    for (let x = -h; x < w; x += gap) {
      hx.moveTo(x, h);
      hx.lineTo(x + h, 0);
    }
    hx.stroke();
    hx.globalCompositeOperation = 'destination-in';
    hx.imageSmoothingEnabled = true;
    hx.drawImage(mask, 0, 0, w, h);
    hx.globalCompositeOperation = 'source-over';
    hit = { raster, key, canvas };
    hatchCache.set(civ, hit);
  }
  if (p.proj) reprojectImage(ctx, hit.canvas, w, h, p.proj.mp, { s: S, ox: 0, oy: 0 });
  else ctx.drawImage(hit.canvas, 0, 0);
}
