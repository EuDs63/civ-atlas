/**
 * 作者的人物一生的足迹(要画什么由 ui/characterInfo.ts 的 characterTrail 算好):屏幕上的人物层(ui/CharacterLayer.tsx)和导出的地图图片共用。
 *
 * - 去过的地方按先后连起来,每段稍微弯一点(看得出是走过去的,不像国界):控制点在两头中点往旁边挪段长的 0.14
 * - 走过的一段:白边 6 像素 + 人物颜色的实线 3 像素;还没走到的:白边 5 像素 + 虚线 2.5 像素(7 实 6 空,淡一些)
 * - 每处一个白底圆点(半径 6,人物颜色的圈 3 像素;还没到的圈淡一些);旁边写年份("2490、2561";州后面写州名),
 *   先放右边,压着地图上的字、别的年份、按钮面板就换左边、下边、上边;还没到的年份写浅灰
 * - 头像:那一年他在的那一处,白边圆形头像(名字的第一个字,直径 36)带一个朝下的小尖角(和「查找」里的人一样);
 *   正在挑地方时是半透明的小一号头像
 *
 * 位置都是世界坐标;画的时候经 MarkFrame.pt 换到画布上(平面主图左右相连、弯边投影、地球仪、导出各给各的)。只算、只往给定的画布上画,不碰 DOM。
 */
import { MARK_FONT, type MarkFrame, type Measure } from './marks';

/** 一处落脚的地方 */
export interface TrailStop {
  /** 世界坐标 */
  at: [number, number];
  /** 旁边写的字:"2490、2561" / "2506、2511 赤云泽" */
  label: string;
  /** 还没走到(时间轴那一年以后才去):圈和年份淡一些 */
  future: boolean;
}

/** 一段路:从第 a 处到第 b 处 */
export interface TrailSeg {
  a: number;
  b: number;
  /** 还没走(虚线) */
  future: boolean;
}

export interface TrailInput {
  /** 人物的颜色 */
  color: string;
  /** 头像上的字 */
  avatar: string;
  stops: TrailStop[];
  segs: TrailSeg[];
  /** 头像停在第几处(−1 = 不画:出生前、去世后) */
  pin: number;
  /** 半透明的头像(正在挑的那一处,世界坐标);没有 = null */
  ghost?: [number, number] | null;
}

export type TrailSide = 'r' | 'l' | 'b' | 't';

export interface PlacedTrail {
  color: string;
  avatar: string;
  /** 一段段弯线(画布坐标):起点、控制点、终点 */
  segs: { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number; future: boolean }[];
  dots: { x: number; y: number; future: boolean }[];
  labels: { text: string; x: number; y: number; side: TrailSide; w: number; future: boolean; box: [number, number, number, number] }[];
  /** 头像尖角的位置 */
  pins: { x: number; y: number }[];
  ghosts: { x: number; y: number }[];
}

/** 头像直径(平时 / 半透明的)、尖角高和宽、尖角离那一处的距离 */
export const AVATAR = 36;
export const AVATAR_GHOST = 32;
const TAIL = 8;
const TAIL_W = 12;
const LIFT = 4;
/** 年份的字号、行高 */
const YEAR_SIZE = 13;
const YEAR_LINE = 1.2;
/** 年份离圆点多远 */
const GAP_SIDE = 9;
const GAP_V = 8;
const DOT_R = 6;
const MARGIN = 60;

/** 头像圆心(尖角在 (x, y) 时;d = 直径) */
export function avatarCenter(x: number, y: number, d = AVATAR): [number, number] {
  return [x, y - LIFT - TAIL + 1 - d / 2];
}

const overlap = (a: readonly number[], b: readonly number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** 平面主图:把画布上的 x 挪整数圈,落到看得见的范围中间附近 */
function shiftOf(f: MarkFrame, x: number): number {
  if (!f.period) return 0;
  const c = (f.win[0] + f.win[1]) / 2;
  return f.period * Math.round((c - x) / f.period);
}

const roughMeasure: Measure = (t, size) => [...t].reduce((s, ch) => s + (ch.charCodeAt(0) < 0x2e80 ? 0.6 : 1), 0) * size;

/**
 * 摆好足迹:每处换到画布上,连线(平面主图左右相连:下一处挑离上一处近的那一圈;弯边投影跨了切口的一段不画);
 * 年份挑一边写(躲开 avoid = 地图上的字、按钮面板,和已经放了的年份、圆点、头像)
 */
export function layoutTrail(t: TrailInput, f: MarkFrame, opts: { measure?: Measure; avoid?: readonly number[][] } = {}): PlacedTrail {
  const measure = opts.measure ?? roughMeasure;
  const avoid = opts.avoid ?? [];
  const out: PlacedTrail = { color: t.color, avatar: t.avatar, segs: [], dots: [], labels: [], pins: [], ghosts: [] };
  const P = t.stops.map((s) => {
    const p = f.pt(s.at[0], s.at[1]);
    return p ? ([p[0] + shiftOf(f, p[0]), p[1]] as [number, number]) : null;
  });
  const shifts = f.period ? [-f.period, 0, f.period] : [0];
  const inWin = (x: number, y: number, m = MARGIN) => x >= f.win[0] - m && x <= f.win[1] + m && y >= -m && y <= f.h + m;
  // 线
  for (const s of t.segs) {
    const a = P[s.a];
    const b0 = P[s.b];
    if (!a || !b0) continue;
    const b: [number, number] = f.period ? [b0[0] + f.period * Math.round((a[0] - b0[0]) / f.period), b0[1]] : b0;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2 || (f.cut && len > f.cut)) continue;
    const cx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * 0.14;
    const cy = (a[1] + b[1]) / 2 + (b[0] - a[0]) * 0.14;
    for (const sh of shifts) {
      const x0 = Math.min(a[0], b[0], cx) + sh;
      const x1 = Math.max(a[0], b[0], cx) + sh;
      if (x1 < f.win[0] - MARGIN || x0 > f.win[1] + MARGIN) continue;
      out.segs.push({ x0: a[0] + sh, y0: a[1], cx: cx + sh, cy, x1: b[0] + sh, y1: b[1], future: s.future });
    }
  }
  // 圆点、头像(先占住地方,年份躲开它们)
  const taken: number[][] = [];
  const visible: { k: number; x: number; y: number }[] = [];
  P.forEach((p, k) => {
    if (!p) return;
    for (const sh of shifts) {
      const x = p[0] + sh;
      if (!inWin(x, p[1])) continue;
      out.dots.push({ x, y: p[1], future: t.stops[k].future });
      taken.push([x - DOT_R - 1, p[1] - DOT_R - 1, x + DOT_R + 1, p[1] + DOT_R + 1]);
      visible.push({ k, x, y: p[1] });
    }
  });
  const pinAt = (x: number, y: number, d: number, list: { x: number; y: number }[]) => {
    list.push({ x, y });
    const [cx, cy] = avatarCenter(x, y, d);
    // 圆和尖角分开占:年份可以紧挨着点写在尖角旁边
    taken.push([cx - d / 2 - 1, cy - d / 2 - 1, cx + d / 2 + 1, cy + d / 2 + 1], [x - TAIL_W / 2 - 1, cy + d / 2, x + TAIL_W / 2 + 1, y - LIFT + 1]);
  };
  const pp = t.pin >= 0 ? P[t.pin] : null;
  if (pp) for (const sh of shifts) if (inWin(pp[0] + sh, pp[1])) pinAt(pp[0] + sh, pp[1], AVATAR, out.pins);
  if (t.ghost) {
    const g = f.pt(t.ghost[0], t.ghost[1]);
    if (g) {
      const gx = g[0] + shiftOf(f, g[0]);
      for (const sh of shifts) if (inWin(gx + sh, g[1])) pinAt(gx + sh, g[1], AVATAR_GHOST, out.ghosts);
    }
  }
  // 年份
  const th = YEAR_SIZE * YEAR_LINE;
  for (const v of visible) {
    const s = t.stops[v.k];
    if (!s.label) continue;
    const w = measure(s.label, YEAR_SIZE);
    const { x, y } = v;
    const cand: { side: TrailSide; box: [number, number, number, number] }[] = [
      { side: 'r', box: [x + GAP_SIDE, y - th / 2, x + GAP_SIDE + w, y + th / 2] },
      { side: 'l', box: [x - GAP_SIDE - w, y - th / 2, x - GAP_SIDE, y + th / 2] },
      { side: 'b', box: [x - w / 2, y + GAP_V, x + w / 2, y + GAP_V + th] },
      { side: 't', box: [x - w / 2, y - GAP_V - th, x + w / 2, y - GAP_V] },
    ];
    const inside = (c: (typeof cand)[number]) => c.box[0] >= f.win[0] && c.box[2] <= f.win[1] && c.box[1] >= 0 && c.box[3] <= f.h;
    const fits = (c: (typeof cand)[number]) => inside(c) && !taken.some((b) => overlap(c.box, b));
    const clear = (c: (typeof cand)[number]) => fits(c) && !avoid.some((b) => overlap(c.box, b));
    const pick = cand.find(clear) ?? cand.find(fits) ?? cand.find(inside) ?? cand[0];
    taken.push(pick.box);
    out.labels.push({ text: s.label, x, y, side: pick.side, w, future: s.future, box: pick.box });
  }
  return out;
}

/** 画布坐标上这一点是不是点在头像上 */
export function hitTrailPin(p: PlacedTrail | null, x: number, y: number): boolean {
  if (!p) return false;
  return p.pins.some((q) => {
    const [cx, cy] = avatarCenter(q.x, q.y);
    return Math.hypot(x - cx, y - cy) <= AVATAR / 2 + 2 || (Math.abs(x - q.x) <= 7 && y >= cy && y <= q.y);
  });
}

type Ctx = CanvasRenderingContext2D;

const rgba = (hex: string, a: number) => {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
};

/** 一个头像:白边圆、名字的第一个字、朝下的尖角(尖在 (x, y − LIFT));d = 直径;alpha = 不透明度 */
export function drawAvatar(ctx: Ctx, x: number, y: number, color: string, text: string, d = AVATAR, alpha = 1) {
  const [cx, cy] = avatarCenter(x, y, d);
  const r = d / 2;
  const tip = y - LIFT;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const shape = new Path2D();
  shape.arc(cx, cy, r, 0, Math.PI * 2);
  shape.moveTo(x - TAIL_W / 2, tip - TAIL);
  shape.lineTo(x + TAIL_W / 2, tip - TAIL);
  shape.lineTo(x, tip);
  shape.closePath();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1.5;
  ctx.fillStyle = '#fff';
  ctx.fill(shape);
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(cx, cy, r - 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = `600 ${(d * 0.46).toFixed(2)}px ${MARK_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(text, cx, cy + 0.5);
  ctx.restore();
}

/** 把摆好的足迹画到画布上 */
export function drawTrail(ctx: Ctx, p: PlacedTrail) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const curve = (s: PlacedTrail['segs'][number]) => {
    ctx.beginPath();
    ctx.moveTo(s.x0, s.y0);
    ctx.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1);
    ctx.stroke();
  };
  // 白边先画(交叉的地方颜色线压在白边上)
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  for (const s of p.segs) {
    ctx.lineWidth = s.future ? 5 : 6;
    curve(s);
  }
  for (const s of p.segs) {
    ctx.strokeStyle = rgba(p.color, s.future ? 0.6 : 0.95);
    ctx.lineWidth = s.future ? 2.5 : 3;
    ctx.setLineDash(s.future ? [7, 6] : []);
    curve(s);
  }
  ctx.setLineDash([]);
  for (const d of p.dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, DOT_R, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = d.future ? rgba(p.color, 0.55) : p.color;
    ctx.stroke();
  }
  for (const l of p.labels) drawYear(ctx, l);
  for (const g of p.ghosts) drawAvatar(ctx, g.x, g.y, p.color, p.avatar, AVATAR_GHOST, 0.6);
  for (const q of p.pins) drawAvatar(ctx, q.x, q.y, p.color, p.avatar);
  ctx.restore();
}

/** 年份:白色光晕 + 深色字(还没到的浅灰、细一点) */
function drawYear(ctx: Ctx, l: PlacedTrail['labels'][number]) {
  ctx.save();
  ctx.font = `${l.future ? 500 : 600} ${YEAR_SIZE}px ${MARK_FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const x = l.box[0];
  const y = (l.box[1] + l.box[3]) / 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 4;
  ctx.strokeText(l.text, x, y);
  ctx.shadowBlur = 0;
  ctx.lineWidth = 3;
  ctx.strokeText(l.text, x, y);
  ctx.fillStyle = l.future ? '#8e8e93' : '#1d1d1f';
  ctx.fillText(l.text, x, y);
  ctx.restore();
}

/** 正在挑地方时跟着鼠标的半透明头像 + 十字(尖角对着鼠标) */
export function drawGhostAvatar(ctx: Ctx, x: number, y: number, color: string, text: string) {
  drawAvatar(ctx, x, y + LIFT, color, text, AVATAR_GHOST, 0.6);
  ctx.save();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(x - 9, y);
  ctx.lineTo(x + 9, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 9);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#1d1d1f';
  ctx.stroke();
  ctx.restore();
}
