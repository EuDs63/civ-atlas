/**
 * 城市兴衰(阶段 3,cities.ts):洗劫、毁城、重建、旧都衰落;人口按年份段现算;接着推逐字节一致;
 * 史事字段;通往废城的路荒废;地图上的遗址记号、悬停、编年史措辞。
 */
import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { generateCiv, type Civ, type Settlement } from '../src/gen/civ';
import { CivSim } from '../src/gen/civ/sim';
import { ownersAt } from '../src/gen/civ/timeline';
import { polityModelOf } from '../src/gen/civ/polities';
import { cityModelOf, cityStats } from '../src/gen/civ/cities';
import { CAPITAL_BOOST, CAPITAL_DECLINE, CAPITAL_RAMP, SACK_RECOVER, capitalLevel, populationAt, ruinSites } from '../src/gen/civ/growth';
import { buildChronicle, filterChronicle, MAJOR } from '../src/gen/civ/chronicle';
import { routeCities } from '../src/gen/civ/polities';
import { rasterize } from '../src/gen/raster';
import { civMapLayer } from '../src/render/civ/labels';
import { RUIN, ruinsAt } from '../src/render/civ/settlements';
import { CIV_SHOW_OFF } from '../src/render/civ/overlay';
import { describeCiv, nearestSettlement } from '../src/ui/civDescribe';
import { setCivTime } from '../src/ui/civView';

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

/** 先推到 cut 年、fromCiv 接着推到 whole.endYear:和一口气推完逐项比(日志、检查点、归属、史事、国家表、城镇表) */
function expectResumeSame(w: World, whole: Civ, cut: number) {
  const half = generateCiv(w, { endYear: cut });
  const before = JSON.stringify(half.settlements);
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
  res.checkpoints.forEach((c, i) => expect(bytes(c.polity).equals(bytes(whole.checkpoints[i].polity)), `${tag}:检查点 ${c.year}`).toBe(true));
  expect(JSON.stringify(res.annals), `${tag}:史事`).toBe(JSON.stringify(whole.annals));
  const m = polityModelOf(sim)!;
  expect(JSON.stringify(strip(m.polities)), `${tag}:国家表`).toBe(JSON.stringify(strip(whole.polities)));
  expect(JSON.stringify(strip(m.settlements)), `${tag}:城镇表`).toBe(JSON.stringify(strip(whole.settlements)));
  // 接着推不改传进来的城镇表(国都年份段、洗劫记录都复制了一份)
  expect(JSON.stringify(half.settlements), `${tag}:不改传进来的城镇表`).toBe(before);
  return sim;
}

/** 一座城(单测用):建城那年人口 = 上限 / 41,growth 大时很快长满 */
function city(extra: Partial<Settlement> = {}): Settlement {
  return { id: 0, cell: 0, region: 0, culture: 0, name: '渭城', founded: 0, capacity: 100, growth: 0.05, port: false, ...extra };
}

describe('城市兴衰 · 人口按年份段现算', () => {
  it('洗劫:当年人口折损,之后按 SACK_RECOVER 年慢慢恢复;被毁之后为 0', () => {
    const s = city({ sacks: [{ year: 1000, loss: 0.5 }] });
    const full = populationAt(city(), 1000);
    expect(populationAt(s, 1000 - 1 / 256)).toBeCloseTo(full, 6);
    expect(populationAt(s, 1000)).toBeCloseTo(full * 0.5, 6);
    expect(populationAt(s, 1000 + SACK_RECOVER)).toBeCloseTo(full * (1 - 0.5 / Math.E), 6);
    expect(populationAt(s, 1400) / full).toBeGreaterThan(0.99);
    // 两次洗劫叠在一起
    const twice = city({ sacks: [{ year: 1000, loss: 0.5 }, { year: 1010, loss: 0.4 }] });
    expect(populationAt(twice, 1010)).toBeCloseTo(full * (1 - 0.5 * Math.exp(-10 / SACK_RECOVER)) * 0.6, 6);
    // 被毁
    const razed = city({ ended: 1200 });
    expect(populationAt(razed, 1200)).toBe(0);
    expect(populationAt(razed, 2999)).toBe(0);
    expect(populationAt(razed, 1199)).toBeGreaterThan(0);
  });

  it('国都加成:立都后 CAPITAL_RAMP 年加满;失去国都之位后 CAPITAL_DECLINE 年退掉;再立都从剩下的接着加;旧数据只有 capitalFrom 照旧', () => {
    const base = populationAt(city(), 2000);
    const s = city({ capitalFrom: 500, capitalSpans: [{ from: 500, until: 1000, polity: 0 }] });
    expect(capitalLevel(s, 500 + CAPITAL_RAMP / 2)).toBeCloseTo(0.5, 9);
    expect(capitalLevel(s, 1000)).toBe(1);
    expect(capitalLevel(s, 1000 + CAPITAL_DECLINE / 3)).toBeCloseTo(2 / 3, 9);
    expect(capitalLevel(s, 1000 + CAPITAL_DECLINE)).toBe(0);
    expect(populationAt(s, 1000)).toBeCloseTo(base * (1 + CAPITAL_BOOST), 6);
    expect(populationAt(s, 2000)).toBeCloseTo(base, 6);
    // 旧都一两百年里回落:每年都在往下走,直到加成退完
    for (let y = 1000; y < 1000 + CAPITAL_DECLINE; y += 10) expect(populationAt(s, y + 10)).toBeLessThan(populationAt(s, y));
    // 再立都:从剩下的那几成接着加
    const again = city({ capitalFrom: 500, capitalSpans: [{ from: 500, until: 1000, polity: 0 }, { from: 1050, polity: 1 }] });
    const left = 1 - 50 / CAPITAL_DECLINE;
    expect(capitalLevel(again, 1050)).toBeCloseTo(left, 9);
    expect(capitalLevel(again, 1070)).toBeCloseTo(Math.min(1, left + 20 / CAPITAL_RAMP), 9);
    expect(capitalLevel(again, 5000)).toBe(1);
    // 只有 capitalFrom(旧数据):和原来一样从 capitalFrom 起一直是国都
    const old = city({ capitalFrom: 500 });
    expect(capitalLevel(old, 600)).toBeCloseTo(100 / CAPITAL_RAMP, 9);
    expect(capitalLevel(old, 5000)).toBe(1);
  });
});

describe('城市兴衰 · 推演', () => {
  it('fromCiv 接着推:在第 1200 年、毁城 / 重建 / 洗劫 / 旧都渐衰那一刻和那一年切开,和一口气推完逐字节一致', () => {
    const p = { ...DEFAULT_PARAMS, seed: 7 };
    const w = world(p);
    const whole = civOf(p);
    const A = whole.annals;
    const first = (k: string) => A.find((e) => e.kind === k && e.year > 400)!;
    const ruin = first('ruin');
    const rebuild = first('rebuild');
    const sack = first('sack');
    const decline = first('decline');
    for (const e of [ruin, rebuild, sack, decline]) expect(e, '四种事都有').toBeDefined();
    const cuts = new Set([1200, ruin.year, Math.floor(ruin.year), rebuild.year, Math.floor(rebuild.year), sack.year, decline.year]);
    for (const cut of cuts) expectResumeSame(w, whole, cut);
    // 接着推之后,毁城计数(按战争)从史事里重建出来了
    const sim = CivSim.fromCiv(w, generateCiv(w, { endYear: 2000 }));
    const razed = [...cityModelOf(sim)!.razed.values()].reduce((a, b) => a + b, 0);
    expect(razed).toBe(A.filter((e) => e.kind === 'ruin' && e.year <= 2000).length);
  }, 120_000);

  it('确定性:同一个种子两次,史事、城镇表逐字节相同', () => {
    const w = world({ ...DEFAULT_PARAMS, seed: 2024 });
    const a = generateCiv(w);
    const b = generateCiv(w);
    expect(JSON.stringify(a.annals)).toBe(JSON.stringify(b.annals));
    expect(JSON.stringify(a.settlements)).toBe(JSON.stringify(b.settlements));
    expect(JSON.stringify(a.routes.map((r) => [r.built, r.abandoned ?? null, [...r.cells]]))).toBe(JSON.stringify(b.routes.map((r) => [r.built, r.abandoned ?? null, [...r.cells]])));
  });

  it('populationAt 任何年份都有限、非负;被毁后为 0', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const years = [0, 500.5, 1234.567, 2000, civ.endYear];
      for (const e of civ.annals) if (e.kind === 'sack' || e.kind === 'ruin' || e.kind === 'decline') years.push(e.year - 1 / 512, e.year, e.year + 1 / 512, e.year + 37.3);
      for (const s of civ.settlements) {
        for (const y of years) {
          const pop = populationAt(s, y);
          expect(Number.isFinite(pop)).toBe(true);
          expect(pop).toBeGreaterThanOrEqual(0);
          if (s.ended !== undefined && y >= s.ended) expect(pop).toBe(0);
        }
        for (const k of s.sacks ?? []) {
          expect(k.loss).toBeGreaterThan(0);
          expect(k.loss).toBeLessThan(1);
        }
      }
    }
  });

  it('史事按约定的字段记:洗劫 / 毁城紧挨在同一刻的攻占前面;重建在故址上;旧都衰落时确实失去了国都之位、人口回落', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const A = civ.annals;
      const S = civ.settlements;
      A.forEach((e, i) => {
        const tag = `seed ${seed} 第 ${i} 条 ${e.kind}`;
        if (e.kind === 'sack' || e.kind === 'ruin') {
          // 后面(同一刻可能还有别的洗劫 / 毁城)紧跟着这一州的攻占:同一场战争、同一对国家
          let j = i + 1;
          while (A[j] && (A[j].kind === 'sack' || A[j].kind === 'ruin') && A[j].year === e.year) j++;
          const c = A[j];
          expect(c.kind, tag).toBe('conquer');
          expect([c.year, c.region, c.a, c.b, c.war, c.settlement], tag).toEqual([e.year, e.region, e.a, e.b, e.war, e.settlement]);
          expect(e.war, tag).toBeGreaterThanOrEqual(0);
          const s = S[e.settlement];
          expect(s.region, tag).toBe(e.region);
          if (e.kind === 'ruin') expect(s.ended, tag).toBe(e.year);
          else expect(s.sacks!.some((k) => k.year === e.year), tag).toBe(true);
        } else if (e.kind === 'rebuild') {
          const s = S[e.settlement];
          const old = S[s.rebuilds!];
          expect(s.founded, tag).toBe(e.year);
          expect(old.region, tag).toBe(e.region);
          expect(s.region, tag).toBe(e.region);
          expect(s.cell, tag).toBe(old.cell);
          expect(old.ended!, tag).toBeLessThan(e.year);
          expect(e.a, tag).toBe(ownersAt(civ, e.year).polity[e.region]);
          expect(e.b, tag).toBe(-1);
        } else if (e.kind === 'decline') {
          const s = S[e.settlement];
          const sp = s.capitalSpans!.filter((x) => x.until !== undefined && x.until < e.year).pop()!;
          expect(sp, tag).toBeDefined();
          expect(sp.polity, tag).toBe(e.a);
          expect(populationAt(s, e.year), tag).toBeLessThan(populationAt(s, sp.until!));
          expect(s.ended === undefined || s.ended > e.year, tag).toBe(true);
        }
      });
      // 城镇表和史事对得上:每座被毁的城有一条毁城,每座重建的城有一条重建,每次洗劫有一条洗劫
      expect(S.filter((s) => s.ended !== undefined).length).toBe(A.filter((e) => e.kind === 'ruin').length);
      expect(S.filter((s) => s.rebuilds !== undefined).length).toBe(A.filter((e) => e.kind === 'rebuild').length);
      expect(S.reduce((n, s) => n + (s.sacks?.length ?? 0), 0)).toBe(A.filter((e) => e.kind === 'sack').length);
      // 国都年份段:和各国的国都变迁表一致(每一段 = 某国做国都的那一段)
      for (const p of civ.polities) {
        const caps = p.capitals!;
        caps.forEach((c, k) => {
          const until = k + 1 < caps.length ? caps[k + 1].year : p.ended;
          const sp = S[c.settlement].capitalSpans!.find((x) => x.polity === p.id && x.from === c.year);
          expect(sp, `${p.name} 的第 ${k} 个国都`).toBeDefined();
          expect(sp!.until).toBe(until);
        });
      }
    }
  });

  it('默认参数 seed 7 / 2024:毁城 5–45 座、多数是村镇;一场战争最多毁 3 座;有重建也有留下的遗址;有洗劫、有旧都渐衰', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const c = cityStats(civ);
      const tag = `seed ${seed}`;
      expect(c.ruins, tag).toBeGreaterThanOrEqual(5);
      expect(c.ruins, tag).toBeLessThanOrEqual(45);
      expect(c.ruinsByRank[0] + c.ruinsByRank[1], tag).toBeGreaterThan(c.ruins / 2);
      expect(c.maxRuinsPerWar, tag).toBeLessThanOrEqual(3);
      expect(c.rebuilds, tag).toBeGreaterThan(0);
      expect(c.ruinsAtEnd, tag).toBeGreaterThan(0);
      expect(c.sacks, tag).toBeGreaterThan(c.ruins);
      expect(c.declines, tag).toBeGreaterThan(0);
      // 被毁的城不算城镇:结束时每个有人住的州最多一座还在的城
      const alive = civ.settlements.filter((s) => s.ended === undefined);
      expect(new Set(alive.map((s) => s.region)).size).toBe(alive.length);
    }
  });

  it('通往废城的路荒废:结束时还在用的路不会以废城为尽头(路过废城的干道照常);荒废年份不早于修路年份', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const w = world({ ...DEFAULT_PARAMS, seed });
      const ruins = new Set(ruinSites(civ, civ.endYear).map((s) => s.cell));
      const live = civ.routes.filter((r) => r.abandoned === undefined && r.kind !== 'sea');
      // 每个地块连着几段还在用的路
      const deg = new Map<number, Set<number>>();
      const link = (a: number, b: number) => {
        let d = deg.get(a);
        if (!d) deg.set(a, (d = new Set()));
        d.add(b);
      };
      for (const r of live) {
        for (let t = 1; t < r.cells.length; t++) {
          link(r.cells[t - 1], r.cells[t]);
          link(r.cells[t], r.cells[t - 1]);
        }
      }
      for (const c of ruins) {
        const d = deg.get(c)?.size ?? 0;
        expect(d === 0 || d >= 2, `seed ${seed} 遗址 ${c} 连着 ${d} 段路`).toBe(true);
      }
      for (const r of civ.routes) if (r.abandoned !== undefined) expect(r.abandoned).toBeGreaterThan(r.built);
      // 修路用的城:同一处城址先后的城合成一座,毁了没重建的记 ended
      const rc = routeCities(civ.settlements, civ.polities, civ.endYear);
      expect(new Set(rc.map((c) => c.cell)).size).toBe(rc.length);
      for (const c of rc) if (c.ended !== undefined) expect(ruins.has(c.cell)).toBe(true);
      expect(w.mesh.n).toBeGreaterThan(0);
    }
  });
});

describe('城市兴衰 · 地图、悬停、编年史', () => {
  it('地图:遗址画成"故城遗址"记号(不和还在的城重叠),回放到毁城之前没有;放大后写"古某城"', () => {
    const p = { ...DEFAULT_PARAMS, seed: 7 };
    const w = world(p);
    const civ = civOf(p);
    const raster = rasterize(w, 1);
    const ruin = civ.annals.find((e) => e.kind === 'ruin')!;
    const at = (year: number) => civMapLayer({ world: w, raster, civ, style: 'fantasy', year, show: { ...CIV_SHOW_OFF, polities: true } });
    const end = at(civ.endYear);
    const marks = end.marks.filter((m) => m.kind === RUIN);
    expect(marks.length).toBe(ruinsAt(civ, civ.endYear).length);
    expect(marks.length).toBeGreaterThan(0);
    const cells = new Set(end.marks.filter((m) => m.kind !== RUIN).map((m) => civ.settlements[m.id].cell));
    for (const m of marks) expect(cells.has(civ.settlements[m.id].cell)).toBe(false);
    expect(end.items.some((it) => it.text.startsWith('古'))).toBe(true);
    // 毁城那一刻之前没有这处遗址,之后有
    const before = at(ruin.year - 1).marks.filter((m) => m.kind === RUIN).map((m) => m.id);
    const after = at(ruin.year).marks.filter((m) => m.kind === RUIN).map((m) => m.id);
    expect(before).not.toContain(ruin.settlement);
    expect(after).toContain(ruin.settlement);
  });

  it('悬停:遗址所在的州写"故城遗址 · 某城(第 N 年毁于兵火)";最近城市不会是被毁的城;重建以后不再写遗址', () => {
    const civ = civOf({ ...DEFAULT_PARAMS, seed: 7 });
    const ruin = civ.annals.find((e) => e.kind === 'ruin')!;
    const s = civ.settlements[ruin.settlement];
    const cell = civ.regions.seat[s.region];
    try {
      setCivTime({ year: ruin.year + 1 });
      const lines = describeCiv(civ, cell);
      expect(lines).toContain(`故城遗址 · ${s.name}(第 ${Math.floor(ruin.year)} 年毁于兵火)`);
      expect(nearestSettlement(civ, s.region, ruin.year + 1)).not.toBe(s.id);
      setCivTime({ year: ruin.year - 1 });
      expect(describeCiv(civ, cell).some((l) => l.startsWith('故城遗址'))).toBe(false);
      expect(nearestSettlement(civ, s.region, ruin.year - 1)).toBe(s.id);
      const re = civ.settlements.find((x) => x.rebuilds === s.id);
      if (re) {
        setCivTime({ year: re.founded + 1 });
        expect(describeCiv(civ, cell).some((l) => l.startsWith('故城遗址'))).toBe(false);
        expect(nearestSettlement(civ, s.region, re.founded + 1)).toBe(re.id);
      }
    } finally {
      setCivTime({ year: null });
    }
  });

  it('编年史:毁城单列(大城是大事)也折进战争、排在攻占后面;洗劫只在战争里;重建、旧都渐衰各一条;措辞干净', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const A = civ.annals;
      const list = buildChronicle(civ);
      const top = new Map(list.map((e) => [e.id, e]));
      const kids = new Map<number, { war: number; index: number }>();
      for (const e of list) if (e.kind === 'war') e.children!.forEach((c, index) => kids.set(c.id, { war: e.id, index }));
      A.forEach((e, i) => {
        const tag = `seed ${seed} 第 ${i} 条 ${e.kind}`;
        if (e.kind === 'sack' || e.kind === 'ruin') {
          const k = kids.get(i);
          expect(k, tag).toBeDefined();
          // 排在那条攻占后面
          const w = top.get(k!.war)!;
          const conquer = w.children!.findIndex((c) => c.kind === 'conquer' && A[c.id].region === e.region && A[c.id].year === e.year);
          expect(conquer, tag).toBeGreaterThanOrEqual(0);
          expect(conquer, tag).toBeLessThan(k!.index);
          expect(top.has(i), tag).toBe(e.kind === 'ruin');
        }
        if (e.kind === 'rebuild' || e.kind === 'decline') expect(top.has(i), tag).toBe(true);
      });
      for (const e of list) {
        for (const x of [e, ...(e.children ?? [])]) {
          if (!['sack', 'ruin', 'rebuild', 'decline'].includes(x.kind)) continue;
          expect(x.text).not.toMatch(/undefined|NaN|某国|一城/);
          expect(x.text.length).toBeGreaterThan(3);
          if (x.kind === 'ruin') expect(x.text).toMatch(/破|焚毁|毁于|屠/);
          if (x.kind === 'sack') expect(x.text).toMatch(/洗劫|大掠/);
          if (x.kind === 'rebuild') expect(x.text).toMatch(/重建|新城/);
          if (x.kind === 'decline') expect(x.text).toMatch(/[旧故]都.+渐衰$/);
          expect(['掠', '毁', '建', '衰']).toContain(x.tag);
        }
      }
      // 小镇被毁不是大事;"大事"里的毁城都是城以上
      for (const e of filterChronicle(list, { major: true })) if (e.kind === 'ruin') expect(e.importance).toBe(MAJOR);
    }
  });
});
