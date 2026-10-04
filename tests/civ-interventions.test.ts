/**
 * 干预(阶段 4,gen/civ/interventions.ts):带着干预从第 0 年整段重推。
 * - 干预年份之前的日志、史事、国家表、城镇表和不干预时逐字节一致
 * - 不许灭:原本亡于战争的国家到第 3000 年仍在;结盟的两国之后不互相宣战;宣战那一年确有 war 史事
 * - 划州、立国、迁都、不许扩张:各自生效;"划州 + 永久"的州到第 3000 年仍属该国;立国出来的国家能改名、能被"不许灭"引用
 * - 确定性:同样的干预两次推演逐字节相同;fromCiv 接着推(切在干预之前 / 当年 / 之后)和一口气推完一致
 * - 改名按稳定键照样套得上;键指不到时不报错
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import type { Annal } from '../src/gen/civ/types';
import { CivSim } from '../src/gen/civ/sim';
import { polityModelOf, canCross } from '../src/gen/civ/polities';
import { InterventionModel } from '../src/gen/civ/interventions';
import { ownersAt } from '../src/gen/civ/timeline';
import { buildChronicle, interventionOutcome } from '../src/gen/civ/chronicle';
import { capitalAt, polityName } from '../src/gen/civ/growth';
import {
  applyNames,
  cleanInterventions,
  polityKey,
  regionKey,
  resolveKey,
  sameInterventions,
  settlementKey,
  type Intervention,
} from '../src/gen/edits';

const worlds = new Map<string, World>();
function world(seed: number): World {
  const key = `${seed}`;
  let w = worlds.get(key);
  if (!w) worlds.set(key, (w = generateWorld({ ...DEFAULT_PARAMS, seed })));
  return w;
}
const bases = new Map<string, Civ>();
function base(seed: number): Civ {
  const key = `${seed}`;
  let c = bases.get(key);
  if (!c) bases.set(key, (c = generateCiv(world(seed))));
  return c;
}

function bytes(a: ArrayBufferView) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

/** 日志里年份 < y 的前几条 */
function logBefore(civ: Civ, y: number) {
  const L = civ.log;
  let n = 0;
  while (n < L.size && L.year[n] < y) n++;
  return {
    n,
    parts: (['year', 'region', 'layer', 'value', 'cause'] as const).map((k) => bytes(L[k].subarray(0, n))),
  };
}
const annalsBefore = (civ: Civ, y: number) => JSON.stringify(civ.annals.filter((e) => e.year < y));

/** 同一个世界、同样的干预推两次:整份 Civ(除了名字以外的一切也都)逐字节一致 */
function fingerprint(civ: Civ): string {
  const L = civ.log;
  return JSON.stringify({
    annals: civ.annals,
    polities: civ.polities,
    settlements: civ.settlements,
    log: (['year', 'region', 'layer', 'value', 'cause'] as const).map((k) => bytes(L[k].subarray(0, L.size)).toString('base64')),
    polity: bytes(civ.polity).toString('base64'),
    culture: bytes(civ.culture).toString('base64'),
  });
}

/** 名字、配色、国号写法在推演结束后才定:只比推演出来的部分 */
const strip = <T extends { name: string; color?: unknown; dynasties?: { name: string }[] }>(a: T[]) =>
  a.map((x) => ({ ...x, name: '', color: 0, eastern: undefined, dynasties: x.dynasties?.map((d) => ({ ...d, name: '' })) }));

/** 一个原本亡于战争(被别国灭掉)、到过"国"一档的国家,和它亡国前的一个年份 */
function fallenPolity(civ: Civ) {
  const falls = civ.annals.filter((a) => a.kind === 'fall' && a.b >= 0);
  for (const f of falls) {
    const p = civ.polities[f.a];
    if (!(p.titles ?? []).some((t) => t.tier >= 1)) continue;
    const from = Math.max(Math.ceil(p.founded) + 1, Math.floor(p.ended! - 80));
    if (from >= p.ended!) continue;
    return { p, from };
  }
  throw new Error('找不到亡于战争的国家');
}

/** y 年前后两国接壤(按攻方能走的边) */
function bordering(civ: Civ, a: number, b: number, y: number): boolean {
  const own = ownersAt(civ, y).polity;
  const reg = civ.regions;
  const A = civ.polities[a];
  for (let r = 0; r < reg.count; r++) {
    if (own[r] !== a) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (own[reg.adj[k]] === b && canCross(A, reg.adjKind[k])) return true;
  }
  return false;
}

/** 一对会打仗的国家(结盟测试用):[a, b, 结盟的年份 = 那场仗之前 20 年, 那场仗的年份]。两国在结盟那年都已立国、没亡 */
function rivals(civ: Civ, nth = 0): [number, number, number, number] {
  let n = 0;
  for (const w of civ.annals) {
    if (w.kind !== 'war' || w.settlement >= 0) continue;
    const from = Math.floor(w.year) - 20;
    const A = civ.polities[w.a];
    const B = civ.polities[w.b];
    if (A.founded >= from - 1 || B.founded >= from - 1 || (A.ended ?? Infinity) <= from || (B.ended ?? Infinity) <= from) continue;
    if (n++ < nth) continue;
    return [w.a, w.b, from, w.year];
  }
  throw new Error('找不到一对会打仗的国家');
}

const warsBetween = (civ: Civ, a: number, b: number, from: number): Annal[] =>
  civ.annals.filter((e) => e.kind === 'war' && e.year >= from && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));

/** 键 → 这个历史里的国家编号(−1 = 没有) */
const idOf = (civ: Civ, key: string) => {
  const r = resolveKey(civ, key);
  return r && r.kind === 'polity' ? r.id : -1;
};

describe('干预 · 数据格式', () => {
  it('cleanInterventions:丢掉不合格的、年份取整夹紧;合格的原样返回', () => {
    const good: Intervention[] = [
      { kind: 'protect', a: 'polity:r12#0', from: 1800 },
      { kind: 'ally', a: 'polity:r12#0', b: 'polity:r40#1', from: 1800, until: 2000 },
      { kind: 'declare', a: 'polity:r12#0', b: 'polity:r40#1', from: 1900 },
      { kind: 'unity', a: 'polity:r40#1', from: 1850 },
    ];
    expect(cleanInterventions(good)).toBe(good);
    const messy = [
      ...good,
      { kind: 'nuke', a: 'polity:r1#0', from: 10 },
      { kind: 'protect', a: 'settlement:r1#0', from: 10 },
      { kind: 'ally', a: 'polity:r1#0', b: 'polity:r1#0', from: 10 },
      { kind: 'declare', a: 'polity:r1#0', from: 10 },
      { kind: 'protect', a: 'polity:r1#0', from: Number.NaN },
      { kind: 'protect', a: 'polity:r1#0', from: -5.5, extra: 1 },
      { kind: 'ally', a: 'polity:r1#0', b: 'polity:r2#0', from: 99.9, until: 50 },
      null,
      'x',
    ];
    const c = cleanInterventions(messy);
    expect(c.slice(0, 4)).toEqual(good);
    expect(c.slice(4)).toEqual([
      { kind: 'protect', a: 'polity:r1#0', from: 0 },
      { kind: 'ally', a: 'polity:r1#0', b: 'polity:r2#0', from: 99 },
    ]);
    // 保护可以有截止年份(要在 from 之后)
    const timed: Intervention = { kind: 'protect', a: 'polity:r12#0', from: 1800, until: 2100 };
    expect(cleanInterventions([timed])).toEqual([timed]);
    expect(cleanInterventions([{ ...timed, until: 1800 }])).toEqual([{ kind: 'protect', a: 'polity:r12#0', from: 1800 }]);
    expect(cleanInterventions(undefined)).toEqual([]);
    expect(sameInterventions(good, good.map((v) => ({ ...v })))).toBe(true);
    expect(sameInterventions(good, good.slice(1))).toBe(false);
  });

  it('推演里的"键 → 编号"和 edits.ts 的 polityKey 一致', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const iv = new InterventionModel([], seed);
      iv.pm = { polities: civ.polities, settlements: civ.settlements, terrain: { regions: civ.regions } } as never;
      for (const p of civ.polities) {
        const k = polityKey(civ, p.id);
        expect(iv.resolve(k), `seed ${seed} 国家 ${p.id}`).toBe(p.id);
        // 旧格式(州号)也一样
        expect(iv.resolve(k.replace(/:c\d+#/, `:r${civ.settlements[p.capital].region}#`)), `seed ${seed} 国家 ${p.id}(旧键)`).toBe(p.id);
      }
      for (const s of civ.settlements) expect(iv.resolveCity(settlementKey(civ, s.id))).toBe(s.id);
      expect(iv.resolve('polity:r99999#0')).toBe(-1);
      expect(iv.resolve(`polity:c${civ.regions.of.findIndex((r) => r < 0)}#0`)).toBe(-1);
    }
  });
});

describe('干预 · 推演', () => {
  it('没有干预时和原来一样;干预年份之前的日志、史事、国家表、城镇表和不干预时逐字节一致', () => {
    for (const seed of [7, 2024]) {
      const w = world(seed);
      const civ = base(seed);
      expect(generateCiv(w, { interventions: [] }).interventions).toBeUndefined();
      const { p, from } = fallenPolity(civ);
      const [a, b, allyFrom] = rivals(civ);
      const list: Intervention[] = [
        { kind: 'protect', a: polityKey(civ, p.id), from },
        { kind: 'ally', a: polityKey(civ, a), b: polityKey(civ, b), from: allyFrom },
      ];
      for (const v of list) {
        const y = v.from;
        const c = generateCiv(w, { interventions: [v] });
        expect(c.interventions).toEqual([v]);
        // 整段重推:y 年之前的史事、日志和不干预时逐字节一致
        const la = logBefore(c, y);
        const lb = logBefore(civ, y);
        expect(la.n, `seed ${seed} ${v.kind}:日志条数`).toBe(lb.n);
        la.parts.forEach((x, i) => expect(x.equals(lb.parts[i]), `seed ${seed} ${v.kind}:日志`).toBe(true));
        expect(annalsBefore(c, y), `seed ${seed} ${v.kind}:史事`).toBe(annalsBefore(civ, y));
        // 推到干预那一刻之前为止:整张国家表、城镇表、检查点、归属都一样
        const cut = y - 1 / 256;
        const x0 = generateCiv(w, { endYear: cut });
        const x1 = generateCiv(w, { endYear: cut, interventions: [v] });
        expect(JSON.stringify(x1.polities), `seed ${seed} ${v.kind}:国家表`).toBe(JSON.stringify(x0.polities));
        expect(JSON.stringify(x1.settlements), `seed ${seed} ${v.kind}:城镇表`).toBe(JSON.stringify(x0.settlements));
        expect(bytes(x1.polity).equals(bytes(x0.polity))).toBe(true);
        expect(x1.checkpoints.length).toBe(x0.checkpoints.length);
        x1.checkpoints.forEach((k, i) => expect(bytes(k.polity).equals(bytes(x0.checkpoints[i].polity))).toBe(true));
        // 干预确实改变了之后的历史
        expect(JSON.stringify(c.annals)).not.toBe(JSON.stringify(civ.annals));
      }
    }
  }, 120_000);

  it('不许灭:原本亡于战争的国家(seed 7、2024 各一个)加上后到第 3000 年仍在;编年史里记一条干预', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const { p, from } = fallenPolity(civ);
      const key = polityKey(civ, p.id);
      const c = generateCiv(world(seed), { interventions: [{ kind: 'protect', a: key, from }] });
      const id = idOf(c, key);
      expect(id, `seed ${seed}:${polityName(p, p.ended! - 1)} 还在新历史里`).toBeGreaterThanOrEqual(0);
      const q = c.polities[id];
      expect(q.ended, `seed ${seed}:${polityName(p, p.ended! - 1)}(原本亡于第 ${Math.floor(p.ended!)} 年)到第 3000 年仍在`).toBeUndefined();
      expect([...c.polity].filter((x) => x === id).length).toBeGreaterThan(0);
      expect(c.annals.some((e) => (e.kind === 'fall' && e.a === id) || (e.kind === 'merge' && e.b === id))).toBe(false);
      const iv = buildChronicle(c).filter((e) => e.kind === 'intervene');
      expect(iv.length).toBe(1);
      expect(iv[0].text).toMatch(/^【干预】.+自此不亡$/);
      expect(Math.floor(iv[0].year)).toBe(from);
      expect(iv[0].importance).toBe(3);
    }
  }, 120_000);

  it('保护到某一年:那之前不亡;之后照常(亡也亡在截止年份以后);编年史写"自此不亡,至第 N 年"', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const { p, from } = fallenPolity(civ);
      const key = polityKey(civ, p.id);
      const until = Math.floor(p.ended!) + 100;
      const v: Intervention = { kind: 'protect', a: key, from, until };
      // 做决定时现查:from 起护着,until 那一刻起不再护着
      const im = new InterventionModel([v], seed);
      im.pm = { polities: civ.polities, settlements: civ.settlements, terrain: { regions: civ.regions } } as never;
      expect([from - 0.5, from, until - 0.01, until, until + 50].map((t) => im.protects(p.id, t))).toEqual([false, true, true, false, false]);
      const c = generateCiv(world(seed), { interventions: [v] });
      const id = idOf(c, key);
      expect(id).toBeGreaterThanOrEqual(0);
      const q = c.polities[id];
      expect(q.ended === undefined || q.ended >= until, `seed ${seed}:到第 ${until} 年之前不亡(新历史亡于 ${q.ended})`).toBe(true);
      expect(c.annals.some((e) => e.year < until && ((e.kind === 'fall' && e.a === id) || (e.kind === 'merge' && e.b === id)))).toBe(false);
      const iv = buildChronicle(c).filter((e) => e.kind === 'intervene');
      expect(iv[0].text).toMatch(new RegExp(`^【干预】.+自此不亡,至第 ${until} 年$`));
      // 年份之前和不干预时逐字节一致
      expect(annalsBefore(c, from)).toBe(annalsBefore(civ, from));
    }
  }, 120_000);

  it('结盟:两国之后不互相宣战;结盟时正在交战的当即议和', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      for (const nth of [0, 1, 2]) {
        const [a, b, from, y] = rivals(civ, nth);
        expect(warsBetween(civ, a, b, from).length).toBeGreaterThan(0);
        const ka = polityKey(civ, a);
        const kb = polityKey(civ, b);
        const c = generateCiv(world(seed), { interventions: [{ kind: 'ally', a: ka, b: kb, from }] });
        const A = idOf(c, ka);
        const B = idOf(c, kb);
        expect(A).toBeGreaterThanOrEqual(0);
        expect(B).toBeGreaterThanOrEqual(0);
        expect(warsBetween(c, A, B, from), `seed ${seed}:第 ${Math.floor(y)} 年那场仗不再打`).toEqual([]);
        const text = buildChronicle(c).find((e) => e.kind === 'intervene')!.text;
        expect(text).toMatch(/^【干预】.+与.+结盟$/);
      }
      // 正在交战时结盟:当即议和(议和紧跟在干预后面)
      const w = civ.annals.find((e) => {
        if (e.kind !== 'war') return false;
        const end = civ.annals.find((f) => f.kind === 'peace' && f.war === e.war);
        return !!end && end.year - e.year > 6 && civ.polities[e.a].ended === undefined;
      })!;
      const mid = Math.floor(w.year) + 3;
      const c = generateCiv(world(seed), { interventions: [{ kind: 'ally', a: polityKey(civ, w.a), b: polityKey(civ, w.b), from: mid }] });
      const i = c.annals.findIndex((e) => e.kind === 'intervene');
      expect(c.annals[i + 1]?.kind).toBe('peace');
      expect(c.annals[i + 1].year).toBe(mid);
      expect(c.annals[i + 1].war).toBe(w.war);
    }
  }, 120_000);

  it('结盟:一方被第三国宣战时,另一方多半援盟参战(史事 war 的 settlement 列记盟国,编年史写"应某国之约")', () => {
    // 找几对"会被第三国攻打"的邻国结盟,看援盟有没有发生
    let joined = 0;
    let tried = 0;
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      for (const w of civ.annals) {
        if (w.kind !== 'war' || w.year < 1000) continue;
        // 宣战那一年年初结盟(之前的历史一字不差,这场仗照样会打):守方 w.b 和一个同时挨着攻方 w.a 的国家 z
        const y0 = Math.floor(w.year);
        if (w.year === y0 || civ.polities[w.b].founded >= y0 - 1) continue;
        const own = ownersAt(civ, y0 - 0.01).polity;
        const z = civ.polities.find(
          (q) => q.id !== w.a && q.id !== w.b && q.founded < y0 - 1 && (q.ended ?? Infinity) > w.year && own.includes(q.id) &&
            bordering(civ, q.id, w.b, y0 - 0.01) && bordering(civ, q.id, w.a, y0 - 0.01),
        )?.id;
        if (z === undefined) continue;
        tried++;
        const c = generateCiv(world(seed), {
          interventions: [{ kind: 'ally', a: polityKey(civ, z), b: polityKey(civ, w.b), from: y0 }],
        });
        const helped = c.annals.filter((e) => e.kind === 'war' && e.settlement >= 0);
        if (helped.length) {
          joined++;
          const e = helped[0];
          // 援盟那场仗紧跟在"第三国向盟国宣战"之后(同一刻)
          const i = c.annals.indexOf(e);
          const before = c.annals.slice(0, i).reverse().find((x) => x.kind === 'war' && x.year === e.year);
          expect(before && before.b === e.settlement && before.a === e.b).toBe(true);
          const entry = buildChronicle(c).find((x) => x.kind === 'war' && x.id === i);
          expect(entry?.text).toMatch(/应.+之约(,遣.+)?伐/);
        }
        if (tried >= 5 * (seed === 7 ? 1 : 2)) break;
      }
    }
    // 援盟的机会是 ALLY_JOIN(八成)
    expect(tried).toBeGreaterThanOrEqual(6);
    expect(joined, `试了 ${tried} 对盟国`).toBeGreaterThanOrEqual(Math.ceil(tried * 0.4));
  }, 180_000);

  it('宣战:那一年确有 war 史事(紧跟在干预后面);不接壤的打不成,编年史写明原因', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const y = 2000;
      const own = ownersAt(civ, y - 0.01).polity;
      const alive = civ.polities.filter((p) => p.founded < y - 1 && (p.ended ?? Infinity) > y && own.includes(p.id));
      // 一对接壤、此刻没在交战的国家;一对不接壤的
      let pair: [number, number] | null = null;
      let far: [number, number] | null = null;
      for (const p of alive) {
        for (const q of alive) {
          if (p.id === q.id) continue;
          const touch = bordering(civ, p.id, q.id, y - 0.01);
          const fighting = civ.annals.some(
            (e) =>
              e.kind === 'war' &&
              e.year < y &&
              ((e.a === p.id && e.b === q.id) || (e.a === q.id && e.b === p.id)) &&
              !civ.annals.some((f) => f.kind === 'peace' && f.war === e.war && f.year < y),
          );
          if (touch && !fighting && !pair) pair = [p.id, q.id];
          if (!touch && !far) far = [p.id, q.id];
        }
      }
      expect(pair && far).toBeTruthy();
      const [a, b] = pair!;
      const c = generateCiv(world(seed), {
        interventions: [
          { kind: 'declare', a: polityKey(civ, a), b: polityKey(civ, b), from: y },
          { kind: 'declare', a: polityKey(civ, far![0]), b: polityKey(civ, far![1]), from: y },
        ],
      });
      const i = c.annals.findIndex((e) => e.kind === 'intervene' && e.war === 0);
      expect(i).toBeGreaterThanOrEqual(0);
      const w = c.annals[i + 1];
      expect(w.kind).toBe('war');
      expect(w.year).toBe(y);
      expect([w.a, w.b]).toEqual([c.annals[i].a, c.annals[i].b]);
      const chron = buildChronicle(c).filter((e) => e.kind === 'intervene');
      expect(chron.map((e) => e.text)).toEqual([expect.stringMatching(/^【干预】.+向.+宣战$/), expect.stringMatching(/不接壤,未能成行$/)]);
      // 不接壤的那一条后面没有 war
      const j = c.annals.findIndex((e) => e.kind === 'intervene' && e.war === 1);
      expect(c.annals[j + 1]?.kind === 'war' && c.annals[j + 1].year === y && c.annals[j + 1].a === c.annals[j].a).toBe(false);
    }
  }, 120_000);

  it('禁止分裂:从那一年起没有州从它的国土里叛离', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      // 一个后来有州叛离的国家
      const s = civ.annals.find((e) => e.kind === 'split' && e.b >= 0 && e.year > 1200 && civ.polities[e.b].founded < e.year - 60);
      expect(s).toBeTruthy();
      const key = polityKey(civ, s!.b);
      const from = Math.floor(s!.year) - 30;
      const c = generateCiv(world(seed), { interventions: [{ kind: 'unity', a: key, from }] });
      const id = idOf(c, key);
      expect(c.annals.filter((e) => e.kind === 'split' && e.b === id && e.year >= from)).toEqual([]);
      expect(buildChronicle(c).find((e) => e.kind === 'intervene')!.text).toMatch(/四境无叛/);
    }
  }, 120_000);

  it('确定性:同样的干预两次推演逐字节相同;fromCiv 接着推(切在干预之前 / 之后)和一口气推完一致', () => {
    for (const seed of [7, 2024]) {
      const w = world(seed);
      const civ = base(seed);
      const { p, from } = fallenPolity(civ);
      const [a, b, allyFrom] = rivals(civ);
      const list: Intervention[] = [
        { kind: 'ally', a: polityKey(civ, a), b: polityKey(civ, b), from: allyFrom, until: 2400 },
        { kind: 'protect', a: polityKey(civ, p.id), from },
        { kind: 'declare', a: polityKey(civ, b), b: polityKey(civ, a), from: 2500 },
      ];
      const whole = generateCiv(w, { interventions: list });
      expect(fingerprint(generateCiv(w, { interventions: list.map((v) => ({ ...v })) }))).toBe(fingerprint(whole));
      for (const cut of [allyFrom - 1, allyFrom, Math.floor((from + allyFrom) / 2), 2450, 2500, 2700]) {
        const half = generateCiv(w, { endYear: cut, interventions: list });
        const sim = CivSim.fromCiv(w, half);
        sim.run(whole.endYear);
        const res = sim.result();
        const tag = `seed ${seed} 从第 ${cut} 年接着推`;
        expect(res.log.size, tag).toBe(whole.log.size);
        for (const k of ['year', 'region', 'layer', 'value', 'cause'] as const) {
          expect(bytes(res.log[k]).equals(bytes(whole.log[k].subarray(0, whole.log.size))), `${tag}:日志 ${k}`).toBe(true);
        }
        expect(JSON.stringify(res.annals), `${tag}:史事`).toBe(JSON.stringify(whole.annals));
        const m = polityModelOf(sim)!;
        expect(JSON.stringify(strip(m.polities)), `${tag}:国家表`).toBe(JSON.stringify(strip(whole.polities)));
        expect(JSON.stringify(strip(m.settlements)), `${tag}:城镇表`).toBe(JSON.stringify(strip(whole.settlements)));
      }
    }
  }, 240_000);

  it('改名按稳定键照样套得上;键指不到(新历史里没有这国)时不报错', () => {
    const seed = 7;
    const civ = base(seed);
    const { p, from } = fallenPolity(civ);
    const key = polityKey(civ, p.id);
    const c = generateCiv(world(seed), { interventions: [{ kind: 'protect', a: key, from }] });
    // 新历史里没有的国家:原来在 from 以后才立的、新历史里键指不到的
    const lost = civ.polities.map((q) => polityKey(civ, q.id)).filter((k) => idOf(c, k) < 0);
    const names: Record<string, string> = { [key]: '饕餮', 'polity:r99999#0': '不存在', ...(lost[0] ? { [lost[0]]: '失落' } : {}) };
    const named = applyNames(c, names);
    const id = idOf(c, key);
    expect(named.polities[id].name).toBe('饕餮');
    expect(polityName(named.polities[id], named.endYear)).toContain('饕餮');
    expect(named.polities.some((q) => q.name === '失落' || q.name === '不存在')).toBe(false);
    // 编年史里的干预条目也用新名字
    expect(buildChronicle(named).find((e) => e.kind === 'intervene')!.text).toContain('饕餮');
    // 干预里的键指不到:不报错,不记干预
    const none = generateCiv(world(seed), { interventions: [{ kind: 'protect', a: 'polity:r99999#0', from: 1000 }] });
    expect(none.annals.some((e) => e.kind === 'intervene')).toBe(false);
    expect(fingerprint(none)).toBe(fingerprint(civ));
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 划州、立国、迁都、不许扩张

/** y 年某国的州数 */
const sizeAt = (civ: Civ, p: number, y: number) => ownersAt(civ, y).polity.reduce((n, x) => n + (x === p ? 1 : 0), 0);

/** y 年(之前一刻)有人住、属某国、不是国都的一州,和它的主人(国家立国满 100 年、那年之后还在) */
function ownedRegion(civ: Civ, y: number): { r: number; o: number } {
  const own = ownersAt(civ, y - 0.01);
  for (let r = 0; r < civ.regions.count; r++) {
    const o = own.polity[r];
    if (o < 0 || own.culture[r] < 0) continue;
    const P = civ.polities[o];
    if (P.founded > y - 100 || (P.ended ?? Infinity) <= y + 1 || civ.settlements[capitalAt(P, y)].region === r) continue;
    return { r, o };
  }
  throw new Error('找不到有主的州');
}

/** y 年有人住、不属任何国家(部落地带)的一州 */
function tribalRegion(civ: Civ, y: number): number {
  const own = ownersAt(civ, y - 0.01);
  for (let r = 0; r < civ.regions.count; r++) if (own.culture[r] >= 0 && own.polity[r] < 0) return r;
  throw new Error('找不到部落地带');
}

/** y 年没人住的州 */
function emptyRegion(civ: Civ, y: number): number {
  const own = ownersAt(civ, y - 0.01);
  for (let r = 0; r < civ.regions.count; r++) if (own.culture[r] < 0) return r;
  throw new Error('找不到没人住的州');
}

/** y 年某国的一个边境州(不是国都),和挨着它的另一国(到第 3000 年仍在);原本到第 3000 年不归那一国 */
function borderRegion(civ: Civ, y: number): { r: number; o: number; q: number } {
  const own = ownersAt(civ, y - 0.01).polity;
  const reg = civ.regions;
  for (let r = 0; r < reg.count; r++) {
    const o = own[r];
    if (o < 0 || civ.settlements[capitalAt(civ.polities[o], y)].region === r) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const q = own[reg.adj[k]];
      if (q >= 0 && q !== o && civ.polities[q].ended === undefined && civ.polity[r] !== q) return { r, o, q };
    }
  }
  throw new Error('找不到边境州');
}

/** y 年最大的国家,和它国土里另一座城(不是国都) */
function bigPolityCity(civ: Civ, y: number): { p: number; s: number } {
  const own = ownersAt(civ, y - 0.01).polity;
  const alive = civ.polities.filter((p) => p.founded < y - 1 && (p.ended ?? Infinity) > y + 1);
  alive.sort((a, b) => sizeAt(civ, b.id, y) - sizeAt(civ, a.id, y) || a.id - b.id);
  const P = alive[0];
  const cap = capitalAt(P, y);
  const s = civ.settlements.filter((x) => x.id !== cap && own[x.region] === P.id && x.founded < y && (x.ended ?? Infinity) > y).pop()!;
  return { p: P.id, s: s.id };
}

/** a 到 b 年间扩张最多的国家 */
function expander(civ: Civ, a: number, b: number): number {
  let best = -1;
  let gain = 0;
  for (const p of civ.polities) {
    if (!(p.founded < a && (p.ended ?? Infinity) > b)) continue;
    const g = sizeAt(civ, p.id, b) - sizeAt(civ, p.id, a);
    if (g > gain) {
      gain = g;
      best = p.id;
    }
  }
  return best;
}

/**
 * 找一段"有国家在扩张"的 600 年:先看第 1000–1600 年,没有(这个世界的国家立得晚、或那几百年里谁都没长)再往后挪。
 * 返回起止年份和扩张得最多的国家
 */
function expansion(civ: Civ): { a: number; b: number; p: number } {
  for (const a of [1000, 1200, 1400, 1600, 800]) {
    const b = a + 600;
    const p = expander(civ, a, b);
    if (p >= 0 && sizeAt(civ, p, b) - sizeAt(civ, p, a) > 5) return { a, b, p };
  }
  return { a: 1000, b: 1600, p: expander(civ, 1000, 1600) };
}

/** 干预年份之前逐字节一致:日志、史事;推到干预那一刻之前为止,国家表、城镇表、归属也一样 */
function samePast(seed: number, v: Intervention, c: Civ) {
  const w = world(seed);
  const civ = base(seed);
  const y = v.from;
  const la = logBefore(c, y);
  const lb = logBefore(civ, y);
  expect(la.n, `seed ${seed} ${v.kind}:日志条数`).toBe(lb.n);
  la.parts.forEach((x, i) => expect(x.equals(lb.parts[i]), `seed ${seed} ${v.kind}:日志`).toBe(true));
  expect(annalsBefore(c, y), `seed ${seed} ${v.kind}:史事`).toBe(annalsBefore(civ, y));
  const cut = y - 1 / 256;
  const x0 = generateCiv(w, { endYear: cut });
  const x1 = generateCiv(w, { endYear: cut, interventions: [v] });
  expect(JSON.stringify(x1.polities), `seed ${seed} ${v.kind}:国家表`).toBe(JSON.stringify(x0.polities));
  expect(JSON.stringify(x1.settlements), `seed ${seed} ${v.kind}:城镇表`).toBe(JSON.stringify(x0.settlements));
  expect(bytes(x1.polity).equals(bytes(x0.polity))).toBe(true);
}

const ivText = (c: Civ) => buildChronicle(c).filter((e) => e.kind === 'intervene').map((e) => e.text);

describe('干预 · 划州 / 立国 / 迁都 / 不许扩张 · 数据格式', () => {
  it('cleanInterventions 认划州、立国、迁都、不许扩张;国名按改名的规矩清理;键格式不对的丢掉', () => {
    const good: Intervention[] = [
      { kind: 'cede', a: 'polity:r12#0', region: 'region:r40', from: 1800 },
      { kind: 'cede', a: 'polity:r12#0', region: 'region:r40', from: 1800, permanent: true },
      { kind: 'found', region: 'region:r40', from: 1500 },
      { kind: 'found', region: 'region:r40', from: 1500, name: '饕餮' },
      { kind: 'move', a: 'polity:r12#0', city: 'settlement:r40#1', from: 2000 },
      { kind: 'halt', a: 'polity:r12#0', from: 1000 },
      { kind: 'halt', a: 'polity:r12#0', from: 1000, until: 1400 },
    ];
    expect(cleanInterventions(good)).toBe(good);
    const c = cleanInterventions([
      ...good,
      { kind: 'cede', a: 'polity:r12#0', region: 'polity:r40#0', from: 1 },
      { kind: 'cede', a: 'polity:r12#0', region: 'region:r40', from: 1, permanent: 'yes' },
      { kind: 'found', a: 'polity:r12#0', from: 1 },
      { kind: 'found', region: 'region:r4', from: 1, name: '  秦国 ' },
      { kind: 'found', region: 'region:r4', from: 1, name: '   ' },
      { kind: 'move', a: 'polity:r12#0', city: 'region:r4', from: 1 },
      { kind: 'halt', a: 'polity:r12#0', from: 900.7, until: 800 },
    ]);
    expect(c.slice(0, good.length)).toEqual(good);
    expect(c.slice(good.length)).toEqual([
      { kind: 'cede', a: 'polity:r12#0', region: 'region:r40', from: 1 },
      { kind: 'found', region: 'region:r4', from: 1, name: '秦' },
      { kind: 'found', region: 'region:r4', from: 1 },
      { kind: 'halt', a: 'polity:r12#0', from: 900 },
    ]);
  });
});

describe('干预 · 划州 / 立国 / 迁都 / 不许扩张 · 推演', () => {
  it('立国:那一年这州立起一个新国家(有主的州从原主分出来;部落地带也行);之前逐字节一致;编年史写"【干预】…立国"', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const y = 1500;
      const { r, o } = ownedRegion(civ, y);
      const t = tribalRegion(civ, y);
      for (const [region, parent] of [
        [r, o],
        [t, -1],
      ]) {
        const v: Intervention = { kind: 'found', region: regionKey(civ, region), from: y, name: '饕餮' };
        const c = generateCiv(world(seed), { interventions: [v] });
        samePast(seed, v, c);
        const iv = c.annals.find((e) => e.kind === 'intervene')!;
        const p = c.polities[iv.a];
        expect(p, `seed ${seed} 州 ${region}`).toBeTruthy();
        expect(p.founded).toBe(y);
        expect(p.name).toBe('饕餮');
        expect(c.settlements[p.capital].region).toBe(region);
        expect(p.culture).toBe(ownersAt(civ, y - 0.01).culture[region]);
        expect(p.parent).toBe(parent < 0 ? undefined : parent);
        expect(ownersAt(c, y).polity[region]).toBe(p.id);
        expect(polityKey(c, p.id)).toMatch(new RegExp(`^polity:c${civ.regions.seat[region]}#\\d+$`));
        // 立国那条 found 并进干预那一条
        const text = ivText(c);
        expect(text).toEqual([parent >= 0 ? expect.stringMatching(/^【干预】.+脱.+自立,号饕餮.+都/) : expect.stringMatching(/^【干预】.+立国,号饕餮/)]);
        expect(buildChronicle(c).some((e) => e.kind === 'found' && e.polities[0] === p.id)).toBe(false);
        // 开国之君写在干预那一条里
        const founder = c.people!.find((x) => x.role === 'ruler' && x.polity === p.id)!;
        const entry = buildChronicle(c).find((e) => e.kind === 'intervene')!;
        expect(entry.text).toContain(`奉${founder.name}为主`);
        expect(entry.people).toContain(founder.id);
        expect(interventionOutcome(c, 0)).toMatchObject({ ok: true });
      }
    }
  }, 180_000);

  it('立国出来的国家能改名、能被"不许灭"引用(它到第 3000 年仍在)', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const y = 1500;
      const { r } = ownedRegion(civ, y);
      const found: Intervention = { kind: 'found', region: regionKey(civ, r), from: y };
      const c1 = generateCiv(world(seed), { interventions: [found] });
      const id1 = c1.annals.find((e) => e.kind === 'intervene')!.a;
      const key = polityKey(c1, id1);
      // 改名
      const named = applyNames(c1, { [key]: '饕餮' });
      expect(named.polities[id1].name).toBe('饕餮');
      expect(ivText(named)[0]).toContain('饕餮');
      // 不许灭(引用新国家的键;同一年、排在立国后面)
      const c2 = generateCiv(world(seed), { interventions: [found, { kind: 'protect', a: key, from: y }] });
      const id2 = idOf(c2, key);
      expect(id2).toBeGreaterThanOrEqual(0);
      expect(c2.polities[id2].founded).toBe(y);
      expect(c2.polities[id2].ended, `seed ${seed}:立出来的国家加了不许灭`).toBeUndefined();
      expect(ivText(c2)[1]).toMatch(/自此不亡$/);
      // 之前的历史一样:干预年份之前的史事
      expect(annalsBefore(c2, y)).toBe(annalsBefore(civ, y));
    }
  }, 180_000);

  it('划州:那一年这州归该国(原主照常);"永久"的到第 3000 年仍属该国;没人住的州划不成,写明原因', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const y = 1800;
      const { r, o, q } = borderRegion(civ, y);
      const kq = polityKey(civ, q);
      const ko = polityKey(civ, o);
      for (const permanent of [false, true]) {
        const v: Intervention = permanent
          ? { kind: 'cede', a: kq, region: regionKey(civ, r), from: y, permanent: true }
          : { kind: 'cede', a: kq, region: regionKey(civ, r), from: y };
        const c = generateCiv(world(seed), { interventions: [v] });
        samePast(seed, v, c);
        const Q = idOf(c, kq);
        const O = idOf(c, ko);
        expect(ownersAt(c, y).polity[r], `seed ${seed}:划过去了`).toBe(Q);
        // 不算战争:原主那一刻没亡、没有战争史事
        expect(c.polities[O].ended === undefined || c.polities[O].ended! > y).toBe(true);
        expect(c.annals.some((e) => e.year === y && e.kind === 'war' && (e.a === Q || e.b === Q))).toBe(false);
        if (permanent) {
          expect(c.polity[r], `seed ${seed}:永久划给的州到第 3000 年仍属该国`).toBe(Q);
          expect(c.polities[Q].ended).toBeUndefined();
        }
        expect(ivText(c)[0]).toMatch(permanent ? /^【干预】.+划归.+永为.+之土$/ : /^【干预】.+划归.+$/);
      }
      // 没人住的州:划不成
      const e = emptyRegion(civ, y);
      const c = generateCiv(world(seed), { interventions: [{ kind: 'cede', a: kq, region: regionKey(civ, e), from: y }] });
      expect(ivText(c)[0]).toMatch(/无人居住$/);
      expect(interventionOutcome(c, 0)).toMatchObject({ ok: false, why: expect.stringMatching(/没人住/) });
      expect(ownersAt(c, y + 1).polity[e]).toBe(-1);
    }
  }, 180_000);

  it('迁都:那一年国都换到这座城;城不在本国国土里的迁不成,写明原因', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const y = 2000;
      const { p, s } = bigPolityCity(civ, y);
      const k = polityKey(civ, p);
      const v: Intervention = { kind: 'move', a: k, city: settlementKey(civ, s), from: y };
      const c = generateCiv(world(seed), { interventions: [v] });
      samePast(seed, v, c);
      const id = idOf(c, k);
      expect(capitalAt(c.polities[id], y), `seed ${seed}:迁都到 ${civ.settlements[s].name}`).toBe(s);
      const i = c.annals.findIndex((e) => e.kind === 'intervene');
      expect(c.annals[i + 1]).toMatchObject({ kind: 'capital', a: id, settlement: s, year: y });
      expect(ivText(c)[0]).toMatch(new RegExp(`^【干预】.+迁都${civ.settlements[s].name}$`));
      // 迁都那条 capital 并进干预那一条
      expect(buildChronicle(c).some((e) => e.kind === 'capital' && e.id === i + 1)).toBe(false);
      // 别国的城:迁不成
      const own = ownersAt(civ, y - 0.01).polity;
      const foreign = civ.settlements.find((x) => own[x.region] >= 0 && own[x.region] !== p && x.founded < y && (x.ended ?? Infinity) > y)!;
      const c2 = generateCiv(world(seed), { interventions: [{ kind: 'move', a: k, city: settlementKey(civ, foreign.id), from: y }] });
      expect(capitalAt(c2.polities[idOf(c2, k)], y)).toBe(capitalAt(civ.polities[p], y));
      expect(ivText(c2)[0]).toMatch(/^【干预】.+欲迁都.+,然.+属.+$/);
      expect(interventionOutcome(c2, 0)).toMatchObject({ ok: false, why: expect.stringMatching(/不在本国国土里/) });
    }
  }, 180_000);

  it('不许扩张:禁令期间国土不增、不主动宣战;到期后接着扩张', () => {
    for (const seed of [7, 2024]) {
      const civ = base(seed);
      const { a, b, p } = expansion(civ);
      const k = polityKey(civ, p);
      expect(sizeAt(civ, p, b) - sizeAt(civ, p, a), `seed ${seed}:原本扩张了`).toBeGreaterThan(5);
      for (const until of [undefined, a + 400]) {
        const v: Intervention = until ? { kind: 'halt', a: k, from: a, until } : { kind: 'halt', a: k, from: a };
        const c = generateCiv(world(seed), { interventions: [v] });
        samePast(seed, v, c);
        const id = idOf(c, k);
        const end = until ?? c.endYear;
        const n0 = sizeAt(c, id, a);
        // 禁令期间一州不多(被打时丢了的州反攻夺回不算扩张:不超过开头的州数)
        for (let y = a; y < end; y += 50) expect(sizeAt(c, id, y), `seed ${seed} 第 ${y} 年`).toBeLessThanOrEqual(n0);
        // 不主动宣战(也不援盟)
        expect(c.annals.filter((e) => e.kind === 'war' && e.a === id && e.year >= a && e.year < end)).toEqual([]);
        if (until) expect(sizeAt(c, id, b), `seed ${seed}:到期后接着扩张`).toBeGreaterThan(sizeAt(c, id, until));
        expect(ivText(c)[0]).toMatch(until ? new RegExp(`不再开疆拓土,至第 ${until} 年`) : /不再开疆拓土/);
      }
    }
  }, 180_000);

  it('确定性:四种一起下,两次推演逐字节相同;fromCiv 在干预之前 / 当年 / 之后切开接着推都和一口气推完一致', () => {
    for (const seed of [7, 2024]) {
      const w = world(seed);
      const civ = base(seed);
      const { r } = ownedRegion(civ, 1500);
      const bd = borderRegion(civ, 1800);
      const mv = bigPolityCity(civ, 2000);
      const hp = expansion(civ);
      const list: Intervention[] = [
        { kind: 'halt', a: polityKey(civ, hp.p), from: hp.a, until: hp.a + 400 },
        { kind: 'found', region: regionKey(civ, r), from: 1500 },
        { kind: 'cede', a: polityKey(civ, bd.q), region: regionKey(civ, bd.r), from: 1800, permanent: true },
        { kind: 'move', a: polityKey(civ, mv.p), city: settlementKey(civ, mv.s), from: 2000 },
      ];
      const whole = generateCiv(w, { interventions: list });
      expect(fingerprint(generateCiv(w, { interventions: list.map((v) => ({ ...v })) }))).toBe(fingerprint(whole));
      const cuts = new Set([999, 1000, 1200, 1400, 1450, 1500, 1501, 1800, 2000, 2400, hp.a - 1, hp.a, hp.a + 400]);
      for (const cut of [...cuts].sort((x, y) => x - y)) {
        const half = generateCiv(w, { endYear: cut, interventions: list });
        const sim = CivSim.fromCiv(w, half);
        sim.run(whole.endYear);
        const res = sim.result();
        const tag = `seed ${seed} 从第 ${cut} 年接着推`;
        expect(res.log.size, tag).toBe(whole.log.size);
        for (const k of ['year', 'region', 'layer', 'value', 'cause'] as const) {
          expect(bytes(res.log[k]).equals(bytes(whole.log[k].subarray(0, whole.log.size))), `${tag}:日志 ${k}`).toBe(true);
        }
        expect(JSON.stringify(res.annals), `${tag}:史事`).toBe(JSON.stringify(whole.annals));
        const m = polityModelOf(sim)!;
        expect(JSON.stringify(strip(m.polities)), `${tag}:国家表`).toBe(JSON.stringify(strip(whole.polities)));
        expect(JSON.stringify(strip(m.settlements)), `${tag}:城镇表`).toBe(JSON.stringify(strip(whole.settlements)));
      }
    }
  }, 300_000);
});
