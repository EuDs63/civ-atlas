/**
 * 王朝更替(阶段 3,dynasty.ts):东方改朝换代换国号、西幻王室更迭国名不变;接着推、确定性、史事字段、起名、编年史措辞。
 */
import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { generateCiv, type Civ, type Polity } from '../src/gen/civ';
import { CivSim } from '../src/gen/civ/sim';
import { ownersAt } from '../src/gen/civ/timeline';
import { polityModelOf } from '../src/gen/civ/polities';
import { MIN_AGE, OLD_AGE, dynastyModelOf, dynastyStats } from '../src/gen/civ/dynasty';
import {
  capitalAt,
  dynastyAt,
  dynastyIndexAt,
  dynastyTitle,
  polityAllTitles,
  polityAlive,
  polityName,
  polityRootAt,
  polityRoots,
  polityShortTitle,
  polityTierAt,
  polityTitleChain,
  polityTitles,
} from '../src/gen/civ/growth';
import { DYNASTY_TIER, buildChronicle, filterChronicle, MAJOR } from '../src/gen/civ/chronicle';
import { polityLabels } from '../src/render/labels/polity';
import { REF_MAP_CSS } from '../src/render/labels/draw';
import { rasterize } from '../src/gen/raster';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

const worlds = new Map<string, World>();
function world(p: WorldParams): World {
  const key = JSON.stringify(p);
  let w = worlds.get(key);
  if (!w) worlds.set(key, (w = generateWorld(p)));
  return w;
}
const civs = new Map<string, Civ>();
function civOf(p: WorldParams): Civ {
  const key = JSON.stringify(p);
  let c = civs.get(key);
  if (!c) civs.set(key, (c = generateCiv(world(p))));
  return c;
}

function bytes(a: ArrayBufferView) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/** 名字、配色、国号写法(含王朝名)在推演结束后才定:只比推演出来的部分 */
const strip = <T extends { name: string; color?: unknown; dynasties?: { name: string }[] }>(a: T[]) =>
  a.map((x) => ({ ...x, name: '', color: 0, eastern: undefined, dynasties: x.dynasties?.map((d) => ({ ...d, name: '' })) }));

/** 先推到 cut 年、fromCiv 接着推到 whole.endYear:和一口气推完逐项比(日志、检查点、归属、史事、国家表、城镇表) */
function expectResumeSame(w: World, whole: Civ, cut: number) {
  const half = generateCiv(w, { endYear: cut });
  const sim = CivSim.fromCiv(w, half);
  sim.run(whole.endYear);
  const res = sim.result();
  const L = whole.log;
  const tag = `从第 ${cut} 年接着推`;
  expect(res.log.size, tag).toBe(L.size);
  for (const k of ['year', 'region', 'layer', 'value', 'cause'] as const) {
    expect(bytes(res.log[k]).equals(bytes(L[k].subarray(0, L.size))), `${tag}:日志 ${k}`).toBe(true);
  }
  expect(bytes(res.polity).equals(bytes(whole.polity)), tag).toBe(true);
  res.checkpoints.forEach((c, i) => expect(bytes(c.polity).equals(bytes(whole.checkpoints[i].polity)), `${tag}:检查点 ${c.year}`).toBe(true));
  expect(JSON.stringify(res.annals), `${tag}:史事`).toBe(JSON.stringify(whole.annals));
  const m = polityModelOf(sim)!;
  expect(JSON.stringify(strip(m.polities)), `${tag}:国家表`).toBe(JSON.stringify(strip(whole.polities)));
  expect(JSON.stringify(strip(m.settlements)), `${tag}:城镇表`).toBe(JSON.stringify(strip(whole.settlements)));
  // 接着推的时候没有动过切开那一刻的国家表(fromCiv 复制了一份)
  expect(JSON.stringify(half.polities.map((p) => p.dynasties?.length ?? 0))).toBe(
    JSON.stringify(generateCiv(w, { endYear: cut }).polities.map((p) => p.dynasties?.length ?? 0)),
  );
  return sim;
}

/** 改朝换代史事前后的国家(同一刻之前 / 之后) */
const EPS = 1 / 512;

describe('王朝更替', () => {
  it('fromCiv 接着推:先推到第 1200 年、以及在改朝换代那一刻 / 那一年切开,和一口气推完逐字节一致', () => {
    let cutAtDynasty = 0;
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const whole = civOf({ ...small, seed });
      const dyn = whole.annals.filter((e) => e.kind === 'dynasty');
      expect(dyn.length, `seed ${seed} 小世界也要有改朝换代`).toBeGreaterThan(1);
      const cuts = new Set<number>([1200]);
      // 改朝换代的那一刻(那一刻的事件都已经处理完)、那一年的年初(那一年还没到)
      for (const e of dyn.filter((_, i) => i % 2 === 0).slice(0, 3)) {
        cuts.add(e.year);
        cuts.add(Math.floor(e.year));
        cutAtDynasty++;
      }
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        const sim = expectResumeSame(w, whole, cut);
        expect(dynastyModelOf(sim)).toBeDefined();
      }
    }
    expect(cutAtDynasty).toBeGreaterThanOrEqual(4);
  }, 180_000);

  it('确定性:同一个种子两次,史事、国家表(含王朝名)逐字节相同', () => {
    const a = generateCiv(world({ ...small, seed: 3 }));
    const b = generateCiv(generateWorld({ ...small, seed: 3 }));
    expect(a.annals.some((e) => e.kind === 'dynasty')).toBe(true);
    expect(JSON.stringify(a.annals)).toBe(JSON.stringify(b.annals));
    expect(JSON.stringify(a.polities)).toBe(JSON.stringify(b.polities));
  });

  it('史事按约定的字段记:dynasty(a = 国家,region = 新朝根据地,settlement = 新国都,b = war = −1);国家表的历朝和史事一一对应', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const P = civ.polities;
      const A = civ.annals;
      const byPolity = new Map<number, number[]>();
      for (const e of A.filter((x) => x.kind === 'dynasty')) {
        const p = P[e.a];
        const tag = `seed ${seed} 第 ${e.year} 年 ${p.name}`;
        expect(e.b, tag).toBe(-1);
        expect(e.war, tag).toBe(-1);
        expect(polityAlive(p, e.year), tag).toBe(true);
        // 大国才改朝换代:国号到过第 2 档;当朝已经 OLD_AGE 年以上的,到过第 1 档就行
        const prev = p.dynasties![dynastyIndexAt(p, e.year) - 1].year;
        expect(polityTierAt(p, e.year), tag).toBeGreaterThanOrEqual(e.year - prev >= OLD_AGE ? 1 : 2);
        // 根据地在本国国土里、是本族的州、有城;新国都 = 当年的国都(定都根据地时就是根据地的城)
        const own = ownersAt(civ, e.year).polity;
        expect(own[e.region], tag).toBe(e.a);
        expect(civ.culture[e.region] >= 0).toBe(true);
        expect(e.settlement, tag).toBe(capitalAt(p, e.year));
        const seat = civ.settlements.find((s) => s.region === e.region)!;
        expect(seat, tag).toBeDefined();
        const moved = capitalAt(p, e.year - EPS) !== e.settlement;
        if (moved) {
          expect(e.settlement, `${tag} 定都根据地`).toBe(seat.id);
          expect(p.capitals!.some((c) => c.year === e.year && c.settlement === e.settlement)).toBe(true);
        }
        let list = byPolity.get(e.a);
        if (!list) byPolity.set(e.a, (list = []));
        list.push(e.year);
      }
      let changed = 0;
      for (const p of P) {
        const d = p.dynasties;
        const ys = byPolity.get(p.id) ?? [];
        if (!d) {
          expect(ys, p.name).toEqual([]);
          continue;
        }
        changed++;
        // 第一条 = 立国那年、立国时的国都;之后每条对应一条 dynasty 史事
        expect(d[0]).toMatchObject({ year: p.founded, seat: p.capital });
        expect(d.slice(1).map((x) => x.year)).toEqual(ys);
        for (let i = 1; i < d.length; i++) {
          const e = A.find((x) => x.kind === 'dynasty' && x.a === p.id && x.year === d[i].year)!;
          expect(civ.settlements[d[i].seat].region).toBe(e.region);
          // 一朝至少几十年
          expect(d[i].year - d[i - 1].year).toBeGreaterThanOrEqual(MIN_AGE);
        }
        for (const x of d) expect(x.name.length, p.name).toBeGreaterThan(0);
      }
      expect(changed, `seed ${seed}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('东方改朝换代换国号(地图上的国名跟着年份变,国号档位不变);西幻王室更迭国名不变、王朝名不重', () => {
    let east = 0;
    let west = 0;
    for (const seed of [7, 2024, 3]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      // 全世界的国名词根(含历朝)不重复:东方新朝不和本国以前的国号、也不和别国撞名
      const roots = new Map<string, number>();
      const bare = (r: string) => ([...r].length === 2 && r[0] === '大' ? r.slice(1) : r);
      for (const p of civ.polities) {
        for (const r of polityRoots(p)) {
          const o = roots.get(bare(r));
          expect(o === undefined || o === p.id, `seed ${seed} ${r} 撞名`).toBe(true);
          roots.set(bare(r), p.id);
        }
      }
      for (const e of civ.annals.filter((x) => x.kind === 'dynasty')) {
        const p = civ.polities[e.a];
        const before = polityName(p, e.year - EPS);
        const after = polityName(p, e.year);
        const i = dynastyIndexAt(p, e.year);
        expect(i).toBeGreaterThanOrEqual(1);
        expect(dynastyAt(p, e.year)!.year).toBe(e.year);
        // 国号档位不因改朝换代而变(只升不降)
        expect(polityTierAt(p, e.year)).toBeGreaterThanOrEqual(polityTierAt(p, e.year - EPS));
        if (p.eastern) {
          east++;
          expect(after, `seed ${seed} ${before}`).not.toBe(before);
          expect(polityRootAt(p, e.year)).toBe(p.dynasties![i].name);
          expect(polityRootAt(p, e.year - EPS)).toBe(p.dynasties![i - 1].name);
          expect(polityTitles(p, e.year)).not.toEqual(polityTitles(p, e.year - EPS));
          // 本国以前的国号不再用
          for (let j = 0; j < i; j++) expect(p.dynasties![j].name).not.toBe(p.dynasties![i].name);
          // 中原、仙侠语感单字为主
          expect([...p.dynasties![i].name].length).toBeLessThanOrEqual(3);
          expect(after).not.toMatch(/王国|帝国|共和国|城邦|大大/);
        } else {
          west++;
          expect(after.startsWith(p.name), `seed ${seed} ${after}`).toBe(true);
          expect(polityRootAt(p, e.year)).toBe(p.name);
          expect(dynastyTitle(p, i)).toMatch(/王朝$/);
          expect(dynastyTitle(p, i)).not.toBe(dynastyTitle(p, i - 1));
        }
      }
      // 地图文字的字(历朝的全称、简称)都不空
      for (const p of civ.polities) for (const t of polityAllTitles(p)) expect(t.length).toBeGreaterThan(0);
    }
    expect(east).toBeGreaterThanOrEqual(5);
    expect(west).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('调参:只有大国(和当朝很老的中等国家)换;东方一朝平均 150–450 年;每个世界改朝换代 / 王室更迭 5–40 次,东方 ≤ 20 次、两个世界合计 ≥ 5 次', () => {
    // 东方改朝换代的次数看这个世界里大国是不是东方语感(起名时才定):seed 7 的大国(阶段 4 推演随机数按位置取以后)多是西幻,
    // 东方只换了一两次;所以"东方 5–20 次"改按两个世界合计算,每个世界只要求有改朝换代 / 王室更迭
    let eastSum = 0;
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const s = dynastyStats(civ);
      const tag = `seed ${seed}`;
      eastSum += s.eastern;
      expect(s.eastern + s.western, tag).toBeGreaterThanOrEqual(5);
      expect(s.eastern + s.western, tag).toBeLessThanOrEqual(40);
      expect(s.eastern, tag).toBeGreaterThanOrEqual(1);
      expect(s.eastern, tag).toBeLessThanOrEqual(20);
      expect(s.meanEastern, tag).toBeGreaterThanOrEqual(150);
      expect(s.meanEastern, tag).toBeLessThanOrEqual(450); // 阶段 4 地形洼地按位置取以后 seed 2024 约 427 年(seed 99 约 487 年)
      // 不是每个国家都在换:部落不换;换过的国家不超过六成(国家少的世界里大国占的比例高一些);一朝不会上千年
      for (const id of s.perPolity.keys()) expect(Math.max(...(civ.polities[id].titles ?? []).map((t) => t.tier)), tag).toBeGreaterThanOrEqual(1);
      expect(s.perPolity.size, tag).toBeLessThanOrEqual(civ.polities.length * 0.6);
      for (const p of civ.polities) {
        const d = p.dynasties ?? [];
        for (let i = 1; i < d.length; i++) expect(d[i].year - d[i - 1].year, `${tag} ${p.name}`).toBeLessThan(800);
      }
    }
    expect(eastSum, '两个世界东方改朝换代合计').toBeGreaterThanOrEqual(5);
  });

  it('编年史:每次改朝换代一条(标签"朝"),东方大国是大事;"享国 N 年"按当朝算;复国沿用亡国时那一朝的国号', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const list = buildChronicle(civ);
      const dyn = list.filter((e) => e.kind === 'dynasty');
      expect(dyn.length).toBe(civ.annals.filter((e) => e.kind === 'dynasty').length);
      for (const e of dyn) {
        const p = civ.polities[e.polities[0]];
        const i = dynastyIndexAt(p, e.year);
        const n = Math.floor(e.year) - Math.floor(p.dynasties![i - 1].year);
        expect(e.tag).toBe('朝');
        expect(e.text).not.toMatch(/某国|undefined|NaN|-1|旧王室/);
        expect(e.text).toContain(`享国 ${n} 年`);
        if (p.eastern) {
          // "大昌享国 312 年而亡,景氏起于青州代之,国号大景,定都青阳" / "…,权臣景氏篡位,国号大景" / "…,入主昌京,国号大景"
          expect(e.text).toMatch(/^.+享国 \d+ 年而亡,(权臣.+氏篡位|.+氏起于.+),国号.+$/);
          expect(e.text).toContain(`${polityRootAt(p, e.year)}氏`);
          // 当时第 DYNASTY_TIER 档以上的是大事
          expect(e.importance).toBe(polityTierAt(p, e.year) >= DYNASTY_TIER ? MAJOR : 2);
        } else {
          // "索拉特王国王室更迭,塞伦纳王朝享国 312 年而终,卡诺王朝兴"
          expect(e.text).toMatch(/^.+(王室更迭|汗位易主),.+王朝享国 \d+ 年而终,.+王朝兴(,迁都.+)?$/);
          expect(e.text).toContain(dynastyTitle(p, i));
          expect(e.importance).toBeLessThan(MAJOR);
        }
        expect(filterChronicle([e], { polity: p.id })).toHaveLength(1);
      }
      // 亡国的"享国 N 年"按当朝算
      for (const e of list.filter((x) => x.kind === 'fall')) {
        const p = civ.polities[e.polities[0]];
        if (!p.dynasties) continue;
        const start = p.dynasties[dynastyIndexAt(p, e.year)].year;
        const m = e.text.match(/享国 (\d+) 年/);
        if (m) expect(Number(m[1])).toBe(Math.floor(e.year) - Math.floor(start));
      }
    }
  });

  it('地图:改朝换代之后国名跟着换(东方),缓存不串年份', () => {
    const w = world({ ...DEFAULT_PARAMS, seed: 7 });
    const civ = civOf({ ...DEFAULT_PARAMS, seed: 7 });
    const raster = rasterize(w, 1);
    const e = civ.annals.find((x) => x.kind === 'dynasty' && civ.polities[x.a].eastern && x.year > 1500)!;
    expect(e).toBeDefined();
    const p = civ.polities[e.a];
    const names = (y: number) =>
      polityLabels(w, raster, civ, y, { refCss: REF_MAP_CSS })
        .labels.filter((l) => l.polity === p.id)
        .map((l) => l.text);
    const y0 = Math.floor(e.year) - 1;
    const y1 = Math.ceil(e.year) + 1;
    const want = (y: number) => [polityName(p, y), polityShortTitle(p, polityTierAt(p, y), y)];
    const a = names(y0);
    const b = names(y1);
    const a2 = names(y0);
    expect(a.length).toBe(1);
    expect(want(y0)).toContain(a[0]);
    expect(want(y1)).toContain(b[0]);
    expect(a[0]).not.toBe(b[0]);
    expect(a2).toEqual(a);
  });

  it('国号小工具:第几朝、当朝词根、各朝全称和简称、国号路线(国家面板改国名时预览)', () => {
    const p: Polity = {
      id: 0,
      name: '昌',
      culture: 0,
      capital: 0,
      founded: 100,
      kind: 'farm',
      expansionism: 1,
      color: [0, 0, 0],
      lineage: 'realm',
      titles: [
        { year: 100, tier: 0 },
        { year: 300, tier: 1 },
        { year: 500, tier: 2 },
        { year: 900, tier: 3 },
      ],
      eastern: true,
      capitals: [{ year: 100, settlement: 0 }],
      dynasties: [
        { year: 100, name: '昌', seat: 0 },
        { year: 700, name: '景', seat: 1 },
        { year: 1100, name: '雍', seat: 2 },
      ],
    };
    expect([50, 100, 699, 700, 1099, 1100, 3000].map((y) => dynastyIndexAt(p, y))).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(polityName(p, 600)).toBe('大昌');
    expect(polityName(p, 700)).toBe('大景');
    expect(polityName(p, 950)).toBe('大景王朝');
    expect(polityName(p, 1200)).toBe('大雍王朝');
    expect(polityShortTitle(p, 3, 1200)).toBe('大雍');
    expect(polityShortTitle(p, 3)).toBe('大昌');
    expect(polityTitles(p)).toEqual(['昌部', '昌国', '大昌', '大昌王朝']);
    expect(polityTitles(p, 800)).toEqual(['景部', '景国', '大景', '大景王朝']);
    expect(polityRoots(p)).toEqual(['昌', '景', '雍']);
    expect(polityTitleChain(p)).toBe('昌部 → 昌国 → 大昌 → 大景 → 大景王朝 → 大雍王朝');
    // 西幻:国名不变
    const q: Polity = { ...p, name: '索拉特', eastern: false, dynasties: p.dynasties!.map((d, i) => ({ ...d, name: ['塞伦纳', '卡诺', '瓦伦'][i] })) };
    expect(polityName(q, 1200)).toBe('索拉特帝国');
    expect(polityRootAt(q, 1200)).toBe('索拉特');
    expect(dynastyTitle(q, 1)).toBe('卡诺王朝');
    expect(polityTitleChain(q)).toBe('索拉特部 → 索拉特国 → 索拉特王国 → 索拉特帝国');
    // 没改朝换代过的国家照旧
    const r: Polity = { ...p, dynasties: undefined };
    expect(polityName(r, 1200)).toBe('大昌王朝');
    expect(dynastyAt(r, 1200)).toBeUndefined();
    expect(dynastyTitle(r, 0)).toBe('');
  });
});
