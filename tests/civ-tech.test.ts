/**
 * 技术层(gen/civ/tech.ts):气质标签、时代领先 / 落后、发明与传播;
 * 编年史条目(techText.ts)措辞干净、编号不和史事 / 信仰撞;国家面板用的摘要说得通。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { GENERATOR_VERSION } from '../src/gen/edits';
import { buildChronicle, filterChronicle, MAJOR } from '../src/gen/civ/chronicle';
import { faithEntries, fullChronicle } from '../src/gen/civ/religionText';
import { buildTech, eraTitle, lagLabel, polityTechAt, TECH_ERAS, techLabel } from '../src/gen/civ/tech';
import { techEntries, techEventText } from '../src/gen/civ/techText';

const worlds = new Map<number, World>();
function world(seed: number): World {
  let w = worlds.get(seed);
  if (!w) worlds.set(seed, (w = generateWorld({ ...DEFAULT_PARAMS, cells: 12000, seed })));
  return w;
}
const civs = new Map<number, Civ>();
function civOf(seed: number): Civ {
  let c = civs.get(seed);
  if (!c) civs.set(seed, (c = generateCiv(world(seed))));
  return c;
}

const CLEAN = /undefined|NaN|null|\[object/;
const TEMPERS = new Set(['守成', '好战', '开疆', '商路发达', '孤悬一方', '兼收并蓄', '雄踞一方', '短促']);

describe('技术层版本', () => {
  it('GENERATOR_VERSION 已加到 11(旧存档提示来自旧版本)', () => {
    expect(GENERATOR_VERSION).toBeGreaterThanOrEqual(11);
  });
});

describe.each([7, 2024])('技术层 · seed=%i', (seed) => {
  it('有摇篮、各国有气质和路程;时代表固定', () => {
    const civ = civOf(seed);
    const tech = civ.tech!;
    expect(tech.eras.map((e) => e.name)).toEqual(TECH_ERAS.map((e) => e.name));
    expect(tech.cradles.length).toBeGreaterThan(0);
    expect(tech.polities.length).toBe(civ.polities.length);
    for (const tp of tech.polities) {
      expect(tp.polity).toBeGreaterThanOrEqual(0);
      expect(tp.temperaments.length).toBeGreaterThanOrEqual(1);
      expect(tp.temperaments.length).toBeLessThanOrEqual(2);
      for (const t of tp.temperaments) expect(TEMPERS.has(t)).toBe(true);
      expect(tp.cradleDist).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(tp.lagYears)).toBe(true);
    }
  });

  it('同一种子两次技术层一致;buildTech 可单独重算', () => {
    const a = civOf(seed).tech!;
    const b = generateCiv(world(seed)).tech!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const c = buildTech({ ...civOf(seed), tech: undefined });
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('每样技术至多一件发明,传播在发明之后;via 说得通', () => {
    const tech = civOf(seed).tech!;
    const invents = tech.events.filter((e) => e.kind === 'invent');
    const kinds = invents.map((e) => e.tech);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(invents.length).toBeGreaterThanOrEqual(2);
    for (const e of tech.events) {
      expect(e.year).toBeGreaterThanOrEqual(0);
      expect(e.year).toBeLessThanOrEqual(civOf(seed).endYear);
      expect(civOf(seed).polities[e.polity]).toBeDefined();
      if (e.kind === 'invent') {
        expect(e.via).toBe('origin');
        expect(e.from).toBeUndefined();
      } else {
        expect(e.from).toBeGreaterThanOrEqual(0);
        expect(e.via === 'war' || e.via === 'trade').toBe(true);
        const inv = invents.find((x) => x.tech === e.tech)!;
        expect(e.year).toBeGreaterThanOrEqual(inv.year);
      }
    }
  });

  it('编年史有技术条目:措辞干净、重要度 1–3、id 不和史事 / 信仰撞', () => {
    const civ = civOf(seed);
    const te = techEntries(civ);
    expect(te.length).toBe(civ.tech!.events.length);
    expect(te.length).toBeGreaterThan(0);
    const ids = new Set([
      ...buildChronicle(civ).map((e) => e.id),
      ...faithEntries(civ).map((e) => e.id),
      ...te.map((e) => e.id),
    ]);
    expect(ids.size).toBe(buildChronicle(civ).length + faithEntries(civ).length + te.length);
    for (const e of te) {
      expect(e.kind).toBe('tech');
      expect(e.tag === '技' || e.tag === '播').toBe(true);
      expect(e.importance).toBeGreaterThanOrEqual(1);
      expect(e.importance).toBeLessThanOrEqual(3);
      expect(e.text).not.toMatch(CLEAN);
      expect(e.text.length).toBeGreaterThan(2);
    }
    const all = fullChronicle(civ);
    expect(all.filter((e) => e.kind === 'tech').length).toBe(te.length);
    // 发明类大事里至少有几条能进"大事"
    expect(filterChronicle(te, { major: true }).length).toBeGreaterThan(0);
    expect(MAJOR).toBe(3);
  });

  it('气质会写进部分纪事口吻;面板摘要有时代和领先 / 落后', () => {
    const civ = civOf(seed);
    const samples = civ.tech!.events.slice(0, 8).map((e) => techEventText(civ, e));
    expect(samples.some((t) => /始兴|始制|首创|军中得|商路/.test(t))).toBe(true);
    const p = civ.polities[0];
    const info = polityTechAt(civ, p.id, Math.min(civ.endYear, p.ended ?? civ.endYear));
    expect(info).not.toBeNull();
    expect(info!.eraName).toMatch(/时代$/);
    expect(info!.lagText.length).toBeGreaterThan(0);
    expect(eraTitle(1)).toBe('铁器时代');
    expect(lagLabel(0)).toBe('与摇篮相当');
    expect(lagLabel(40)).toMatch(/^落后约/);
    expect(lagLabel(-30)).toMatch(/^领先约/);
    expect(techLabel('gunpowder')).toBe('火器');
  });
});

describe('技术纪事样品(seed 7)', () => {
  it('打印几条发明 / 传播和气质,供 PR 说明引用', () => {
    const civ = civOf(7);
    const invent = civ.tech!.events.filter((e) => e.kind === 'invent').slice(0, 3);
    const spread = civ.tech!.events.filter((e) => e.kind === 'spread').slice(0, 4);
    for (const e of [...invent, ...spread]) {
      const line = `第 ${Math.floor(e.year)} 年 ${techEventText(civ, e)}`;
      expect(line).not.toMatch(CLEAN);
      // eslint-disable-next-line no-console
      console.log(line);
    }
    for (const tp of civ.tech!.polities.slice(0, 5)) {
      const p = civ.polities[tp.polity];
      // eslint-disable-next-line no-console
      console.log(`${p.name}: ${tp.temperaments.join('·')} · ${lagLabel(tp.lagYears)} · 摇篮${tp.cradleDist}步`);
    }
  });
});
