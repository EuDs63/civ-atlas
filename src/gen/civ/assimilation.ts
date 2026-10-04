/**
 * 民族同化与迁徙:民族分布不再"扩散完就定格" —— 被异族统治久了的州渐渐改换民族,
 * 打仗、亡国时民族会迁徙,一个民族的州全没了就消亡。
 * 挂在同一个推演引擎(sim.ts)上,改民族一律走 setOwner(Layer.Culture, 州, 民族, Ev.Assimilate / Ev.Migrate),
 * 发生了什么记进史事(assimilate / migrate / vanish,字段见 types.ts 的 AnnalKind)。
 *
 * 流程(index.ts 在 installPolitics 之后调用 installAssimilation):
 *
 *   看民族(Ev.CultureCheck)每个国家立国 CHECK_FIRST 年后,每 CHECK_EVERY 年看一眼治下(每段里随机一个时刻),依次:
 *
 *   ① 随征服而来的移民:游牧国家上一次看到这一次之间打下来的异族州,挨着本族地盘的,
 *      各有 SETTLE_P 的机会迁进本族人、改换成本族(林地打折;迁进来的州挨着的也算,一次最多 SETTLE_MAX 州)。
 *   ② 避兵外迁:这些年被本国打下来的异族州(按民族分),那个民族有机会外迁:
 *        赔率 = FLIGHT_ODDS × 丢的州数 × 游牧征服者 FLIGHT_NOMAD × 那一国因此亡了 FLIGHT_FALL
 *      从丢掉的州出发,经本族地盘往外找(不进征服者的国土),迁进最近的几州(最多 FLIGHT_MAX 州、路程 FLIGHT_REACH 以内):
 *      无人之地(最近)、部落地带、同族国家治下的异族州;迁入的州改换成迁徙的民族。迁出的州民族不变(走的只是一部分人)。
 *   ③ 同化:本国治下的异族州,这一段年数里改换成统治民族的机会 = 1 − e^(−速率 × 年数),
 *        速率 = RATE × 统治年数(MIN_RULE 年起,FULL_RULE 年满)× 四周统治民族的边界占比(国都另保底 CAPITAL_KIN)
 *              × 离国都近(e^(−路程 ÷ REACH))× 统治民族在本国的人口占比(÷ STRONG_SHARE,最多算 1)
 *              × 地形(草原荒漠上的游牧民族、高山上的高原民族、林中的山林民族、小岛上的海洋民族难同化;游牧国家难同化农耕地区)
 *              × 原民族越大越难、越小越快(√(SIZE_REF ÷ 州数),夹在 [SIZE_MIN, SIZE_MAX])
 *      统治民族在本国人口占比不到 REVERSE_SHARE、另有一族占到 REVERSE_MAJ 时反过来:统治民族的州被那一族同化
 *      (入主的少数民族渐为多数民族所化),速率另乘 REVERSE_K。默认参数下很少见:战争打下的异族国土很少多过本族。
 *      同一次看里先定好哪些州改换,再一起改:同化一次最多往外推一圈,前线齐整。
 *
 *   看孤地(Ev.EnclaveCheck)每 ENCLAVE_EVERY 年看一次部落地带(没有国家的州):被别族团团围住的孤地
 *      (四周某一族的边界占比 ≥ ENCLAVE_F,隔海峡的对岸按 STRAIT_BORDER 算边界;定居 ENCLAVE_HOLD 年以上)也会被四邻同化,
 *      速率按 ENCLAVE_RATE 算(乘同样的地形、原民族大小系数)—— 零星的残部渐渐融进四邻,小民族可能就此消亡。
 *
 *   不闪烁:一州改换民族(含最初定居)后 HOLD 年内不再改换。
 *   民族消亡:一个民族的州全没了,记 Culture.ended 和一条 vanish;消亡前预约的到达作废(见 cultures.ts)。
 *   州名、城名、城镇的民族(Settlement.culture = 建城时的民族)都不改:地名留着旧民族的语感。
 *
 * **不存内存状态**:看民族的时刻由"国家 + 第几次"算出;统治年数 = 州最近一次换国家(战争模型,由变化日志重建);
 *   这些年打下来的州 = 战争模型里带年份的攻占(由史事重建);一州上次改换民族 = 变化日志;消亡、迁徙记在民族表里。
 *
 * 随机数:keyed(subSeed(seed, 'civ-assim'), 国家 / 州…, 第几次, 用途),和处理顺序无关。
 * 国家、民族、州一律用位置锚(PolityModel.ptag、发源州 / 州的治所地块;见 rand.ts),不用编号。纯计算,不碰 DOM。
 */
import { Biome } from '../biomes';
import type { World } from '../world';
import { MinHeap } from '../util';
import { geometryOf, type Geometry } from '../geometry';
import { AdjKind, Layer, type Civ, type Culture, type MigrationDir, type Polity, type Year } from './types';
import { fexp, keyed, keyed4, subSeed } from './rand';
import { Ev, quantize, type CivSim } from './sim';
import { cultureModelOf } from './cultures';
import { polityModelOf, type PolityModel } from './polities';
import { warModelOf, type WarModel } from './wars';
import { capitalAt } from './growth';

// ---- 调参(以截图和统计数为准,见 scripts/gen-stats.ts) ----
/** 立国后多少年开始看民族;之后每隔多少年看一次(每段里 20%–80% 处随机一个时刻) */
const CHECK_FIRST = 50;
const CHECK_EVERY = 50;
/** 一州改换民族(含最初定居)后,这么多年内不再改换(不闪烁) */
export const HOLD = 150;

/** 同化:统治满 MIN_RULE 年才开始,FULL_RULE 年满速 */
const MIN_RULE = 100;
const FULL_RULE = 300;
/** 同化速率的底数(每年);离国都的路程(标准路程)每 REACH 衰减到 1/e */
const RATE = 1 / 10;
const REACH = 5;
/** 国都所在的异族州:四周统治民族的边界占比至少按这么多算(国都一带先同化) */
const CAPITAL_KIN = 0.5;
/** 统治民族在本国的人口占比到这么多,同化就是满速 */
const STRONG_SHARE = 0.6;
/** 原民族越大越难同化、越小越快被同化(残部很快融进四邻):× √(SIZE_REF ÷ 州数),夹在 [SIZE_MIN, SIZE_MAX] */
const SIZE_REF = 25;
const SIZE_MIN = 0.4;
const SIZE_MAX = 2;
/** 反向同化:统治民族占本国人口不到 REVERSE_SHARE、另有一族到 REVERSE_MAJ;速率乘 REVERSE_K */
const REVERSE_SHARE = 0.35;
const REVERSE_MAJ = 0.5;
const REVERSE_K = 0.8;
/** 地形:草原荒漠上的游牧民族、高山(海拔 > HIGH_ELEV)上的高原民族、林中的山林民族、小岛上的海洋民族难同化 */
const RESIST_STEPPE = 0.2;
const RESIST_HIGH = 0.35;
const HIGH_ELEV = 900;
const RESIST_FOREST = 0.4;
const RESIST_ISLAND = 0.5;
/** 游牧国家同化草原荒漠以外的地方(牧人很少把农夫变成牧人,多是迁人进来,见 ①) */
const NOMAD_FARMLAND = 0.35;

/** 看孤地:每隔多少年看一次;四周某一族的边界占比至少多少;定居多少年以上;速率的底数(每年) */
const ENCLAVE_EVERY = 50;
const ENCLAVE_F = 0.5;
const ENCLAVE_HOLD = 300;
const ENCLAVE_RATE = 1 / 80;
/** 看孤地时,隔海峡的邻州算多长的边界(标准路程) */
const STRAIT_BORDER = 0.3;

/** 随征服而来的移民(游牧国家):每州的机会、林地打折、一次最多几州 */
const SETTLE_P = 0.45;
const SETTLE_FOREST = 0.3;
const SETTLE_MAX = 6;

/** 避兵外迁:赔率底数(× 丢的州数)、游牧征服者、亡国 */
const FLIGHT_ODDS = 0.06;
const FLIGHT_NOMAD = 2;
const FLIGHT_FALL = 3;
/** 外迁的州数 = 丢的州数 × FLIGHT_RATIO(至少 1、最多 FLIGHT_MAX);路程(标准路程)不超过 FLIGHT_REACH */
const FLIGHT_RATIO = 0.8;
const FLIGHT_MAX = 6;
const FLIGHT_REACH = 8;
/** 找迁入地时的路程系数:无人之地、部落地带、同族国家治下的异族州 */
const TO_EMPTY = 0.7;
const TO_TRIBAL = 1;
const TO_KIN_STATE = 1.3;
/** 过界系数(按 AdjKind:平地、跨河、翻山、海峡、航线) */
const CROSS = [1, 1.2, 2, 2, 3];

// 随机数用途编号
const U_CHECK_T = 1;
const U_ASSIM = 2;
const U_SETTLE = 3;
const U_FLIGHT = 4;
const U_ENCLAVE_T = 5;
const U_ENCLAVE = 6;

const biomeSet = (list: number[]) => {
  const t = new Uint8Array(16);
  for (const b of list) t[b] = 1;
  return t;
};
const STEPPE_DESERT = biomeSet([Biome.Steppe, Biome.ColdDesert, Biome.TemperateDesert, Biome.HotDesert]);
const FOREST = biomeSet([Biome.TemperateForest, Biome.TemperateRainforest, Biome.Rainforest, Biome.TropicalDryForest, Biome.Taiga, Biome.Wetland]);

// ---------------------------------------------------------------------------
// 模型

export interface AssimModel {
  pm: PolityModel;
  wm: WarModel;
  /** 民族表(和 cultures.ts 的模型同一份:消亡年份、迁徙记录写在这里) */
  cultures: Culture[];
  base: number;
  /** 世界的几何(按州治所定迁徙的方位) */
  geo: Geometry;
  /** 州 → 最近一次改换民族(含最初定居)的年份;没人住过 = −Infinity */
  since: Float64Array;
  /** 民族 → 现在有几州 */
  count: Int32Array;
}

function newModel(pm: PolityModel, wm: WarModel, cultures: Culture[], world: World): AssimModel {
  const reg = pm.terrain.regions;
  const R = reg.count;
  return {
    pm,
    wm,
    cultures,
    base: subSeed(pm.seed, 'civ-assim'),
    geo: geometryOf(world.mesh),
    since: new Float64Array(R).fill(-Infinity),
    count: new Int32Array(cultures.length),
  };
}

/** 国家 p 第 k 次看民族的时刻 */
function checkTime(am: AssimModel, p: number, k: number): number {
  return am.pm.polities[p].founded + CHECK_FIRST + CHECK_EVERY * (k + 0.2 + 0.6 * keyed(am.base, am.pm.ptag[p], k, U_CHECK_T));
}

/** 第 k 次看孤地的时刻 */
function enclaveTime(am: AssimModel, k: number): number {
  return ENCLAVE_EVERY * (k + 0.2 + 0.6 * keyed(am.base, k, 0, U_ENCLAVE_T));
}

const models = new WeakMap<CivSim, AssimModel>();

/** 推演引擎上挂着的同化与迁徙模型(测试、统计用;fromCiv 接着推之后的民族表也在这里) */
export function assimModelOf(sim: CivSim): AssimModel | undefined {
  return models.get(sim);
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

/** 登记同化与迁徙的事件处理和监听(installPolitics 之后调用) */
export function installAssimilation(sim: CivSim, pm: PolityModel, world: World): AssimModel {
  const wm = warModelOf(sim);
  const cm = cultureModelOf(sim);
  if (!wm || !cm) throw new Error('installAssimilation:先 installCultures、installWars');
  const am = newModel(pm, wm, cm.cultures, world);
  hook(sim, am);
  sim.schedule(enclaveTime(am, 0), Ev.EnclaveCheck, 0, 0);
  return am;
}

function hook(sim: CivSim, am: AssimModel): void {
  models.set(sim, am);
  const { pm, wm, cultures, since, count } = am;
  const T = pm.terrain;
  const reg = T.regions;
  const R = T.R;
  const culture = sim.owners[Layer.Culture];
  const owner = sim.owners[Layer.Polity];

  // 民族层:记下每州最近一次改换民族的年份、各民族的州数
  sim.onChange(Layer.Culture, (r, v, prev) => {
    since[r] = sim.now;
    if (prev >= 0) count[prev]--;
    if (v >= 0) count[v]++;
  });
  // 新国家(立国、分裂、复国)拿到第一州时预约第一次看民族
  sim.onChange(Layer.Polity, (_r, v, _prev, cause) => {
    if (v >= 0 && (cause === Ev.PolityFound || cause === Ev.Split) && pm.size[v] === 1) sim.schedule(checkTime(am, v, 0), Ev.CultureCheck, 0, v);
  });

  // ---- 小工具 ----
  const held = (r: number, t: number) => t - since[r] >= HOLD;
  const city = (r: number) => pm.cityOf[r];

  /** 改民族 + 记史事;原民族的州因此一州不剩就消亡 */
  const change = (kind: 'assimilate' | 'migrate', r: number, c: number, cause: number, pid: number, t: number) => {
    const old = culture[r];
    sim.setOwner(Layer.Culture, r, c, cause);
    sim.record(kind, { a: c, b: old, region: r, settlement: city(r), war: pid });
    if (old >= 0 && count[old] === 0 && cultures[old].ended === undefined) {
      cultures[old].ended = t;
      sim.record('vanish', { a: old, b: c, region: r });
    }
  };

  /** 从 from 这几州到 to 这几州(治所位置的平均)的方位 */
  const direction = (from: readonly number[], to: readonly number[]): MigrationDir => {
    const seatOf = (r: number) => reg.seat[r];
    const a = [0, 0];
    const b = [0, 0];
    am.geo.meanPoint(from, seatOf, a);
    am.geo.meanPoint(to, seatOf, b);
    const d = [0, 0];
    am.geo.pointOffset(a[0], a[1], b[0], b[1], d);
    const dx = d[0];
    const dy = d[1]; // 当地(东, 南)分量:dy 正 = 向南
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? '东' : '西';
    return dy > 0 ? '南' : '北';
  };

  const addMigration = (c: number, t: number, dir: MigrationDir) => {
    const cu = cultures[c];
    (cu.migrations ??= []).push({ year: t, dir });
  };

  /** 州 r 陆上(不含航线)挨着民族 c 的州 */
  const touches = (r: number, c: number): boolean => {
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      if (reg.adjKind[k] !== AdjKind.SeaRoute && culture[reg.adj[k]] === c) return true;
    }
    return false;
  };

  /** 这一段时间里(from, t] 本国 p 打下来、现在还在手里的州:州 → 原主 */
  const conquered = (p: number, from: number, t: number): Map<number, number> => {
    const out = new Map<number, number>();
    for (const w of wm.wars) {
      if (!w || (w.a !== p && w.b !== p) || w.start > t || (w.end !== undefined && w.end <= from)) continue;
      const other = w.a === p ? w.b : w.a;
      for (const e of w.takes) {
        if (e.by === p && e.year > from && e.year <= t && owner[e.region] === p) out.set(e.region, other);
      }
    }
    return out;
  };

  // ---- ① 随征服而来的移民(游牧国家) ----
  const settle = (P: Polity, k: number, t: number, taken: readonly number[]) => {
    const g = P.culture;
    const cand = taken.filter((r) => culture[r] >= 0 && culture[r] !== g && held(r, t) && keyed4(am.base, pm.ptag[P.id], reg.seat[r], k, U_SETTLE) < SETTLE_P * (FOREST[reg.biome[r]] ? SETTLE_FOREST : 1));
    const done: number[] = [];
    const from = new Set<number>();
    // 挨着本族地盘的先迁;迁进来的州挨着的也算(一圈圈往外),一次最多 SETTLE_MAX 州
    for (let grew = true; grew && done.length < SETTLE_MAX; ) {
      grew = false;
      for (const r of cand) {
        if (done.length >= SETTLE_MAX) break;
        if (culture[r] === g || !touches(r, g)) continue;
        for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
          const j = reg.adj[e];
          if (culture[j] === g && !done.includes(j)) from.add(j);
        }
        change('migrate', r, g, Ev.Migrate, P.id, t);
        done.push(r);
        grew = true;
      }
    }
    if (done.length) addMigration(g, t, direction([...from].sort((a, b) => a - b), done));
  };

  // ---- ② 避兵外迁 ----
  const heap = new MinHeap(64);
  const dist = new Float64Array(R).fill(Infinity);
  const touched: number[] = [];
  const flee = (P: Polity, V: number, sources: readonly number[], t: number, n: number) => {
    const Vsea = cultures[V].kind === 'sea';
    const isTarget = (j: number) => {
      const c = culture[j];
      if (c === V || !T.habitable[j] || !held(j, t)) return false;
      const o = owner[j];
      if (o === P.id) return false;
      return o < 0 || pm.polities[o].culture === V;
    };
    // 从丢掉的州出发,经本族地盘和可迁入的州往外找(Dijkstra;路程 × 过界 × 迁入地的难易)
    heap.size = 0;
    for (const r of sources) {
      dist[r] = 0;
      touched.push(r);
      heap.push(r, 0);
    }
    const picked: number[] = [];
    while (heap.size && picked.length < n) {
      const r = heap.pop();
      const d = heap.lastPri;
      if (d > dist[r]) continue;
      if (culture[r] !== V) picked.push(r); // 起点都是本族的州;弹出来的异族州就是迁入地
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const kind = reg.adjKind[k];
        if (kind === AdjKind.SeaRoute || (kind === AdjKind.Strait && !Vsea)) continue;
        const j = reg.adj[k];
        let f: number;
        if (culture[j] === V) f = 1;
        else if (isTarget(j)) f = culture[j] < 0 ? TO_EMPTY : owner[j] < 0 ? TO_TRIBAL : TO_KIN_STATE;
        else continue;
        const nd = d + (reg.adjLen[k] / T.refLen) * CROSS[kind] * f;
        if (nd > FLIGHT_REACH || nd >= dist[j]) continue;
        if (dist[j] === Infinity) touched.push(j);
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
    for (const r of touched) dist[r] = Infinity;
    touched.length = 0;
    if (!picked.length) return;
    for (const r of picked) change('migrate', r, V, Ev.Migrate, P.id, t);
    addMigration(V, t, direction(sources, picked));
  };

  /** 民族 c 的州 r 改换成民族 g 的难易(地形:本民族住惯了的地方难同化)× 原民族大小 */
  const ease = (c: number, g: number, r: number): number => {
    const O = cultures[c];
    const bi = reg.biome[r];
    let f = 1;
    if (O.kind === 'nomad' && STEPPE_DESERT[bi] && cultures[g].kind !== 'nomad') f *= RESIST_STEPPE;
    else if (O.kind === 'highland' && reg.elevation[r] > HIGH_ELEV) f *= RESIST_HIGH;
    else if (O.kind === 'forest' && FOREST[bi]) f *= RESIST_FOREST;
    else if (O.kind === 'sea' && T.island[r]) f *= RESIST_ISLAND;
    return f * Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.sqrt(SIZE_REF / Math.max(1, count[c]))));
  };

  // ---- ③ 同化 ----
  const weight = new Float64Array(cultures.length);
  const assimilate = (P: Polity, k: number, t: number, span: number) => {
    const mine = pm.lands[P.id];
    if (!mine.length) return;
    // 本国各民族的人口(按州的人口上限)
    weight.fill(0);
    let W = 0;
    for (const r of mine) {
      const c = culture[r];
      if (c < 0) continue;
      const w = Math.max(1e-3, reg.capacity[r]);
      weight[c] += w;
      W += w;
    }
    if (!(W > 0)) return;
    const own = weight[P.culture] / W;
    let M = -1;
    for (let c = 0; c < weight.length; c++) if (c !== P.culture && (M < 0 || weight[c] > weight[M])) M = c;
    const reverse = own < REVERSE_SHARE && M >= 0 && weight[M] / W >= REVERSE_MAJ;
    const strength = reverse ? REVERSE_K : Math.min(1, own / STRONG_SHARE);
    if (!(strength > 0)) return;
    const d = pm.capDist[P.id];
    const capR = pm.settlements[capitalAt(P, t)].region;
    const nomadRuler = P.kind === 'nomad';
    const out: [number, number][] = [];
    for (const r of mine) {
      const c = culture[r];
      if (c < 0 || (reverse ? c !== P.culture : c === P.culture) || !held(r, t)) continue;
      const g = reverse ? M : P.culture;
      const rule = t - wm.since[r];
      if (rule < MIN_RULE) continue;
      // 四周民族 g 的边界占比(陆上;只算有人住的邻州)
      let kin = 0;
      let tot = 0;
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const cj = culture[reg.adj[e]];
        if (cj < 0) continue;
        tot += reg.adjBorder[e];
        if (cj === g) kin += reg.adjBorder[e];
      }
      let f = tot > 0 ? kin / tot : 0;
      if (!reverse && r === capR) f = Math.max(f, CAPITAL_KIN);
      if (!(f > 0)) continue;
      const near = d[r] < Infinity ? fexp(-d[r] / REACH) : 0;
      let e = ease(c, g, r);
      const bi = reg.biome[r];
      if (!reverse && nomadRuler && !STEPPE_DESERT[bi] && bi !== Biome.Savanna) e *= NOMAD_FARMLAND;
      const ramp = Math.min(1, (rule - MIN_RULE) / (FULL_RULE - MIN_RULE));
      const rate = RATE * ramp * f * near * strength * e;
      const p = 1 - fexp(-rate * span);
      if (keyed4(am.base, pm.ptag[P.id], reg.seat[r], k, U_ASSIM) < p) out.push([r, g]);
    }
    for (const [r, g] of out) change('assimilate', r, g, Ev.Assimilate, P.id, t);
  };

  sim.on(Ev.CultureCheck, (k, p, t) => {
    const P = pm.polities[p];
    if (!P || P.ended !== undefined) return;
    sim.schedule(checkTime(am, p, k + 1), Ev.CultureCheck, k + 1, p);
    const from = k > 0 ? quantize(checkTime(am, p, k - 1)) : P.founded;
    // 这些年打下来的州(按原来的民族分;先分好,游牧移民迁进来以后原来的民族照样算作被征服的)
    const taken = conquered(p, from, t);
    const victims = new Map<number, number[]>();
    const fell = new Set<number>();
    for (const [r, y] of [...taken].sort((u, v) => u[0] - v[0])) {
      const c = culture[r];
      if (c < 0 || c === P.culture) continue;
      let list = victims.get(c);
      if (!list) victims.set(c, (list = []));
      list.push(r);
      const Y = pm.polities[y];
      if (Y && Y.culture === c && Y.ended !== undefined && Y.ended > from && Y.ended <= t) fell.add(c);
    }
    if (P.kind === 'nomad' && taken.size) settle(P, k, t, [...taken.keys()].sort((a, b) => a - b));
    for (const [V, rs] of [...victims].sort((u, v) => u[0] - v[0])) {
      if (count[V] <= 0) continue;
      const odds = FLIGHT_ODDS * rs.length * (P.kind === 'nomad' ? FLIGHT_NOMAD : 1) * (fell.has(V) ? FLIGHT_FALL : 1);
      if (keyed4(am.base, pm.ptag[p], reg.seat[am.cultures[V].hearth], k, U_FLIGHT) >= odds / (1 + odds)) continue;
      // 迁徙的人从丢掉、现在还是本族的州出发
      const src = rs.filter((r) => culture[r] === V);
      if (!src.length) continue;
      flee(P, V, src, t, Math.min(FLIGHT_MAX, Math.max(1, Math.round(rs.length * FLIGHT_RATIO))));
    }
    assimilate(P, k, t, t - from);
  });

  // ---- 看孤地:部落地带里被别族团团围住的州 ----
  const around = new Float64Array(cultures.length);
  sim.on(Ev.EnclaveCheck, (k, _b, t) => {
    sim.schedule(enclaveTime(am, k + 1), Ev.EnclaveCheck, k + 1, 0);
    const span = t - (k > 0 ? quantize(enclaveTime(am, k - 1)) : 0);
    const out: [number, number][] = [];
    const seen: number[] = [];
    for (let r = 0; r < R; r++) {
      const c = culture[r];
      if (c < 0 || owner[r] >= 0 || t - since[r] < ENCLAVE_HOLD) continue;
      // 四周没有别族的州(绝大多数)先排除,省时间
      let other = false;
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1] && !other; e++) {
        const cj = culture[reg.adj[e]];
        other = cj >= 0 && cj !== c;
      }
      if (!other) continue;
      // 四周各民族的边界(陆上;只算有人住的邻州),挑最多的那一族
      let tot = 0;
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const cj = culture[reg.adj[e]];
        // 隔海峡的邻州(共享边界为 0)按 STRAIT_BORDER 个标准路程算:小岛上的残部也会被对岸同化
        const b = reg.adjKind[e] === AdjKind.Strait ? STRAIT_BORDER * T.refLen : reg.adjBorder[e];
        if (cj < 0 || !(b > 0)) continue;
        if (around[cj] === 0) seen.push(cj);
        around[cj] += b;
        tot += b;
      }
      let g = -1;
      for (const cj of seen) if (cj !== c && (g < 0 || around[cj] > around[g] || (around[cj] === around[g] && cj < g))) g = cj;
      const f = g >= 0 && tot > 0 ? around[g] / tot : 0;
      for (const cj of seen) around[cj] = 0;
      seen.length = 0;
      if (f < ENCLAVE_F) continue;
      const rate = ENCLAVE_RATE * f * ease(c, g, r);
      if (keyed(am.base, reg.seat[r], k, U_ENCLAVE) < 1 - fexp(-rate * span)) out.push([r, g]);
    }
    for (const [r, g] of out) change('assimilate', r, g, Ev.Assimilate, -1, t);
  });
}

/**
 * 由 Civ 重建同化与迁徙的推演状态(CivSim.fromCiv 调用,在 resumePolitics 之后):
 * 各州上次改换民族的年份从变化日志里读,各民族的州数现数;民族表用 cultures.ts 复制的那一份(消亡、迁徙照原样);
 * 再按"国家 + 第几次"算出还没到的看民族,补进引擎。
 */
export function resumeAssimilation(sim: CivSim, world: World, civ: Civ): void {
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  const cm = cultureModelOf(sim);
  if (!pm || !wm || !cm) return;
  const am = newModel(pm, wm, cm.cultures, world);
  const log = civ.log;
  for (let i = 0; i < log.size; i++) if (log.layer[i] === Layer.Culture) am.since[log.region[i]] = log.year[i];
  const culture = sim.owners[Layer.Culture];
  for (let r = 0; r < culture.length; r++) if (culture[r] >= 0) am.count[culture[r]]++;
  hook(sim, am);

  const now = sim.now;
  for (const p of pm.polities) {
    if (p.ended !== undefined) continue;
    let k = 0;
    while (quantize(checkTime(am, p.id, k)) <= now) k++;
    sim.schedule(checkTime(am, p.id, k), Ev.CultureCheck, k, p.id);
  }
  let k = 0;
  while (quantize(enclaveTime(am, k)) <= now) k++;
  sim.schedule(enclaveTime(am, k), Ev.EnclaveCheck, k, 0);
}

// ---------------------------------------------------------------------------
// 统计(scripts/gen-stats.ts、stress.ts、单测用)

export interface AssimStats {
  /** 最初定居之后又改换过民族的州;占结束时有人住的州的比例 */
  changed: number;
  changedShare: number;
  /** 同化改换的州次;其中统治民族被多数民族同化的 */
  assimilated: number;
  reverse: number;
  /** 迁徙的波数、迁入的州次;其中随征服而来(游牧移民)的波数 */
  migrations: number;
  migrated: number;
  settlerWaves: number;
  /** 消亡的民族;结束时还在的民族 */
  vanished: number;
  alive: number;
  /** 结束时在世各国"统治民族占本国州数"的平均 */
  rulingShare: number;
  /** 50 年内民族变了 2 次以上的州(最初定居不算一次) */
  flippy: number;
}

export function assimStats(civ: Civ): AssimStats {
  const R = civ.regions.count;
  const L = civ.log;
  const times: number[][] = Array.from({ length: R }, () => []);
  for (let i = 0; i < L.size; i++) if (L.layer[i] === Layer.Culture) times[L.region[i]].push(L.year[i]);
  let changed = 0;
  let flippy = 0;
  let occ = 0;
  for (let r = 0; r < R; r++) {
    if (civ.culture[r] >= 0) occ++;
    const ts = times[r];
    if (ts.length > 1) changed++;
    for (let i = 2; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] < 50) {
        flippy++;
        break;
      }
    }
  }
  let assimilated = 0;
  let reverse = 0;
  let migrated = 0;
  let migrations = 0;
  let settlerWaves = 0;
  civ.annals.forEach((e, i) => {
    if (e.kind === 'assimilate') {
      assimilated++;
      if (civ.polities[e.war]?.culture === e.b) reverse++;
    } else if (e.kind === 'migrate') {
      migrated++;
      const prev = civ.annals[i - 1];
      const same = prev && prev.kind === 'migrate' && prev.year === e.year && prev.a === e.a && prev.war === e.war;
      if (!same) {
        migrations++;
        if (civ.polities[e.war]?.culture === e.a) settlerWaves++;
      }
    }
  });
  const alive = new Set<number>();
  for (let r = 0; r < R; r++) if (civ.culture[r] >= 0) alive.add(civ.culture[r]);
  let sum = 0;
  let n = 0;
  const size = new Map<number, number>();
  const own = new Map<number, number>();
  for (let r = 0; r < R; r++) {
    const p = civ.polity[r];
    if (p < 0) continue;
    size.set(p, (size.get(p) ?? 0) + 1);
    if (civ.culture[r] === civ.polities[p].culture) own.set(p, (own.get(p) ?? 0) + 1);
  }
  for (const [p, s] of size) {
    sum += (own.get(p) ?? 0) / s;
    n++;
  }
  return {
    changed,
    changedShare: occ ? changed / occ : 0,
    assimilated,
    reverse,
    migrations,
    migrated,
    settlerWaves,
    vanished: civ.cultures.filter((c) => c.ended !== undefined).length,
    alive: alive.size,
    rulingShare: n ? sum / n : 0,
    flippy,
  };
}
