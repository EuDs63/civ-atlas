import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type WorldParams, type World } from '../src/gen/world';
import { Biome } from '../src/gen/biomes';
import { MinHeap } from '../src/gen/util';
import { generateCiv, type Civ } from '../src/gen/civ';
import { Layer } from '../src/gen/civ/types';
import { CivSim, Ev, CHECKPOINT_EVERY, quantize } from '../src/gen/civ/sim';
import { ownersAt, ownersFromScratch } from '../src/gen/civ/timeline';
import { planCultures, travelYears, cultureTerrain, type CultureModel } from '../src/gen/civ/cultures';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

/** 同一个参数只生成一次世界(生成一次要零点几秒) */
const worlds = new Map<string, World>();
function world(p: WorldParams): World {
  const key = JSON.stringify(p);
  let w = worlds.get(key);
  if (!w) worlds.set(key, (w = generateWorld(p)));
  return w;
}

/**
 * 参照实现:一次多源洇染(不经过事件引擎)。各民族从发源州出发,先到先得,不可居的州只路过;
 * 次序和引擎一样按"时刻(1/256 年)+ 预约先后"。返回 endYear 时各州的民族和定居年份。
 */
function referenceFlood(m: CultureModel, endYear: number) {
  const T = m.terrain;
  const reg = T.regions;
  const R = T.R;
  const owner = new Int16Array(R).fill(-1);
  const when = new Float64Array(R).fill(Infinity);
  const passed = new Uint8Array(m.cultures.length * R);
  const heap = new MinHeap(256);
  const eT: number[] = [];
  const eR: number[] = [];
  const eC: number[] = [];
  let seq = 0;
  const push = (t: number, r: number, c: number) => {
    const tq = quantize(t);
    eT.push(tq);
    eR.push(r);
    eC.push(c);
    heap.push(eT.length - 1, Math.round(tq * 256) * 2 ** 28 + seq++);
  };
  for (const cu of m.cultures) push(cu.born, cu.hearth, cu.id);
  while (heap.size) {
    const e = heap.pop();
    const t = eT[e];
    if (t > endYear) break;
    const r = eR[e];
    const c = eC[e];
    if (T.habitable[r]) {
      if (owner[r] >= 0) continue;
      owner[r] = c;
      when[r] = t;
    } else {
      if (passed[c * R + r]) continue;
      passed[c * R + r] = 1;
    }
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const j = reg.adj[k];
      if (T.habitable[j] ? owner[j] >= 0 : passed[c * R + j]) continue;
      const dt = travelYears(m, c, k);
      if (dt < Infinity) push(t + dt, j, c);
    }
  }
  return { owner, when };
}

/**
 * 扩散阶段的尽头:阶段 3 同化与迁徙(assimilation.ts)第一次改换民族的前一刻(1/256 年)。
 * 在这之前,民族层只有诞生和到达,应当和一次多源洇染逐州一致;之后民族会被同化、迁徙改掉,不再比
 */
function spreadPhaseEnd(civ: Civ): number {
  const L = civ.log;
  for (let i = 0; i < L.size; i++) {
    if (L.layer[i] === Layer.Culture && L.cause[i] !== Ev.CultureBorn && L.cause[i] !== Ev.CultureArrive) return quantize(L.year[i] - 1 / 256);
  }
  return civ.endYear;
}

/** 和 generateCiv 用同样的输入重新定一遍民族(不含推演后的起名 / 配色) */
function modelOf(w: World, civ: Civ, birthSpan: number): CultureModel {
  return planCultures(w, civ.habitat, civ.regions, { cultures: 'auto', pace: 1, birthSpan })!;
}

/** Civ 里所有能比的数组 */
function arraysOf(civ: Civ) {
  const L = civ.log;
  return {
    culture: civ.culture,
    polity: civ.polity,
    year: L.year.subarray(0, L.size),
    region: L.region.subarray(0, L.size),
    layer: L.layer.subarray(0, L.size),
    value: L.value.subarray(0, L.size),
    cause: L.cause.subarray(0, L.size),
    ...Object.fromEntries(civ.checkpoints.flatMap((c, i) => [[`cp${i}c`, c.culture], [`cp${i}p`, c.polity]])),
  };
}

function bytes(a: ArrayBufferView) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

describe('推演引擎(合成的小例子)', () => {
  it('同一时刻的事件按预约先后处理;州的归属变了,之前预约到这个州的事件过期作废', () => {
    const sim = new CivSim(3);
    const seen: string[] = [];
    sim.on(Ev.CultureArrive, (r, c, t) => {
      seen.push(`${t}:${r}←${c}`);
      if (sim.owners[Layer.Culture][r] < 0) sim.setOwner(Layer.Culture, r, c, Ev.CultureArrive);
    });
    sim.schedule(10, Ev.CultureArrive, 0, 1);
    sim.schedule(10, Ev.CultureArrive, 0, 2); // 同一时刻、后预约:版本号已变,过期
    sim.schedule(5, Ev.CultureArrive, 1, 3);
    sim.schedule(10, Ev.CultureArrive, 2, 4);
    sim.schedule(10, Ev.CultureArrive, 2, 5);
    sim.run(20);
    expect(seen).toEqual(['5:1←3', '10:0←1', '10:2←4']);
    expect(Array.from(sim.owners[Layer.Culture])).toEqual([1, 3, 4]);
    expect(Array.from(sim.version)).toEqual([1, 1, 1]);
    const res = sim.result();
    expect(res.log.size).toBe(3);
    expect(Array.from(res.log.region)).toEqual([1, 0, 2]);
    expect(Array.from(res.log.year)).toEqual([5, 10, 10]);
  });

  it('检查点存"那一年及以前的变化全部生效后"的状态;run 只推到给定年份', () => {
    const sim = new CivSim(2);
    // 自定义一个不核对版本号的事件类型(阶段 3 的"攻占"之类):州 0 先归 7,250 年后改归 9
    const TAKE = 60;
    sim.on(TAKE, (r, c) => sim.setOwner(Layer.Culture, r, c, TAKE), { watch: false });
    sim.schedule(100, TAKE, 0, 7); // 正好在检查点那一年:算进检查点
    sim.schedule(150, TAKE, 1, 8);
    sim.schedule(250.001, TAKE, 0, 9);
    sim.run(200);
    let res = sim.result();
    expect(res.checkpoints.map((c) => c.year)).toEqual([100, 200]);
    expect(Array.from(res.checkpoints[0].culture)).toEqual([7, -1]);
    expect(Array.from(res.checkpoints[1].culture)).toEqual([7, 8]);
    expect(sim.pending).toBe(1);
    sim.run(300);
    res = sim.result();
    expect(res.checkpoints.map((c) => c.year)).toEqual([100, 200, 300]);
    expect(Array.from(res.culture)).toEqual([9, 8]);
    // 事件时间取整到 1/256 年
    expect(res.log.year[2]).toBe(quantize(250.001));
  });

  it('setOwner 写日志、版本号 +1、通知监听者;新值等于旧值时什么都不做', () => {
    const sim = new CivSim(2);
    const heard: number[][] = [];
    sim.onChange(Layer.Culture, (r, v, prev, cause) => heard.push([r, v, prev, cause]));
    sim.setOwner(Layer.Culture, 1, 3, Ev.CultureBorn);
    sim.setOwner(Layer.Culture, 1, 3, Ev.CultureArrive);
    sim.setOwner(Layer.Polity, 1, 0, Ev.PolityArrive);
    expect(heard).toEqual([[1, 3, -1, Ev.CultureBorn]]);
    expect(Array.from(sim.version)).toEqual([0, 2]);
    expect(sim.result().log.size).toBe(2);
  });
});

describe('民族扩张', () => {
  // 阶段 3 有了同化与迁徙,民族层到后来会被改掉:这两条只比扩散阶段(第一次同化 / 迁徙之前)
  it('关掉诞生年份差异时,扩散阶段事件引擎的结果和一次多源洇染逐州一致(归属和定居年份都一样)', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      for (const endYear of [3000, 60000]) {
        const civ = generateCiv(w, { birthSpan: 0, endYear });
        const m = modelOf(w, civ, 0);
        expect(m.cultures.every((c) => c.born === 0)).toBe(true);
        const until = spreadPhaseEnd(civ);
        expect(until, '扩散阶段至少几百年').toBeGreaterThan(400);
        const ref = referenceFlood(m, until);
        expect(Array.from(ownersAt(civ, until).culture)).toEqual(Array.from(ref.owner));
        const settled = new Float64Array(civ.regions.count).fill(Infinity);
        for (let i = 0; i < civ.log.size && civ.log.year[i] <= until; i++) if (civ.log.layer[i] === Layer.Culture) settled[civ.log.region[i]] = civ.log.year[i];
        expect(Array.from(settled)).toEqual(Array.from(ref.when));
      }
    }
  });

  it('诞生年份错开时,扩散阶段也和洇染一致(诞生只是晚出发的源头)', () => {
    const w = world({ ...small, seed: 7 });
    const civ = generateCiv(w);
    const m = modelOf(w, civ, 400);
    expect(new Set(m.cultures.map((c) => c.born)).size).toBeGreaterThan(1);
    expect(Math.min(...m.cultures.map((c) => c.born))).toBe(0);
    const until = spreadPhaseEnd(civ);
    expect(until).toBeGreaterThan(500);
    expect(Array.from(ownersAt(civ, until).culture)).toEqual(Array.from(referenceFlood(m, until).owner));
  });

  it('确定性:同一个种子跑两次,所有数组逐字节相等,民族表完全一样', () => {
    const w = world({ ...small, seed: 2024 });
    const a = generateCiv(w);
    const b = generateCiv(generateWorld({ ...small, seed: 2024 }));
    const A = arraysOf(a);
    const B = arraysOf(b);
    expect(Object.keys(A)).toEqual(Object.keys(B));
    for (const k of Object.keys(A) as (keyof typeof A)[]) expect(bytes(A[k]).equals(bytes(B[k])), k).toBe(true);
    expect(JSON.stringify(a.cultures)).toBe(JSON.stringify(b.cultures));
    expect(a.regions.name).toEqual(b.regions.name);
    expect(a.spreadYears).toBe(b.spreadYears);
  });

  it('ownersAt(civ, endYear) 等于"现在"的归属;从检查点跳到任意年份,和从头翻日志一致', () => {
    const w = world({ ...small, seed: 7 });
    const civ = generateCiv(w);
    const end = ownersAt(civ, civ.endYear);
    expect(Array.from(end.culture)).toEqual(Array.from(civ.culture));
    expect(Array.from(end.polity)).toEqual(Array.from(civ.polity));
    expect(civ.checkpoints.map((c) => c.year)).toEqual(
      Array.from({ length: Math.floor(civ.endYear / CHECKPOINT_EVERY) }, (_, i) => (i + 1) * CHECKPOINT_EVERY),
    );
    const years = [-1, 0, 0.5, 99.99, 100, 100.004, 777.7, 1000, 1999.9, 2999, 3000, 5000];
    for (let i = 0; i < 40; i++) years.push(civ.log.year[Math.floor((i / 40) * civ.log.size)]);
    const out = { culture: new Int16Array(civ.regions.count), polity: new Int16Array(civ.regions.count) };
    for (const y of years) {
      const fast = ownersAt(civ, y, out);
      expect(fast).toBe(out); // 复用 out
      const slow = ownersFromScratch(civ, y);
      expect(Array.from(fast.culture), `第 ${y} 年`).toEqual(Array.from(slow.culture));
      expect(Array.from(fast.polity)).toEqual(Array.from(slow.polity));
    }
    // 日志按年份排好序
    for (let i = 1; i < civ.log.size; i++) expect(civ.log.year[i]).toBeGreaterThanOrEqual(civ.log.year[i - 1]);
  });

  it('CivSim.fromCiv 接着推:先推到第 1200 年再接着推到 3000 年,和一口气推到 3000 年完全一样', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...small, seed });
      const whole = generateCiv(w, { endYear: 3000 });
      const half = generateCiv(w, { endYear: 1200 });
      const sim = CivSim.fromCiv(w, half);
      sim.run(3000);
      const res = sim.result();
      expect(Array.from(res.culture)).toEqual(Array.from(whole.culture));
      expect(res.log.size).toBe(whole.log.size);
      expect(bytes(res.log.year).equals(bytes(whole.log.year.subarray(0, whole.log.size)))).toBe(true);
      expect(bytes(res.log.region).equals(bytes(whole.log.region.subarray(0, whole.log.size)))).toBe(true);
      expect(bytes(res.log.value).equals(bytes(whole.log.value.subarray(0, whole.log.size)))).toBe(true);
      expect(res.checkpoints.map((c) => c.year)).toEqual(whole.checkpoints.map((c) => c.year));
      res.checkpoints.forEach((c, i) => expect(Array.from(c.culture)).toEqual(Array.from(whole.checkpoints[i].culture)));
      // 阶段 3 有了战争:国家层的日志(原因里有"攻占")、各检查点的国家归属、史事(宣战 / 攻占 / 议和……)也一样
      expect(bytes(res.log.cause).equals(bytes(whole.log.cause.subarray(0, whole.log.size)))).toBe(true);
      expect(Array.from(whole.log.cause.subarray(0, whole.log.size)).includes(Ev.Conquer)).toBe(true);
      res.checkpoints.forEach((c, i) => expect(Array.from(c.polity)).toEqual(Array.from(whole.checkpoints[i].polity)));
      expect(JSON.stringify(res.annals)).toBe(JSON.stringify(whole.annals));
    }
  });

  it('推演前就结束(endYear 早于部分民族诞生)时,fromCiv 会补上还没诞生的民族', () => {
    const w = world({ ...small, seed: 7 });
    const whole = generateCiv(w, { endYear: 1000 });
    const early = generateCiv(w, { endYear: 30 });
    expect(early.cultures.some((c) => c.born > 30)).toBe(true);
    const sim = CivSim.fromCiv(w, early);
    sim.run(1000);
    expect(Array.from(sim.result().culture)).toEqual(Array.from(whole.culture));
  });

  it('默认参数:结束时可居州 85%–95% 有人住;游牧民族多在草原荒漠;海洋民族能跨海', () => {
    let seaAcross = 0;
    for (const seed of [7, 2024]) {
      const w = world({ ...DEFAULT_PARAMS, seed });
      const civ = generateCiv(w);
      expect(civ.viable).toBe(true);
      expect(civ.cultures.length).toBeGreaterThanOrEqual(4);
      expect(civ.cultures.length).toBeLessThanOrEqual(16);
      const T = cultureTerrain(w, civ.habitat, civ.regions);
      let H = 0;
      let occ = 0;
      for (let r = 0; r < T.R; r++) {
        if (!T.habitable[r]) {
          expect(civ.culture[r]).toBe(-1); // 不可居的州不归属任何民族
          continue;
        }
        H++;
        if (civ.culture[r] >= 0) occ++;
      }
      const frac = occ / H;
      expect(frac).toBeGreaterThanOrEqual(0.85);
      expect(frac).toBeLessThanOrEqual(0.95);

      // 游牧民族的地盘里,草原 / 稀树草原 / 荒漠占一半上下或更多(高纬度的苔原、针叶林也有游牧),而且明显比其他民族多
      const grass = new Set<number>([Biome.Steppe, Biome.Savanna, Biome.HotDesert, Biome.TemperateDesert, Biome.ColdDesert]);
      const tally = { nomad: [0, 0], other: [0, 0] };
      for (let r = 0; r < T.R; r++) {
        const c = civ.culture[r];
        if (c < 0) continue;
        const t = civ.cultures[c].kind === 'nomad' ? tally.nomad : tally.other;
        t[1]++;
        if (grass.has(civ.regions.biome[r])) t[0]++;
      }
      expect(tally.nomad[1]).toBeGreaterThan(0);
      expect(tally.nomad[0] / tally.nomad[1]).toBeGreaterThanOrEqual(0.45);
      expect(tally.nomad[0] / tally.nomad[1]).toBeGreaterThan((1.5 * tally.other[0]) / tally.other[1]);

      // 海洋民族的地盘跨过海(占了不止一块陆地)
      for (const cu of civ.cultures) {
        if (cu.kind !== 'sea') continue;
        const lms = new Set<number>();
        for (let r = 0; r < T.R; r++) if (civ.culture[r] === cu.id) lms.add(civ.regions.landmass[r]);
        if (lms.size > 1) seaAcross++;
      }
      // 每个民族都有名字、语感、颜色;有人住的州都有州名
      for (const cu of civ.cultures) {
        expect(cu.name.length).toBeGreaterThan(0);
        expect(cu.style.length).toBeGreaterThan(0);
        expect(cu.color.every((v) => Number.isFinite(v))).toBe(true);
      }
      for (let r = 0; r < T.R; r++) expect(Boolean(civ.regions.name?.[r])).toBe(civ.culture[r] >= 0);
    }
    expect(seaAcross).toBeGreaterThan(0);
  });

  it('陆上地名按所在州的民族语感起名(读 civ.culture);海名不带民族', () => {
    for (const seed of [7, 2024]) {
      const w = world({ ...DEFAULT_PARAMS, seed });
      const civ = generateCiv(w);
      let named = 0;
      for (const p of civ.places) {
        if (p.kind === 'sea') {
          expect(p.culture).toBe(-1);
          continue;
        }
        const r = p.cell !== undefined ? civ.regions.of[p.cell] : -1;
        expect(p.culture, p.name).toBe(r >= 0 ? civ.culture[r] : -1);
        if (p.culture >= 0) named++;
      }
      expect(named).toBeGreaterThan(5);
    }
  });

  it('太冷的星球没有民族,时间轴照样能查', () => {
    const w = world({ ...small, seed: 7, temperature: -12 });
    const civ = generateCiv(w);
    if (!civ.viable) {
      expect(civ.cultures).toEqual([]);
      expect(civ.log.size).toBe(0);
      expect(Array.from(ownersAt(civ, 1500).culture).every((v) => v === -1)).toBe(true);
    }
  });
});
