import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { AdjKind, Layer, type Annal } from '../src/gen/civ/types';
import { CivSim, Ev } from '../src/gen/civ/sim';
import { ownersAt } from '../src/gen/civ/timeline';
import { canCross, polityModelOf } from '../src/gen/civ/polities';
import { CAPITAL_GRACE, HOLD, exclaveMask, warModelOf, warStats } from '../src/gen/civ/wars';
import { capitalAt, polityAlive } from '../src/gen/civ/growth';
import { buildChronicle } from '../src/gen/civ/chronicle';

/**
 * 州 r 是不是国家 pid 灭国时一并收下的残部(wars.ts 的 annex:"隔海的残部最后一并归 x"):
 * r 最后一次归 pid 是攻占,而且就在那一刻有国家亡于 pid。这样收下的隔海领土,非海洋国家也会有
 */
function annexedOverseas(civ: Civ, pid: number, r: number): boolean {
  const L = civ.log;
  let last = -1;
  for (let i = 0; i < L.size; i++) if (L.region[i] === r && L.layer[i] === Layer.Polity) last = i;
  if (last < 0 || L.value[last] !== pid || L.cause[last] !== Ev.Conquer) return false;
  const y = L.year[last];
  return civ.annals.some((e) => e.kind === 'fall' && e.b === pid && e.year === y);
}

const small = { ...DEFAULT_PARAMS, cells: 12000 };

/** 和战争有关的史事种类(war 列是战争编号) */
const WAR_KINDS = new Set<string>(['war', 'conquer', 'peace', 'fall', 'capital']);

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

/** 名字、配色、国号写法在推演结束后才定:只比推演出来的部分 */
const strip = <T extends { name: string; color?: unknown; dynasties?: { name: string }[] }>(a: T[]) =>
  a.map((x) => ({ ...x, name: '', color: 0, eastern: undefined, dynasties: x.dynasties?.map((d) => ({ ...d, name: '' })) }));

/** 先推到 split 年、fromCiv 接着推到 whole.endYear:和一口气推完逐项比(日志、检查点、归属、史事、国家表、城镇表) */
function expectResumeSame(w: World, whole: Civ, split: number) {
  const half = generateCiv(w, { endYear: split });
  const sim = CivSim.fromCiv(w, half);
  sim.run(whole.endYear);
  const res = sim.result();
  const L = whole.log;
  const tag = `从第 ${split} 年接着推`;
  expect(res.log.size, tag).toBe(L.size);
  for (const k of ['year', 'region', 'layer', 'value', 'cause'] as const) {
    expect(bytes(res.log[k]).equals(bytes(L[k].subarray(0, L.size))), `${tag}:日志 ${k}`).toBe(true);
  }
  expect(bytes(res.polity).equals(bytes(whole.polity)), tag).toBe(true);
  expect(bytes(res.culture).equals(bytes(whole.culture)), tag).toBe(true);
  expect(res.checkpoints.map((c) => c.year)).toEqual(whole.checkpoints.map((c) => c.year));
  res.checkpoints.forEach((c, i) => expect(bytes(c.polity).equals(bytes(whole.checkpoints[i].polity)), `${tag}:检查点 ${c.year}`).toBe(true));
  expect(JSON.stringify(res.annals), `${tag}:史事`).toBe(JSON.stringify(whole.annals));
  const m = polityModelOf(sim)!;
  expect(JSON.stringify(strip(m.polities)), `${tag}:国家表`).toBe(JSON.stringify(strip(whole.polities)));
  expect(JSON.stringify(strip(m.settlements)), `${tag}:城镇表`).toBe(JSON.stringify(strip(whole.settlements)));
  return { half, sim };
}

describe('战争与攻占', () => {
  it('fromCiv 接着推:在打仗打到一半、刚迁都、刚亡国时切开,接着推的结果和一口气推完完全一样(史事、日志、国家表)', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const whole = civOf({ ...small, seed });
      const wars = whole.annals.filter((e) => e.kind === 'war');
      expect(wars.length, `seed ${seed} 小世界也要有战争`).toBeGreaterThan(3);
      const splits = new Set<number>([1200, 2000, 2500]);
      // 几场仗打到一半的年份(宣战和议和之间)
      for (const e of wars.filter((_, i) => i % 3 === 1)) {
        const peace = whole.annals.find((q) => q.kind === 'peace' && q.war === e.war);
        const end = peace?.year ?? whole.endYear;
        if (end - e.year > 4) splits.add(Math.floor((e.year + end) / 2));
      }
      // 迁都、亡国的那一刻(同一时刻切开:那一刻的事件都已经处理完)
      for (const e of whole.annals) if (e.kind === 'capital' || e.kind === 'fall') splits.add(e.year);
      let midWar = 0;
      for (const split of [...splits].sort((a, b) => a - b).slice(0, 12)) {
        const { half, sim } = expectResumeSame(w, whole, split);
        // 切开的那一刻有仗还在打:接着推时由史事重建出来
        const open = half.annals.filter((e) => e.kind === 'war' && !half.annals.some((q) => q.kind === 'peace' && q.war === e.war));
        if (open.length) midWar++;
        const wm = warModelOf(sim)!;
        expect(wm.wars.length).toBe(wars.length);
      }
      expect(midWar, `seed ${seed}:至少在几场仗打到一半时切开过`).toBeGreaterThanOrEqual(2);
    }
  }, 120_000);

  it('确定性:同一个种子两次,史事、国家表逐字节相同', () => {
    const a = generateCiv(world({ ...small, seed: 99 }));
    const b = generateCiv(generateWorld({ ...small, seed: 99 }));
    expect(a.annals.some((e) => e.kind === 'war')).toBe(true);
    expect(JSON.stringify(a.annals)).toBe(JSON.stringify(b.annals));
    expect(JSON.stringify(a.polities)).toBe(JSON.stringify(b.polities));
  });

  it('史事按约定的字段记:宣战 → 攻占 → 灭亡 / 迁都 → 议和;攻占就是日志里一条原因为"攻占"的归属变化', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const A = civ.annals;
      const P = civ.polities;
      const reg = civ.regions;
      const war = new Map<number, { a: number; b: number; start: number; at: number; peace?: number; peaceAt?: number }>();
      const conquerLog = new Map<string, number>();
      for (let i = 0; i < civ.log.size; i++) {
        if (civ.log.layer[i] !== Layer.Polity || civ.log.cause[i] !== Ev.Conquer) continue;
        conquerLog.set(`${civ.log.year[i]}|${civ.log.region[i]}`, civ.log.value[i]);
      }
      let conquers = 0;
      A.forEach((e, i) => {
        const before = ownersAt(civ, e.year - 1 / 512).polity;
        const after = ownersAt(civ, e.year).polity;
        switch (e.kind) {
          case 'war': {
            expect(e.war).toBe(war.size); // 按宣战先后编号
            expect(polityAlive(P[e.a], e.year) && polityAlive(P[e.b], e.year)).toBe(true);
            // 宣战时两国接壤(经攻方能走的边)
            let touch = false;
            for (let r = 0; r < reg.count && !touch; r++) {
              if (before[r] !== e.a) continue;
              for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (before[reg.adj[k]] === e.b && canCross(P[e.a], reg.adjKind[k])) touch = true;
            }
            expect(touch, `战争 ${e.war}`).toBe(true);
            war.set(e.war, { a: e.a, b: e.b, start: e.year, at: i });
            break;
          }
          case 'conquer': {
            conquers++;
            const w = war.get(e.war)!;
            expect(w, `攻占记的战争 ${e.war}`).toBeDefined();
            expect(w.peace).toBeUndefined();
            expect([w.a, w.b]).toContain(e.a);
            expect([w.a, w.b]).toContain(e.b);
            expect(e.a).not.toBe(e.b);
            expect(before[e.region], `第 ${e.year} 年州 ${e.region} 原主`).toBe(e.b);
            expect(after[e.region]).toBe(e.a);
            expect(conquerLog.get(`${e.year}|${e.region}`)).toBe(e.a);
            // 州里当时的城(阶段 3 城市兴衰:这一刻被毁的照样记;早先被毁的不算)
            const city = civ.settlements.find((s) => s.region === e.region && s.founded <= e.year && !((s.ended ?? Infinity) < e.year));
            expect(e.settlement).toBe(city ? city.id : -1);
            break;
          }
          case 'capital': {
            // 国都失守的迁都紧跟在那条攻占后面;主动迁都(politics.ts)时旧国都还在本国手里。新国都都在本国国土内
            const prev = A[i - 1];
            const lost = prev.kind === 'conquer' && prev.b === e.a && prev.year === e.year;
            // 被迫迁都记那场战争的编号,主动迁都记 −1
            expect(e.war, `第 ${e.year} 年迁都`).toBe(lost ? prev.war : -1);
            expect(civ.settlements[e.settlement].region).toBe(e.region);
            expect(after[e.region]).toBe(e.a);
            expect(capitalAt(P[e.a], e.year)).toBe(e.settlement);
            const old = civ.settlements[capitalAt(P[e.a], e.year - 1 / 512)].region;
            if (lost) expect(old).toBe(prev.region);
            else {
              expect(before[old], `第 ${e.year} 年主动迁都`).toBe(e.a);
              expect(old).not.toBe(e.region);
            }
            break;
          }
          case 'fall': {
            const prev = A[i - 1];
            expect(prev.kind).toBe('conquer');
            expect(prev.region).toBe(e.region);
            expect(prev.b).toBe(e.a);
            expect(e.b).toBe(prev.a);
            expect(e.war).toBe(prev.war);
            expect(P[e.a].ended).toBe(e.year);
            expect(after.includes(e.a)).toBe(false);
            break;
          }
          case 'peace': {
            const w = war.get(e.war)!;
            expect(w.peace, `战争 ${e.war} 只议和一次`).toBeUndefined();
            expect([e.a, e.b]).toEqual([w.a, w.b]);
            expect(e.year).toBeGreaterThanOrEqual(w.start);
            w.peace = e.year;
            w.peaceAt = i;
            break;
          }
        }
      });
      expect(conquers).toBe(A.filter((e) => e.kind === 'conquer').length);
      expect(conquerLog.size, '日志里每条"攻占"都有一条史事').toBe(conquers);
      // 每场仗都议和了(或者打到结束年份还没打完)
      for (const [id, w] of war) {
        if (w.peace === undefined) continue;
        // 只看和战争有关的种类(同化与迁徙的史事借 war 列记国家,不是战争编号)
        const last = A.map((e, i) => (e.war === id && WAR_KINDS.has(e.kind) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
        expect(w.peaceAt, `战争 ${id}:议和是这场战争的最后一条`).toBe(last);
      }
      // 灭亡的国家都有一条"灭亡";被并掉的(阶段 3 分合)只有一条"合并",不另记灭亡
      for (const p of P) {
        const falls = A.filter((e) => e.kind === 'fall' && e.a === p.id).length;
        const merged = A.filter((e) => e.kind === 'merge' && e.b === p.id).length;
        expect(falls + merged).toBe(p.ended === undefined ? 0 : 1);
      }
    }
  }, 60_000);

  it('前线不闪烁:一州在战争里易手后 HOLD 年内不再易手,50 年内没有换 3 次国家的州;攻方只打和自己接壤的州;迁都不会一迁再迁', () => {
    for (const seed of [7, 2024, 3, 99]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const reg = civ.regions;
      const last = new Float64Array(reg.count).fill(-Infinity);
      const L = civ.log;
      // 按日志顺序重放国家层的归属:每条"攻占"之前,攻方的国土要挨着这一州(同一时刻先攻下的州也算:丢了国都撑不下去的小国,残部挨着国都)。
      // 例外:丢了国都撑不下去、残部一并归攻方(wars.ts 的 annex)时,和国都不连着的残部(隔海的、被别国围住的飞地)最后一并归攻方
      const fellAt = new Set(civ.annals.filter((e) => e.kind === 'fall').map((e) => `${e.year}|${e.a}`));
      const own = new Int16Array(reg.count).fill(-1);
      for (let i = 0; i < L.size; i++) {
        if (L.layer[i] !== Layer.Polity) continue;
        const r = L.region[i];
        if (L.cause[i] === Ev.Conquer) {
          expect(L.year[i] - last[r], `seed ${seed} 州 ${r} 第 ${L.year[i]} 年`).toBeGreaterThanOrEqual(HOLD);
          const x = L.value[i];
          let touch = false;
          for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (own[reg.adj[k]] === x && canCross(civ.polities[x], reg.adjKind[k])) touch = true;
          expect(touch || fellAt.has(`${L.year[i]}|${own[r]}`), `seed ${seed} 州 ${r}`).toBe(true);
        }
        own[r] = L.value[i];
        last[r] = L.year[i];
      }
      expect(warStats(civ).flippy, `seed ${seed}`).toBe(0);
      // 迁都后 CAPITAL_GRACE 年内不再迁都(新国都攻不下):不会几年里一迁再迁
      for (const p of civ.polities) {
        const c = p.capitals!;
        for (let i = 2; i < c.length; i++) expect(c[i].year - c[i - 1].year, `seed ${seed} ${p.name}`).toBeGreaterThanOrEqual(CAPITAL_GRACE);
      }
    }
  }, 60_000);

  it('默认参数 seed 7 / 2024:有战争、有亡国、有迁都;在世国家 8–20 个;第 3000 年的政区图成片(飞地 < 3%)', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const st = warStats(civ);
      expect(st.wars, `seed ${seed}`).toBeGreaterThanOrEqual(8);
      // 阶段 3 分合以后国家多了(分出来、复国的),仗也多了:3000 年里约 45–65 场
      expect(st.wars, `seed ${seed}`).toBeLessThanOrEqual(90);
      expect(st.falls, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(st.capitalMoves, `seed ${seed}`).toBeGreaterThan(0);
      expect(st.conquests, `seed ${seed}`).toBeGreaterThan(30);
      expect(st.alive, `seed ${seed}`).toBeGreaterThanOrEqual(8);
      expect(st.alive, `seed ${seed}`).toBeLessThanOrEqual(20);
      expect(st.exclaveShare, `seed ${seed}`).toBeLessThan(0.03);
      // 各个百年的政区图也成片
      for (let y = 1500; y <= 3000; y += 500) {
        const own = ownersAt(civ, y).polity;
        const ex = exclaveMask(civ, own, y);
        let n = 0;
        let owned = 0;
        for (let r = 0; r < civ.regions.count; r++) {
          n += ex[r];
          if (own[r] >= 0) owned++;
        }
        expect(n / Math.max(1, owned), `seed ${seed} 第 ${y} 年`).toBeLessThan(0.04);
      }
    }
  }, 60_000);

  it('编年史(真实战争数据):每场战争折叠成一条,攻占、被迫迁都都挂在战争下;亡国、主动迁都另列;一方在别处亡国的仗写"既亡"', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const list = buildChronicle(civ);
      const count = (k: string) => civ.annals.filter((e) => e.kind === k).length;
      expect(list.filter((e) => e.kind === 'war').length).toBe(count('war'));
      // 没有单列的攻占:都挂在某场战争下(部落地带的扩张走"国家到达",不记攻占)
      expect(civ.annals.every((e) => e.kind !== 'conquer' || (e.war >= 0 && e.b >= 0))).toBe(true);
      expect(list.some((e) => e.kind === 'conquer')).toBe(false);
      expect(list.filter((e) => e.kind === 'fall').length).toBe(count('fall'));
      // 国都失守的迁都(带战争编号)挂在那场战争下,顶层只有主动迁都
      const forced = civ.annals.filter((e) => e.kind === 'capital' && e.war >= 0).length;
      expect(forced).toBeGreaterThan(0);
      expect(list.filter((e) => e.kind === 'capital').length).toBe(count('capital') - forced);
      expect(list.flatMap((e) => e.children ?? []).filter((c) => c.kind === 'capital').length).toBe(forced);
      for (const e of list) for (const x of [e, ...(e.children ?? [])]) expect(x.text).not.toMatch(/某国|undefined|NaN/);
      for (const w of list.filter((e) => e.kind === 'war')) {
        const peace = w.children!.find((c) => c.kind === 'peace');
        if (!peace) continue;
        const gone = w.polities.slice(0, 2).some((id) => (civ.polities[id].ended ?? Infinity) <= peace.year);
        if (gone) expect(peace.text).toMatch(/既亡/);
      }
    }
  });

  it('编年史:一方在另一场战争里亡国,这场仗的议和写"既亡,兵戈遂息"', () => {
    const real = civOf({ ...small, seed: 7 });
    const y = 2500;
    const r = real.settlements[real.polities[1].capital].region;
    const polities = real.polities.map((p) => ({ ...p, ended: p.id === 1 ? y + 5 : undefined }));
    const mk = (year: number, kind: Annal['kind'], a: number, b: number, war: number, region = -1): Annal => ({ year, kind, a, b, region, settlement: -1, war });
    const annals: Annal[] = [
      mk(y, 'war', 0, 1, 0),
      mk(y + 1, 'war', 2, 1, 1),
      mk(y + 5, 'conquer', 2, 1, 1, r),
      mk(y + 5, 'fall', 1, 2, 1, r),
      mk(y + 5, 'peace', 2, 1, 1),
      mk(y + 5, 'peace', 0, 1, 0),
    ];
    const list = buildChronicle({ ...real, polities, annals });
    const w0 = list.find((e) => e.kind === 'war' && e.id === 0)!;
    expect(w0.children!.find((c) => c.kind === 'peace')!.text).toMatch(/既亡,兵戈遂息$/);
  });

  it('被攻占的州民族不变、城镇照旧(这一刻被毁的除外,见 cities.ts);只有海洋国家能跨海打仗', () => {
    const civ = civOf({ ...DEFAULT_PARAMS, seed: 2024 });
    const L = civ.log;
    const cultureAt = new Int16Array(civ.regions.count).fill(-1);
    for (let i = 0; i < L.size; i++) if (L.layer[i] === Layer.Culture) cultureAt[L.region[i]] = L.value[i];
    for (const e of civ.annals) {
      if (e.kind !== 'conquer') continue;
      // 民族层没有因为战争变过(民族归属只在定居时写一次)
      expect(civ.culture[e.region]).toBe(cultureAt[e.region]);
      // 城被毁的:一定是这一刻、有一条毁城的史事(阶段 3 城市兴衰)
      const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
      if (s && s.ended !== undefined && s.ended <= e.year) {
        expect(s.ended).toBe(e.year);
        expect(civ.annals.some((x) => x.kind === 'ruin' && x.settlement === s.id && x.year === e.year)).toBe(true);
      }
    }
    for (let i = 0; i < L.size; i++) expect(L.layer[i] === Layer.Culture && L.cause[i] === Ev.Conquer).toBe(false);
    // 非海洋国家的国土不跨陆块(灭国时一并收下的隔海残部除外,见 annexedOverseas)
    for (const p of civ.polities) {
      if (p.kind === 'sea') continue;
      const lms = new Set<number>();
      for (let r = 0; r < civ.regions.count; r++) if (civ.polity[r] === p.id && !annexedOverseas(civ, p.id, r)) lms.add(civ.regions.landmass[r]);
      expect(lms.size).toBeLessThanOrEqual(1);
    }
    expect(AdjKind.Strait).toBe(3);
  });
});
