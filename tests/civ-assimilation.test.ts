/**
 * 民族同化与迁徙(阶段 3,assimilation.ts):同化、随征服而来的移民、避兵外迁、孤地被四邻同化、民族消亡;
 * 接着推逐字节一致、不闪烁、史事字段、编年史措辞。
 */
import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { Layer, type Annal, type AnnalKind, type Culture, type Polity } from '../src/gen/civ/types';
import { CivSim, Ev } from '../src/gen/civ/sim';
import { ownersAt } from '../src/gen/civ/timeline';
import { polityModelOf } from '../src/gen/civ/polities';
import { HOLD, assimModelOf, assimStats } from '../src/gen/civ/assimilation';
import { polityName } from '../src/gen/civ/growth';
import {
  ASSIM_GAP,
  ASSIM_MAJOR,
  ASSIM_SPAN,
  MIGRATE_MAJOR,
  buildChronicle,
  filterChronicle,
  type ChronicleEntry,
} from '../src/gen/civ/chronicle';

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

/** 名字、配色、语感、国号写法、朝名在推演结束后才定:只比推演出来的部分 */
const strip = <T extends { name: string; color?: unknown; dynasties?: { name: string }[] }>(a: T[]) =>
  a.map((x) => ({ ...x, name: '', color: 0, eastern: undefined, style: '', dynasties: x.dynasties?.map((d) => ({ ...d, name: '' })) }));

/** 先推到 cut 年、fromCiv 接着推到 whole.endYear:和一口气推完逐项比(日志、检查点、归属、史事、国家表、城镇表、民族表) */
function expectResumeSame(w: World, whole: Civ, cut: number) {
  const half = generateCiv(w, { endYear: cut });
  const before = JSON.stringify(half.cultures);
  const sim = CivSim.fromCiv(w, half);
  sim.run(whole.endYear);
  const res = sim.result();
  const L = whole.log;
  const tag = `从第 ${cut} 年接着推`;
  expect(res.log.size, tag).toBe(L.size);
  for (const k of ['year', 'region', 'layer', 'value', 'cause'] as const) {
    expect(bytes(res.log[k]).equals(bytes(L[k].subarray(0, L.size))), `${tag}:日志 ${k}`).toBe(true);
  }
  expect(bytes(res.culture).equals(bytes(whole.culture)), `${tag}:民族层`).toBe(true);
  expect(bytes(res.polity).equals(bytes(whole.polity)), `${tag}:国家层`).toBe(true);
  res.checkpoints.forEach((c, i) => {
    expect(bytes(c.culture).equals(bytes(whole.checkpoints[i].culture)), `${tag}:检查点 ${c.year}`).toBe(true);
    expect(bytes(c.polity).equals(bytes(whole.checkpoints[i].polity)), `${tag}:检查点 ${c.year}`).toBe(true);
  });
  expect(JSON.stringify(res.annals), `${tag}:史事`).toBe(JSON.stringify(whole.annals));
  const m = polityModelOf(sim)!;
  expect(JSON.stringify(strip(m.polities)), `${tag}:国家表`).toBe(JSON.stringify(strip(whole.polities)));
  expect(JSON.stringify(strip(m.settlements)), `${tag}:城镇表`).toBe(JSON.stringify(strip(whole.settlements)));
  const am = assimModelOf(sim)!;
  expect(JSON.stringify(strip(am.cultures)), `${tag}:民族表(消亡、迁徙)`).toBe(JSON.stringify(strip(whole.cultures)));
  // 接着推不改传进来的 civ
  expect(JSON.stringify(half.cultures), `${tag}:不改传进来的民族表`).toBe(before);
}

describe('同化与迁徙', () => {
  it('fromCiv 接着推:在第 1200 年、迁徙 / 同化 / 孤地同化 / 民族消亡那一刻切开,和一口气推完逐字节一致(史事、日志、国家表、民族表)', () => {
    const seen = { migrate: 0, assimilate: 0, enclave: 0, vanish: 0 };
    for (const seed of [7, 2024, 3]) {
      const w = world({ ...small, seed });
      const whole = civOf({ ...small, seed });
      const A = whole.annals;
      const cuts = new Set<number>([1200]);
      const pick = (kind: keyof typeof seen, ys: number[]) => {
        for (const y of [...new Set(ys)].slice(0, 2)) {
          cuts.add(y);
          seen[kind]++;
        }
      };
      pick('migrate', A.filter((e) => e.kind === 'migrate').map((e) => e.year));
      pick('assimilate', A.filter((e) => e.kind === 'assimilate' && e.war >= 0).map((e) => e.year));
      pick('enclave', A.filter((e) => e.kind === 'assimilate' && e.war < 0).map((e) => e.year));
      pick('vanish', A.filter((e) => e.kind === 'vanish').map((e) => e.year));
      for (const cut of [...cuts].sort((a, b) => a - b)) expectResumeSame(w, whole, cut);
    }
    expect(seen.migrate).toBeGreaterThanOrEqual(2);
    expect(seen.assimilate).toBeGreaterThanOrEqual(2);
    expect(seen.enclave).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('确定性:同一个种子两次,日志、史事、民族表逐字节相同', () => {
    const a = civOf({ ...small, seed: 2024 });
    const b = generateCiv(generateWorld({ ...small, seed: 2024 }));
    expect(a.annals.some((e) => e.kind === 'assimilate')).toBe(true);
    expect(JSON.stringify(a.annals)).toBe(JSON.stringify(b.annals));
    expect(JSON.stringify(a.cultures)).toBe(JSON.stringify(b.cultures));
    for (const k of ['year', 'region', 'layer', 'value', 'cause'] as const) {
      expect(bytes(a.log[k].subarray(0, a.log.size)).equals(bytes(b.log[k].subarray(0, b.log.size))), k).toBe(true);
    }
  });

  it('史事按约定的字段记;定居之后民族层只因同化、迁徙而变,一律走 setOwner(日志原因对得上)', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const tag = `seed ${seed}`;
      const L = civ.log;
      // 定居之后的改换:原因只能是同化或迁徙;每条都有一条对应的史事
      const cur = new Int16Array(civ.regions.count).fill(-1);
      const changes = new Map<string, number>();
      for (let i = 0; i < L.size; i++) {
        if (L.layer[i] !== Layer.Culture) continue;
        const r = L.region[i];
        if (cur[r] >= 0) {
          expect([Ev.Assimilate, Ev.Migrate], `${tag} 日志 ${i}`).toContain(L.cause[i]);
          changes.set(`${L.year[i]}|${r}`, L.cause[i]);
        } else expect([Ev.CultureBorn, Ev.CultureArrive, Ev.Migrate], `${tag} 日志 ${i}`).toContain(L.cause[i]);
        expect(L.value[i], `${tag}:民族层不会变回没人住`).toBeGreaterThanOrEqual(0);
        cur[r] = L.value[i];
      }
      const A = civ.annals;
      const waves = new Map<number, Set<number>>();
      let mine = 0;
      A.forEach((e, i) => {
        if (e.kind !== 'assimilate' && e.kind !== 'migrate' && e.kind !== 'vanish') return;
        const before = ownersAt(civ, e.year - 1 / 512);
        const after = ownersAt(civ, e.year);
        if (e.kind === 'vanish') {
          const prev = A[i - 1];
          expect(['assimilate', 'migrate'], `${tag} 第 ${i} 条`).toContain(prev.kind);
          expect(prev.b).toBe(e.a);
          expect(prev.a).toBe(e.b);
          expect(prev.region).toBe(e.region);
          expect(civ.cultures[e.a].ended).toBe(e.year);
          expect(after.culture.includes(e.a), `${tag}:${civ.cultures[e.a].name}族消亡后一州不剩`).toBe(false);
          expect(civ.culture.includes(e.a)).toBe(false);
          return;
        }
        mine++;
        const cause = e.kind === 'assimilate' ? Ev.Assimilate : Ev.Migrate;
        expect(after.culture[e.region], `${tag} 第 ${i} 条`).toBe(e.a);
        expect(before.culture[e.region]).toBe(e.b);
        expect(e.a).not.toBe(e.b);
        if (e.b >= 0) expect(changes.get(`${e.year}|${e.region}`)).toBe(cause);
        // 州里当时的城(阶段 3 城市兴衰:被毁了的不算)
        const city = civ.settlements.find((s) => s.region === e.region && s.founded <= e.year && !((s.ended ?? Infinity) <= e.year));
        expect(e.settlement).toBe(city ? city.id : -1);
        if (e.kind === 'assimilate') {
          // 统治这一州的国家(−1 = 部落地带里的孤地)
          expect(before.polity[e.region], `${tag} 第 ${i} 条`).toBe(e.war);
          // 统治民族同化异族(新民族 = 统治民族),或统治民族反被多数民族同化(原民族 = 统治民族)
          if (e.war >= 0) expect(civ.polities[e.war].culture === e.a || civ.polities[e.war].culture === e.b).toBe(true);
        } else {
          const P = civ.polities[e.war];
          expect(P, `${tag} 第 ${i} 条迁徙的起因`).toBeDefined();
          // 随征服而来的移民:迁进本国刚打下来的州;避兵外迁:不迁进征服者的国土
          if (P.culture === e.a) expect(before.polity[e.region]).toBe(e.war);
          else expect(before.polity[e.region]).not.toBe(e.war);
          let s = waves.get(e.a);
          if (!s) waves.set(e.a, (s = new Set()));
          s.add(e.year);
        }
      });
      expect(mine).toBeGreaterThan(0);
      // 日志里定居之后的每一次改换,都有一条同化 / 迁徙的史事
      expect(changes.size).toBe(A.filter((e) => (e.kind === 'assimilate' || e.kind === 'migrate') && e.b >= 0).length);
      // 民族表里的迁徙记录:每一波一条,年份对得上
      for (const cu of civ.cultures) {
        const ys = (cu.migrations ?? []).map((m) => m.year);
        expect(ys, `${tag} ${cu.name}`).toEqual([...(waves.get(cu.id) ?? [])]);
        for (const m of cu.migrations ?? []) expect('东南西北').toContain(m.dir);
      }
      // 消亡的民族都有一条 vanish
      for (const cu of civ.cultures) expect(A.filter((e) => e.kind === 'vanish' && e.a === cu.id).length).toBe(cu.ended === undefined ? 0 : 1);
    }
  }, 60_000);

  it('不闪烁:一州改换民族(含最初定居)后 HOLD 年内不再改换,50 年内民族变了 2 次以上的州为 0;城镇的民族是建城那年的民族(不跟着改)', () => {
    for (const seed of [7, 2024, 3]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const L = civ.log;
      const last = new Float64Array(civ.regions.count).fill(-Infinity);
      for (let i = 0; i < L.size; i++) {
        if (L.layer[i] !== Layer.Culture) continue;
        const r = L.region[i];
        expect(L.year[i] - last[r], `seed ${seed} 州 ${r} 第 ${L.year[i]} 年`).toBeGreaterThanOrEqual(HOLD);
        last[r] = L.year[i];
      }
      expect(assimStats(civ).flippy, `seed ${seed}`).toBe(0);
      for (const s of civ.settlements) expect(s.culture, `seed ${seed} ${s.name}`).toBe(ownersAt(civ, s.founded).culture[s.region]);
    }
  });

  it('默认参数 seed 7 / 2024:5%~三成的有人州改换过民族;同化、迁徙都有;民族有减少但留下大多数;大国治下的统治民族占比上升', () => {
    // GENERATOR_VERSION 4(地形像一颗星球:高原多、岛多)以后同化少了一些:改换过民族的州 7.6%~14.7%(以前 15%~22%),
    // seed 7 只有 1 波迁徙(以前 6~8 波)。下限按新世界放宽。
    // GENERATOR_VERSION 7(洋流改了气候,历史重排)以后 seed 7 改换过民族的州 5.4%、同化 41 州、没有迁徙。
    // 20 个种子前后比:改换过民族的州平均 14.1% → 12.6%,以前也有只有 5.5%、同化 52 州、没有迁徙的世界。
    // 下限再放宽到 5%、同化 30 州以上;迁徙按两个世界合计算
    let migrations = 0;
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const s = assimStats(civ);
      const tag = `seed ${seed}`;
      expect(s.changedShare, tag).toBeGreaterThanOrEqual(0.05);
      expect(s.changedShare, tag).toBeLessThanOrEqual(0.3);
      expect(s.assimilated, tag).toBeGreaterThan(30);
      migrations += s.migrations;
      expect(s.migrated, tag).toBeGreaterThanOrEqual(s.migrations);
      expect(s.alive, tag).toBeGreaterThanOrEqual(Math.ceil(civ.cultures.length * 0.7));
      expect(s.alive + s.vanished, tag).toBe(civ.cultures.length);
      expect(s.rulingShare, tag).toBeGreaterThan(0.85);
      expect(s.flippy, tag).toBe(0);
      // 消亡的民族:图例上还在民族表里,有消亡年份
      for (const cu of civ.cultures) if (cu.ended !== undefined) expect(cu.ended).toBeLessThanOrEqual(civ.endYear);
    }
    // 两个世界合计至少 3 波迁徙
    expect(migrations).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('大帝国核心区同化明显、边远处保留异族:被同化的州离国都(州图跳数)比结束时留下的异族州近', () => {
    let nearSum = 0;
    let nearN = 0;
    let farSum = 0;
    let farN = 0;
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const reg = civ.regions;
      const hops = (from: number, own: Int16Array, p: number) => {
        const d = new Int32Array(reg.count).fill(-1);
        const q = [from];
        d[from] = 0;
        for (let h = 0; h < q.length; h++) {
          const r = q[h];
          for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
            const j = reg.adj[k];
            if (d[j] < 0 && own[j] === p) {
              d[j] = d[r] + 1;
              q.push(j);
            }
          }
        }
        return d;
      };
      const capOf = (p: Polity, y: number) => {
        let sid = p.capital;
        for (const c of p.capitals ?? []) if (c.year <= y) sid = c.settlement;
        return civ.settlements[sid].region;
      };
      for (const e of civ.annals) {
        if (e.kind !== 'assimilate' || e.war < 0 || civ.polities[e.war].culture !== e.a) continue;
        const own = ownersAt(civ, e.year - 1 / 512).polity;
        const d = hops(capOf(civ.polities[e.war], e.year), own, e.war)[e.region];
        if (d >= 0) {
          nearSum += d;
          nearN++;
        }
      }
      for (const p of civ.polities) {
        if (p.ended !== undefined) continue;
        const d = hops(capOf(p, civ.endYear), civ.polity, p.id);
        for (let r = 0; r < reg.count; r++) {
          if (civ.polity[r] === p.id && civ.culture[r] !== p.culture && d[r] >= 0) {
            farSum += d[r];
            farN++;
          }
        }
      }
    }
    expect(nearN).toBeGreaterThan(20);
    expect(farN).toBeGreaterThan(10);
    expect(nearSum / nearN).toBeLessThan(farSum / farN);
  }, 60_000);

  it('编年史(真实世界):一波迁徙折成一条,同化按国家和年代折叠,民族消亡单列;措辞干净,"大事"不超过五十五条', () => {
    const BAD = /undefined|NaN|null|−1|-1|第 0 州|某国|某族|异族人|Infinity|\[object/;
    for (const seed of [7, 2024, 3]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const A = civ.annals;
      const list = buildChronicle(civ);
      const kids = (k: AnnalKind) => list.filter((e) => e.kind === k);
      // 迁徙:同一刻、同一民族、同一起因的几州一条;子条目就是每一州
      const waves = kids('migrate');
      expect(waves.length).toBe(assimStats(civ).migrations);
      for (const e of waves) {
        expect(e.text, e.text).toMatch(/^.+族(避.+兵锋[东南西北]迁,入|随.+(南下|北上|东进|西进),徙居).+$/);
        expect(e.text).not.toMatch(BAD);
        expect(e.tag).toBe('徙');
        // 亡国后逃难的一波,"大事"里合写进那场战争("…,艾莱斯国亡,艾莱斯族南迁,入阿拉斯等五州")
        const merged = list.some((w) => w.kind === 'war' && w.importance === 3 && w.text.includes(e.text.replace(/避.+兵锋/, '')));
        expect(e.importance).toBe(e.regions.length >= MIGRATE_MAJOR && !merged ? 3 : 2);
        const n = e.children?.length ?? 1;
        expect(n).toBe(e.regions.length);
        for (const c of e.children ?? []) expect(c.text).toMatch(/^.+人(迁入|徙居).+\((原为.+所居|原为无人之地)\)$/);
      }
      // 同化:折叠进来的逐州同化一条不少;一段不超过 ASSIM_SPAN 年,相邻两州相隔不超过 ASSIM_GAP 年
      const as = kids('assimilate');
      expect(as.reduce((n, e) => n + (e.children?.length ?? 1), 0)).toBe(A.filter((e) => e.kind === 'assimilate').length);
      for (const e of as) {
        expect(e.text, e.text).toMatch(/渐为.+人$/);
        expect(e.text).not.toMatch(BAD);
        expect(e.tag).toBe('化');
        expect(e.end - e.year).toBeLessThanOrEqual(ASSIM_SPAN);
        const ys = (e.children ?? [e]).map((c) => c.year);
        for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeLessThanOrEqual(ASSIM_GAP);
        if (e.regions.length >= ASSIM_MAJOR) expect(e.importance).toBe(3);
        else expect(e.importance).toBeLessThan(3);
      }
      for (const e of kids('vanish')) {
        expect(e.text).toMatch(/^.+族亡/);
        expect(e.importance).toBe(3);
      }
      // 和 civ-chronicle.test.ts 的"大事"条数上限一致(seed 7、2024 不超过 50,别的种子不超过 55);同化与迁徙自己的大事不超过十条
      expect(filterChronicle(list, { major: true }).length, `seed ${seed}`).toBeLessThanOrEqual(seed === 3 ? 55 : 50);
      const mineMajor = filterChronicle(list, { major: true }).filter((e) => e.kind === 'migrate' || e.kind === 'assimilate' || e.kind === 'vanish');
      expect(mineMajor.length, `seed ${seed}`).toBeLessThanOrEqual(10);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 编年史措辞:手工造的史事

function culture(id: number, name: string, extra: Partial<Culture> = {}): Culture {
  return { id, name, style: 'central', kind: 'farm', hearth: 0, born: 0, expansionism: 1, color: [120, 90, 60], ...extra };
}

function polity(id: number, name: string, cu: number, founded: number, tier: number, extra: Partial<Polity> = {}): Polity {
  return {
    id,
    name,
    culture: cu,
    capital: 0,
    founded,
    kind: 'farm',
    expansionism: 1,
    color: [120, 90, 60],
    lineage: 'realm',
    titles: [{ year: founded, tier }],
    capitals: [{ year: founded, settlement: 0 }],
    eastern: true,
    ...extra,
  };
}

function annal(year: number, kind: AnnalKind, f: Partial<Omit<Annal, 'year' | 'kind'>> = {}): Annal {
  return { year, kind, a: f.a ?? -1, b: f.b ?? -1, region: f.region ?? -1, settlement: f.settlement ?? -1, war: f.war ?? -1 };
}

describe('编年史 · 同化与迁徙的措辞', () => {
  const REGION_NAMES = ['汾州', '瑞州', '青州', '柳州', '白州', '渭州', '疏勒原', '云州'];
  // 民族:0 渭、1 居兰、2 乌耐(游牧);国家:0 渭(渭族)、1 乌耐(乌耐族,汗国)
  const cultures = [
    culture(0, '渭'),
    culture(1, '居兰', { migrations: [{ year: 1840, dir: '西' }] }),
    culture(2, '乌耐', { kind: 'nomad', migrations: [{ year: 1900.5, dir: '南' }], ended: 2600 }),
  ];
  const wei = polity(0, '渭', 0, 700, 2);
  const unai = polity(1, '乌耐', 2, 800, 1, { lineage: 'khanate', kind: 'nomad', eastern: false });
  const annals: Annal[] = [
    // 居兰族避渭的兵锋西迁,入三州(一州原是无人之地)
    annal(1840, 'migrate', { a: 1, b: 0, region: 6, war: 0 }),
    annal(1840, 'migrate', { a: 1, b: -1, region: 3, war: 0 }),
    annal(1840, 'migrate', { a: 1, b: 2, region: 4, war: 0 }),
    // 乌耐汗国南下,乌耐人徙居一州
    annal(1900.5, 'migrate', { a: 2, b: 0, region: 7, war: 1 }),
    // 渭治下的同化:两段(隔得久的另起一段)
    annal(2000, 'assimilate', { a: 0, b: 1, region: 1, war: 0 }),
    annal(2050, 'assimilate', { a: 0, b: 1, region: 2, war: 0 }),
    annal(2100, 'assimilate', { a: 0, b: 1, region: 3, war: 0 }),
    annal(2100 + ASSIM_GAP + 50, 'assimilate', { a: 0, b: 1, region: 4, war: 0 }),
    // 统治民族反被同化:乌耐汗国的乌耐人渐为渭人
    annal(2400, 'assimilate', { a: 0, b: 2, region: 5, war: 1 }),
    // 部落地带的孤地
    annal(2500, 'assimilate', { a: 0, b: 2, region: 0, war: -1 }),
    // 乌耐族亡:最后一州也被同化
    annal(2600, 'assimilate', { a: 0, b: 2, region: 7, war: -1 }),
    annal(2600, 'vanish', { a: 2, b: 0, region: 7 }),
  ];
  const civ = {
    seed: 1,
    endYear: 3000,
    regions: { count: REGION_NAMES.length, name: REGION_NAMES, capacity: Float32Array.from([50, 40, 30, 20, 10, 60, 45, 8]) },
    cultures,
    polities: [wei, unai],
    settlements: [{ id: 0, cell: 0, region: 5, culture: 0, name: '渭城', founded: 0, capacity: 50, growth: 0.002, port: false }],
    annals,
  } as unknown as Civ;
  const list = buildChronicle(civ);
  const text = (k: AnnalKind) => list.filter((e) => e.kind === k).map((e) => e.text);
  const W = polityName(wei, 1840);
  const U = polityName(unai, 1900.5);

  it('迁徙:一波一条,方位读民族表;避兵外迁写"避某国兵锋西迁",随征服而来写"随某国南下"', () => {
    expect(text('migrate')).toEqual([`居兰族避${W}兵锋西迁,入疏勒原等三州`, `乌耐族随${U}南下,徙居云州`]);
    const wave = list.find((e) => e.kind === 'migrate' && e.children)!;
    expect(wave.children!.map((c) => c.text)).toEqual(['居兰人迁入疏勒原(原为渭人所居)', '居兰人迁入柳州(原为无人之地)', '居兰人迁入白州(原为乌耐人所居)']);
    expect(wave.polities).toEqual([0]);
    expect(wave.regions).toEqual([6, 3, 4]);
    expect(wave.importance).toBe(3 >= MIGRATE_MAJOR ? 3 : 2);
  });

  it('同化:同一国治下、同一对民族按年代折叠;统治民族反被同化、部落地带的孤地各有写法;民族消亡单列', () => {
    const as = list.filter((e) => e.kind === 'assimilate');
    expect(as.map((e) => e.text)).toEqual([
      `${polityName(wei, 2000)}治下,瑞州等三州的居兰人渐为渭人`,
      `${polityName(wei, 2270)}治下,白州的居兰人渐为渭人`,
      `${polityName(unai, 2400)}的乌耐人渐染渭俗,渭州渐为渭人`,
      // 部落地带的两处孤地相隔不到 ASSIM_GAP 年,折成一条
      '汾州、云州的乌耐人渐为渭人',
    ]);
    expect(as[0].year).toBe(2000);
    expect(as[0].end).toBe(2100);
    expect(as[0].children!.map((c) => c.text)).toEqual(['瑞州的居兰人渐为渭人', '青州的居兰人渐为渭人', '柳州的居兰人渐为渭人']);
    expect(as[0].polities).toEqual([0]);
    expect(as[3].polities).toEqual([]);
    expect(as[3].regions).toEqual([0, 7]);
    expect(text('vanish')).toEqual(['乌耐族亡,最后的云州亦为渭人']);
    expect(list.find((e) => e.kind === 'vanish')!.importance).toBe(3);
    // 按国家筛选:渭国的同化、迁徙都在
    const mine = filterChronicle(list, { polity: 0 });
    expect(mine.some((e) => e.kind === 'assimilate') && mine.some((e) => e.kind === 'migrate')).toBe(true);
  });

  it('条目按年份排好;每条都有非空中文和一字标签', () => {
    for (let i = 1; i < list.length; i++) expect(list[i].year).toBeGreaterThanOrEqual(list[i - 1].year);
    const all: ChronicleEntry[] = list.flatMap((e) => [e, ...(e.children ?? [])]);
    for (const e of all) {
      expect(e.text).toMatch(/[一-鿿]/);
      expect(e.text).not.toMatch(/undefined|NaN|−1|-1|某族/);
      expect(e.tag).toMatch(/^[一-鿿]$/);
    }
  });
});
