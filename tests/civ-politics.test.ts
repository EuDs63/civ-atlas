/**
 * 分与合(阶段 3,politics.ts):分裂 / 独立、合并、复国、主动迁都、部落地带补立国。
 */
import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { Layer } from '../src/gen/civ/types';
import { CivSim, Ev } from '../src/gen/civ/sim';
import { ownersAt } from '../src/gen/civ/timeline';
import { canCross, polityModelOf } from '../src/gen/civ/polities';
import { NEWBORN, warStats } from '../src/gen/civ/wars';
import { politicsModelOf, politicsStats } from '../src/gen/civ/politics';
import { capitalAt, polityAlive, polityRootAt, polityTitles, polityShortTitle, tierOf } from '../src/gen/civ/growth';
import { GREAT_TIER, MAJOR, buildChronicle } from '../src/gen/civ/chronicle';

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

/** 名字、配色、国号写法在推演结束后才定:只比推演出来的部分 */
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
  return sim;
}

/** 某年各国的州数 */
function sizesAt(civ: Civ, y: number): Map<number, number> {
  const own = ownersAt(civ, y).polity;
  const n = new Map<number, number>();
  for (let r = 0; r < own.length; r++) if (own[r] >= 0) n.set(own[r], (n.get(own[r]) ?? 0) + 1);
  return n;
}

describe('分与合', () => {
  it('fromCiv 接着推:在分裂、合并、复国、主动迁都那一刻切开,和一口气推完逐字节一致', () => {
    const seen = { split: 0, merge: 0, restore: 0, capital: 0 };
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const whole = civOf({ ...small, seed });
      const cuts = new Set<number>([1200]);
      const pick = (kind: 'split' | 'merge' | 'restore' | 'capital', ys: number[]) => {
        for (const y of ys.slice(0, 2)) {
          cuts.add(y);
          seen[kind]++;
        }
      };
      const A = whole.annals;
      pick('split', A.filter((e) => e.kind === 'split' && whole.polities[e.a].restores === undefined).map((e) => e.year));
      pick('restore', A.filter((e) => e.kind === 'split' && whole.polities[e.a].restores !== undefined).map((e) => e.year));
      pick('merge', A.filter((e) => e.kind === 'merge').map((e) => e.year));
      pick(
        'capital',
        A.filter((e, i) => e.kind === 'capital' && !(A[i - 1]?.kind === 'conquer' && A[i - 1].b === e.a && A[i - 1].year === e.year)).map((e) => e.year),
      );
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        const sim = expectResumeSame(w, whole, cut);
        expect(politicsModelOf(sim)).toBeDefined();
      }
    }
    // 两个小世界里分裂、合并、复国、主动迁都都切到过
    expect(seen.split).toBeGreaterThanOrEqual(2);
    expect(seen.merge).toBeGreaterThanOrEqual(1);
    expect(seen.restore).toBeGreaterThanOrEqual(1);
    expect(seen.capital).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('确定性:同一个种子两次,史事、国家表逐字节相同(含分裂、合并、复国)', () => {
    const a = generateCiv(world({ ...small, seed: 3 }));
    const b = generateCiv(generateWorld({ ...small, seed: 3 }));
    expect(a.annals.some((e) => e.kind === 'split')).toBe(true);
    expect(JSON.stringify(a.annals)).toBe(JSON.stringify(b.annals));
    expect(JSON.stringify(a.polities)).toBe(JSON.stringify(b.polities));
    expect(bytes(a.log.cause.subarray(0, a.log.size)).equals(bytes(b.log.cause.subarray(0, b.log.size)))).toBe(true);
  });

  it('史事按约定的字段记:split(新国家 ← 原来的国家,起事的州,新国都)、merge(并入的一方 ← 被并掉的);改归属都走 setOwner', () => {
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const P = civ.polities;
      const reg = civ.regions;
      const L = civ.log;
      // 日志里原因为"分裂""合并"的归属变化,按 年份|国家 计数
      const logCount = new Map<string, number>();
      for (let i = 0; i < L.size; i++) {
        if (L.layer[i] !== Layer.Polity || (L.cause[i] !== Ev.Split && L.cause[i] !== Ev.Merge)) continue;
        const k = `${L.cause[i]}|${L.year[i]}|${L.value[i]}`;
        logCount.set(k, (logCount.get(k) ?? 0) + 1);
      }
      let checked = 0;
      for (const e of civ.annals) {
        const before = ownersAt(civ, e.year - 1 / 512).polity;
        const after = ownersAt(civ, e.year).polity;
        if (e.kind === 'split') {
          checked++;
          const N = P[e.a];
          const tag = `seed ${seed} 第 ${e.year} 年 ${N.name}`;
          expect(N.founded, tag).toBe(e.year);
          expect(N.parent, tag).toBe(e.b);
          expect(polityAlive(P[e.b], e.year), tag).toBe(true);
          expect(N.capitals![0]).toEqual({ year: e.year, settlement: e.settlement });
          expect(N.capital).toBe(e.settlement);
          expect(civ.settlements[e.settlement].culture === N.culture || civ.culture[civ.settlements[e.settlement].region] === N.culture).toBe(true);
          // 新国家的国土全是从原来的国家分出来的,含起事的州和新国都;成片(都和新国都连着)
          const mine: number[] = [];
          for (let r = 0; r < reg.count; r++) if (after[r] === e.a) mine.push(r);
          expect(mine.length, tag).toBeGreaterThanOrEqual(2);
          for (const r of mine) expect(before[r], tag).toBe(e.b);
          expect(after[e.region]).toBe(e.a);
          expect(after[civ.settlements[e.settlement].region]).toBe(e.a);
          expect(logCount.get(`${Ev.Split}|${e.year}|${e.a}`)).toBe(mine.length);
          const capR = civ.settlements[e.settlement].region;
          const reached = new Set([capR]);
          const q = [capR];
          while (q.length) {
            const r = q.pop()!;
            for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
              const j = reg.adj[k];
              if (after[j] === e.a && !reached.has(j) && canCross(N, reg.adjKind[k])) {
                reached.add(j);
                q.push(j);
              }
            }
          }
          expect(reached.size, `${tag}:国土成片`).toBe(mine.length);
          // 国号从第 0 档起算,按起事那年的州数定档(同一刻记进 titles)
          expect(N.titles![0]).toEqual({ year: e.year, tier: tierOf(mine.length) });
          // 原来的国家国都还在
          expect(after[civ.settlements[capitalAt(P[e.b], e.year)].region]).toBe(e.b);
          // 复国:故国先亡、同族
          if (N.restores !== undefined) {
            const F = P[N.restores];
            expect(F.ended, tag).toBeLessThan(e.year);
            expect(F.culture).toBe(N.culture);
            expect(F.restores).toBeUndefined();
          }
        } else if (e.kind === 'merge') {
          checked++;
          const A = P[e.a];
          const B = P[e.b];
          const tag = `seed ${seed} 第 ${e.year} 年 ${B.name} 并入 ${A.name}`;
          expect(B.ended, tag).toBe(e.year);
          expect(A.culture, tag).toBe(B.culture);
          expect(polityAlive(A, e.year)).toBe(true);
          let n = 0;
          for (let r = 0; r < reg.count; r++) {
            if (before[r] !== e.b) continue;
            n++;
            expect(after[r], tag).toBe(e.a);
          }
          expect(n).toBeGreaterThan(0);
          expect(after.includes(e.b)).toBe(false);
          expect(logCount.get(`${Ev.Merge}|${e.year}|${e.a}`)).toBe(n);
          // 双方都不在打仗:没有宣了战、还没议和的仗
          for (const w of civ.annals.filter((x) => x.kind === 'war' && x.year <= e.year && [x.a, x.b].some((p) => p === e.a || p === e.b))) {
            const end = civ.annals.find((x) => x.kind === 'peace' && x.war === w.war);
            expect(end && end.year <= e.year, `${tag}:战争 ${w.war} 还在打`).toBe(true);
          }
        }
      }
      expect(checked, `seed ${seed}`).toBeGreaterThan(3);
    }
  }, 60_000);

  it('分出来的国家有站稳期:NEWBORN 年内没人对它宣战;被并的、复国的国家各只一次', () => {
    for (const seed of [7, 2024, 3, 99]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      for (const e of civ.annals) {
        if (e.kind !== 'war') continue;
        const Q = civ.polities[e.b];
        if (Q.parent !== undefined) expect(e.year - Q.founded, `seed ${seed} 战争 ${e.war}`).toBeGreaterThanOrEqual(NEWBORN);
      }
      const restored = civ.polities.filter((p) => p.restores !== undefined).map((p) => p.restores!);
      expect(new Set(restored).size).toBe(restored.length);
      const merged = civ.annals.filter((e) => e.kind === 'merge').map((e) => e.b);
      expect(new Set(merged).size).toBe(merged.length);
      for (const f of restored) expect(merged.includes(f)).toBe(false);
    }
  }, 60_000);

  // 阶段 3 同化以后,大国治下的异族州少了,分裂(几乎都从异族州起事)随之少了约三成(十个种子平均 8.4 → 5.7 次):
  // 分裂的下限从 5 次放到 1 次,分裂 + 复国合计仍要 4 次以上
  it('默认参数 seed 7 / 2024:分裂 1–20 次、分裂 + 复国 ≥ 4 次、合并 ≤ 6 次、复国 1–6 次(合并、主动迁都两个世界里都有);结束时在世 8–20 国;政区图成片、前线不闪烁', () => {
    // 合并、主动迁都是少见的事(各个种子 0–4 次):按两个世界合计至少一次算,不要求每个世界都有
    let merges = 0;
    let moves = 0;
    for (const seed of [7, 2024]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const ps = politicsStats(civ);
      const ws = warStats(civ);
      const tag = `seed ${seed}`;
      expect(ps.splits, tag).toBeGreaterThanOrEqual(1);
      expect(ps.splits, tag).toBeLessThanOrEqual(20);
      expect(ps.splits + ps.restorations, tag).toBeGreaterThanOrEqual(4);
      merges += ps.merges;
      moves += ps.capitalMoves;
      expect(ps.merges, tag).toBeLessThanOrEqual(6);
      expect(ps.restorations, tag).toBeGreaterThanOrEqual(1);
      expect(ps.restorations, tag).toBeLessThanOrEqual(6);
      expect(ws.alive, tag).toBeGreaterThanOrEqual(8);
      expect(ws.alive, tag).toBeLessThanOrEqual(20);
      expect(ws.flippy, tag).toBe(0);
      expect(ws.exclaveShare, tag).toBeLessThan(0.01);
      // 分出来的国家不是一出生就没了;和原国颜色不同(回放时看得出裂出了一块)
      const born = civ.polities.filter((p) => p.parent !== undefined);
      for (const p of born) expect(p.color, `${tag} ${p.name}`).not.toEqual(civ.polities[p.parent!].color);
      expect(born.filter((p) => p.ended !== undefined && p.ended - p.founded < NEWBORN)).toEqual([]);
      // 大帝国不会一夜碎成十几块:同一国同一年最多分裂一次
      const once = new Set<string>();
      for (const e of civ.annals.filter((x) => x.kind === 'split')) {
        const k = `${e.b}|${Math.floor(e.year)}`;
        expect(once.has(k), `${tag} ${k}`).toBe(false);
        once.add(k);
      }
      // 新国家都不小:分裂至少 5 州(复国至少 2 州)
      for (const e of civ.annals.filter((x) => x.kind === 'split')) {
        const n = sizesAt(civ, e.year).get(e.a) ?? 0;
        expect(n, `${tag} ${civ.polities[e.a].name}`).toBeGreaterThanOrEqual(civ.polities[e.a].restores === undefined ? 5 : 2);
      }
    }
    expect(merges, '两个世界合计有合并').toBeGreaterThanOrEqual(1);
    expect(moves, '两个世界合计有主动迁都').toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('复国的国名沿用故国国名加前缀(东方"后昌""南昌",西幻"新X""北X");地图上的全称、简称都在字表允许的字里', () => {
    let n = 0;
    for (const seed of [7, 2024, 3, 99]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      const names = new Set<string>();
      for (const p of civ.polities) {
        expect(names.has(p.name), `seed ${seed} 重名 ${p.name}`).toBe(false);
        names.add(p.name);
        if (p.restores === undefined) continue;
        n++;
        const F = civ.polities[p.restores];
        // 故国改朝换代过的(东方),沿用它亡国时那一朝的国号
        const last = polityRootAt(F, F.ended!);
        const root = p.eastern && [...last].length === 2 && last[0] === '大' ? last.slice(1) : last;
        expect(p.name, `seed ${seed}`).toMatch(new RegExp(`^[后新东南西北]${root}$`));
        for (let tier = 0; tier < 4; tier++) {
          expect(polityTitles(p)[tier]).toContain(p.name);
          expect(polityShortTitle(p, tier).length).toBeGreaterThan(0);
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('编年史:分裂、复国、合并各有一条(分出来长成大国的、并掉大国的是大事),措辞对得上', () => {
    let majorSplit = false;
    for (const seed of [7, 2024, 1]) {
      const civ = civOf({ ...DEFAULT_PARAMS, seed });
      // 大国:到过第 GREAT_TIER 档
      const great = (id: number) => Math.max(0, ...(civ.polities[id]?.titles ?? []).map((t) => t.tier)) >= GREAT_TIER;
      const list = buildChronicle(civ);
      const splits = list.filter((e) => e.kind === 'split');
      expect(splits.length).toBe(civ.annals.filter((e) => e.kind === 'split').length);
      // 分出来的国家日后长成大国的(不常见:三个世界里至少有一个,见循环后)
      if (splits.some((e) => e.importance === MAJOR)) majorSplit = true;
      for (const e of splits) {
        const p = civ.polities[e.polities[0]];
        // 改朝换代后不久叛离的,"大事"里合写进改朝换代那一条
        const merged = list.some((d) => d.kind === 'dynasty' && d.importance === MAJOR && d.text.includes(e.text));
        expect(e.importance).toBe(great(p.id) && !merged ? MAJOR : 2);
        if (p.restores !== undefined) {
          expect(e.tag).toBe('复');
          const F = civ.polities[p.restores];
          expect(e.text).toContain(`故${polityRootAt(F, F.ended!)}遗民`);
        } else expect(e.tag).toBe('分');
        expect(e.text).not.toMatch(/某国|undefined|NaN|-1/);
      }
      const merges = list.filter((e) => e.kind === 'merge');
      expect(merges.length).toBe(civ.annals.filter((e) => e.kind === 'merge').length);
      for (const e of merges) {
        expect(e.text).toMatch(/^.+并入.+$/);
        expect(e.importance).toBe(great(e.polities[1]) ? MAJOR : 2);
      }
      // 被并掉的国家不另记灭亡
      for (const e of civ.annals.filter((x) => x.kind === 'merge')) {
        expect(civ.annals.some((x) => x.kind === 'fall' && x.a === e.b)).toBe(false);
      }
    }
    expect(majorSplit, '分出来的国家有日后长成大国的').toBe(true);
  });
});
