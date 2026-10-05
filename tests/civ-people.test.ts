/**
 * 人物(gen/civ/people.ts)和战役(wars.ts 的史事 battle):
 * 历代君主从立国排到灭亡不断档、年纪说得通;统帅的任期对得上战争里的每一件事;同种子同一批人;
 * 编年史里写进人名、战役、君主继位(chronicle.ts);干预某一年之前在位的君主不变。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import type { Person } from '../src/gen/civ/types';
import { dynastyIndexAt, polityShortTitle, polityTierAt } from '../src/gen/civ/growth';
import { buildChronicle, filterChronicle, mergeChronicle, polityChronicle, reignEntries, type ChronicleEntry } from '../src/gen/civ/chronicle';
import { rulerRef } from '../src/gen/civ/peopleText';
import { polityKey } from '../src/gen/edits';

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

const rulersOf = (civ: Civ, p: number) =>
  (civ.people ?? []).filter((x) => x.role === 'ruler' && x.polity === p).sort((a, b) => a.from! - b.from! || a.id - b.id);

const flat = (list: readonly ChronicleEntry[]) => list.flatMap((e) => [e, ...(e.children ?? [])]);

describe.each([7, 2024])('人物 · seed=%i', (seed) => {
  it('编号就是下标;名字干净;先是君主,再是统帅', () => {
    const civ = civOf(seed);
    const P = civ.people!;
    expect(P.length).toBeGreaterThan(civ.polities.length);
    P.forEach((x, i) => {
      expect(x.id).toBe(i);
      expect(x.name.length).toBeGreaterThanOrEqual(2);
      expect(x.name).not.toMatch(/undefined|NaN|\s/);
      expect(x.polity).toBeGreaterThanOrEqual(0);
      expect(x.polity).toBeLessThan(civ.polities.length);
    });
    const firstGeneral = P.findIndex((x) => x.role === 'general');
    if (firstGeneral >= 0) expect(P.slice(firstGeneral).every((x) => x.role === 'general')).toBe(true);
  });

  it('历代君主从立国到灭亡一位接一位,不断档;每一朝的第一位不是"继位"', () => {
    const civ = civOf(seed);
    for (const p of civ.polities) {
      const rs = rulersOf(civ, p.id);
      expect(rs.length, p.name).toBeGreaterThan(0);
      expect(rs[0].from).toBe(p.founded);
      for (let i = 1; i < rs.length; i++) expect(rs[i].from, `${p.name} 第 ${i} 位`).toBe(rs[i - 1].until);
      const last = rs[rs.length - 1];
      if (p.ended === undefined) {
        expect(last.until).toBeUndefined();
        expect(last.fate).toBeUndefined();
      } else expect(last.until).toBe(p.ended);
      for (const r of rs) {
        const d = dynastyIndexAt(p, r.from!);
        expect(r.dynasty ?? 0).toBe(p.dynasties?.length ? d : 0);
        const starts = p.dynasties?.length ? r.from === p.dynasties[d].year || r.from === p.founded : r.from === p.founded;
        expect(r.rise === 'heir', `${p.name} ${r.name}`).toBe(!starts);
      }
    }
  });

  it('年纪说得通:即位不早于 10 岁,一生不超过 88 岁;结局和卒年对得上', () => {
    const civ = civOf(seed);
    for (const x of civ.people!) {
      if (x.died !== undefined) {
        expect(x.died - x.born).toBeLessThanOrEqual(88 + 1e-6);
        expect(x.died).toBeLessThanOrEqual(civ.endYear);
      }
      if (x.role !== 'ruler') continue;
      expect(x.from! - x.born).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(x.from! - x.born).toBeLessThanOrEqual(62 + 1e-6);
      if (x.until !== undefined) expect(x.until).toBeGreaterThan(x.from!);
      if (x.fate === 'died' || x.fate === 'murdered' || x.fate === 'overthrown' || x.fate === 'fell') expect(x.died).toBe(x.until);
      if (x.died !== undefined && x.until !== undefined) expect(x.died).toBeGreaterThanOrEqual(x.until);
    }
  });

  it('称号:东方同一朝里不重复,开国之君是太祖(中途称帝的第一位是世祖);还在位的没有称号(西幻的序数在位时就有)', () => {
    const civ = civOf(seed);
    for (const p of civ.polities) {
      const rs = rulersOf(civ, p.id);
      if (!p.eastern || p.lineage === 'khanate') continue;
      for (const r of rs) if (r.until === undefined) expect(r.title ?? '').toBe('');
      const byDyn = new Map<number, Person[]>();
      for (const r of rs) byDyn.set(r.dynasty ?? 0, [...(byDyn.get(r.dynasty ?? 0) ?? []), r]);
      for (const list of byDyn.values()) {
        const titles = list.map((r) => r.title).filter(Boolean);
        expect(new Set(titles).size, p.name).toBe(titles.length);
        if (titles.includes('太祖')) expect(list[0].title).toBe('太祖');
      }
    }
  });

  it('统帅:每场战争两边的任期一段接一段,经手的事都属于这场战争;战死的死在最后一件事上', () => {
    const civ = civOf(seed);
    const A = civ.annals;
    const bySide = new Map<string, { first: number; last: number; x: Person }[]>();
    for (const x of civ.people!) {
      for (const c of x.commands ?? []) {
        expect(c.first).toBeLessThanOrEqual(c.last);
        expect(c.from).toBeLessThanOrEqual(c.until);
        for (const i of [c.first, c.last]) {
          expect(A[i].war).toBe(c.war);
          expect(['war', 'battle', 'conquer']).toContain(A[i].kind);
        }
        expect(A[c.first].year).toBeGreaterThanOrEqual(c.from - 1e-9);
        // 经手的最后一件事时人还在:将领没过卒年(战死的死在那一件事上);君主没下台(亡国那一刻除外)
        if (x.role === 'general' && x.died !== undefined && x.fate !== 'battle') expect(A[c.last].year).toBeLessThan(x.died);
        if (x.role === 'ruler' && x.until !== undefined) {
          if (x.until === civ.polities[x.polity].ended) expect(A[c.last].year).toBeLessThanOrEqual(x.until);
          else expect(A[c.last].year).toBeLessThan(x.until);
        }
        const key = `${c.war}|${c.side}`;
        bySide.set(key, [...(bySide.get(key) ?? []), { first: c.first, last: c.last, x }]);
      }
      if (x.fate === 'battle') {
        expect(x.role).toBe('general');
        const last = x.commands![x.commands!.length - 1];
        expect(x.died).toBe(A[last.last].year);
      }
    }
    expect(bySide.size).toBeGreaterThan(0);
    for (const list of bySide.values()) {
      list.sort((a, b) => a.first - b.first);
      for (let i = 1; i < list.length; i++) expect(list[i].first).toBeGreaterThan(list[i - 1].last);
    }
  });

  it('战役:没打下来的那一仗记在战争里,双方是这场战争的两边', () => {
    const civ = civOf(seed);
    const A = civ.annals;
    const sides = new Map<number, [number, number]>();
    for (const e of A) if (e.kind === 'war' && !sides.has(e.war)) sides.set(e.war, [e.a, e.b]);
    const battles = A.filter((e) => e.kind === 'battle');
    expect(battles.length).toBeGreaterThan(10);
    for (const e of battles) {
      const s = sides.get(e.war)!;
      expect(s).toBeDefined();
      expect([`${s[0]}|${s[1]}`, `${s[1]}|${s[0]}`]).toContain(`${e.a}|${e.b}`);
      expect(e.region).toBeGreaterThanOrEqual(0);
      expect(e.via).toBeGreaterThanOrEqual(0);
      expect(e.via).toBeLessThanOrEqual(4);
    }
  });

  it('编年史:战争里有"某某之战"、开战写统帅;君主继位单列,不进 buildChronicle', () => {
    const civ = civOf(seed);
    const list = buildChronicle(civ);
    const kids = list.flatMap((e) => (e.kind === 'war' ? e.children ?? [] : []));
    const fights = kids.filter((e) => e.kind === 'battle');
    expect(fights.length).toBeGreaterThan(5);
    for (const e of fights) {
      expect(e.tag).toBe('役');
      expect(e.text).toMatch(/^.+之战,/);
      expect(e.text).toMatch(/不克|不下|所却|所败/);
    }
    // 不在战争外单列
    expect(list.some((e) => e.kind === 'battle')).toBe(false);
    // 一州没打下来的战争:事发地是战场
    for (const w of list) {
      if (w.kind !== 'war' || !w.children || w.children.some((c) => c.kind === 'conquer')) continue;
      const sites = w.children.filter((c) => c.kind === 'battle').flatMap((c) => c.regions);
      if (sites.length) expect(new Set(w.regions)).toEqual(new Set(sites));
    }
    const decls = kids.filter((e) => e.kind === 'war');
    expect(decls.length).toBeGreaterThan(5);
    for (const e of decls) expect(e.text).toMatch(/为将|亲征/);
    // 写到的人物都记在 people 上,编号有效
    const P = civ.people!;
    for (const e of flat(list)) {
      for (const id of e.people ?? []) {
        const x = P[id];
        expect(x).toBeDefined();
        expect(e.text.includes(x.name) || (!!x.title && e.text.includes(x.title)), `${e.text} / ${x.name}`).toBe(true);
      }
      expect(e.text).not.toMatch(/undefined|NaN|某国/);
      // 句子里写到的开国之君(立国、分裂、复国、改朝换代;和别的事并成一条的也算)都记在 people 上
      for (const pid of e.polities) {
        for (const x of rulersOf(civ, pid)) {
          if (x.rise === 'heir' || !e.text.includes(x.name) || Math.abs(x.from! - e.year) > 30) continue;
          expect(e.people ?? [], `${e.text} / ${x.name}`).toContain(x.id);
        }
      }
    }
    // 君主继位:每一位"继位"的君主一条,只有选了国家时并进去
    const reigns = reignEntries(civ);
    expect(reigns.length).toBe(P.filter((x) => x.role === 'ruler' && x.rise === 'heir').length);
    expect(list.some((e) => e.kind === 'reign')).toBe(false);
    const ids = new Set(list.map((e) => e.id));
    for (const e of reigns) {
      expect(e.tag).toBe('嗣');
      expect(e.importance).toBe(1);
      expect(e.polities).toHaveLength(1);
      expect(ids.has(e.id)).toBe(false);
      expect(e.text).toMatch(/(即位|继为|继任)/);
      // 新君比先君年长:是兄,不是弟、子、孙
      const x = P[e.id - civ.annals.length];
      const prev = rulersOf(civ, x.polity).find((r) => r.until === x.from)!;
      if (civ.polities[x.polity].lineage !== 'republic' && x.born < prev.born) expect(e.text).toContain('其兄');
      expect(e.text).not.toMatch(/undefined|NaN/);
    }
    // 并进去之后照样按年份排好
    const p = civ.polities.reduce((best, x) => (rulersOf(civ, x.id).length > rulersOf(civ, best.id).length ? x : best)).id;
    const merged = mergeChronicle(filterChronicle(list, { polity: p }), filterChronicle(reigns, { polity: p }));
    for (let i = 1; i < merged.length; i++) expect(merged[i].year).toBeGreaterThanOrEqual(merged[i - 1].year);
    expect(filterChronicle(merged, { major: true }).some((e) => e.kind === 'reign')).toBe(false);
    // 编年史页只看一国的"全部"、国家面板"全部 N 件"都用 polityChronicle:就是这一份
    expect(polityChronicle(civ, list, p).map((e) => e.id)).toEqual(merged.map((e) => e.id));
  });

  it('称呼:按当年的君号写(部落首领写名字,有称号的写称号);帝国的君主带当年的国号简称', () => {
    const civ = civOf(seed);
    for (const x of civ.people!) {
      if (x.role !== 'ruler') continue;
      const p = civ.polities[x.polity];
      const ref = rulerRef(civ, x, x.from!);
      expect(ref.includes(x.name) || (!!x.title && ref.includes(x.title)), ref).toBe(true);
      if (p.eastern && p.lineage !== 'khanate' && polityTierAt(p, x.from!) >= 3 && (x.until === undefined || polityTierAt(p, x.until - 1 / 512) >= 3)) {
        expect(ref.startsWith(polityShortTitle(p, 3, x.from!))).toBe(true);
      }
    }
  });
});

describe('人物 · 稳定', () => {
  it('同一个种子两次生成,人物一模一样', () => {
    const a = civOf(7).people;
    const b = generateCiv(world(7)).people;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('干预某一年之前已经下台的君主,名字、生卒、在位年份和不干预时一样', () => {
    const civ = civOf(7);
    // 找一国在第 1900 年左右对邻国宣战
    const y0 = 1900;
    const alive = civ.polities.filter((p) => p.founded < y0 && (p.ended ?? Infinity) > y0);
    expect(alive.length).toBeGreaterThan(1);
    const c = generateCiv(world(7), { interventions: [{ kind: 'declare', a: polityKey(civ, alive[0].id), b: polityKey(civ, alive[1].id), from: y0 }] });
    const before = (x: Civ) =>
      x.polities.map((p) =>
        rulersOf(x, p.id)
          .filter((r) => r.until !== undefined && r.until < y0)
          .map((r) => [r.name, r.born, r.from, r.until, r.fate]),
      );
    expect(JSON.stringify(before(c))).toBe(JSON.stringify(before(civ)));
  });
});
