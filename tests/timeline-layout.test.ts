/**
 * 时间轴与事件的纯计算:事件类型、排刻度(太密合并)、指到哪一件、播放经过的大事、最近事件、
 * 地图标签的淡入淡出和摆放、事发地。手工造的纪事测规则;再用真实世界(seed 7)核对。
 */
import { describe, expect, it } from 'vitest';
import type { ChronicleEntry, Importance } from '../src/gen/civ/chronicle';
import { buildChronicle, filterChronicle } from '../src/gen/civ/chronicle';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import {
  CARD_SIDES,
  DIAMOND_GAP,
  ORDER_GAP,
  PIN_FADE_OUT_MS,
  PIN_MAX,
  PIN_SHOW_MS,
  addPins,
  cardOffset,
  countUpTo,
  crossed,
  entryAnchor,
  entryWeight,
  evLabel,
  evText,
  evType,
  evYears,
  hitDiamonds,
  layoutDiamonds,
  pinOpacity,
  placeCards,
  recentEntries,
  replayStart,
} from '../src/ui/timelineLayout';

let nextId = 0;
function entry(year: number, kind: string, extra: Partial<ChronicleEntry> = {}): ChronicleEntry {
  return {
    id: nextId++,
    kind: kind as ChronicleEntry['kind'],
    year,
    end: year,
    text: `${kind}@${year}`,
    tag: '立',
    importance: 3 as Importance,
    polities: [0],
    regions: [],
    settlement: -1,
    ...extra,
  };
}

describe('事件类型', () => {
  it('史事种类归成五类 + 干预;不认识的算改朝', () => {
    expect(['war', 'conquer', 'peace', 'sack', 'ruin', 'fall'].map((k) => evType({ kind: k as ChronicleEntry['kind'] }))).toEqual(Array(6).fill('war'));
    expect(evType(entry(1, 'dynasty'))).toBe('dynasty');
    expect(evType(entry(1, 'capital'))).toBe('dynasty');
    expect(evType(entry(1, 'found'))).toBe('found');
    expect(evType(entry(1, 'split'))).toBe('found');
    expect(evType(entry(1, 'rank'))).toBe('empire');
    expect(evType(entry(1, 'assimilate'))).toBe('assim');
    expect(evType(entry(1, 'migrate'))).toBe('assim');
    expect(evType(entry(1, 'intervene'))).toBe('order');
    expect(evType({ kind: 'plague' as ChronicleEntry['kind'] })).toBe('dynasty');
  });

  it('类型名按一字标签;升格里称帝的写"称帝";干预的正文去掉前缀', () => {
    expect(evLabel(entry(1, 'war', { tag: '战' }))).toBe('战争');
    expect(evLabel(entry(1, 'dynasty', { tag: '朝' }))).toBe('改朝');
    expect(evLabel(entry(1, 'rank', { tag: '升', text: '瓦利亚王国称帝,改号瓦利亚帝国' }))).toBe('称帝');
    expect(evLabel(entry(1, 'rank', { tag: '升', text: '沁国升格为大沁' }))).toBe('升格');
    expect(evLabel(entry(1, 'intervene', { tag: '干' }))).toBe('干预');
    expect(evLabel(entry(1, 'found', { tag: '?' }))).toBe('纪事');
    expect(evText(entry(1, 'intervene', { text: '【干预】大昌与索拉特结盟' }))).toBe('大昌与索拉特结盟');
  });

  it('年份:单年 / 跨年 / 还没打完', () => {
    expect(evYears(entry(2629.4, 'war'))).toBe('2629 年');
    expect(evYears(entry(2940, 'war', { end: 2957.9 }))).toBe('2940–2957 年');
    expect(evYears(entry(2987, 'war', { end: 3000, ongoing: true }))).toBe('2987 年起');
  });

  it('分量先看重要度', () => {
    expect(entryWeight(entry(1, 'capital'))).toBeGreaterThan(entryWeight(entry(1, 'fall', { importance: 2 })));
  });
});

describe('刻度排布', () => {
  it('每条一个菱形(战争画在开战那年);位置按年份比例', () => {
    const es = [entry(500, 'found'), entry(1000, 'war', { end: 1300 }), entry(2000, 'split')];
    const { marks, orders } = layoutDiamonds(es, 3000, 300);
    expect(marks.map((d) => d.x)).toEqual([50, 100, 200]);
    expect(orders).toEqual([]);
  });

  it('挨得太近的菱形合并,颜色取分量最重的;合并后的菱形之间至少隔 DIAMOND_GAP', () => {
    // 300 像素 = 3000 年:1 像素 = 10 年
    const es = [entry(1000, 'rank'), entry(1030, 'fall'), entry(1050, 'found'), entry(1500, 'capital'), entry(1540, 'merge')];
    const { marks } = layoutDiamonds(es, 3000, 300);
    expect(marks).toHaveLength(2);
    expect(marks[0].items.map((e) => e.kind)).toEqual(['rank', 'fall', 'found']);
    expect(marks[0].lead.kind).toBe('fall');
    expect(marks[1].lead.kind).toBe('merge');
    expect(marks[1].x - marks[0].x).toBeGreaterThanOrEqual(DIAMOND_GAP);
  });

  it('一长串等距的事不会连成一个大团', () => {
    const es = Array.from({ length: 100 }, (_, i) => entry(1000 + i * 20, 'found'));
    const { marks } = layoutDiamonds(es, 3000, 300);
    expect(marks.length).toBeGreaterThan(200 / (2 * DIAMOND_GAP));
    expect(marks.length).toBeLessThanOrEqual(200 / DIAMOND_GAP + 1);
    for (let i = 1; i < marks.length; i++) expect(marks[i].x - marks[i - 1].x).toBeGreaterThanOrEqual(DIAMOND_GAP - 1e-9);
    expect(marks.reduce((n, d) => n + d.items.length, 0)).toBe(100);
  });

  it('宽度 / 结束年份无效:什么都不画', () => {
    expect(layoutDiamonds([entry(10, 'found')], 3000, 0)).toEqual({ marks: [], orders: [], shifts: [] });
    expect(layoutDiamonds([entry(10, 'found')], 0, 300)).toEqual({ marks: [], orders: [], shifts: [] });
  });

  it('干预单独画成"令":不和菱形合并,挨近的几条并成一个;指到时优先认它', () => {
    const es = [entry(900, 'found'), entry(1001, 'intervene'), entry(1010, 'intervene'), entry(1005, 'rank'), entry(2000, 'intervene')];
    es.sort((a, b) => a.year - b.year);
    const L = layoutDiamonds(es, 3000, 300);
    expect(L.orders).toHaveLength(2);
    expect(L.orders[0].items).toHaveLength(2);
    expect(L.orders[1].x - L.orders[0].x).toBeGreaterThanOrEqual(ORDER_GAP);
    expect(L.marks.flatMap((d) => d.items).map((e) => e.kind)).toEqual(['found', 'rank']);
    expect(hitDiamonds(L, 100.2)?.lead.kind).toBe('intervene');
    expect(hitDiamonds(L, 88)?.lead.kind).toBe('found');
    expect(hitDiamonds(L, 150)).toBeNull();
  });

  it('地形大事单独画成"变":不和"令"、菱形合并;指到时认得出', () => {
    const es = [entry(1600, 'upheaval'), entry(1602, 'intervene'), entry(1601, 'found')];
    es.sort((a, b) => a.year - b.year);
    const L = layoutDiamonds(es, 3000, 300);
    expect(L.shifts.map((d) => d.lead.kind)).toEqual(['upheaval']);
    expect(L.orders.map((d) => d.lead.kind)).toEqual(['intervene']);
    expect(L.marks.flatMap((d) => d.items).map((e) => e.kind)).toEqual(['found']);
    expect(hitDiamonds(L, 160.2, 0.1)?.lead.kind).toBe('intervene');
    expect(hitDiamonds(L, 160, 0.1)?.lead.kind).toBe('upheaval');
    // 同一年的"令"和"变"叠在一处:"变"画在上面,认"变"
    const same = layoutDiamonds([entry(1600, 'intervene'), entry(1600, 'upheaval')], 3000, 300);
    expect(hitDiamonds(same, 160)?.lead.kind).toBe('upheaval');
  });
});

describe('播放', () => {
  const es = [entry(100, 'found'), entry(200, 'rank'), entry(200.5, 'fall'), entry(300, 'capital')];

  it('自动播放 / 重播从结束年份前 400 年起', () => {
    expect(replayStart(3000)).toBe(2600);
    expect(replayStart(300)).toBe(0);
  });

  it('经过的条目:(y0, y1]', () => {
    expect(crossed(es, 100, 200.5).map((e) => e.year)).toEqual([200, 200.5]);
    expect(crossed(es, 0, 99)).toEqual([]);
    expect(crossed(es, 300, 3000)).toEqual([]);
    expect(crossed(es, -1, 100).map((e) => e.year)).toEqual([100]);
  });

  it('最近事件:到这一年为止(含)最近的 4 条,旧的在前', () => {
    const more = [...es, entry(400, 'war'), entry(500, 'dynasty')];
    expect(countUpTo(more, 200)).toBe(2);
    expect(recentEntries(more, 50)).toEqual([]);
    expect(recentEntries(more, 200).map((e) => e.year)).toEqual([100, 200]);
    expect(recentEntries(more, 3000).map((e) => e.year)).toEqual([200.5, 300, 400, 500]);
    expect(recentEntries(more, 300.2, 2).map((e) => e.year)).toEqual([200.5, 300]);
  });
});

describe('地图上的事件标签', () => {
  it('淡入、停住、淡出', () => {
    const [p] = addPins([], [entry(1, 'war')], 1000);
    expect(p.until - p.start).toBe(PIN_SHOW_MS);
    expect(pinOpacity(p, 1000)).toBe(0);
    expect(pinOpacity(p, 1100)).toBeCloseTo(0.5);
    expect(pinOpacity(p, 2000)).toBe(1);
    expect(pinOpacity(p, p.until - PIN_FADE_OUT_MS / 2)).toBeCloseTo(0.5);
    expect(pinOpacity(p, p.until + 1)).toBe(0);
  });

  it('同时最多 PIN_MAX 个:再来新的,最早的提前淡出;过期的收掉;不改原来的数组', () => {
    const es = Array.from({ length: PIN_MAX + 2 }, (_, i) => entry(i, 'war'));
    let live = addPins([], es.slice(0, PIN_MAX), 0);
    const before = live.map((p) => p.until);
    live = addPins(live, es.slice(PIN_MAX), 100);
    const fading = live.filter((p) => p.until <= 100 + PIN_FADE_OUT_MS);
    expect(fading.map((p) => p.e)).toEqual(es.slice(0, 2));
    expect(live.filter((p) => p.until > 100 + PIN_FADE_OUT_MS)).toHaveLength(PIN_MAX);
    expect(before).toEqual(Array(PIN_MAX).fill(PIN_SHOW_MS));
    expect(addPins(live, [], PIN_SHOW_MS + 200)).toHaveLength(0);
  });

  it('卡片默认放在圆环右边;右边出屏就换到左边;两张不重叠', () => {
    const W = 800;
    const H = 500;
    const [a] = placeCards([{ x: 100, y: 200, w: 200, h: 50, side: -1 }], W, H);
    expect(a).toBe(0);
    const [b] = placeCards([{ x: 700, y: 200, w: 200, h: 50, side: -1 }], W, H);
    expect(cardOffset(b, 200, 50)[0]).toBeLessThan(0);
    // 两个事发地挨着:第二张换一边,不压第一张
    const boxes = [
      { x: 300, y: 200, w: 200, h: 50, side: -1 },
      { x: 310, y: 210, w: 200, h: 50, side: -1 },
    ];
    const sides = placeCards(boxes, W, H);
    const rect = (i: number) => {
      const [dx, dy] = cardOffset(sides[i], boxes[i].w, boxes[i].h);
      return [boxes[i].x + dx, boxes[i].y + dy, boxes[i].w, boxes[i].h];
    };
    const [r0, r1] = [rect(0), rect(1)];
    const ox = Math.min(r0[0] + r0[2], r1[0] + r1[2]) - Math.max(r0[0], r1[0]);
    const oy = Math.min(r0[1] + r0[3], r1[1] + r1[3]) - Math.max(r0[1], r1[1]);
    expect(ox > 0 && oy > 0).toBe(false);
    for (const s of sides) expect(s >= 0 && s < CARD_SIDES).toBe(true);
  });

  it('上一帧那一边还放得下就不换', () => {
    const [s] = placeCards([{ x: 400, y: 200, w: 200, h: 50, side: 3 }], 800, 500);
    expect(s).toBe(3);
  });

  it('让出底下的时间轴:贴着底边的事发地,卡片放到上面', () => {
    const [s] = placeCards([{ x: 300, y: 460, w: 200, h: 50, side: -1 }], 800, 500, 8, 84);
    expect(cardOffset(s, 200, 50)[1]).toBeLessThan(-50);
  });
});

describe('真实世界', () => {
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
  const civ = generateCiv(world);
  const majors = filterChronicle(buildChronicle(civ), { major: true });

  it('seed 7:大事刻度不糊成一片,每一件都在某个菱形里', () => {
    for (const width of [900, 380, 120]) {
      const { marks, orders } = layoutDiamonds(majors, civ.endYear, width);
      expect(marks.reduce((n, d) => n + d.items.length, 0) + orders.reduce((n, d) => n + d.items.length, 0)).toBe(majors.length);
      for (let i = 1; i < marks.length; i++) expect(marks[i].x - marks[i - 1].x).toBeGreaterThanOrEqual(DIAMOND_GAP - 1e-9);
      for (const d of marks) expect(d.x >= 0 && d.x <= width).toBe(true);
    }
    expect(layoutDiamonds(majors, civ.endYear, 900).marks.length).toBeGreaterThan(majors.length / 2);
  });

  it('seed 7:每条大事都找得到事发地,在陆地上', () => {
    for (const e of majors) {
      const a = entryAnchor(world, civ, e);
      expect(a, e.text).not.toBeNull();
      const [x, y] = a!;
      expect(x >= 0 && x <= world.width && y >= 0 && y <= world.height).toBe(true);
    }
    // 有城的(立国、改朝入主的城)就是那座城
    const withCity = majors.find((e) => e.settlement >= 0)!;
    const c = civ.settlements[withCity.settlement].cell;
    expect(entryAnchor(world, civ, withCity)).toEqual([world.mesh.x[c], world.mesh.y[c]]);
    // 攻占多州的战争:落在其中一州的治所上
    const war = majors.find((e) => e.kind === 'war' && e.regions.length > 1);
    if (war) {
      const seats = war.regions.map((r) => civ.regions.seat[r]);
      const [x, y] = entryAnchor(world, civ, war)!;
      expect(seats.some((s) => world.mesh.x[s] === x && world.mesh.y[s] === y)).toBe(true);
    }
  });
});
