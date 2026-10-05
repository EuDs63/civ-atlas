/**
 * 城 / 地理实体 / 州的面板用的统计(src/ui/panelData.ts):历任归属和时间轴查到的归属一致;人口取样;相关事件;
 * 地理实体的几个数(有限、正数、单位合理)。
 */
import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { ownersAt } from '../src/gen/civ/timeline';
import { populationAt } from '../src/gen/civ/growth';
import { rasterize, type Raster } from '../src/gen/raster';
import { cityEntries, entriesUpTo, firstOwned, ownerSpans, placeFacts, popSeries, regionEntries, kmText, areaText } from '../src/ui/panelData';
import { interventionActorThen, interventionDoneText, interventionText, nameAt } from '../src/ui/Interventions';
import { polityKey, regionKey } from '../src/gen/edits';
import { polityAlive } from '../src/gen/civ/growth';

let cached: { world: World; civ: Civ; raster: Raster } | null = null;
function seed7() {
  if (!cached) {
    const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
    cached = { world, civ: generateCiv(world), raster: rasterize(world) };
  }
  return cached;
}

describe('面板统计', () => {
  it('历任归属:每一段里取几个年份,时间轴查到的主人都是这一段的国家;段首尾相接、相邻两段主人不同', () => {
    const { civ } = seed7();
    let checked = 0;
    for (let r = 0; r < civ.regions.count; r += 7) {
      const first = firstOwned(civ, r);
      const spans = first === null ? [] : ownerSpans(civ, r, first, civ.endYear);
      if (first === null) {
        expect(ownersAt(civ, civ.endYear).polity[r] < 0 || spans.length === 0).toBe(true);
        continue;
      }
      expect(spans.length).toBeGreaterThan(0);
      expect(spans[0].from).toBe(first);
      expect(spans[spans.length - 1].to).toBe(civ.endYear);
      for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        expect(s.to).toBeGreaterThan(s.from);
        if (i > 0) {
          expect(s.from).toBe(spans[i - 1].to);
          expect(s.polity).not.toBe(spans[i - 1].polity);
        }
        for (const f of [0.1, 0.5, 0.9]) {
          const y = s.from + (s.to - s.from) * f;
          expect(ownersAt(civ, y).polity[r]).toBe(s.polity);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('人口取样:建城前为 0、毁城后为 0;和 populationAt 一致', () => {
    const { civ } = seed7();
    const ruined = civ.settlements.find((s) => s.ended !== undefined)!;
    expect(ruined).toBeTruthy();
    const series = popSeries(ruined, ruined.founded, civ.endYear, 24);
    expect(series).toHaveLength(24);
    for (const x of series) {
      expect(x.pop).toBe(populationAt(ruined, x.year));
      if (x.year >= ruined.ended!) expect(x.pop).toBe(0);
    }
    expect(Math.max(...series.map((x) => x.pop))).toBeGreaterThan(0);
  });

  it('相关事件:毁了的城有"毁城";按年份排好;到某年为止的只含那年以前的', () => {
    const { civ } = seed7();
    const ruined = civ.settlements.filter((s) => s.ended !== undefined);
    expect(ruined.some((s) => cityEntries(civ, s.id).some((e) => e.kind === 'ruin' || e.children?.some((c) => c.kind === 'ruin')))).toBe(true);
    const list = regionEntries(civ, ruined[0].region);
    expect(list.length).toBeGreaterThan(0);
    for (let i = 1; i < list.length; i++) expect(list[i].year).toBeGreaterThanOrEqual(list[i - 1].year);
    const mid = list[Math.floor(list.length / 2)].year;
    const upTo = entriesUpTo(list, mid);
    expect(upTo.every((e) => e.year <= mid + 1e-6)).toBe(true);
    expect(upTo.length).toBe(list.filter((e) => e.year <= mid + 1e-6).length);
    // 缓存:同一份历史再查拿到同一个数组
    expect(regionEntries(civ, ruined[0].region)).toBe(list);
  });

  it('地理实体:山有最高峰和长度,河有长度和流经的州,湖 / 岛 / 荒漠有面积,海有离岸距离和最深处;数都在合理范围', () => {
    const { world, civ, raster } = seed7();
    const seen = new Set<string>();
    civ.places.forEach((p, i) => {
      const f = placeFacts(civ, world, raster, i);
      seen.add(p.kind);
      for (const v of [f.peak, f.lengthKm, f.areaKm2, f.shoreKm, f.depth, f.source, f.rain]) if (v !== undefined) expect(Number.isFinite(v)).toBe(true);
      expect(new Set(f.regions).size).toBe(f.regions.length);
      expect(f.weight).toHaveLength(f.regions.length);
      if (p.kind === 'mountains') {
        expect(f.peak!).toBeGreaterThan(500);
        expect(f.peak!).toBeLessThan(12000);
        expect(f.lengthKm!).toBeGreaterThan(50);
      }
      if (p.kind === 'river') {
        expect(f.lengthKm!).toBeGreaterThan(50);
        expect(f.lengthKm!).toBeLessThan(20000);
        expect(f.regions.length).toBeGreaterThan(0);
      }
      if (p.kind === 'lake' || p.kind === 'island' || p.kind === 'desert') expect(f.areaKm2!).toBeGreaterThan(0);
      if (p.kind === 'sea') {
        expect(f.shoreKm!).toBeGreaterThan(0);
        expect(f.depth!).toBeGreaterThan(0);
      }
    });
    expect(seen.has('mountains') && seen.has('river') && seen.has('sea')).toBe(true);
  });

  it('数字写法', () => {
    expect(kmText(2813)).toBe('2810');
    expect(kmText(12345)).toBe('1.2 万');
    expect(areaText(123456)).toBe('12 万');
    expect(areaText(5432)).toBe('5400');
  });
});

describe('干预的说法', () => {
  it('推完的提示:用给的国名(用户点的那个),保护写成"保护某国";不给就用生效那年的名字;那年叫什么另外查得到', () => {
    const { civ } = seed7();
    const p = civ.polities.find((q) => polityAlive(q, 2000) && polityAlive(q, 2500))!;
    const q = civ.polities.find((o) => o.id !== p.id && polityAlive(o, 2000))!;
    const a = polityKey(civ, p.id);
    const then = nameAt(p, 2000);
    expect(interventionDoneText(civ, { kind: 'halt', a, from: 2000 }, -1, '甲国')).toBe('甲国禁止扩张');
    expect(interventionDoneText(civ, { kind: 'halt', a, from: 2000, until: 2300 }, -1, '甲国')).toBe('甲国禁止扩张(至第 2300 年)');
    expect(interventionDoneText(civ, { kind: 'protect', a, from: 2000 }, -1, '甲国')).toBe('保护甲国');
    expect(interventionDoneText(civ, { kind: 'unity', a, from: 2000 }, -1, '甲国')).toBe('甲国禁止分裂');
    expect(interventionDoneText(civ, { kind: 'ally', a, b: polityKey(civ, q.id), from: 2000 }, -1, '甲国')).toBe(`甲国与${nameAt(q, 2000)}结盟`);
    expect(interventionDoneText(civ, { kind: 'halt', a, from: 2000 })).toBe(`${then}禁止扩张`);
    expect(interventionActorThen(civ, { kind: 'halt', a, from: 2000 })).toBe(then);
    // "我的干预"列表的写法不变
    expect(interventionText(civ, { kind: 'halt', a, from: 2000 })).toBe(`${then}:禁止扩张`);
    const found = { kind: 'found' as const, region: regionKey(civ, 0), from: 2000 };
    expect(interventionActorThen(civ, found)).toBeNull();
    expect(interventionDoneText(civ, found, -1, '甲国')).toBe(interventionText(civ, found));
  });
});
