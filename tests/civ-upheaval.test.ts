/**
 * 地形大事(gen/civ/upheaval.ts;格式见 gen/edits.ts 文件头"地形大事"):选一年让火山喷发、地震抬升、海水漫进来。
 * - 格式:清理(年份取整夹回范围、只认三种修改、件数和笔数有上限)、同一年的合成一件、存档往返
 * - 大事那一年以前:日志、史事、名字、人物、信仰、地名、道路和没有大事时一致;没有大事 = 逐字节不变
 * - 后果:沉了的州没人住、城没于水(不再重建)、国都迁走;火山毁城;隆起的陆地连起两块陆地;编年史并成一条;沉了的遗址不再画
 * - 确定性:同样的大事两次推演逐字节相同
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { mergeUpheavals, previewUpheaval, previewVictims, upheavalBase, upheavalSteps, type UpheavalStep } from '../src/gen/civ/upheaval';
import { DEFAULT_CIV_PARAMS } from '../src/gen/civ';
import { buildChronicle } from '../src/gen/civ/chronicle';
import { ownersAt } from '../src/gen/civ/timeline';
import { capitalAt, ruinSites } from '../src/gen/civ/growth';
import { UPHEAVALS_MAX, UPHEAVAL_OPS_MAX, UPHEAVAL_YEARS, cleanUpheavals, sameUpheavals } from '../src/gen/terrainEdits';
import { EMPTY_EDITS, applyNames, placeKeyOf, polityKey, regionKey, resolveKey, settlementKey, type Upheaval } from '../src/gen/edits';
import { editCount, makeSave, parseSave, saveText } from '../src/gen/savefile';
import { fullChronicle } from '../src/gen/civ/religionText';
import { faithAt } from '../src/gen/civ/religion';
import { civAtEra, withHistory } from '../src/ui/eras';
import { makeFlagView } from '../src/ui/flagStore';
import { upheavalText } from '../src/ui/WorldOverviewInterventions';
import { computeHabitat } from '../src/gen/civ/habitat';
import { reshapeRegions } from '../src/gen/civ/regions';

const PARAMS = { ...DEFAULT_PARAMS, seed: 7 };
/** 种子 7 上的三件大事:大霄国都一带海水漫进来、兹拉季纳国都一带火山喷发、两国之间的海峡隆起 */
const FLOOD: Upheaval = { year: 1600, ops: [{ kind: 'sink', pts: [1856, 574, 1936, 584], r: 40, s: 1.1 }] };
const VOLCANO: Upheaval = { year: 1800, ops: [{ kind: 'volcano', pts: [1278, 768], r: 36, s: 1.1 }] };
const BRIDGE: Upheaval = { year: 2000, ops: [{ kind: 'raise', pts: [1566, 632, 1604, 670], r: 18, s: 1.1 }] };

let w0: World | null = null;
const world = () => (w0 ??= generateWorld(PARAMS));
let plain: Civ | null = null;
const base = () => (plain ??= generateCiv(world()));
const stepsCache = new Map<string, UpheavalStep[]>();
const steps = (list: Upheaval[]) => {
  const key = JSON.stringify(list);
  let s = stepsCache.get(key);
  if (!s) stepsCache.set(key, (s = upheavalSteps(PARAMS, [], null, list)));
  return s;
};
const civs = new Map<string, Civ>();
const civOf = (list: Upheaval[]) => {
  const key = JSON.stringify(list);
  let c = civs.get(key);
  if (!c) civs.set(key, (c = generateCiv(world(), { upheavals: steps(list) })));
  return c;
};

const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function logBefore(civ: Civ, y: number) {
  const L = civ.log;
  let n = 0;
  while (n < L.size && L.year[n] < y) n++;
  return { n, parts: (['year', 'region', 'layer', 'value', 'cause'] as const).map((k) => bytes(L[k].subarray(0, n))) };
}
/** 大事那一年以前出现过的名字、配色 */
function namesBefore(civ: Civ, y: number, R: number) {
  return JSON.stringify({
    polities: civ.polities.filter((p) => p.founded < y).map((p) => [p.name, p.color, p.eastern, (p.dynasties ?? []).filter((d) => d.year < y).map((d) => d.name)]),
    settlements: civ.settlements.filter((s) => s.founded < y).map((s) => s.name),
    cultures: civ.cultures.map((c) => [c.name, c.style, c.color]),
    regions: (civ.regions.name ?? []).slice(0, R),
  });
}
/** 大事那一年以前的人物(编号可能因为之后多出来的人错开,按内容比) */
const peopleBefore = (civ: Civ, y: number) =>
  JSON.stringify(
    (civ.people ?? [])
      .filter((p) => (p.from ?? Infinity) < y)
      .map((p) => [p.role, p.name, p.polity, p.from, p.born])
      .sort(),
  );
function religionBefore(civ: Civ, y: number, R: number) {
  const r = civ.religion!;
  return JSON.stringify({
    events: r.events.filter((e) => e.year < y).map((e) => [e.year, e.kind, r.faiths[e.faith].name, e.polity, e.region, e.settlement]),
    states: r.states.filter((s) => s.from < y).map((s) => [s.polity, r.faiths[s.faith].name, s.from, s.until !== undefined && s.until < y ? s.until : null]),
    checkpoints: r.checkpoints.filter((c) => c.year < y).map((c) => [c.year, Array.from(c.faith.subarray(0, R))]),
  });
}
const placesOf = (ps: Civ['places']) => JSON.stringify(ps.map((p) => [p.kind, p.name, p.cell, p.path.length]));

describe('地形大事 · 格式', () => {
  it('清理:年份取整夹回范围,只认火山 / 抬起陆地 / 沉成海,一笔不剩的丢掉,最多几件几笔;本来就合格的原样返回', () => {
    const ok = [FLOOD, VOLCANO];
    expect(cleanUpheavals(ok)).toBe(ok);
    expect(cleanUpheavals(null)).toEqual([]);
    const lake = { kind: 'lake', pts: [100, 100], r: 10, s: 1 };
    const got = cleanUpheavals([
      { year: 1600.7, ops: [FLOOD.ops[0], lake] },
      { year: -5, ops: VOLCANO.ops },
      { year: 99999, ops: BRIDGE.ops },
      { year: 1200, ops: [lake] },
      { year: 'x', ops: VOLCANO.ops },
      'nope',
    ]);
    expect(got).toEqual([
      { year: 1600, ops: FLOOD.ops },
      { year: UPHEAVAL_YEARS[0], ops: VOLCANO.ops },
      { year: UPHEAVAL_YEARS[1], ops: BRIDGE.ops },
    ]);
    const many = Array.from({ length: UPHEAVALS_MAX + 3 }, (_, i) => ({ year: 100 + i, ops: VOLCANO.ops }));
    expect(cleanUpheavals(many)).toHaveLength(UPHEAVALS_MAX);
    const strokes = Array.from({ length: UPHEAVAL_OPS_MAX + 5 }, () => FLOOD.ops[0]);
    expect(cleanUpheavals([{ year: 10, ops: strokes }])[0].ops).toHaveLength(UPHEAVAL_OPS_MAX);
    expect(sameUpheavals([FLOOD], [{ year: 1600, ops: [{ ...FLOOD.ops[0], pts: FLOOD.ops[0].pts.slice() }] }])).toBe(true);
    expect(sameUpheavals([FLOOD], [VOLCANO])).toBe(false);
    expect(sameUpheavals(undefined, [])).toBe(true);
  });

  it('按年份排,同一年的按列表先后合成一件(修改接在一起,记下是哪几件);年份不在推演里的不算', () => {
    const m = mergeUpheavals([VOLCANO, FLOOD, { year: 1800, ops: BRIDGE.ops }, { year: 3000, ops: BRIDGE.ops }]);
    expect(m.map((u) => [u.year, u.items, u.ops.map((o) => o.kind)])).toEqual([
      [1600, [1], ['sink']],
      [1800, [0, 2], ['volcano', 'raise']],
    ]);
  });

  it('存档:存读往返不变,改了几处把地形大事算进去;格式不对的跳过并提示;没有地形大事不写这一项', () => {
    const edits = { ...EMPTY_EDITS, upheavals: [FLOOD, BRIDGE] };
    const save = makeSave(PARAMS, edits, 'x', '世界', '2026-10-08T00:00:00.000Z');
    expect(editCount(save.edits)).toBe(2);
    const back = parseSave(saveText(save));
    expect(back.ok && back.save.edits.upheavals).toEqual([FLOOD, BRIDGE]);
    expect('upheavals' in makeSave(PARAMS, EMPTY_EDITS, 'x').edits).toBe(false);
    const raw = JSON.parse(saveText(save));
    raw.edits.upheavals.push({ year: 5, ops: [] }, 'bad');
    const r = parseSave(JSON.stringify(raw));
    expect(r.ok && r.save.edits.upheavals).toEqual([FLOOD, BRIDGE]);
    expect(r.ok && r.warnings.some((w) => w.includes('2 件地形大事'))).toBe(true);
    // 读进来了、但丢了几笔的也提示
    raw.edits.upheavals = [{ year: 1700, ops: [{ kind: 'paint' }, ...Array.from({ length: UPHEAVAL_OPS_MAX + 2 }, () => FLOOD.ops[0])] }];
    const s = parseSave(JSON.stringify(raw));
    expect(s.ok && s.save.edits.upheavals![0].ops).toHaveLength(UPHEAVAL_OPS_MAX);
    expect(s.ok && s.warnings).toEqual(expect.arrayContaining([expect.stringContaining('1 笔格式不对'), expect.stringContaining('多出来的 2 笔')]));
  });
});

describe('地形大事 · 推演', () => {
  it('没有地形大事:和不加这一项逐字节相同', () => {
    const a = base();
    const b = generateCiv(world(), { upheavals: [] });
    expect(logBefore(b, Infinity)).toEqual(logBefore(a, Infinity));
    expect(JSON.stringify(b.annals)).toBe(JSON.stringify(a.annals));
    expect(b.eras).toBeUndefined();
    expect(b.upheavals).toBeUndefined();
  }, 120_000);

  it('三件连着发生:第一件那一年以前的日志、史事、名字、人物、信仰、地名、道路和没有大事时一样', () => {
    const a = base();
    const b = civOf([FLOOD, VOLCANO, BRIDGE]);
    const Y = FLOOD.year;
    const R = a.regions.count;
    expect(logBefore(b, Y)).toEqual(logBefore(a, Y));
    expect(JSON.stringify(b.annals.filter((e) => e.year < Y))).toBe(JSON.stringify(a.annals.filter((e) => e.year < Y)));
    expect(namesBefore(b, Y, R)).toBe(namesBefore(a, Y, R));
    expect(peopleBefore(b, Y)).toBe(peopleBefore(a, Y));
    expect(religionBefore(b, Y, R)).toBe(religionBefore(a, Y, R));
    expect(b.eras!.map((e) => e.until)).toEqual([1600, 1800, 2000]);
    expect(placesOf(b.eras![0].places)).toBe(placesOf(a.places));
    expect(JSON.stringify(b.eras![0].routes)).toBe(JSON.stringify(a.routes));
    expect(b.upheavals!.map((u) => [u.year, u.kinds, u.items])).toEqual([
      [1600, ['sink'], [0]],
      [1800, ['volcano'], [1]],
      [2000, ['raise'], [2]],
    ]);
    // 第二件以前和"只有第一件"一样
    const one = civOf([FLOOD]);
    expect(logBefore(b, VOLCANO.year)).toEqual(logBefore(one, VOLCANO.year));
    expect(JSON.stringify(b.annals.filter((e) => e.year < VOLCANO.year))).toBe(JSON.stringify(one.annals.filter((e) => e.year < VOLCANO.year)));
  }, 300_000);

  it('海水漫进来:整州沉没的州从那一刻起没人住,城没于水、不再重建,国都迁走;编年史并成一条', () => {
    const b = civOf([FLOOD]);
    const Y = FLOOD.year;
    const f = b.upheavals![0];
    expect(f.drowned.length).toBeGreaterThan(0);
    for (const r of f.drowned) expect(b.regions.cellStart[r + 1] - b.regions.cellStart[r]).toBe(0);
    const after = ownersAt(b, Y + 0.5);
    for (const r of f.drowned) {
      expect(after.polity[r]).toBe(-1);
      expect(after.culture[r]).toBe(-1);
      expect(b.polity[r]).toBe(-1);
    }
    const sunk = b.annals.filter((e) => e.kind === 'sunk' && e.year === Y);
    expect(sunk.length).toBeGreaterThan(1);
    const last = steps([FLOOD])[0].world;
    for (const e of sunk) {
      expect(e.b).toBe(1);
      expect(b.settlements[e.settlement].ended).toBe(Y);
      expect(last.water[b.settlements[e.settlement].cell]).not.toBe(0);
      expect(b.settlements.some((s) => s.rebuilds === e.settlement)).toBe(false);
    }
    // 结束时还在的城都在陆地上
    for (const s of b.settlements) if (s.ended === undefined) expect(last.water[s.cell]).toBe(0);
    // 大霄的国都沉了,迁都
    const p = b.polities[f.polity];
    expect(capitalAt(p, Y - 1 / 256)).toBe(sunk[0].settlement);
    expect(b.settlements[capitalAt(p, Y + 0.5)].ended).toBeUndefined();
    const e = buildChronicle(b).find((x) => x.kind === 'upheaval')!;
    expect(e.tag).toBe('变');
    expect(e.importance).toBe(3);
    expect(e.text).toMatch(/^海水漫入.+州沉入海中,[^国]+等.+城没于水,迁都.+$/);
    expect(e.children!.filter((c) => c.kind === 'sunk')).toHaveLength(sunk.length);
    expect(buildChronicle(b).some((x) => x.kind === 'sunk')).toBe(false);
  }, 300_000);

  it('后果都并进大事那一条:亡了的国家打着的仗,议和记在后果之后;早先的遗址城址沉了,从那年起不再画', () => {
    // 第 2730 年:维利科拉国(正和萨兰提亚帝国打仗)五州全沉,萨兰提亚帝国的国都德鲁索纳也沉了(州还在,迁都)
    const Y = 2730;
    const seats = [
      [289, 432],
      [268, 435],
      [311, 424],
      [322, 391],
      [302, 406],
    ];
    const W: Upheaval = { year: Y, ops: [...seats.map((pts) => ({ kind: 'sink' as const, pts, r: 68, s: 1.1 })), { kind: 'sink', pts: [152, 225], r: 12, s: 1.1 }] };
    const b = civOf([W]);
    const at = b.annals.filter((e) => e.year === Y).map((e) => e.kind);
    expect(at).toContain('fall');
    expect(at.lastIndexOf('capital')).toBeGreaterThan(at.indexOf('fall'));
    expect(at.indexOf('peace')).toBeGreaterThan(at.lastIndexOf('capital'));
    const ch = buildChronicle(b).filter((x) => b.annals[x.id]?.year === Y);
    expect(ch.map((x) => x.kind)).toEqual(['upheaval']);
    expect(ch[0].text).toMatch(/亡,.+迁都/);
    // 揽霄关第 2111 年毁于战火、没有重建;第 2200 年城址沉入海中
    const R: Upheaval = { year: 2200, ops: [{ kind: 'sink', pts: [1772, 437], r: 30, s: 1.1 }] };
    const r = civOf([R]);
    const id = r.settlements.findIndex((s) => s.name === '揽霄关');
    expect(r.settlements[id].ended).toBeLessThan(R.year);
    expect(r.upheavals![0].ruins).toEqual([id]);
    expect(ruinSites(r, R.year - 1).map((s) => s.id)).toContain(id);
    expect(ruinSites(r, R.year).map((s) => s.id)).not.toContain(id);
  }, 300_000);

  it('大事同一年下的干预照常生效,排在大事后面', () => {
    const p = base().polities.findIndex((x) => x.name.startsWith('兹拉季纳'));
    const iv = [{ kind: 'protect' as const, a: polityKey(base(), p), from: VOLCANO.year }];
    const c = generateCiv(world(), { interventions: iv, upheavals: steps([VOLCANO]) });
    const k = c.annals.findIndex((e) => e.kind === 'intervene' && e.war === 0);
    expect(k).toBeGreaterThan(c.annals.findIndex((e) => e.kind === 'upheaval'));
    expect(c.annals[k].year).toBe(VOLCANO.year);
  }, 300_000);

  it('火山喷发:山下的国都被毁、迁都;隆起的陆地连起两块陆地;同一年的两件合成一件', () => {
    const v = civOf([VOLCANO]);
    const ev = buildChronicle(v).find((x) => x.kind === 'upheaval')!;
    expect(ev.text).toMatch(/境内火山喷发,国都.+被毁,迁都/);
    const burnt = v.annals.filter((e) => e.kind === 'sunk');
    expect(burnt.length).toBeGreaterThan(0);
    for (const e of burnt) expect(e.b).toBe(0);

    const r = civOf([BRIDGE]);
    const f = r.upheavals![0];
    expect(f.joined).toBeDefined();
    expect(f.joinedBy![0]).not.toBe(f.joinedBy![1]);
    expect(buildChronicle(r).find((x) => x.kind === 'upheaval')!.text).toMatch(/之间的海峡隆起成陆$/);
    // 新冒出来的陆地都分进了州
    const w = steps([BRIDGE])[0].world;
    for (let c = 0; c < w.mesh.n; c++) if (w.water[c] === 0) expect(r.regions.of[c]).toBeGreaterThanOrEqual(0);

    const both = steps([VOLCANO, { year: VOLCANO.year, ops: BRIDGE.ops }]);
    expect(both).toHaveLength(1);
    expect(both[0].items).toEqual([0, 1]);
    expect(both[0].ops.map((o) => o.kind)).toEqual(['volcano', 'raise']);
  }, 300_000);

  it('稳定键:大事前就有的国家、城、州,键和没有大事时一样,国都沉了的国家照样找得到;大事前后各段的州指同一个', () => {
    const b = civOf([FLOOD]);
    const plain0 = base();
    const Y = FLOOD.year;
    const f = b.upheavals![0];
    for (const p of plain0.polities.filter((x) => x.founded < Y)) expect(polityKey(b, p.id)).toBe(polityKey(plain0, p.id));
    for (const s of plain0.settlements.filter((x) => x.founded < Y)) expect(settlementKey(b, s.id)).toBe(settlementKey(plain0, s.id));
    for (let r = 0; r < plain0.regions.count; r++) expect(regionKey(b, r)).toBe(regionKey(plain0, r));
    // 国都沉了的那一国、整州沉没的州:按键都找得回来
    expect(resolveKey(b, polityKey(b, f.polity))).toEqual({ kind: 'polity', id: f.polity });
    for (const r of f.drowned) expect(resolveKey(b, regionKey(b, r))).toEqual({ kind: 'region', id: r });
    for (const p of b.polities) expect(resolveKey(b, polityKey(b, p.id))).toEqual({ kind: 'polity', id: p.id });
    for (const s of b.settlements) expect(resolveKey(b, settlementKey(b, s.id))).toEqual({ kind: 'settlement', id: s.id });
    // 大事前那一段的州(Civ.eras)和大事后一样认键
    const era = { ...b, regions: { ...b.eras![0].regions, keyOf: b.regions.keyOf, keySeat: b.regions.keySeat } };
    expect(polityKey(era, f.polity)).toBe(polityKey(b, f.polity));
  }, 300_000);

  it('山海河湖:大事前后还是同一处的,锚点挪了键也一样,改的名在两段都认得', () => {
    const b = civOf([FLOOD]);
    const e0 = civAtEra(b, 0);
    let moved = 0;
    const names: Record<string, string> = {};
    b.places.forEach((p, j) => {
      const i = e0.places.findIndex((q) => q.kind === p.kind && q.name === p.name);
      if (i < 0) return;
      if (e0.places[i].cell !== p.cell) moved++;
      expect(placeKeyOf(b, j)).toBe(placeKeyOf(e0, i));
      names[placeKeyOf(b, j)] = `改名${j}`;
    });
    expect(moved).toBeGreaterThan(0);
    const after = applyNames(b, names).places;
    const before = applyNames(e0, names).places;
    b.places.forEach((p, j) => {
      const i = e0.places.findIndex((q) => q.kind === p.kind && q.name === p.name);
      if (i >= 0) expect(before[i].name).toBe(after[j].name);
    });
  }, 300_000);

  it('沉下去又抬起来的地方:新划出来的州按键找得回自己', () => {
    const UP: Upheaval = { year: 1800, ops: [{ kind: 'raise', pts: [1856, 574, 1936, 584], r: 44, s: 1.6 }] };
    const b = civOf([FLOOD, UP]);
    expect(b.upheavals![1].added.length).toBeGreaterThan(0);
    for (let r = 0; r < b.regions.count; r++) expect(resolveKey(b, regionKey(b, r))).toEqual({ kind: 'region', id: r });
  }, 300_000);

  it('海里抬出新州:不在整百年的大事到下一个检查点之间,新州没人住(检查点按州数补齐)', () => {
    const Y = 2050;
    const ISLAND: Upheaval = {
      year: Y,
      ops: [
        { kind: 'raise', pts: [1820, 473, 1860, 473], r: 44, s: 1.6 },
        { kind: 'raise', pts: [1840, 453, 1840, 493], r: 44, s: 1.6 },
      ],
    };
    const b = civOf([ISLAND]);
    const f = b.upheavals![0];
    expect(f.added.length).toBeGreaterThan(0);
    for (const c of b.checkpoints) expect(c.polity.length).toBe(b.regions.count);
    const own = ownersAt(b, Y + 0.5);
    for (const r of f.added) expect(own.polity[r]).toBe(-1);
    // 时间轴在大事以前:那一段的州少,归属、信仰照样查得出来(和整段历史的前面那些州一样)
    const e0 = civAtEra(b, 0);
    expect(e0.regions.count).toBeLessThan(b.regions.count);
    const R0 = e0.regions.count;
    for (const y of [1000, 2000]) {
      const a = ownersAt(e0, y);
      const full = ownersAt(b, y);
      expect(Array.from(a.polity)).toEqual(Array.from(full.polity.subarray(0, R0)));
      expect(Array.from(a.culture)).toEqual(Array.from(full.culture.subarray(0, R0)));
      expect(Array.from(faithAt(e0, y))).toEqual(Array.from(faithAt(b, y).subarray(0, R0)));
    }
  }, 300_000);

  it('地图在大事以前那一段时:编年史按整段历史算,国旗按大事以前的地形配(拖时间轴跨过大事都不变)', () => {
    const b = civOf([FLOOD]);
    const e0 = withHistory(civAtEra(b, 0), b);
    expect(e0.regions.count).toBe(b.eras![0].regions.count);
    expect(fullChronicle(e0)).toBe(fullChronicle(b));
    const w0 = world();
    const w1 = steps([FLOOD])[0].world;
    const geo = { world: w0, civ: civAtEra(b, 0) };
    const before = makeFlagView(w0, e0, undefined, null, geo).book;
    const after = makeFlagView(w1, b, undefined, null, geo).book;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  }, 300_000);

  it('预览("会怎么样"):放好还没发生时算出来的州和城,和真让它发生以后一样', () => {
    // 已经有第 1600 年的海水漫进来,再预览第 1800 年的火山:那一年的地形、州是套上第一件以后的
    const civ = civOf([FLOOD]);
    const prior = steps([FLOOD]);
    const both = steps([FLOOD, VOLCANO]);
    const { world: w0, regions: r0 } = upheavalBase(world(), prior, VOLCANO.year, DEFAULT_CIV_PARAMS.regionArea);
    expect(w0).toBe(prior[0].world);
    expect(r0.count).toBe(civ.regions.count);
    expect(Array.from(r0.of)).toEqual(Array.from(civ.regions.of));
    const pv = previewUpheaval(w0, r0, both[1].world, VOLCANO.ops, DEFAULT_CIV_PARAMS.regionArea);
    const real = civOf([FLOOD, VOLCANO]);
    const f = real.upheavals![1];
    expect([pv.region, pv.drowned, pv.shrunk, pv.grown, pv.added, pv.sunk, pv.risen]).toEqual([f.region, f.drowned, f.shrunk, f.grown, f.added, f.sunk, f.risen]);
    expect(pv.risenCells.length).toBe(pv.risen);
    const victims = previewVictims(civ, world(), both[1].world.water, VOLCANO.year, VOLCANO.ops);
    const sunk = real.annals.filter((e) => e.kind === 'sunk' && e.war === 1);
    expect(victims.map((v) => [v.id, v.drowned])).toEqual(sunk.map((e) => [e.settlement, e.b === 1]));
    expect(victims[0].capital).toBe(true);
  }, 300_000);

  it('预览同一年的第二件:州和两件合成一件真发生以后一样(只算再加的这几笔改了什么)', () => {
    // 第 1600 年已经有海水漫进来,同一年再在同一处抬升:真发生时两件合成一件,从那一年以前的州一次划到底
    const UP: Upheaval = { year: FLOOD.year, ops: [{ kind: 'raise', pts: [1856, 574, 1936, 584], r: 44, s: 1.6 }] };
    const { world: w0, regions: r0 } = upheavalBase(world(), steps([FLOOD]), FLOOD.year, DEFAULT_CIV_PARAMS.regionArea);
    expect(w0).toBe(steps([FLOOD])[0].world);
    expect(r0.count).toBe(base().regions.count);
    const w1 = steps([FLOOD, UP])[0].world;
    const pv = previewUpheaval(w0, r0, w1, UP.ops, DEFAULT_CIV_PARAMS.regionArea);
    const real = civOf([FLOOD, UP]);
    const r1 = reshapeRegions(w1, computeHabitat(w1), r0, { regionArea: DEFAULT_CIV_PARAMS.regionArea });
    expect(r1.count).toBe(real.regions.count);
    expect(Array.from(r1.of)).toEqual(Array.from(real.regions.of));
    expect(pv.added).toEqual(real.upheavals![0].added);
    // 同一年前一件淹掉的州又抬了起来:不算这一件淹的
    expect(pv.drowned).toEqual([]);
    expect(pv.risen).toBeGreaterThan(0);
  }, 300_000);

  it('「我的干预」里同一年的几件:"连起两块陆地"只算给连起来的那一处的那一件', () => {
    // 同一年在两处抬升:合成一条以后连起的是第二件那一带的两块陆地,第一件那一行不说"之间"
    const ISLE: Upheaval = { year: BRIDGE.year, ops: [{ kind: 'raise', pts: [1820, 473, 1860, 473], r: 44, s: 1.6 }] };
    const list = [BRIDGE, ISLE];
    const b = civOf(list);
    const F = b.upheavals![0];
    expect(F.items).toEqual([0, 1]);
    const [sa, sb] = F.joined!.map((r) => b.regions.seat[r]);
    const w = steps(list)[0].world;
    for (const c of [sa, sb]) expect(Math.abs(w.mesh.x[c] - 1840)).toBeLessThan(80);
    expect(upheavalText(b, w, list, 1).text).toContain('之间');
    expect(upheavalText(b, w, list, 0).text).not.toContain('之间');
  }, 300_000);

  it('确定性:同样的大事两次推演逐字节相同', () => {
    const a = civOf([FLOOD, VOLCANO, BRIDGE]);
    const b = generateCiv(world(), { upheavals: upheavalSteps(PARAMS, [], null, [FLOOD, VOLCANO, BRIDGE]) });
    expect(logBefore(b, Infinity)).toEqual(logBefore(a, Infinity));
    expect(JSON.stringify(b.annals)).toBe(JSON.stringify(a.annals));
    expect(JSON.stringify(b.polities)).toBe(JSON.stringify(a.polities));
    expect(JSON.stringify(b.settlements)).toBe(JSON.stringify(a.settlements));
    expect(placesOf(b.places)).toBe(placesOf(a.places));
    expect(JSON.stringify(b.upheavals)).toBe(JSON.stringify(a.upheavals));
  }, 300_000);
});
