/**
 * 地图上的战事(render/civ/warfare.ts):战争按史事整理得对,某一年画哪些仗、哪些州画斜线、双剑多浓,
 * 战线只画在交战两国之间、短齿朝守方。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { ownersAt } from '../src/gen/civ/timeline';
import type { Raster } from '../src/gen/raster';
import { CIV_SHOW_DEFAULT, CIV_SHOW_OFF, type CivDrawParams } from '../src/render/civ/overlay';
import { AFTER, drawWarfare, frontTeeth, warFront, warMarkPoints, warScene, warsShown, warSpans } from '../src/render/civ/warfare';
import type { LabelView } from '../src/render/labels/draw';

let world: World;
let civ: Civ;
const params = (year: number, show = { ...CIV_SHOW_OFF, polities: true, wars: true }): CivDrawParams => ({
  world,
  raster: {} as Raster,
  civ,
  style: 'fantasy',
  year,
  show,
});

/** 离世界坐标 (x, y) 最近的地块(东西相连) */
function cellAt(x: number, y: number): number {
  const { n, x: cx, y: cy, width: W } = world.mesh;
  let best = -1;
  let bd = Infinity;
  for (let c = 0; c < n; c++) {
    let dx = Math.abs(cx[c] - x) % W;
    if (dx > W / 2) dx = W - dx;
    const d = dx * dx + (cy[c] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** 有仗在打、地图上有战线的几年 */
function warYears(): number[] {
  const out: number[] = [];
  for (let y = 0; y <= civ.endYear && out.length < 6; y += 37) if (warFront(params(y)).length) out.push(y);
  return out;
}

beforeAll(() => {
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
  civ = generateCiv(world);
  // Node 里没有 Path2D:只要能加点就行
  (globalThis as { Path2D?: unknown }).Path2D ??= class {
    moveTo() {}
    lineTo() {}
  };
});

describe('战争按史事整理', () => {
  it('每场仗:先宣战后打,打完的有议和、亡国或一方不在了,每一仗都在开打和打完之间', () => {
    const spans = warSpans(civ);
    expect(spans.length).toBeGreaterThan(3);
    const A = civ.annals;
    for (const w of spans) {
      expect(w.end).toBeGreaterThanOrEqual(w.start);
      if (w.end !== Infinity) {
        const why =
          A.some((e) => e.war === w.id && (e.kind === 'peace' || (e.kind === 'fall' && (e.a === w.atk || e.a === w.def))) && e.year === w.end) ||
          [w.atk, w.def].some((id) => civ.polities[id]?.ended !== undefined && Math.max(w.start, civ.polities[id].ended!) === w.end);
        expect(why).toBe(true);
      }
      for (const f of w.fights) {
        expect(f.year).toBeGreaterThanOrEqual(w.start);
        expect(f.year).toBeLessThanOrEqual(w.end);
        expect(f.region).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('议和时割让的州不算打过一仗', () => {
    const A = civ.annals;
    let ceded = 0;
    for (let i = 0; i < A.length; i++) {
      const e = A[i];
      if (e.kind !== 'peace' || e.region <= 0) continue;
      const w = warSpans(civ).find((s) => s.id === e.war)!;
      for (let j = i - e.region; j < i; j++) {
        const c = A[j];
        if (c.kind !== 'conquer' || c.war !== e.war) continue;
        ceded++;
        // 同一刻同一州另有一场真打的仗(洗劫、战役)才可能有双剑
        const fought = A.some((x, k) => k !== j && x.war === e.war && x.region === c.region && x.year === c.year && (x.kind === 'battle' || x.kind === 'sack'));
        if (!fought) expect(w.fights.some((f) => f.region === c.region && f.year === c.year)).toBe(false);
      }
    }
    expect(ceded).toBeGreaterThan(0);
  });
});

describe('某一年的战事', () => {
  it('正在打的仗、易手的州、双剑的浓淡', () => {
    let checked = 0;
    for (let y = 0; y <= civ.endYear; y += 23) {
      const s = warScene(civ, y);
      const spans = warSpans(civ);
      expect(s.live).toEqual(spans.filter((w) => w.start <= y && y < w.end));
      // 斜线只画正在打的仗里攻占过的州
      const want = new Set<number>();
      for (const w of s.live) for (const t of w.taken) if (t.year <= y) want.add(t.region);
      expect(s.taken).toEqual([...want].sort((a, b) => a - b));
      for (const m of s.marks) {
        expect(m.alpha).toBeGreaterThan(0);
        expect(m.alpha).toBeLessThanOrEqual(1);
      }
      // 每场有过仗的战争正好一个"最近一仗"
      const withFights = spans.filter((w) => w.start <= y && y < w.end + AFTER && w.fights.some((f) => f.year <= y)).length;
      expect(s.marks.filter((m) => m.latest).length).toBe(withFights);
      checked += s.live.length;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('仗打完以后双剑慢慢淡去,AFTER 年后不再画', () => {
    const w = warSpans(civ).find((s) => s.end !== Infinity && s.fights.length && s.end + AFTER <= civ.endYear);
    expect(w).toBeTruthy();
    const alphaOf = (y: number) => Math.max(0, ...warScene(civ, y).marks.filter((m) => m.war === w!.id).map((m) => m.alpha));
    expect(warScene(civ, w!.end).live.includes(w!)).toBe(false);
    expect(alphaOf(w!.end - 0.01)).toBeGreaterThan(0.45);
    expect(alphaOf(w!.end + AFTER / 2)).toBeLessThanOrEqual(0.5);
    expect(alphaOf(w!.end + AFTER / 2)).toBeGreaterThan(0);
    expect(alphaOf(w!.end + AFTER)).toBe(0);
  });

  it('没放大时每场仗只画最近一仗,放大后画每一仗(同一个州只画一个)', () => {
    for (const y of warYears()) {
      const few = warMarkPoints(params(y), false);
      const all = warMarkPoints(params(y), true);
      expect(all.length).toBeGreaterThanOrEqual(few.length);
      const key = (m: { x: number; y: number }) => `${m.x},${m.y}`;
      expect(new Set(all.map(key)).size).toBe(all.length);
      for (const m of [...few, ...all]) expect(Number.isFinite(m.x) && Number.isFinite(m.y)).toBe(true);
    }
  });
});

describe('战线', () => {
  it('只画在正在交战的两国之间', () => {
    const years = warYears();
    expect(years.length).toBeGreaterThan(0);
    for (const y of years) {
      const own = ownersAt(civ, y).polity;
      const { live } = warScene(civ, y);
      for (const l of warFront(params(y))) {
        // 线上中间一点两侧各挪一点,两边的国家是交战的一对
        const P = l.pts;
        const i = (P.length >> 2) << 1;
        const dx = P[i + 2] - P[i];
        const dy = P[i + 3] - P[i + 1];
        const d = Math.hypot(dx, dy) || 1;
        const side = (s: number) => own[civ.regions.of[cellAt(P[i] + (s * 3 * dy) / d, P[i + 1] - (s * 3 * dx) / d)]];
        const pair = [side(1), side(-1)].sort((a, b) => a - b);
        expect(live.some((w) => [w.atk, w.def].sort((a, b) => a - b).join() === pair.join())).toBe(true);
      }
    }
  });

  it('短齿朝守方', () => {
    let hit = 0;
    let total = 0;
    for (const y of warYears()) {
      const own = ownersAt(civ, y).polity;
      const { live } = warScene(civ, y);
      for (const l of warFront(params(y))) {
        // 画布 y 朝下,齿伸向前进方向的左边;按世界坐标布齿(一个世界单位 = 一个像素),看齿尖落在谁家
        const tips: number[] = [];
        frontTeeth({ moveTo() {}, lineTo: (x, yy) => tips.push(x, yy) }, l.pts, 6.5, 3);
        for (let k = 0; k < tips.length; k += 2) {
          const owner = own[civ.regions.of[cellAt(tips[k], tips[k + 1])]];
          const w = live.find((w) => w.atk === owner || w.def === owner);
          if (!w) continue;
          total++;
          if (live.some((w) => w.def === owner)) hit++;
        }
      }
    }
    expect(total).toBeGreaterThan(20);
    expect(hit / total).toBeGreaterThan(0.9);
  });
});

describe('开关', () => {
  it('默认打开;要开着"国家"才画;关掉就什么都不画', () => {
    expect(CIV_SHOW_DEFAULT.wars).toBe(true);
    expect(CIV_SHOW_OFF.wars).toBe(false);
    const y = warYears()[0];
    expect(warsShown(params(y))).toBe(true);
    expect(warsShown(params(y, { ...CIV_SHOW_OFF, polities: true }))).toBe(false);
    expect(warsShown(params(y, { ...CIV_SHOW_OFF, wars: true }))).toBe(false);
    const calls = { stroke: 0 };
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'stroke' ? () => calls.stroke++ : () => {}), set: () => true }) as unknown as CanvasRenderingContext2D;
    const lv: LabelView = { scale: 1, ox: 0, oy: 0, dpr: 1, k: 1, mapCss: world.width, worldW: world.width, worldH: world.height, wrap: world.width, canvasW: world.width, canvasH: world.height };
    expect(drawWarfare(ctx, params(y, { ...CIV_SHOW_OFF, polities: true }), lv, null)).toEqual({ lines: 0, marks: 0 });
    expect(calls.stroke).toBe(0);
    const drawn = drawWarfare(ctx, params(y), lv, null);
    expect(drawn.lines).toBeGreaterThan(0);
    expect(calls.stroke).toBeGreaterThan(0);
  });
});
