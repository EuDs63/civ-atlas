/**
 * 城市与国家:建城、S 形成长、港口、立国、国家扩张、国号分档。
 * 全部挂在民族用的同一个推演引擎(sim.ts)上,改归属一律走 setOwner,写进同一本变化日志。
 *
 * 流程(index.ts 调用):
 *   planPolities    民族定好之后:港口、国都间距、城市规模的基准
 *   installPolities 挂到 CivSim 上(在 sim.run 之前):
 *     州有人定居(民族层归属变了)→ 过 5–40 年"建城":治所成为聚落
 *     建城 → 人口上限够大的,算出人口越过立国门槛的那一年(S 形曲线可以直接反解),预约"立国"
 *     立国 → 这一州还没归别国、离别的国都足够远(州图跳数),就成为国都,国家从这里出发
 *     国家拿下一州(国家层归属变了)→ 预约邻州的"国家到达";国土跨过一档就预约"升格"
 *     邻州后来才有人住 → 也给它预约"国家到达"(阶段 3 部落地带的州被同化 / 迁入改换了民族,也重新预约)
 *   (sim.run)
 *   finishPolities  推演之后:配色、起城名 / 国名(含历朝的王朝名,阶段 3 王朝更替)
 *
 * 国家走一步要几年 = STEP_YEARS × 路程 × 地形 × 过界 × 民族(同族 1、异族 ×2.5)× 类型修正 × 离国都远近 × 抖动 ÷ 扩张性
 *   - 只进有人住、还没有国家的州:无人区不去;阶段 2 先到先得,两国相接就停在那里
 *   - 只有海洋国家能跨海(海峡、航线),别的国家不会有跨海领土
 *   - 离国都越远越慢(× e^(离国都的路程 / REACH)):国家不会无限铺开,边远处留下有人住、没有国家的"部落地带"
 *   - 阶段 3 有了战争(wars.ts):国家会丢州、迁都、灭亡。"国家到达"触发时要求这个国家和国都连成一片的国土
 *     还挨着那一州(丢了出发的那一州、或者只剩被切出去的飞地挨着,就不去了:不长出飞地);灭亡的国家撤掉国都间距标记;
 *     迁都后"离国都的路程"按新国都算(迁都那一刻之后预约的才按新的)
 *   - 阶段 4 干预"不许扩张"(interventions.ts,挂在 PolityModel.iv 上):"国家到达"触发时这国在禁令里就不去;
 *     禁令到期那一刻从现有国土重新预约(respread;fromCiv 接着推时 resumePolities 按日志把那一刻的预约也补上)
 *
 * 由 Civ 能重建"接下来该发生什么"(resumePolities,CivSim.fromCiv 调用),不用存事件堆。
 * 随机数:subSeed(seed, 'civ-polity…') + keyed(按实体取),和处理顺序无关。纯计算,不碰 DOM。
 * keyed 的"实体"一律是位置锚(见 rand.ts):州 = 治所地块,城 / 国家 = PolityModel.stag / ptag(地块 + 这州第几个),
 * 改地形后多一个、少一个州或国家,别处的随机数不跟着错位。
 */
import { Biome } from '../biomes';
import type { World } from '../world';
import { MinHeap } from '../util';
import { geometryOf } from '../geometry';
import { AdjKind, Layer, type Civ, type Culture, type NamePins, type Polity, type PolityLineage, type Regions, type Settlement, type Year } from './types';
import { BIOME_COST } from './habitat';
import { anchorTag, fexp, fpow, keyed, subSeed } from './rand';
import { quantize, Ev, type CivSim } from './sim';
import { KIND_INFO } from './display';
import { cultureNeighbors, cultureTerrain, type CultureModel, type CultureTerrain } from './cultures';
import { SETTLEMENT_RANKS, capitalAt, populationAt, tierOf, yearReaching } from './growth';
import { namePolities, nameSettlements, type RestoreDirection } from './naming';
import type { RouteCity } from './routes';
import type { InterventionModel } from './interventions';

// ---- 调参(以截图效果为准) ----
/** 州有人定居后,过这么多年建城(随机) */
const FOUND_DELAY: [number, number] = [5, 40];
/**
 * 城的人口上限(千人)= CAP_REF × (州的人口上限 / 基准)^CAP_EXP × 港口 / 大河加成 × 随机 0.8–1.25。
 * 基准 = 这个世界可居州人口上限的第 90 百分位 ÷ CAP_P90(默认世界约 100):换精细度、气候时城市的大小分布不变。
 * 指数 > 1:沃野里的城比贫瘠处的城大得多,少数大城、大量村镇(城市规模的"长尾")
 */
const CAP_REF = 11;
const CAP_P90 = 2.07;
const CAP_EXP = 1.6;
const PORT_CAP = 1.3;
const RIVER_CAP = 1.15;
/** 成长速度(每年):GROWTH × 随机 0.75–1.25 */
const GROWTH = 0.0022;
/** 立国门槛:人口越过这么多(千人),而且建城满 MIN_AGE 年 */
export const FOUND_POP = 20;
const MIN_AGE = 400;
/** 自动国家数:每多少个可居州一个(只用来定国都间距;实际数量由推演决定) */
const REGIONS_PER_POLITY = 60;
/** 国都间距(州图跳数)= SPACING × √(可居州数 / 目标国家数) */
const SPACING = 0.85;
/** 过界系数(按 AdjKind 下标:平地、跨河、翻山、海峡、航线);海峡、航线只有海洋国家能走 */
const CROSS = [1, 1.3, 2, 2, 3];
/** 进异族的州 */
const OTHER_CULTURE = 2.5;
/** 国家走一个标准路程要几年(国都旁边;离国都越远越慢) */
const STEP_YEARS = 60;
/** 离国都越远越慢:× e^(路程 / REACH),路程以"标准路程"计 */
const REACH = 12;
/** 群落系数 = (通行代价 / 70) ^ BIOME_EXP */
const BIOME_EXP = 0.6;
/** 修路:到结束年份至少长到这一级(1 = 镇)的城镇才连路(国都、港口总是连) */
const ROUTE_MIN_RANK = 1;
/** 海洋国家走城邦共和一系的概率(其余走农耕一系) */
const REPUBLIC_P = 0.75;

const BIOME_F = BIOME_COST.map((c) => fpow(Math.max(1, c) / 70, BIOME_EXP));
const biomeSet = (list: number[]) => {
  const t = new Uint8Array(16);
  for (const b of list) t[b] = 1;
  return t;
};
const STEPPE_DESERT = biomeSet([Biome.Steppe, Biome.ColdDesert, Biome.TemperateDesert, Biome.HotDesert, Biome.Savanna]);
const FOREST = biomeSet([Biome.TemperateForest, Biome.TemperateRainforest, Biome.Rainforest, Biome.TropicalDryForest, Biome.Taiga]);

// ---------------------------------------------------------------------------
// 模型:推演要用的全部东西(可以由 Civ 重建,见 resumePolities)

export interface PolityModel {
  terrain: CultureTerrain;
  cultures: Culture[];
  /** keyed 随机数的根 */
  base: number;
  /** 推演中逐步长出来的城镇、国家(编号 = 下标) */
  settlements: Settlement[];
  polities: Polity[];
  /** 州 → 城镇编号(−1 = 还没建城) */
  cityOf: Int32Array;
  /** 州 → 治所能当港口 */
  port: Uint8Array;
  /** 国家 → 当前州数、当前国号档位 */
  size: number[];
  tier: number[];
  /** 国家 → 现在的国土(州号升序;和 size 一起在归属监听里维护)。战争、分合要扫某国国土时用它,不用扫全部州 */
  lands: number[][];
  /** 州 → 离它不到 spacing 跳的国都个数(> 0 的州不能再立国;国家灭亡时撤掉它立国时加的标记) */
  near: Int32Array;
  /** 国家 → 各州离(现在的)国都的路程(标准路程;走不到 = Infinity) */
  capDist: Float32Array[];
  /** 国家 → 上一个国都的路程表、最近一次迁都的年份(迁都那一刻预约的扩张还按旧国都算,见 distFor) */
  capDistPrev: (Float32Array | null)[];
  capMoved: number[];
  /** 国家 → 历史上接壤过的国家(配色用:灭亡、易手之后照样错开颜色) */
  met: Set<number>[];
  /**
   * 国家 → 位置锚:anchorTag(立国时国都的地块, 这州第几个立的国)(和稳定键 `polity:c4567#0` 同一个意思)。
   * 推演里按国家取的随机数(keyed)一律按它取,不按编号(见 rand.ts)
   */
  ptag: number[];
  /** 城 → 位置锚:anchorTag(所在地块, 这州第几座城)(稳定键 `settlement:c4567#1`) */
  stag: number[];
  /** 地块 → 那里已经立过几国 / 建过几座城(算位置锚的"第几个") */
  pAt: Map<number, number>;
  sAt: Map<number, number>;
  /** 种子(战争等后续模块取自己的随机数根) */
  seed: number;
  /** 国都间距(州图跳数) */
  spacing: number;
  /** 城的人口上限的基准(州的人口上限,见 CAP_P90) */
  capNorm: number;
  /** 国家走一个标准路程要几年(STEP_YEARS ÷ 扩张快慢总系数) */
  years: number;
  /** 离国都越远越慢:× e^(路程 / reach) */
  reach: number;
  /** 阶段 4 干预(interventions.ts 挂上;没有干预 = 不给):"不许扩张"在"国家到达"时查 */
  iv?: InterventionModel;
}

/** 升序数组里的位置(第一个 ≥ r 的下标) */
function lowerBound(a: number[], r: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function landAdd(a: number[], r: number) {
  const i = lowerBound(a, r);
  if (a[i] !== r) a.splice(i, 0, r);
}
function landRemove(a: number[], r: number) {
  const i = lowerBound(a, r);
  if (a[i] === r) a.splice(i, 1);
}

/** 地块 cell 上下一个实体的位置锚(count 里记着这个地块上已经有几个) */
function nextTag(count: Map<number, number>, cell: number): number {
  const n = count.get(cell) ?? 0;
  count.set(cell, n + 1);
  return anchorTag(cell, n);
}

/** 国家的位置锚(keyed 随机数用,见 PolityModel.ptag) */
export function polityTag(m: PolityModel, pid: number): number {
  return m.ptag[pid];
}

/** 城的位置锚(keyed 随机数用,见 PolityModel.stag) */
export function cityTag(m: PolityModel, sid: number): number {
  return m.stag[sid];
}

/** 民族的位置锚:发源州的治所地块(keyed 随机数用) */
export function cultureTag(m: PolityModel, c: number): number {
  return m.terrain.regions.seat[m.cultures[c].hearth];
}

/** 州 r 的城:人口上限(千人) */
function cityCapacity(m: PolityModel, r: number): number {
  const T = m.terrain;
  let cap = CAP_REF * fpow(T.regions.capacity[r] / m.capNorm, CAP_EXP);
  if (m.port[r]) cap *= PORT_CAP;
  if (T.riverSeat[r]) cap *= RIVER_CAP;
  return cap * (0.8 + 0.45 * keyed(m.base, T.regions.seat[r], 2));
}

function cityGrowth(m: PolityModel, r: number): number {
  return GROWTH * (0.75 + 0.5 * keyed(m.base, m.terrain.regions.seat[r], 3));
}

/** 有人定居后几年建城 */
function foundDelay(m: PolityModel, r: number): number {
  return FOUND_DELAY[0] + (FOUND_DELAY[1] - FOUND_DELAY[0]) * keyed(m.base, m.terrain.regions.seat[r], 1);
}

/** 这座城人口越过立国门槛的年份(建城不满 MIN_AGE 年的往后推);够不着 = Infinity */
export function foundingYear(s: Settlement): Year {
  const t = yearReaching(s, FOUND_POP);
  return t < Infinity ? Math.max(t, s.founded + MIN_AGE) : Infinity;
}

/**
 * 港口:治所挨着能通航的海,而且是天然良港(只挨着一块海)或河口;
 * 每块陆地在它挨着的每片海上至少一个港口(挑人口上限最大的);一片海凑不够两个港口就一个都不设(航线要两头)。
 */
function findPorts(world: World, T: CultureTerrain): Uint8Array {
  const { mesh, water, flux, riverThreshold } = world;
  const { n, adjStart, adj } = mesh;
  const reg = T.regions;
  const R = reg.count;
  const open = (i: number) => water[i] === 1 && !frozen(world, i);
  // 能通航的海面连通片
  const sea = new Int32Array(n).fill(-1);
  {
    const q = new Int32Array(n);
    let id = 0;
    for (let s = 0; s < n; s++) {
      if (!open(s) || sea[s] >= 0) continue;
      let qt = 0;
      q[qt++] = s;
      sea[s] = id;
      for (let qh = 0; qh < qt; qh++) {
        const i = q[qh];
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          if (sea[j] < 0 && open(j)) {
            sea[j] = id;
            q[qt++] = j;
          }
        }
      }
      id++;
    }
  }
  // 每个治所挨着的海(取挨着的第一片)
  const seaOf = new Int32Array(R).fill(-1);
  const good = new Uint8Array(R);
  for (let r = 0; r < R; r++) {
    if (!T.habitable[r]) continue;
    const s = reg.seat[r];
    let nSea = 0;
    for (let k = adjStart[s]; k < adjStart[s + 1]; k++) {
      const j = adj[k];
      if (water[j] === 1) nSea++;
      if (sea[j] >= 0 && seaOf[r] < 0) seaOf[r] = sea[j];
    }
    if (seaOf[r] < 0) continue;
    if (nSea === 1 || flux[s] >= riverThreshold) good[r] = 1;
  }
  const port = new Uint8Array(R);
  // 每块陆地 × 每片海:最好的一个
  const best = new Map<number, number>();
  for (let r = 0; r < R; r++) {
    if (seaOf[r] < 0) continue;
    if (good[r]) port[r] = 1;
    const key = reg.landmass[r] * 65536 + seaOf[r];
    const b = best.get(key);
    if (b === undefined || reg.capacity[r] > reg.capacity[b]) best.set(key, r);
  }
  for (const r of best.values()) port[r] = 1;
  // 一片海不到两个港口:都不算
  const perSea = new Map<number, number>();
  for (let r = 0; r < R; r++) if (port[r]) perSea.set(seaOf[r], (perSea.get(seaOf[r]) ?? 0) + 1);
  for (let r = 0; r < R; r++) if (port[r] && (perSea.get(seaOf[r]) ?? 0) < 2) port[r] = 0;
  return port;
}

function frozen(world: World, i: number): boolean {
  return world.seaIce[i] >= 0.5 || world.biome[i] === Biome.SeaIce;
}

/**
 * 这一刻预约国家 pid 的扩张用哪张"离国都的路程"表:迁都那一刻(同一个时刻)还按旧国都算,之后按新国都。
 * 这样同一时刻里迁都和扩张谁先谁后都一样,fromCiv 按日志重放时能算出同样的到达年份
 */
function distFor(m: PolityModel, pid: number, now: number): Float32Array {
  return now > m.capMoved[pid] ? m.capDist[pid] : m.capDistPrev[pid] ?? m.capDist[pid];
}

/** 国家 p 经邻接边 k 进州 b 要几年;Infinity = 走不了。dist = 离国都的路程表,cb = 州 b 的民族 */
function stepYearsWith(m: PolityModel, p: Polity, k: number, b: number, dist: Float32Array, cb: number): number {
  const T = m.terrain;
  const reg = T.regions;
  const kind = reg.adjKind[k];
  const sea = p.kind === 'sea';
  if ((kind === AdjKind.Strait || kind === AdjKind.SeaRoute) && !sea) return Infinity;
  const d = dist[b];
  if (!(d < Infinity)) return Infinity;
  const bi = reg.biome[b];
  let mod = 1;
  let cross = CROSS[kind];
  switch (p.kind) {
    case 'nomad':
      mod = STEPPE_DESERT[bi] ? 0.7 : FOREST[bi] ? 2.5 : 1;
      break;
    case 'highland':
      mod = reg.elevation[b] < 300 ? 2 : 1;
      if (kind === AdjKind.Mountain) cross = 1.1;
      break;
    case 'sea':
      mod = T.coastal[b] ? 0.7 : T.inland[b] ? 1.8 : 1;
      break;
    case 'river':
      mod = T.river[b] ? 0.7 : 1.3;
      break;
    case 'lake':
      mod = T.lake[b] ? 0.7 : 1.2;
      break;
    case 'forest':
      mod = FOREST[bi] ? 0.8 : 1.4;
      break;
    default:
      break;
  }
  const culture = cb === p.culture ? 1 : OTHER_CULTURE;
  const len = reg.adjLen[k] / T.refLen;
  const jitter = 0.8 + 0.4 * keyed(m.base, m.ptag[p.id], reg.seat[b], 4);
  return (
    (m.years * len * BIOME_F[bi] * Math.sqrt(T.poverty[b]) * cross * mod * culture * fexp(d / m.reach) * jitter) /
    p.expansionism
  );
}

/** 国家 p 经邻接边 k 进州 b 要几年(现在预约);Infinity = 走不了 */
function stepYears(m: PolityModel, sim: CivSim, p: Polity, k: number, b: number): number {
  return stepYearsWith(m, p, k, b, distFor(m, p.id, sim.now), sim.owners[Layer.Culture][b]);
}

/** 国家 p 能不能走邻接边 k(海峡、航线只有海洋国家能走) */
export function canCross(p: Polity, kind: number): boolean {
  return p.kind === 'sea' || (kind !== AdjKind.Strait && kind !== AdjKind.SeaRoute);
}

/** 连通搜索用的草稿(每个州图一份):访问标记 + 队列 */
const scratch = new WeakMap<Regions, { seen: Int32Array; stamp: number; q: Int32Array }>();

/**
 * 国家 pid 的国土里,和国都(经本国国土、它能走的边)连成一片的州:mark[州] === 返回的戳记。
 * 战争里国土被切开时,切出去的那几块不算(见 bordersCore);海洋国家可以走海路
 */
export function coreOf(m: PolityModel, owner: Int16Array, pid: number, t: Year): { seen: Int32Array; stamp: number } {
  const reg = m.terrain.regions;
  let sc = scratch.get(reg);
  if (!sc) scratch.set(reg, (sc = { seen: new Int32Array(reg.count), stamp: 0, q: new Int32Array(reg.count) }));
  const stamp = ++sc.stamp;
  const p = m.polities[pid];
  const cap = m.settlements[capitalAt(p, t)].region;
  if (owner[cap] !== pid) return { seen: sc.seen, stamp };
  const { seen, q } = sc;
  let qt = 0;
  q[qt++] = cap;
  seen[cap] = stamp;
  for (let h = 0; h < qt; h++) {
    const r = q[h];
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const j = reg.adj[k];
      if (seen[j] === stamp || owner[j] !== pid || !canCross(p, reg.adjKind[k])) continue;
      seen[j] = stamp;
      q[qt++] = j;
    }
  }
  return { seen, stamp };
}

/**
 * 国家 pid 现在有没有挨着州 r、而且和国都连成一片的州(经它能走的边)。
 * 阶段 2 国土只增不减、总是连成一片,等于"有没有州挨着 r";阶段 3 国土被切开以后,切出去的飞地不再往外长
 */
function bordersCore(m: PolityModel, owner: Int16Array, pid: number, r: number, t: Year): boolean {
  const reg = m.terrain.regions;
  const p = m.polities[pid];
  let any = false;
  for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
    if (owner[reg.adj[k]] === pid && canCross(p, reg.adjKind[k])) any = true;
  }
  if (!any) return false;
  const { seen, stamp } = coreOf(m, owner, pid, t);
  for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
    if (seen[reg.adj[k]] === stamp && canCross(p, reg.adjKind[k])) return true;
  }
  return false;
}

/**
 * 各州离国都的路程(标准路程,Dijkstra;非海洋国家不跨海)。国家扩张(stepYears)和战争(远征远近)共用这一份。
 * 搜索时用 Float64 记路程(和堆里的优先级同一精度),最后才存成 Float32 ——
 * 阶段 2 曾直接用 Float32 记,"弹出的优先级 > 表里取整后的值"就被当成过期跳过,约一半的州没被展开,背后的州成了"走不到"
 */
export function capitalDistance(T: CultureTerrain, from: number, sea: boolean): Float32Array {
  // 按"地形 + 出发州 + 能不能渡海"缓存:迁都、复国常常回到用过的国都,不用每次重算(返回的表只读)
  let cache = distCache.get(T);
  if (!cache) distCache.set(T, (cache = new Map()));
  const key = from * 2 + (sea ? 1 : 0);
  const hit = cache.get(key);
  if (hit) return hit;
  const out = capitalDistanceRaw(T, from, sea);
  cache.set(key, out);
  return out;
}

const distCache = new WeakMap<CultureTerrain, Map<number, Float32Array>>();

/** 两个 Dijkstra(离国都的路程、国都间距标记)共用的堆和路程表(推演是单线程的,两者不会同时跑);路程表用完都复原成 Infinity */
const dijkstra = { heap: new MinHeap(256), d: new Float64Array(0) };
function dijkstraScratch(R: number): Float64Array {
  if (dijkstra.d.length < R) dijkstra.d = new Float64Array(R).fill(Infinity);
  dijkstra.heap.size = 0;
  return dijkstra.d;
}

function capitalDistanceRaw(T: CultureTerrain, from: number, sea: boolean): Float32Array {
  const reg = T.regions;
  const R = reg.count;
  const d = new Float64Array(R).fill(Infinity);
  dijkstraScratch(R);
  const heap = dijkstra.heap;
  d[from] = 0;
  heap.push(from, 0);
  while (heap.size) {
    const r = heap.pop();
    const dr = heap.lastPri;
    if (dr > d[r]) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const kind = reg.adjKind[k];
      if ((kind === AdjKind.Strait || kind === AdjKind.SeaRoute) && !sea) continue;
      const j = reg.adj[k];
      const nd = dr + (reg.adjLen[k] / T.refLen) * CROSS[kind];
      if (nd < d[j]) {
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return Float32Array.from(d);
}

/** 州图跳数(陆上 1、海峡 2、航线 5)不到 limit 的州:mark[州] += add */
export function markNear(reg: Regions, from: number, limit: number, mark: Int32Array, add: number) {
  const d = dijkstraScratch(reg.count);
  const heap = dijkstra.heap;
  const touched = [from];
  d[from] = 0;
  heap.push(from, 0);
  while (heap.size) {
    const r = heap.pop();
    const dr = heap.lastPri;
    if (dr > d[r]) continue;
    mark[r] += add;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const kind = reg.adjKind[k];
      const nd = dr + (kind === AdjKind.SeaRoute ? 5 : kind === AdjKind.Strait ? 2 : 1);
      const j = reg.adj[k];
      if (nd < limit && nd < d[j]) {
        if (d[j] === Infinity) touched.push(j);
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  for (const r of touched) d[r] = Infinity;
}

/** 州 a 在州 b 的邻接表里的下标(b → a 的那条边) */
export function edgeTo(reg: Regions, b: number, a: number): number {
  for (let k = reg.adjStart[b]; k < reg.adjStart[b + 1]; k++) if (reg.adj[k] === a) return k;
  return -1;
}

/** 国号一系;seatCell = 国都所在州的治所地块(位置锚) */
function lineageOf(base: number, kind: Culture['kind'], seatCell: number): PolityLineage {
  if (kind === 'nomad') return 'khanate';
  if (kind === 'sea') return keyed(base, seatCell, 6) < REPUBLIC_P ? 'republic' : 'realm';
  return 'realm';
}

/** 可居州人口上限的第 90 百分位 ÷ CAP_P90 */
function capacityNorm(T: CultureTerrain): number {
  const caps: number[] = [];
  for (let r = 0; r < T.R; r++) if (T.habitable[r]) caps.push(T.regions.capacity[r]);
  if (!caps.length) return 1;
  caps.sort((a, b) => a - b);
  return Math.max(1e-3, caps[Math.floor(0.9 * (caps.length - 1))] / CAP_P90);
}

/** 国都间距:SPACING × √(可居州数 / 目标国家数) */
function capitalSpacing(T: CultureTerrain, polities: number | 'auto'): number {
  let H = 0;
  for (let r = 0; r < T.R; r++) H += T.habitable[r];
  const target = polities === 'auto' ? Math.max(8, Math.min(20, H / REGIONS_PER_POLITY)) : Math.max(1, polities);
  return Math.max(2, SPACING * Math.sqrt(H / target));
}

function emptyModel(T: CultureTerrain, cultures: Culture[], seed: number, port: Uint8Array, spacing: number, years: number): PolityModel {
  return {
    terrain: T,
    cultures,
    base: subSeed(seed, 'civ-polity'),
    seed,
    settlements: [],
    polities: [],
    cityOf: new Int32Array(T.R).fill(-1),
    port,
    size: [],
    lands: [],
    tier: [],
    near: new Int32Array(T.R),
    capDist: [],
    capDistPrev: [],
    capMoved: [],
    met: [],
    ptag: [],
    stag: [],
    pAt: new Map(),
    sAt: new Map(),
    spacing,
    capNorm: capacityNorm(T),
    years,
    reach: REACH,
  };
}

// ---------------------------------------------------------------------------
// 定参数

export interface PolityPlanParams {
  polities: number | 'auto';
  /** 扩张快慢总系数(和民族共用) */
  pace: number;
}

/** 民族定好之后(planCultures 的结果):港口、国都间距、城市规模的基准、国家扩张快慢 */
export function planPolities(world: World, cm: CultureModel, p: PolityPlanParams): PolityModel {
  const T = cm.terrain;
  return emptyModel(T, cm.cultures, world.params.seed, findPorts(world, T), capitalSpacing(T, p.polities), STEP_YEARS / Math.max(1e-3, p.pace));
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

const models = new WeakMap<CivSim, PolityModel>();

/** 推演引擎上挂着的城镇 / 国家模型(推演中途、或 fromCiv 接着推之后,拿到最新的城镇和国家表) */
export function polityModelOf(sim: CivSim): PolityModel | undefined {
  return models.get(sim);
}

/** 登记城镇、国家的事件处理和监听(民族的 installCultures 之后调用) */
export function installPolities(sim: CivSim, m: PolityModel): void {
  models.set(sim, m);
  const T = m.terrain;
  const reg = T.regions;
  const culture = sim.owners[Layer.Culture];
  const polity = sim.owners[Layer.Polity];

  // 州有人定居:预约建城;邻州已有国家的,预约国家到达。
  // 阶段 3 同化 / 迁徙改换了部落地带的民族:不再建城(城早建好了,或者定居时已经预约过),
  // 但之前预约到这一州的国家到达都过期了(版本号变了),按新的民族重新预约
  sim.onChange(Layer.Culture, (r, v, prev) => {
    if (v < 0) return;
    const t = sim.now;
    if (prev < 0 && m.cityOf[r] < 0 && T.habitable[r]) sim.schedule(t + foundDelay(m, r), Ev.SettlementFound, r, 0);
    if (polity[r] >= 0) return;
    for (let q = reg.adjStart[r]; q < reg.adjStart[r + 1]; q++) {
      const j = reg.adj[q];
      const pid = polity[j];
      if (pid < 0) continue;
      const k = edgeTo(reg, j, r);
      const dt = stepYears(m, sim, m.polities[pid], k, r);
      if (dt < Infinity) sim.schedule(t + dt, Ev.PolityArrive, r, pid);
    }
  });

  // 国家拿下一州(扩张、立国,或战争里攻占):州数 +1(跨过一档就预约"升格"),记下新接壤的国家,预约邻州的国家到达
  sim.onChange(Layer.Polity, (r, v, prev) => {
    if (prev >= 0) {
      m.size[prev]--;
      landRemove(m.lands[prev], r);
    }
    if (v < 0) return;
    m.size[v]++;
    landAdd(m.lands[v], r);
    if (tierOf(m.size[v]) > m.tier[v]) sim.schedule(sim.now, Ev.PolityRank, m.settlements[capitalAt(m.polities[v], sim.now)].region, v);
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const o = polity[reg.adj[k]];
      if (o >= 0 && o !== v && reg.adjKind[k] !== AdjKind.SeaRoute) {
        m.met[v].add(o);
        m.met[o].add(v);
      }
    }
    spreadFrom(sim, m, r, v, sim.now);
  });

  sim.on(Ev.SettlementFound, (r, _b, t) => {
    if (m.cityOf[r] >= 0 || culture[r] < 0) return;
    foundCity(sim, m, r, t);
  });

  sim.on(Ev.PolityFound, (r, sid, t) => {
    const s = m.settlements[sid];
    // 阶段 3 城市兴衰:城已经被毁了(cities.ts)就立不成
    if (!s || s.region !== r || s.ended !== undefined || polity[r] >= 0 || m.near[r] > 0 || culture[r] < 0) return;
    const p = addPolity(m, sid, culture[r], t);
    sim.setOwner(Layer.Polity, r, p.id, Ev.PolityFound);
    sim.record('found', { a: p.id, region: r, settlement: sid });
  });

  sim.on(Ev.PolityArrive, (r, pid, t) => {
    if (polity[r] >= 0 || culture[r] < 0) return;
    // 阶段 4 干预"不许扩张":不进无主的州(禁令到期时 respread 从现有国土重新预约)
    if (m.iv?.halted(pid, t)) return;
    // 战争里丢了出发的那一州(或者已经灭亡),又没有和国都连成一片的州挨着这一州:不去了(不长出、不扩大飞地)
    if (m.polities[pid].ended !== undefined || !bordersCore(m, polity, pid, r, t)) return;
    sim.setOwner(Layer.Polity, r, pid, Ev.PolityArrive);
  });

  sim.on(Ev.PolityRank, (r, pid, t) => {
    const nt = tierOf(m.size[pid]);
    if (nt <= m.tier[pid]) return;
    const first = m.tier[pid] < 0;
    m.tier[pid] = nt;
    m.polities[pid].titles!.push({ year: t, tier: nt });
    // 立国那一刻的第 0 档不算升格(已经记了"立国")
    if (!first) sim.record('rank', { a: pid, region: r, settlement: capitalAt(m.polities[pid], t) });
  });
}

/** 国家 pid 刚拿下州 r:给 r 的邻州里有人住、还没有国家的预约"国家到达" */
function spreadFrom(sim: CivSim, m: PolityModel, r: number, pid: number, t: number) {
  const reg = m.terrain.regions;
  const culture = sim.owners[Layer.Culture];
  const polity = sim.owners[Layer.Polity];
  const p = m.polities[pid];
  for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
    const j = reg.adj[k];
    if (culture[j] < 0 || polity[j] >= 0) continue;
    const dt = stepYears(m, sim, p, k, j);
    if (dt < Infinity) sim.schedule(t + dt, Ev.PolityArrive, j, pid);
  }
}

/**
 * 国家 pid 从现有国土(州号升序)往外重新预约扩张:和每拿下一州时预约的一样(阶段 4 干预"不许扩张"到期时调用;
 * resumePolities 按日志重放时在同一刻做同样的事)
 */
export function respread(sim: CivSim, m: PolityModel, pid: number): void {
  for (const r of m.lands[pid].slice()) spreadFrom(sim, m, r, pid, sim.now);
}

/**
 * 在州 r 的治所建一座城(建城事件;阶段 3 城市兴衰的重建也走这里:rebuild.of = 被毁的旧城,成长速度 × rebuild.growth):
 * 人口上限、成长速度按州定(keyed,和先后无关);人口够立国的,预约"立国"。返回新城
 */
export function foundCity(sim: CivSim, m: PolityModel, r: number, t: Year, rebuild?: { of: number; growth: number }): Settlement {
  const reg = m.terrain.regions;
  const id = m.settlements.length;
  const s: Settlement = {
    id,
    cell: reg.seat[r],
    region: r,
    culture: sim.owners[Layer.Culture][r],
    name: '',
    founded: t,
    capacity: cityCapacity(m, r),
    growth: cityGrowth(m, r) * (rebuild ? rebuild.growth : 1),
    port: m.port[r] === 1,
  };
  if (rebuild) s.rebuilds = rebuild.of;
  m.settlements.push(s);
  m.stag.push(nextTag(m.sAt, s.cell));
  m.cityOf[r] = id;
  const tf = foundingYear(s);
  if (tf < Infinity) sim.schedule(tf, Ev.PolityFound, r, id);
  return s;
}

/** 城 s 从 t 起做 pid 的国都(阶段 3 城市兴衰:记进 Settlement.capitalSpans,人口的国都加成按它涨落) */
function capitalOpen(s: Settlement, pid: number, t: Year) {
  if (s.capitalFrom === undefined) s.capitalFrom = t;
  const spans = (s.capitalSpans ??= []);
  const last = spans[spans.length - 1];
  if (last && last.until === undefined) return; // 已经是国都(同一刻换了一国:极少见)
  spans.push({ from: t, polity: pid });
}

/** 城 s 从 t 起不再是 pid 的国都(迁都 / 亡国;旧都的国都加成慢慢退掉) */
function capitalClose(s: Settlement, pid: number, t: Year) {
  const last = s.capitalSpans?.[s.capitalSpans.length - 1];
  if (last && last.until === undefined && last.polity === pid) last.until = t;
}

/** 国家 → 国都失去国都之位时的回调(阶段 3 城市兴衰:cities.ts 预约"看旧都"。只在推演里挂,不存进 Civ) */
const capitalLost = new WeakMap<PolityModel, (sid: number, pid: number, t: Year) => void>();

/** 挂上"国都失去国都之位"的回调(cities.ts 用) */
export function onCapitalLost(m: PolityModel, fn: (sid: number, pid: number, t: Year) => void): void {
  capitalLost.set(m, fn);
}

/**
 * 迁都(战争里国都失守时由 wars.ts 调用,主动迁都由 politics.ts 调用):国都变迁表加一条、国都间距标记挪到新国都、新国都开始享受国都的人口加成(已经当过国都的照旧)、
 * 以后的扩张按新国都算路程。只改模型,史事由调用方记。旧都的国都加成慢慢退掉(Settlement.capitalSpans)
 */
export function moveCapital(m: PolityModel, pid: number, sid: number, t: Year): void {
  const p = m.polities[pid];
  const s = m.settlements[sid];
  const old = capitalAt(p, Infinity);
  // 国都间距标记跟着国都走:旧国都一带(没归别国的部落地带)以后又能立国,新国都周围不能
  const reg = m.terrain.regions;
  markNear(reg, m.settlements[old].region, m.spacing, m.near, -1);
  markNear(reg, s.region, m.spacing, m.near, 1);
  p.capitals!.push({ year: t, settlement: sid });
  if (old !== sid) {
    capitalClose(m.settlements[old], pid, t);
    capitalOpen(s, pid, t);
    capitalLost.get(m)?.(old, pid, t);
  }
  m.capDistPrev[pid] = m.capDist[pid];
  m.capDist[pid] = capitalDistance(m.terrain, s.region, p.kind === 'sea');
  m.capMoved[pid] = t;
}

/** 国家灭亡 / 被并掉(wars.ts、politics.ts 调用):记下年份,撤掉(最后一个)国都周围的"国都间距"标记(以后那里又能立新国) */
export function endPolity(m: PolityModel, pid: number, t: Year): void {
  const p = m.polities[pid];
  p.ended = t;
  const cap = capitalAt(p, Infinity);
  markNear(m.terrain.regions, m.settlements[cap].region, m.spacing, m.near, -1);
  capitalClose(m.settlements[cap], pid, t);
  capitalLost.get(m)?.(cap, pid, t);
}

/**
 * 新国家(立国、分裂、复国共用):建国家表的一项、模型里各项(州数、档位、离国都的路程……)、国都周围的"国都间距"标记。
 * 还没有国土:调用方接着用 setOwner 把国都(和别的州)划给它,国都要第一个划(州数、升格、预约扩张都挂在监听上)。
 * sid = 国都,cu = 民族(国家的类型、扩张性、国号一系按它和国都所在州定)
 */
export function addPolity(m: PolityModel, sid: number, cu: number, t: Year, extra: Partial<Polity> = {}): Polity {
  const s = m.settlements[sid];
  const r = s.region;
  const seat = m.terrain.regions.seat[r];
  const kind = m.cultures[cu].kind;
  const p: Polity = {
    id: m.polities.length,
    name: '',
    culture: cu,
    capital: sid,
    founded: t,
    kind,
    expansionism: KIND_INFO[kind].expansionism * (0.8 + 0.5 * keyed(m.base, seat, 5)),
    color: [128, 128, 128],
    lineage: lineageOf(m.base, kind, seat),
    titles: [],
    capitals: [{ year: t, settlement: sid }],
    ...extra,
  };
  capitalOpen(s, p.id, t);
  m.polities.push(p);
  m.ptag.push(nextTag(m.pAt, seat));
  m.size.push(0);
  m.lands.push([]);
  m.tier.push(-1);
  m.capDist.push(capitalDistance(m.terrain, r, kind === 'sea'));
  m.capDistPrev.push(null);
  m.capMoved.push(-Infinity);
  m.met.push(new Set());
  markNear(m.terrain.regions, r, m.spacing, m.near, 1);
  return p;
}

/**
 * 由 Civ 重建城镇、国家层的推演状态(CivSim.fromCiv 调用,在 resumeCultures 之后):
 * 登记事件处理,再按日志重算所有还没发生的"建城""立国""国家到达"。
 *
 * "国家到达"按日志从头重放:每次有国家拿下一州、每次有州新定居,当时预约了哪些到达、各在哪一年,
 * 照原样重算一遍(离国都的路程按当时的国都),还没到期、目标州还没归国家的补进引擎 ——
 * 包括从后来在战争里丢掉的州出发的那些(触发时再按接壤与否判断,和一口气推完时一样)。
 * 阶段 4 干预"不许扩张"到期的那一刻(已经过去的,iv 给出)也照样重放:那一刻这国从当时的国土往外预约了一遍(见 respread),
 * 到期事件在同一刻里最先处理,所以排在那一刻的所有日志前面。
 */
export function resumePolities(sim: CivSim, world: World, civ: Civ, iv?: InterventionModel | null): void {
  const T = cultureTerrain(world, civ.habitat, civ.regions);
  const reg = T.regions;
  const R = T.R;
  // 国都间距按默认的"自动"数量(和 planPolities 同一个公式)
  const m = emptyModel(T, civ.cultures, civ.seed, findPorts(world, T), capitalSpacing(T, 'auto'), civ.polityYears ?? STEP_YEARS);
  // 阶段 3 城市兴衰:国都年份段、洗劫记录接着推时会往里加,复制一份(不改传进来的 civ)
  m.settlements = civ.settlements.map((s) => {
    const c = { ...s };
    if (s.capitalSpans) c.capitalSpans = s.capitalSpans.map((x) => ({ ...x }));
    if (s.sacks) c.sacks = s.sacks.map((x) => ({ ...x }));
    return c;
  });
  m.polities = civ.polities.map((p) => ({
    ...p,
    titles: (p.titles ?? []).map((t) => ({ ...t })),
    capitals: (p.capitals ?? [{ year: p.founded, settlement: p.capital }]).map((c) => ({ ...c })),
    ...(p.dynasties ? { dynasties: p.dynasties.map((d) => ({ ...d })) } : {}),
  }));
  // 州里现在的城(被毁的不算:阶段 3 城市兴衰,毁了还没重建的州没有城)
  for (const s of m.settlements) if (s.ended === undefined) m.cityOf[s.region] = s.id;
  // 位置锚:按编号(= 建城 / 立国先后)数"这州第几个",和推演时一样
  for (const s of m.settlements) m.stag.push(nextTag(m.sAt, s.cell));
  for (const p of m.polities) m.ptag.push(nextTag(m.pAt, reg.seat[m.settlements[p.capital].region]));
  // 各国历任国都的路程表(按国都所在州缓存)
  const distCache = new Map<number, Float32Array>();
  const distOf = (p: Polity, sid: number) => {
    const r = m.settlements[sid].region;
    const key = r * 2 + (p.kind === 'sea' ? 1 : 0);
    let d = distCache.get(key);
    if (!d) distCache.set(key, (d = capitalDistance(T, r, p.kind === 'sea')));
    return d;
  };
  for (const p of m.polities) {
    m.size.push(0);
    m.lands.push([]);
    const tl = p.titles ?? [];
    m.tier.push(tl.length ? tl[tl.length - 1].tier : -1);
    const caps = p.capitals!;
    m.capDist.push(distOf(p, caps[caps.length - 1].settlement));
    m.capDistPrev.push(caps.length > 1 ? distOf(p, caps[caps.length - 2].settlement) : null);
    m.capMoved.push(caps.length > 1 ? caps[caps.length - 1].year : -Infinity);
    m.met.push(new Set());
    // 国都间距标记跟着国都走(见 moveCapital):在世的国家标在现在的国都周围
    if (p.ended === undefined) markNear(reg, m.settlements[caps[caps.length - 1].settlement].region, m.spacing, m.near, 1);
  }
  for (let r = 0; r < R; r++) {
    if (civ.polity[r] < 0) continue;
    m.size[civ.polity[r]]++;
    m.lands[civ.polity[r]].push(r);
  }
  installPolities(sim, m);

  const now = sim.now;
  const culture = sim.owners[Layer.Culture];
  const polity = sim.owners[Layer.Polity];
  // 定居年份(日志里最后一次"从没人住变成有人住";阶段 3 同化、迁徙改换民族不算定居,建城不另预约)。
  // 顺带记下每州最后一条日志的下标(下面判断当年预约的"国家到达"过期了没有)
  const settled = new Float64Array(R).fill(Infinity);
  const lastLog = new Int32Array(R).fill(-1);
  const log = civ.log;
  {
    const cur = new Int16Array(R).fill(-1);
    for (let i = 0; i < log.size; i++) {
      const r = log.region[i];
      lastLog[r] = i;
      if (log.layer[i] !== Layer.Culture) continue;
      const v = log.value[i];
      if (v >= 0 && cur[r] < 0) settled[r] = log.year[i];
      else if (v < 0) settled[r] = Infinity;
      cur[r] = v;
    }
  }
  // 还没建城的州(城被毁了的州不算:重建由 cities.ts 管)
  const hadCity = new Uint8Array(R);
  for (const s of m.settlements) hadCity[s.region] = 1;
  for (let r = 0; r < R; r++) {
    if (culture[r] < 0 || hadCity[r] || !T.habitable[r] || !(settled[r] < Infinity)) continue;
    sim.schedule(settled[r] + foundDelay(m, r), Ev.SettlementFound, r, 0);
  }
  // 还没到立国年份的城(当过国都的不算:立国过了,或是迁都迁来的 —— 那一州早归了国家,立国事件触发时本来也立不成;
  // 被毁的城也不算:立国事件触发时立不成)
  for (const s of m.settlements) {
    if (s.capitalFrom !== undefined || s.ended !== undefined) continue;
    const tf = foundingYear(s);
    if (tf < Infinity && quantize(tf) > now) sim.schedule(tf, Ev.PolityFound, s.region, s.id);
  }
  // "国家到达":按日志重放。预约那一刻的国都 = 在那一刻之前(不含同一时刻)最近的一次迁都后的国都,见 distFor
  const distAt = (pid: number, y: number): Float32Array => {
    const p = m.polities[pid];
    const caps = p.capitals!;
    let sid = caps[0].settlement;
    for (let i = 1; i < caps.length && caps[i].year < y; i++) sid = caps[i].settlement;
    return distOf(p, sid);
  };
  const cu = new Int16Array(R).fill(-1);
  const po = new Int16Array(R).fill(-1);
  const pend: { t: number; j: number; pid: number }[] = [];
  /** 第 i 条日志引起的一次预约:国家 pid 经边 k 进州 j(路程、民族都按当时的) */
  const add = (i: number, pid: number, k: number, j: number, y: number) => {
    // 预约之后目标州的归属(任何一层)又变过:引擎里那次到达已经过期(版本号对不上)——
    // 归了国家(以后也不会变回无主),或者阶段 3 同化 / 迁徙改换了民族
    if (lastLog[j] > i || polity[j] >= 0) return;
    const dt = stepYearsWith(m, m.polities[pid], k, j, distAt(pid, y), cu[j]);
    if (dt < Infinity && quantize(y + dt) > now) pend.push({ t: y + dt, j, pid });
  };
  // 阶段 4 干预"不许扩张"已经到期的(按时刻先后):到期那一刻这国从当时的国土(州号升序)往外预约,和 respread 一样
  if (iv) iv.pm = m;
  const ends = iv ? iv.haltEndsUpTo(now) : [];
  let ei = 0;
  /** 在第 i 条日志之后(下一条之前)重放到期的预约 */
  const retrigger = (i: number, y: number) => {
    for (; ei < ends.length && ends[ei].t <= y; ei++) {
      const e = ends[ei];
      const pid = iv!.resolveBefore(e.key, e.t);
      if (pid < 0) continue;
      for (let r = 0; r < R; r++) {
        if (po[r] !== pid) continue;
        for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
          const j = reg.adj[k];
          if (cu[j] >= 0 && po[j] < 0) add(i, pid, k, j, e.t);
        }
      }
    }
  };
  for (let i = 0; i < log.size; i++) {
    const r = log.region[i];
    const v = log.value[i];
    const y = log.year[i];
    if (ei < ends.length) retrigger(i - 1, y);
    if (log.layer[i] === Layer.Culture) {
      cu[r] = v;
      if (v < 0 || po[r] >= 0) continue;
      for (let q = reg.adjStart[r]; q < reg.adjStart[r + 1]; q++) {
        const pid = po[reg.adj[q]];
        if (pid >= 0) add(i, pid, edgeTo(reg, reg.adj[q], r), r, y);
      }
    } else {
      po[r] = v;
      if (v < 0) continue;
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const j = reg.adj[k];
        if (cu[j] >= 0 && po[j] < 0) add(i, v, k, j, y);
      }
      // 历史上接壤过的国家(配色用)
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const o = po[reg.adj[k]];
        if (o >= 0 && o !== v && reg.adjKind[k] !== AdjKind.SeaRoute) {
          m.met[v].add(o);
          m.met[o].add(v);
        }
      }
    }
  }
  if (ei < ends.length) retrigger(log.size - 1, Infinity);
  for (const e of pend) sim.schedule(e.t, Ev.PolityArrive, e.j, e.pid);
}

// ---------------------------------------------------------------------------
// 推演之后:配色、起名

/** 国家色板:柔和、色相拉开的政区图配色(写实风淡罩一层,手绘风做水彩);不用绿色(森林、林地本身是绿的,绿色罩染看不出来) */
export const POLITY_PALETTE: [number, number, number][] = [
  [214, 96, 77], // 朱
  [74, 128, 196], // 蓝
  [232, 168, 56], // 金
  [150, 98, 178], // 紫
  [70, 164, 158], // 青
  [226, 126, 164], // 粉
  [168, 120, 72], // 赭
  [228, 112, 108], // 鲑红
  [96, 104, 176], // 靛
  [206, 150, 110], // 驼
  [186, 70, 110], // 玫
  [96, 170, 212], // 天
  [196, 142, 48], // 赭黄(纸本身偏黄,太浅的黄色看不出来)
  [128, 96, 88], // 褐
  [200, 110, 200], // 品
  [58, 104, 168], // 钴蓝
  [240, 140, 96], // 橙
  [110, 128, 150], // 石板
  [178, 60, 60], // 绛
  [140, 180, 180], // 灰青
];

function colorDist(a: readonly number[], b: readonly number[]): number {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/**
 * 分裂 / 复国出来的国家和原来的国家(Polity.parent)的色差另加分(× PARENT_COLOR_W,最多算到 400):
 * 分出来的新国一定挨着原国,颜色要格外错开,回放时才看得出"裂出了一块"
 */
const PARENT_COLOR_W = 0.6;

/**
 * 配色:按编号依次挑,和接壤国家色差越大越好(和原国更要错开);同一时期的国家尽量不重复
 * (早已灭亡的国家的颜色可以再用:阶段 3 分分合合,先后立过的国家比色板里的颜色多)
 */
function assignPolityColors(polities: Polity[], nb: Set<number>[], base: number, tags: readonly number[], pins?: NamePins['polities']) {
  const used = new Uint8Array(POLITY_PALETTE.length);
  const paletteOf: number[] = [];
  for (const p of polities) {
    // 地形大事:钉住的配色照用(见 NamePins)
    const pc = pins?.get(p.id)?.color;
    if (pc) {
      paletteOf.push(Math.max(0, POLITY_PALETTE.findIndex((c) => c[0] === pc[0] && c[1] === pc[1] && c[2] === pc[2])));
      p.color = [...pc] as [number, number, number];
      continue;
    }
    // 立国时还在世的国家用过的颜色(编号在前的国家立国不晚于它)
    used.fill(0);
    for (let q = 0; q < p.id; q++) {
      const Q = polities[q];
      if (Q.ended === undefined || Q.ended > p.founded) used[paletteOf[q]] = 1;
    }
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < POLITY_PALETTE.length; i++) {
      const col = POLITY_PALETTE[i];
      let near = 400;
      for (const o of nb[p.id]) if (o < p.id) near = Math.min(near, colorDist(col, polities[o].color));
      const parent = p.parent !== undefined ? PARENT_COLOR_W * Math.min(400, colorDist(col, polities[p.parent].color)) : 0;
      const s = Math.min(near, 280) + parent - (used[i] ? 220 : 0) - 1.2 * i + 20 * keyed(base, tags[p.id], i, 9);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    paletteOf.push(best);
    p.color = [...POLITY_PALETTE[best]] as [number, number, number];
  }
}

/** 推演结束后:配色、国名词根、城名 */
export function finishPolities(world: World, m: PolityModel, owner: Int16Array, pins?: NamePins): void {
  const seed = world.params.seed;
  // 配色看"历史上接壤过的国家"(推演中逐次记下的,见 met)+ 结束时的邻国:灭亡、易手之后,回放到哪一年邻国颜色都错得开
  const nb = cultureNeighbors(m.terrain.regions, owner, m.polities.length);
  m.met.forEach((set, i) => set.forEach((o) => nb[i].add(o)));
  assignPolityColors(m.polities, nb, subSeed(seed, 'civ-polity-color'), m.ptag, pins?.polities);
  // 城名先起:西幻的王朝名借王室根据地的城名(阶段 3 王朝更替)。城名、国名各用各的种子,先后不影响结果
  nameSettlements(seed, m.settlements, m.cultures, pins?.settlements);
  // 地形大事:钉住的国名先占上(和干预"立国"时作者起的国名一样不另起),朝名起完再照钉住的改回去
  if (pins) for (const [id, v] of pins.polities) if (v.name && m.polities[id]) m.polities[id].name = v.name;
  const pinned = pins ? new Set([...pins.polities.values()].map((v) => v.name ?? '')) : undefined;
  namePolities(seed, m.polities, m.cultures, { settlements: m.settlements, regionNames: m.terrain.regions.name }, restoreDirection(world, m), pinned);
  if (pins)
    for (const [id, v] of pins.polities) {
      const ds = m.polities[id]?.dynasties;
      if (ds) v.dynasties.forEach((x, i) => x !== undefined && ds[i] && (ds[i].name = x));
    }
}

/** 复国的新国都离故国最后的国都超过这么多个州的间距,国名按方向加前缀("南昌"),否则算在故地复国("后昌") */
const RESTORE_FAR = 4;

/** 复国的国家在故国的哪个方向另立(见 naming.ts 的 namePolities) */
function restoreDirection(world: World, m: PolityModel): RestoreDirection {
  const reg = m.terrain.regions;
  let area = 0;
  for (let r = 0; r < reg.count; r++) area += reg.area[r];
  const far = RESTORE_FAR * Math.sqrt(area / Math.max(1, reg.count));
  const geo = geometryOf(world.mesh);
  const d = [0, 0];
  return (p, fallen) => {
    const a = m.settlements[p.capital].cell;
    const b = m.settlements[capitalAt(fallen, Infinity)].cell;
    if (geo.dist2(a, b) < far * far) return null;
    geo.offset(b, a, d);
    const dx = d[0];
    const dy = d[1]; // 当地(东, 南)分量:dy 正 = 向南
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? '东' : '西';
    return dy > 0 ? '南' : '北';
  };
}

/**
 * 修路用的城(交给 routes.ts):国都、港口,以及到结束年份长到"镇"以上的城镇(村子不修路,路网不至于密成一张网)。
 * 国都(含迁都后的新国都)= 大城(大路从立都 / 迁都那年起修),港口照城镇的标记。
 * "建城年份"交给道路的是这座城长成镇的年份(港口、国都是真正的建城年份):路随城镇长大一条条修起来,
 * 早年只有零星村落,不会一开始就路网密布。路的修建年份取两端里较晚的那个。
 *
 * 阶段 3 城市兴衰:同一处城址先后的城(被毁、又重建,同一地块)合成一座 —— 从第一座(够格的)建起,
 * 到最后一座被毁为止(ended;还在 = 不给):通往废城的路那一年起荒废,中间重建过的照常通路。
 * 被毁的城按"被毁之前长到过镇"算够不够格。
 */
export function routeCities(settlements: Settlement[], polities: Polity[], endYear: Year): RouteCity[] {
  const capitalFrom = new Map<number, Year>();
  for (const p of polities) {
    for (const c of p.capitals ?? [{ year: p.founded, settlement: p.capital }]) {
      capitalFrom.set(c.settlement, Math.min(capitalFrom.get(c.settlement) ?? Infinity, c.year));
    }
  }
  const town = SETTLEMENT_RANKS[ROUTE_MIN_RANK].min;
  // 同一地块先后的城(按建城先后)
  const atCell = new Map<number, Settlement[]>();
  for (const s of settlements) {
    const g = atCell.get(s.cell);
    if (g) g.push(s);
    else atCell.set(s.cell, [s]);
  }
  /** 够格修路的年份(国都、港口 = 建城那年;其余 = 长成镇那年;被毁前没长成镇 / 到结束年份还不是镇 = Infinity) */
  const from = (s: Settlement): Year => {
    if (capitalFrom.has(s.id) || s.port) return s.founded;
    if (s.ended === undefined) return populationAt(s, endYear) >= town ? Math.max(s.founded, yearReaching(s, town)) : Infinity;
    const y = Math.max(s.founded, yearReaching(s, town));
    return y < s.ended ? y : Infinity;
  };
  const out: RouteCity[] = [];
  for (const s of settlements) {
    const g = atCell.get(s.cell)!;
    if (g[0] !== s) continue;
    let founded = Infinity;
    let majorFrom = Infinity;
    for (const x of g) {
      founded = Math.min(founded, from(x));
      if (capitalFrom.has(x.id)) majorFrom = Math.min(majorFrom, capitalFrom.get(x.id)!);
    }
    if (!(founded < Infinity)) continue;
    const c: RouteCity = { cell: s.cell, major: majorFrom < Infinity, majorFrom: majorFrom < Infinity ? majorFrom : undefined, port: g.some((x) => x.port), founded };
    const ended = g[g.length - 1].ended;
    if (ended !== undefined) c.ended = ended;
    out.push(c);
  }
  return out;
}
