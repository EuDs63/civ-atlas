/**
 * 名字、稳定键、历史"留在原地"(阶段 4 改地形):
 * - 起名不碰推演:除名字外的世界、历史钉住指纹(推演有意改了就更新,GENERATOR_VERSION 加一);同种子两次(连名字)逐字节相同
 * - 名字按位置取:放一座小火山 / 挖一个湖以后,锚点和语感都没变的地名不变;远处的海名基本不变;挖湖时远处的地名 ≥ 80% 不变
 * - 推演随机数按位置取(gen/civ/rand.ts):改地形后州号、国家编号错开,远处的民族、国家大多照旧
 * - 稳定键按地块定位:改地形以后指回同一块地方,或者找不到;旧 r 格式(州号)照样能读
 * - 干预用新键:改地形以后照样生效,指不到的标"未生效"
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, MAP_H, MAP_W, generateWorld, type World } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ, Place } from '../src/gen/civ/types';
import { interventionOutcome } from '../src/gen/civ/chronicle';
import { applyNames, cultureKey, polityKey, regionKey, resolveKey, settlementKey, type Intervention, type TerrainOp } from '../src/gen/edits';
import { ownersAt } from '../src/gen/civ/timeline';

// ---------------------------------------------------------------------------
// 工具

/** 离某类地块(陆地 / 海)最远的一格(按邻接步数;只在地图中间一带找)—— 和 terrain-edits.test.ts 一样 */
function farthestFrom(w: World, wantLand: boolean): number {
  const { n, adjStart, adj, x, y } = w.mesh;
  const dist = new Int32Array(n).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < n; i++) if ((w.water[i] === 0) !== wantLand) (dist[i] = 0), q.push(i);
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (dist[j] < 0) (dist[j] = dist[i] + 1), q.push(j);
    }
  }
  let best = -1;
  for (let i = 0; i < n; i++) {
    if ((w.water[i] === 0) !== wantLand || Math.abs(y[i] - MAP_H / 2) > 260 || x[i] < 200 || x[i] > MAP_W - 200) continue;
    if (best < 0 || dist[i] > dist[best]) best = i;
  }
  return best;
}

interface Case {
  w0: World;
  c0: Civ;
  w1: World;
  c1: Civ;
  op: TerrainOp;
}

const bases = new Map<number, { w: World; c: Civ }>();
function base(seed: number) {
  let b = bases.get(seed);
  if (!b) {
    const w = generateWorld({ ...DEFAULT_PARAMS, seed });
    bases.set(seed, (b = { w, c: generateCiv(w) }));
  }
  return b;
}

/** 界面上的档位(gen/terrainEdits.ts 的 TERRAIN_PRESETS):海里最开阔处放一座小火山("小"档)/ 陆上离海最远处挖一个湖("中"档:州数会变、州号错开) */
const cases = new Map<string, Case>();
function edited(seed: number, kind: 'volcano' | 'lake'): Case {
  const id = `${seed}-${kind}`;
  let c = cases.get(id);
  if (!c) {
    const { w: w0, c: c0 } = base(seed);
    const at = farthestFrom(w0, kind === 'lake');
    const pts = [Math.round(w0.mesh.x[at]), Math.round(w0.mesh.y[at])];
    const op: TerrainOp = kind === 'volcano' ? { kind, pts, r: 18, s: 0.85 } : { kind, pts, r: 16, s: 1 };
    const w1 = generateWorld({ ...DEFAULT_PARAMS, seed }, undefined, [op]);
    cases.set(id, (c = { w0, c0, w1, c1: generateCiv(w1), op }));
  }
  return c;
}

/** 离修改处够远(世界坐标)才算"远处" */
const FAR = 200;
const farFrom = (k: Case) => (cell: number) => Math.hypot(k.w0.mesh.x[cell] - k.op.pts[0], k.w0.mesh.y[cell] - k.op.pts[1]) > FAR;

/** 改地形以后同一个地理实体:同种类、锚点最近(3 个地块间距以内) */
function counterpart(k: Case, p: Place): Place | null {
  const { x, y } = k.w0.mesh;
  const sp = Math.sqrt((MAP_W * MAP_H * 0.66) / DEFAULT_PARAMS.cells);
  let best: Place | null = null;
  let bd = Infinity;
  for (const q of k.c1.places) {
    if (q.kind !== p.kind) continue;
    const d = Math.hypot(x[p.cell!] - x[q.cell!], y[p.cell!] - y[q.cell!]);
    if (d < bd) (bd = d), (best = q);
  }
  return bd <= 3 * sp ? best : null;
}

const styleOf = (civ: Civ, p: Place) => (p.culture >= 0 ? civ.cultures[p.culture].style : '');
const ratio = (xs: boolean[]) => xs.filter(Boolean).length / Math.max(1, xs.length);

/** 除名字以外的世界 + 历史的指纹(名字、语感、东方 / 西幻、拉丁原形、改名前的名字不算;小数按 64 位原样) */
const NAME_FIELDS = new Set(['name', 'style', 'eastern', 'latin', 'defaultName']);
const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);
function historyPrint(world: World, civ: Civ): string {
  const h = createHash('sha1');
  const feed = (v: unknown): void => {
    if (v === null || v === undefined) return void h.update(`~${v}`);
    if (ArrayBuffer.isView(v)) return void h.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    if (Array.isArray(v)) {
      h.update(`[${v.length}`);
      v.forEach(feed);
      return void h.update(']');
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v as object).sort()) {
        if (NAME_FIELDS.has(k)) continue;
        h.update(`.${k}`);
        feed((v as Record<string, unknown>)[k]);
      }
      return;
    }
    // 小数按 64 位原样比:推演里的 pow / exp / log 都舍入到 24 位(gen/civ/rand.ts),Apple 芯片的 macOS 和 x64 的 Linux(CI)上逐位一样
    if (typeof v === 'number') {
      f64[0] = v;
      return void h.update(f64b);
    }
    h.update(`${typeof v}:${String(v)}`);
  };
  feed({ elevation: world.elevation, water: world.water, flux: world.flux });
  feed(civ);
  return h.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------

describe('起名不碰推演', () => {
  it('没有改地形时,除名字外的世界、历史钉住指纹;同种子两次连名字都一样', () => {
    // 期望值是 GENERATOR_VERSION 7(球面世界 + 人物、战役 + 洋流)算的。推演、地形有意改了的话更新它,并把 GENERATOR_VERSION 加一
    const expected: Record<number, string> = { 7: 'd4f58570144a6564', 2024: '9783af7f2472c61d' };
    for (const seed of [7, 2024]) {
      const P = { ...DEFAULT_PARAMS, cells: 12000, seed };
      const w = generateWorld(P);
      const a = generateCiv(w);
      expect(historyPrint(w, a), `seed ${seed}`).toBe(expected[seed]);
      const b = generateCiv(generateWorld(P));
      const names = (c: Civ) =>
        JSON.stringify([c.cultures.map((x) => [x.name, x.style]), c.regions.name, c.settlements.map((x) => x.name), c.polities.map((p) => [p.name, p.eastern, p.dynasties?.map((d) => d.name)]), c.places.map((p) => [p.name, p.latin])]);
      expect(names(b)).toBe(names(a));
    }
  }, 60_000);
});

describe.each([7, 2024])('改地形以后名字留在原地 · seed=%i', (seed) => {
  it('放一座小火山:锚点和语感都没变的地名不变(≥ 95%);远处的海名不变 ≥ 80%', () => {
    const k = edited(seed, 'volcano');
    const far = farFrom(k);
    const kept: boolean[] = [];
    const seas: boolean[] = [];
    for (const p of k.c0.places) {
      if (!far(p.cell!)) continue;
      const q = counterpart(k, p);
      if (p.kind === 'sea') seas.push(q?.name === p.name);
      if (q && q.cell === p.cell && styleOf(k.c1, q) === styleOf(k.c0, p)) kept.push(q.name === p.name);
    }
    expect(kept.length, '锚点、语感都没变的地名够多').toBeGreaterThan(10);
    expect(ratio(kept), `seed ${seed} 锚点、语感没变的地名不变的比例`).toBeGreaterThanOrEqual(0.95);
    expect(seas.length).toBeGreaterThan(3);
    expect(ratio(seas), `seed ${seed} 远处海名不变的比例`).toBeGreaterThanOrEqual(0.8);
  }, 60_000);

  it('挖一个湖:远处的地名(海、山、河、湖、岛、荒漠)不变 ≥ 80%;同一处的城锚点、语感都没变的,城名不变', () => {
    const k = edited(seed, 'lake');
    const far = farFrom(k);
    const same = k.c0.places.filter((p) => far(p.cell!)).map((p) => counterpart(k, p)?.name === p.name);
    expect(same.length).toBeGreaterThan(20);
    expect(ratio(same), `seed ${seed} 远处地名不变的比例`).toBeGreaterThanOrEqual(0.8);
    // 城:同一地块上的第一座城,民族的语感也没变的,名字不变
    const first1 = new Map<number, number>();
    for (const s of k.c1.settlements) if (!first1.has(s.cell)) first1.set(s.cell, s.id);
    const seen = new Set<number>();
    const cities: boolean[] = [];
    for (const s of k.c0.settlements) {
      if (seen.has(s.cell) || !far(s.cell)) continue;
      seen.add(s.cell);
      const t = k.c1.settlements[first1.get(s.cell) ?? -1];
      if (t && k.c1.cultures[t.culture]?.style === k.c0.cultures[s.culture]?.style) cities.push(t.name === s.name);
    }
    expect(cities.length).toBeGreaterThan(100);
    expect(ratio(cities), `seed ${seed} 同一处、语感没变的城名不变的比例`).toBeGreaterThanOrEqual(0.95);
  }, 60_000);
});

describe.each([7, 2024])('改地形以后远处的历史大多照旧 · seed=%i', (seed) => {
  /** 远处(离修改处 > FAR)、改前改后都是陆地的地块上,这一年的民族 / 国家没变(按稳定键配对:同一处发源的民族、同一处立的国)的比例 */
  function kept(k: Case, year: number): { culture: number; polity: number } {
    const far = farFrom(k);
    const { c0, c1 } = k;
    const cu = c0.cultures.map((_, i) => resolveKey(c1, cultureKey(c0, i))?.id ?? -2);
    const po = c0.polities.map((_, i) => resolveKey(c1, polityKey(c0, i))?.id ?? -2);
    const a = ownersAt(c0, year);
    const a0 = { culture: a.culture.slice(), polity: a.polity.slice() };
    const b = ownersAt(c1, year);
    const same = (x: number, y: number, map: number[]) => (x < 0 ? y < 0 : map[x] === y);
    let n = 0;
    let c = 0;
    let p = 0;
    for (let i = 0; i < k.w0.mesh.n; i++) {
      const r0 = c0.regions.of[i];
      const r1 = c1.regions.of[i];
      if (r0 < 0 || r1 < 0 || !far(i)) continue;
      n++;
      if (same(a0.culture[r0], b.culture[r1], cu)) c++;
      if (same(a0.polity[r0], b.polity[r1], po)) p++;
    }
    return { culture: c / n, polity: p / n };
  }

  it('挖一个湖(州数变了、州号错开):远处陆地到第 3000 年民族没变 ≥ 80%、国家没变 ≥ 75%', () => {
    const k = edited(seed, 'lake');
    expect(k.c1.regions.count, '州数变了(州号错开)').not.toBe(k.c0.regions.count);
    const r = kept(k, k.c0.endYear);
    expect(r.culture, `seed ${seed} 民族`).toBeGreaterThanOrEqual(0.8);
    expect(r.polity, `seed ${seed} 国家`).toBeGreaterThanOrEqual(0.75);
  }, 60_000);

  it('海里放一座小火山:远处的地形不变(99% 以上);远处陆地到第 3000 年民族没变 ≥ 85%、国家没变 ≥ 75%;远处海、山、河的名字没变 ≥ 80%', () => {
    const k = edited(seed, 'volcano');
    // 地形里的随机小洼地按地块取(world.ts):远处的海陆、群落和不放火山时一样,海拔只差风带里水汽的一点点(< 1 米)
    const far = farFrom(k);
    let farLand = 0;
    let moved = 0;
    for (let i = 0; i < k.w0.mesh.n; i++) {
      if (!far(i) || k.w0.water[i] !== 0) continue;
      farLand++;
      if (k.w1.water[i] !== 0 || k.w1.biome[i] !== k.w0.biome[i] || Math.abs(k.w1.elevation[i] - k.w0.elevation[i]) >= 1) moved++;
    }
    expect(farLand).toBeGreaterThan(5000);
    expect(moved / farLand, `seed ${seed} 远处地形变了的陆地块`).toBeLessThan(0.01);
    const r = kept(k, k.c0.endYear);
    expect(r.culture, `seed ${seed} 民族`).toBeGreaterThanOrEqual(0.85);
    expect(r.polity, `seed ${seed} 国家`).toBeGreaterThanOrEqual(0.75);
    const shr = k.c0.places.filter((p) => far(p.cell!) && (p.kind === 'sea' || p.kind === 'mountains' || p.kind === 'river'));
    expect(ratio(shr.map((p) => counterpart(k, p)?.name === p.name)), `seed ${seed} 海山河`).toBeGreaterThanOrEqual(0.8);
  }, 60_000);
});

describe('稳定键按地块定位', () => {
  it.each(['volcano', 'lake'] as const)('%s:州、城、国家的键指回同一块地方,或者找不到;旧 r 格式按州号解析(改地形后多半指到别处)', (kind) => {
    const k = edited(7, kind);
    const { c0, c1 } = k;
    const seat0 = c0.regions.seat;
    const seat1 = c1.regions.seat;
    const of1 = c1.regions.of;
    // 州:指"现在包含治所那块地的州";大多数州的治所没变,就是同一州
    let sameNew = 0;
    let sameOld = 0;
    for (let r = 0; r < c0.regions.count; r++) {
      const a = resolveKey(c1, regionKey(c0, r));
      if (of1[seat0[r]] < 0) expect(a).toBeNull();
      else expect(a).toEqual({ kind: 'region', id: of1[seat0[r]] });
      if (a && seat1[a.id] === seat0[r]) sameNew++;
      const b = resolveKey(c1, `region:r${r}`);
      if (b && seat1[b.id] === seat0[r]) sameOld++;
    }
    expect(sameNew / c0.regions.count, '新键指回同一治所的州').toBeGreaterThan(0.9);
    expect(sameNew).toBeGreaterThan(sameOld * 2);
    // 城:找不到,或者是现在包含那块地的州里的城;大多数就是同一地块上的城
    let cityHere = 0;
    for (const s of c0.settlements) {
      const a = resolveKey(c1, settlementKey(c0, s.id));
      if (!a) continue;
      expect(a.kind).toBe('settlement');
      expect(c1.settlements[a.id].region).toBe(of1[s.cell]);
      if (c1.settlements[a.id].cell === s.cell) cityHere++;
    }
    expect(cityHere / c0.settlements.length, '新键指回同一地块的城').toBeGreaterThan(0.85);
    // 国家:找不到(那里没有立过第几个国),或者是立国时国都在那块地所在州的国家
    for (const p of c0.polities) {
      const a = resolveKey(c1, polityKey(c0, p.id));
      if (!a) continue;
      const q = c1.polities[a.id];
      expect(c1.settlements[q.capital].region).toBe(of1[c0.settlements[p.capital].cell]);
    }
  }, 60_000);

  it('改名按新键套上:改地形以后改过名的城、州还在原地;那块地方成了水就找不到(改名先留着,不套到别处)', () => {
    const k = edited(7, 'volcano');
    const { c0, c1 } = k;
    const far = farFrom(k);
    const s = c0.settlements.find((x) => far(x.cell) && resolveKey(c1, settlementKey(c0, x.id)))!;
    const r = c0.regions.seat.findIndex((cell, i) => far(cell) && i > 100 && c1.regions.of[cell] >= 0);
    const named = applyNames(c1, { [settlementKey(c0, s.id)]: '饕餮城', [regionKey(c0, r)]: '九嶷州' });
    const t = named.settlements.find((x) => x.name === '饕餮城')!;
    expect(t.cell).toBe(s.cell);
    const r1 = c1.regions.of[c0.regions.seat[r]];
    expect(named.regionNames?.[r1]).toBe('九嶷州');
    // 在治所上挖个湖:这州的键找不到了
    const w0 = k.w0;
    const seat = c0.regions.seat[r];
    const lake: TerrainOp = { kind: 'lake', pts: [Math.round(w0.mesh.x[seat]), Math.round(w0.mesh.y[seat])], r: 10, s: 0.7 };
    const w2 = generateWorld({ ...DEFAULT_PARAMS, seed: 7 }, undefined, [lake]);
    expect(w2.water[seat], '治所成了湖').not.toBe(0);
    const c2 = generateCiv(w2);
    expect(resolveKey(c2, regionKey(c0, r))).toBeNull();
    expect(applyNames(c2, { [regionKey(c0, r)]: '九嶷州' })).toBe(c2);
  }, 60_000);

  it('干预用新键:改地形以后照样生效(同一处立的国);指不到的标"未生效"', () => {
    const k = edited(7, 'lake');
    const { c0, c1, w1 } = k;
    const far = farFrom(k);
    // 一个改地形前后都在同一处立国、干预那年还在的国家:不许灭
    const Y = 1500;
    const p = c0.polities.find((x) => {
      const a = resolveKey(c1, polityKey(c0, x.id));
      if (!a || !far(c0.settlements[x.capital].cell)) return false;
      const q = c1.polities[a.id];
      return q.founded < Y && (q.ended ?? Infinity) > Y;
    })!;
    expect(p, '找得到改地形前后都在的国家').toBeTruthy();
    const key = polityKey(c0, p.id);
    const ok: Intervention = { kind: 'protect', a: key, from: Y };
    // 指不到的国家(那块地方没立过第 9 个国)、成了水的州
    const lost: Intervention = { kind: 'unity', a: key.replace(/#\d+$/, '#9'), from: Y };
    const sea = c1.regions.of.findIndex((r) => r < 0);
    const nowhere: Intervention = { kind: 'found', region: `region:c${sea}`, from: Y };
    const c = generateCiv(w1, { interventions: [ok, lost, nowhere] });
    const id = resolveKey(c, key)!.id;
    expect(interventionOutcome(c, 0)).toMatchObject({ ok: true });
    expect(c.annals[interventionOutcome(c, 0).annal].a).toBe(id);
    expect(c.polities[id].ended, '不许灭:到最后还在').toBeUndefined();
    expect(interventionOutcome(c, 1).ok).toBe(false);
    expect(interventionOutcome(c, 2)).toMatchObject({ ok: false, why: expect.stringMatching(/没有这个州/) });
  }, 120_000);
});
