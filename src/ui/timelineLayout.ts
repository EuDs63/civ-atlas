/**
 * 时间轴、最近事件、地图上的事件标签的纯计算部分:事件类型和配色、排刻度(太密就合并)、
 * 播放经过的大事、标签的淡入淡出和摆放、事发地在哪。
 * 不碰 DOM,单测直接测(tests/timeline-layout.test.ts);组件在 CivTimeline.tsx、TimelineMarks.tsx、
 * RecentEvents.tsx、EventPins.tsx。
 *
 * - 事件类型:史事种类(types.ts 的 AnnalKind)归成五类 + 干预,颜色用 CSS 变量(timeline.css 的 [data-ev=…]):
 *   战争(打仗、战役、攻占、议和、洗劫、毁城、灭亡)/ 改朝(改朝换代、君主继位、迁都、旧都衰落)/ 立国(立国、分裂自立、复国、重建)/
 *   称帝(升格、称帝、降格、合并)/ 同化(同化、迁徙、民族消亡)/ 干预(主色)。卡片上的类型名按一字标签细分("攻占""迁都"……)。
 * - 刻度:每条纪事一个小菱形(战争画在开战那年);挨得太近(DIAMOND_GAP 像素以内)合并成一个,
 *   颜色取其中分量最重的那一件,悬停列出每一件。干预单独一种"令"标记,不和菱形合并。
 */
import type { ChronicleEntry } from '../gen/civ/chronicle';
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import { capitalAt } from '../gen/civ/growth';
import { nearX, wrapOf } from '../render/common';

// ---------------------------------------------------------------------------
// 事件类型

/** 五类事件 + 干预(order);CSS 里 [data-ev=war] 等配色 */
export type EvType = 'war' | 'dynasty' | 'found' | 'empire' | 'assim' | 'order';

const KIND_TYPE: Readonly<Record<string, EvType>> = {
  war: 'war',
  battle: 'war',
  conquer: 'war',
  peace: 'war',
  sack: 'war',
  ruin: 'war',
  fall: 'war',
  dynasty: 'dynasty',
  reign: 'dynasty',
  capital: 'dynasty',
  decline: 'dynasty',
  found: 'found',
  split: 'found',
  rebuild: 'found',
  rank: 'empire',
  merge: 'empire',
  assimilate: 'assim',
  migrate: 'assim',
  vanish: 'assim',
  intervene: 'order',
};

/** 这条纪事归哪一类(不认识的种类算"改朝":蓝色,和普通链接一样不抢眼) */
export function evType(e: Pick<ChronicleEntry, 'kind'>): EvType {
  return KIND_TYPE[e.kind] ?? 'dynasty';
}

/** 一字标签 → 卡片上的类型名 */
const TAG_LABEL: Readonly<Record<string, string>> = {
  立: '立国',
  升: '升格',
  降: '衰微',
  战: '战争',
  役: '战役',
  占: '攻占',
  征: '征服',
  和: '议和',
  割: '割地',
  亡: '灭亡',
  迁: '迁都',
  分: '自立',
  复: '复国',
  合: '合并',
  朝: '改朝',
  嗣: '继位',
  徙: '迁徙',
  化: '同化',
  湮: '消亡',
  掠: '洗劫',
  毁: '毁城',
  建: '重建',
  衰: '衰落',
  干: '干预',
};

/** 卡片 / 最近事件 / 提示里的类型名:"战争""改朝""称帝"…… */
export function evLabel(e: Pick<ChronicleEntry, 'tag' | 'kind' | 'text'>): string {
  if (e.kind === 'rank' && e.text.includes('称帝')) return '称帝';
  if (e.kind === 'intervene') return '干预';
  return TAG_LABEL[e.tag] ?? '纪事';
}

/** 正文(干预的"【干预】"前缀去掉:类型名已经写了) */
export function evText(e: Pick<ChronicleEntry, 'text'>): string {
  return e.text.replace(/^【干预】/, '');
}

/** 年份:"2629 年";跨年的 "2940–2957 年";打到最后还没打完的 "2987 年起" */
export function evYears(e: Pick<ChronicleEntry, 'year' | 'end' | 'ongoing'>): string {
  const a = Math.floor(e.year);
  if (e.ongoing) return `${a} 年起`;
  const b = Math.floor(e.end);
  return b > a ? `${a}–${b} 年` : `${a} 年`;
}

/** 种类的分量:同一处挤了几件事时画哪一件的颜色。不认识的种类算中等 */
const KIND_WEIGHT: Readonly<Record<string, number>> = {
  fall: 6,
  split: 5,
  war: 5,
  dynasty: 5,
  found: 4,
  merge: 4,
  rank: 3,
  capital: 2,
  conquer: 1,
  peace: 0,
  vanish: 5,
  migrate: 3,
  assimilate: 1,
  ruin: 4,
  rebuild: 2,
  decline: 2,
  sack: 1,
  intervene: 9,
};

/** 一条纪事的分量(先看重要度,再看种类) */
export function entryWeight(e: ChronicleEntry): number {
  return e.importance * 10 + (KIND_WEIGHT[e.kind] ?? 3);
}

function heavier(a: ChronicleEntry, b: ChronicleEntry): ChronicleEntry {
  const d = entryWeight(b) - entryWeight(a);
  return d > 0 || (d === 0 && b.year < a.year) ? b : a;
}

// ---------------------------------------------------------------------------
// 播放

/** 1× / 4× 每秒走多少年 */
export const PLAY_RATE: Readonly<Record<1 | 4, number>> = { 1: 20, 4: 80 };
/** "回放世界形成"接着放文明:从第 0 年放到结束年份用几秒 */
export const STORY_SECONDS = 15;
/** 自动播放、放完再点播放:从结束年份往前这么多年放起(3000 年的世界 = 第 2600 年) */
export const REPLAY_SPAN = 400;

/** 自动播放 / 重播从哪一年起 */
export function replayStart(end: number): number {
  return Math.max(0, Math.floor(end - REPLAY_SPAN));
}

/** 年份在 (y0, y1] 里的条目(entries 按年份排好) */
export function crossed(entries: readonly ChronicleEntry[], y0: number, y1: number): ChronicleEntry[] {
  const out: ChronicleEntry[] = [];
  for (let i = countUpTo(entries, y0); i < entries.length && entries[i].year <= y1; i++) out.push(entries[i]);
  return out;
}

/** 年份 ≤ y 的条目有几条(entries 按年份排好;二分) */
export function countUpTo(entries: readonly ChronicleEntry[], y: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (entries[m].year <= y) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** 最近事件:到第 y 年为止(含)最近的 n 条,旧的在前 */
export function recentEntries(entries: readonly ChronicleEntry[], y: number, n = 4): ChronicleEntry[] {
  const k = countUpTo(entries, y);
  return entries.slice(Math.max(0, k - n), k);
}

// ---------------------------------------------------------------------------
// 刻度

/** 菱形挨得比这近(像素)就合并 */
export const DIAMOND_GAP = 8;
/** "令"标记挨得比这近(像素)就并成一个(字在竖线右边,约 14 像素宽) */
export const ORDER_GAP = 16;

export interface Diamond {
  /** 在刻度行里的位置(像素,0 = 第 0 年,width = 结束年份) */
  x: number;
  /** 画出来的颜色 / 点它跳到的那一件:分量最重的(一样重取先发生的) */
  lead: ChronicleEntry;
  /** 合并进来的每一件(按年份) */
  items: ChronicleEntry[];
}

export interface DiamondLayout {
  marks: Diamond[];
  /** 干预的"令"标记:挨得太近的并成一个,不和菱形合并 */
  orders: Diamond[];
}

/** 排刻度:entries 按年份排好(buildChronicle / filterChronicle 的顺序);width = 刻度行的像素宽 */
export function layoutDiamonds(entries: readonly ChronicleEntry[], end: number, width: number): DiamondLayout {
  const marks: Diamond[] = [];
  const orders: Diamond[] = [];
  if (!(end > 0) || !(width > 0)) return { marks, orders };
  const at = (y: number) => (Math.min(end, Math.max(0, y)) / end) * width;
  let cur: { sum: number; items: ChronicleEntry[]; lead: ChronicleEntry } | null = null;
  const flush = () => {
    if (cur) marks.push({ x: cur.sum / cur.items.length, lead: cur.lead, items: cur.items });
    cur = null;
  };
  for (const e of entries) {
    const x = at(e.year);
    if (e.kind === 'intervene') {
      const last = orders[orders.length - 1];
      if (last && x - last.x < ORDER_GAP) last.items.push(e);
      else orders.push({ x, lead: e, items: [e] });
      continue;
    }
    // 和正在攒的这一团的中心(平均位置)挨得太近就并进去:各团中心之间至少隔 DIAMOND_GAP
    if (cur && x - cur.sum / cur.items.length < DIAMOND_GAP) {
      cur.items.push(e);
      cur.sum += x;
      cur.lead = heavier(cur.lead, e);
    } else {
      flush();
      cur = { sum: x, items: [e], lead: e };
    }
  }
  flush();
  return { marks, orders };
}

/** 指针在刻度行的 x 处:先认"令"标记,再认最近的菱形;radius = 离多远以内算指到了(像素) */
export function hitDiamonds(layout: DiamondLayout, x: number, radius = 6): Diamond | null {
  const near = (list: Diamond[]) => {
    let best: Diamond | null = null;
    for (const d of list) if (Math.abs(d.x - x) <= radius && (!best || Math.abs(d.x - x) < Math.abs(best.x - x))) best = d;
    return best;
  };
  return near(layout.orders) ?? near(layout.marks);
}

// ---------------------------------------------------------------------------
// 地图上的事件标签

/** 一个标签停多久(毫秒,含淡入淡出) */
export const PIN_SHOW_MS = 3800;
/** 点最近事件 / 刻度跳过去时,那一件的标签停多久 */
export const PIN_JUMP_MS = 5000;
export const PIN_FADE_IN_MS = 200;
export const PIN_FADE_OUT_MS = 600;
/** 同时最多几个(再来新的,最早的那个提前淡出) */
export const PIN_MAX = 3;

export interface LivePin {
  e: ChronicleEntry;
  start: number;
  until: number;
}

/** 加几个标签(now = performance.now());超过 PIN_MAX 个没在淡出的,最早的提前淡出 */
export function addPins(live: readonly LivePin[], add: readonly ChronicleEntry[], now: number, show = PIN_SHOW_MS, max = PIN_MAX): LivePin[] {
  const out = live.filter((p) => p.until > now && !add.includes(p.e)).map((p) => ({ ...p }));
  for (const e of add) out.push({ e, start: now, until: now + show });
  const active = out.filter((p) => p.until - now > PIN_FADE_OUT_MS);
  for (let i = 0; i < active.length - max; i++) active[i].until = now + PIN_FADE_OUT_MS;
  return out;
}

/** 标签此刻的不透明度(淡入 PIN_FADE_IN_MS,最后 PIN_FADE_OUT_MS 淡出) */
export function pinOpacity(p: LivePin, now: number): number {
  return Math.max(0, Math.min(1, (p.until - now) / PIN_FADE_OUT_MS, (now - p.start) / PIN_FADE_IN_MS));
}

/**
 * 标签的卡片放在圆环的哪一边(相对圆环中心的左上角偏移;w、h = 卡片大小):
 * 右边(默认,卡片上沿略高于圆环)→ 左边 → 右下 → 左下 → 右上 → 左上
 */
export function cardOffset(side: number, w: number, h: number): [number, number] {
  const R = 16;
  switch (side) {
    case 1:
      return [-R - w, -24];
    case 2:
      return [R, 14];
    case 3:
      return [-R - w, 14];
    case 4:
      return [R, -14 - h];
    case 5:
      return [-R - w, -14 - h];
    default:
      return [R, -24];
  }
}
export const CARD_SIDES = 6;
/** 圆环(含光晕)的半径 */
const RING_R = 13;

export interface PinBox {
  /** 圆环中心(屏幕像素,标签层里的坐标) */
  x: number;
  y: number;
  /** 卡片大小 */
  w: number;
  h: number;
  /** 上一帧放在哪一边(没放过 = −1) */
  side: number;
}

type Rect = [number, number, number, number];
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 摆卡片:按先后(先来的先挑),每张挑一边 —— 不出标签层(四边留 pad,底下再让出 bottom:时间轴那一行)、
 * 不压别的卡片和圆环;上一帧那一边还完全放得下就不换(拖动地图时不来回跳)。都放不下就挑压得最少的。
 * 返回每张的那一边(cardOffset 的 side)
 */
export function placeCards(pins: readonly PinBox[], bw: number, bh: number, pad = 8, bottom = 0): number[] {
  const placed: Rect[] = [];
  const rings: Rect[] = pins.map((p) => [p.x - RING_R, p.y - RING_R, RING_R * 2, RING_R * 2]);
  const out: number[] = [];
  pins.forEach((p, i) => {
    const cost = (side: number) => {
      const [dx, dy] = cardOffset(side, p.w, p.h);
      const r: Rect = [p.x + dx, p.y + dy, p.w, p.h];
      const inside = overlap(r, [pad, pad, bw - pad * 2, bh - pad * 2 - bottom]);
      let c = (p.w * p.h - inside) * 4;
      for (const q of placed) c += overlap(r, q);
      rings.forEach((q, j) => j !== i && (c += overlap(r, q)));
      return { c, r };
    };
    const sticky = p.side >= 0 && p.side < CARD_SIDES ? cost(p.side) : null;
    let side = p.side;
    let rect: Rect = sticky ? sticky.r : [p.x, p.y, p.w, p.h];
    if (!sticky || sticky.c > 0) {
      let bc = Infinity;
      for (let s = 0; s < CARD_SIDES && bc > 0; s++) {
        const k = cost(s);
        if (k.c < bc) [bc, side, rect] = [k.c, s, k.r];
      }
    }
    placed.push(rect);
    out.push(side);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 事发地

const anchorCache = new WeakMap<Civ, Map<number, [number, number] | null>>();

/**
 * 纪事的事发地(世界坐标;标签的圆环画在这里):
 * 有相关的城(立国 / 迁都的国都、改朝入主的城)就是那座城;否则是事发各州(攻占的州、同化的州……)
 * 里离它们中心最近的那一州的治所;都没有就是第一个相关国家那一年的国都。找不到 = null
 */
export function entryAnchor(world: World, civ: Civ, e: ChronicleEntry): [number, number] | null {
  let m = anchorCache.get(civ);
  if (!m) anchorCache.set(civ, (m = new Map()));
  const hit = m.get(e.id);
  if (hit !== undefined) return hit;
  const at = anchorOf(world, civ, e);
  m.set(e.id, at);
  return at;
}

function anchorOf(world: World, civ: Civ, e: ChronicleEntry): [number, number] | null {
  const { x, y } = world.mesh;
  const n = world.mesh.n;
  const cellXY = (c: number): [number, number] | null => (c >= 0 && c < n ? [x[c], y[c]] : null);
  const s = e.settlement;
  if (s >= 0 && s < civ.settlements.length) return cellXY(civ.settlements[s].cell);
  const seats = e.regions.filter((r) => r >= 0 && r < civ.regions.count).map((r) => civ.regions.seat[r]).filter((c) => c >= 0 && c < n);
  if (seats.length) {
    // 跨 180° 经线的一片按连着算:都挪到离第一个最近的那一份再求中心
    const W = wrapOf(world);
    const ref = x[seats[0]];
    let sx = 0;
    let sy = 0;
    for (const c of seats) {
      sx += nearX(x[c], ref, W);
      sy += y[c];
    }
    const cx = sx / seats.length;
    const cy = sy / seats.length;
    let best = seats[0];
    let bd = Infinity;
    for (const c of seats) {
      const d = (nearX(x[c], cx, W) - cx) ** 2 + (y[c] - cy) ** 2;
      if (d < bd) [best, bd] = [c, d];
    }
    return cellXY(best);
  }
  for (const id of e.polities) {
    const p = civ.polities[id];
    if (!p) continue;
    const cap = capitalAt(p, e.year);
    if (cap >= 0 && cap < civ.settlements.length) return cellXY(civ.settlements[cap].cell);
  }
  return null;
}
