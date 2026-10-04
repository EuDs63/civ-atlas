/**
 * 道路网与航线:城与城之间修路,港口之间开航线。纯计算,不碰 DOM。
 *
 *   1. 定城:有城镇列表时用城镇(见 RouteCity);没有时每个州的治所就是一座城(不可居的除外),
 *      人口上限最大、彼此隔得开的一批当"大城",代替国都。
 *   2. 定连哪些城(只走邻接,每片陆地各算各的):从所有城同时洇染,两城的势力范围相接就是"邻城";
 *      再做 Urquhart 图 —— 每个"三城两两相邻"的三角里删掉代价最大的那条连线,
 *      不会有太远的连线,也没有太多三角回路。先在大城之间连(大路),再在所有城之间连(小路)。
 *   3. 地块级 A* 寻路。每一步的代价 = 距离 × 坡度 × 海拔 × 群落 × 河流(沿河道本身走、跨河都加价,
 *      所以路走在河谷里、河的旁边);已有路的打五折(后修的路并进先修的路,形成主干道),
 *      不穿城的地块加罚(路愿意穿城而过);不下海、不进湖、不穿冰原。
 *      和已有路重合的部分切掉,只留新修的段落。
 *      大路走到早先修的小路上,那一段从大路的修建年份起升级成大路(小路记 abandoned)。
 *   4. 平行的冗余小路:一段小路两端之间沿路网另有一条差不多长、又紧挨着它的路,就删掉它(并进主干道)。
 *   5. 航线:同一片海的港口之间,同样用"势力范围相接 + Urquhart"定连哪些港,在海上 A* 寻路;
 *      近岸便宜、远洋贵;结冰的海(海冰 ≥ 0.5 或海冰群落)不能走。
 *      同一片陆地上、陆路本来就连着的两港,只有海路比陆路近得多时才开航线(省得沿海岸画两道线)。
 *   6. 阶段 3 城市兴衰:城被毁(RouteCity.ended)后,只通往它的路那一年起荒废(Route.abandoned)。
 *      每一步路记下"用它的连线里最晚结束的那一年"(两端都还在的连线 = 永不结束),全都结束了才荒废;
 *      废城的邻城之间另加"绕行"连线(寻路时几乎全走原来经过废城的路),所以路过废城的干道照常在,只有岔进废城的那一截荒废。
 *      被删掉的冗余小路,它的连线改记在替代它的那条路上。
 *
 * 距离和启发函数一律来自几何层(geo.ts / gen/geometry.ts),只沿 mesh 邻接走,不用 x、y 直接算间距。
 * 没有随机数:结果只由世界决定;并列时按地块 / 城的编号定先后。
 */
import { Biome } from '../biomes';
import { MinHeap } from '../util';
import type { Progress, World } from '../world';
import type { Habitat, Regions, Route, Year } from './types';
import { KM_PER_UNIT, adjLengths, cellAreas, refSpacing } from './geo';
import { geometryOf } from '../geometry';

/** 修路用的"城"。由城镇列表生成(polities.ts 的 routeCities;大城 = 国都,port = 城镇的港口标记) */
export interface RouteCity {
  cell: number;
  /** 大城:先在它们之间修大路(没有城镇列表时 = 人口上限最大的一批州的治所) */
  major: boolean;
  /** 港口:可以开航线 */
  port: boolean;
  /** 建城年份。一条路的 built = 两端城市里较晚的那个 */
  founded: Year;
  /** 成为大城(国都)的年份:大路的 built = 两端里较晚的那个。不给 = founded */
  majorFrom?: Year;
  /**
   * 阶段 3 城市兴衰:城被毁的年份(还在 = 不给)。只通往它的路从这一年起荒废(Route.abandoned);
   * 路过它、还连着别的城的路照常用(它的邻城之间另算一条"绕行"连线,见 buildRoutes)
   */
  ended?: Year;
}

export interface RouteOptions {
  /** 不传 = 每州治所一座城(见 seatCities) */
  cities?: RouteCity[];
  progress?: Progress;
}

// ---- 调参(以截图效果为准) ----
/** 宜居分低于这个值的治所不算城(和"城址"显示一致) */
const CITY_MIN_SUIT = 1;
/** 大城约占城数的这个比例(没有城镇列表时代替国都) */
const MAJOR_SHARE = 1 / 40;
/** 大城彼此至少隔开 √(陆地面积 / 大城数) × 这个系数(沿陆地走) */
const MAJOR_SPACING = 0.6;
/** 已有路的地块之间走:打几折 */
const REUSE = 0.5;
/** 不是城的地块:代价乘几 */
const NO_CITY = 2;
/** 坡度(米 / 公里)到这个值时,代价翻倍;按平方增长 */
const SLOPE_REF = 2.5;
const SLOPE_MAX = 40;
/** 平均海拔每多这么多米,代价多一倍 */
const ELEV_REF = 3000;
/** 沿着河道本身走(两块都是河):代价乘几。路走在河边,不压在河上 */
const RIVER_ALONG = 1.5;
/** 跨河:一侧是河的一步多走几成路,按河的大小 √(流量 / 阈值) 放大 */
const RIVER_CROSS = 0.25;
/** 航线:离岸第 1、2、3、4、5+ 块海的代价倍数(近岸便宜、远洋贵) */
const SEA_DEPTH = [1, 1, 1.4, 2, 3];
/** 航线最长多少个地块间距(势力范围洇染的上限) */
const SEA_MAX_STEPS = 45;
/** 同陆地两港:陆路代价 > 海路代价 × 这个倍数才开航线 */
const SEA_VS_LAND = 2.5;
/** 冗余小路:另一条路不超过它长度的这个倍数,而且它的每一块都挨着那条路,就删掉 */
const PARALLEL_RATIO = 1.6;

/** 路段类别在 slot 数组里的编号(0 = 没有路) */
const KIND_CODE = { road: 1, trail: 2, sea: 1 } as const;

/** 群落修路难度(乘在代价上;冰原不能走) */
const BIOME_ROAD: readonly number[] = (() => {
  const t = new Array<number>(16).fill(1);
  t[Biome.Tundra] = 1.25;
  t[Biome.Taiga] = 1.2;
  t[Biome.ColdDesert] = 1.15;
  t[Biome.TemperateDesert] = 1.15;
  t[Biome.Steppe] = 1;
  t[Biome.TemperateForest] = 1.1;
  t[Biome.TemperateRainforest] = 1.25;
  t[Biome.HotDesert] = 1.3;
  t[Biome.Savanna] = 1;
  t[Biome.TropicalDryForest] = 1.1;
  t[Biome.Rainforest] = 1.4;
  t[Biome.Wetland] = 1.5;
  return t;
})();

/** 结冰的水面:海冰 ≥ 0.5,或海冰群落 */
export function icyWater(world: World, i: number): boolean {
  return world.seaIce[i] >= 0.5 || world.biome[i] === Biome.SeaIce;
}

/** 路能走的地块:陆地,且不是冰原 */
export function roadPassable(world: World, i: number): boolean {
  return world.water[i] === 0 && world.biome[i] !== Biome.Ice;
}

/** 航线能走的地块:海面(不含湖),且没结冰 */
export function seaPassable(world: World, i: number): boolean {
  return world.water[i] === 1 && !icyWater(world, i);
}

/**
 * 没有城镇列表时的城:每州治所一座(不可居 / 冰原上的除外)。
 * 大城 = 人口上限最大、彼此隔得开的一批;港口 = 挨着能通航的海。
 */
export function seatCities(world: World, habitat: Habitat, regions: Regions): RouteCity[] {
  const { mesh } = world;
  const { adjStart, adj } = mesh;
  const list: { cell: number; cap: number }[] = [];
  for (let r = 0; r < regions.count; r++) {
    const s = regions.seat[r];
    if (habitat.suitability[s] < CITY_MIN_SUIT || !roadPassable(world, s)) continue;
    list.push({ cell: s, cap: regions.capacity[r] });
  }
  const cities: RouteCity[] = list.map(({ cell }) => {
    let port = false;
    for (let k = adjStart[cell]; k < adjStart[cell + 1]; k++) if (seaPassable(world, adj[k])) port = true;
    return { cell, major: false, port, founded: 0 };
  });
  if (!cities.length) return cities;

  // 大城:按人口上限从大到小,和已选的大城沿陆地隔得够远才选
  let landArea = 0;
  const area = cellAreas(mesh);
  for (let i = 0; i < mesh.n; i++) if (world.water[i] === 0) landArea += area[i];
  const want = Math.max(1, Math.round(cities.length * MAJOR_SHARE));
  const spacing = Math.sqrt(landArea / want) * MAJOR_SPACING;
  const order = list.map((_, i) => i).sort((a, b) => list[b].cap - list[a].cap || list[a].cell - list[b].cell);
  const len = adjLengths(mesh);
  const dist = new Float64Array(mesh.n).fill(Infinity);
  const heap = new MinHeap(256);
  let picked = 0;
  for (const c of order) {
    if (picked >= want) break;
    const s = list[c].cell;
    if (dist[s] < spacing) continue;
    cities[c].major = true;
    picked++;
    // 从新大城出发洇染到 spacing 为止,记下离最近大城的路程
    dist[s] = 0;
    heap.size = 0;
    heap.push(s, 0);
    while (heap.size) {
      const i = heap.pop();
      const d = heap.lastPri;
      if (d > dist[i]) continue;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (!roadPassable(world, j)) continue;
        const nd = d + len[k];
        if (nd < spacing && nd < dist[j]) {
          dist[j] = nd;
          heap.push(j, nd);
        }
      }
    }
  }
  return cities;
}

interface Link {
  a: number;
  b: number;
  w: number;
}

/**
 * 城的"邻城图":从所有城同时洇染(代价 cost,< 0 不能走;maxD 以外不去),
 * 两城的势力范围相接就连一条边,边权 = 两边到交界的代价之和(取最小)。
 */
function neighborGraph(
  mesh: World['mesh'],
  src: number[],
  cost: Float32Array,
  maxD = Infinity,
): Link[] {
  const { n, adjStart, adj } = mesh;
  const d = new Float64Array(n).fill(Infinity);
  const lab = new Int32Array(n).fill(-1);
  const heap = new MinHeap(1024);
  for (let c = 0; c < src.length; c++) {
    const s = src[c];
    if (lab[s] >= 0) continue; // 两城同一块地(不会发生)
    d[s] = 0;
    lab[s] = c;
    heap.push(s, 0);
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastPri;
    if (di > d[i]) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const c = cost[k];
      if (c < 0) continue;
      const j = adj[k];
      const nd = di + c;
      if (nd < d[j] && nd <= maxD) {
        d[j] = nd;
        lab[j] = lab[i];
        heap.push(j, nd);
      }
    }
  }
  const best = new Map<number, Link>();
  const C = src.length;
  for (let i = 0; i < n; i++) {
    const li = lab[i];
    if (li < 0) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const c = cost[k];
      if (c < 0) continue;
      const j = adj[k];
      const lj = lab[j];
      if (lj < 0 || lj === li) continue;
      const w = d[i] + c + d[j];
      if (w > maxD) continue;
      const a = li < lj ? li : lj;
      const b = li < lj ? lj : li;
      const key = a * C + b;
      const cur = best.get(key);
      if (!cur || w < cur.w) best.set(key, { a, b, w });
    }
  }
  return [...best.values()].sort((x, y) => x.a - y.a || x.b - y.b);
}

/** Urquhart 图:每个三角(三点两两相连)删掉最长的那条边。边权并列时按编号定,保证最小生成树留在图里 */
function urquhart(count: number, links: Link[]): Link[] {
  const longer = (x: Link, y: Link) => x.w > y.w || (x.w === y.w && (x.a > y.a || (x.a === y.a && x.b > y.b)));
  const nb: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  links.forEach((e, idx) => {
    nb[e.a].set(e.b, idx);
    nb[e.b].set(e.a, idx);
  });
  const drop = new Uint8Array(links.length);
  for (let a = 0; a < count; a++) {
    const na = [...nb[a].keys()].filter((b) => b > a).sort((x, y) => x - y);
    for (let s = 0; s < na.length; s++) {
      const b = na[s];
      for (let t = s + 1; t < na.length; t++) {
        const c = na[t];
        const bc = nb[b].get(c);
        if (bc === undefined) continue;
        const ab = nb[a].get(b)!;
        const ac = nb[a].get(c)!;
        let m = ab;
        if (longer(links[ac], links[m])) m = ac;
        if (longer(links[bc], links[m])) m = bc;
        drop[m] = 1;
      }
    }
  }
  return links.filter((_, i) => !drop[i]);
}

/** 由 cell 找邻接槽位 k(adj[k] === j)。邻居只有六七个,直接扫 */
function slotOf(mesh: World['mesh'], i: number, j: number): number {
  for (let k = mesh.adjStart[i]; k < mesh.adjStart[i + 1]; k++) if (mesh.adj[k] === j) return k;
  return -1;
}

/** 可复用的 A* 寻路器(类型化数组 + 版本戳,不每次清零) */
class Finder {
  g: Float64Array;
  prev: Int32Array;
  seen: Int32Array;
  done: Int32Array;
  stamp = 0;
  heap = new MinHeap(1024);
  constructor(n: number) {
    this.g = new Float64Array(n);
    this.prev = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.done = new Int32Array(n);
  }
}

export function buildRoutes(world: World, habitat: Habitat, regions: Regions, opts: RouteOptions = {}): Route[] {
  const progress = opts.progress ?? (() => {});
  progress('道路', 0.85);
  const cities = opts.cities ?? seatCities(world, habitat, regions);
  if (cities.length < 2) return [];

  const { mesh, water, biome, elevation, flux, riverThreshold } = world;
  const { n, adjStart, adj } = mesh;
  const len = adjLengths(mesh);
  const step = refSpacing(mesh);
  const geo = geometryOf(mesh);
  /** A* 的启发函数:两地块间距离的下界 */
  const heuristic = (i: number, j: number) => geo.dist(i, j);

  // ---- 静态代价(每个邻接槽位一个;-1 = 不能走) ----
  const pass = new Uint8Array(n);
  const seaOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (roadPassable(world, i)) pass[i] = 1;
    else if (seaPassable(world, i)) seaOk[i] = 1;
  }
  const riverSize = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 河的大小 = √(流量 / 河流阈值):刚成河为 1,大河约 2.5。只用 √ 和四则运算(各浏览器逐位一致)
    if (water[i] === 0 && flux[i] >= riverThreshold) riverSize[i] = Math.sqrt(flux[i] / riverThreshold);
  }
  const depthF = (j: number) => {
    const d = -habitat.coastDist[j];
    return SEA_DEPTH[Math.min(SEA_DEPTH.length - 1, Math.max(0, d - 1))];
  };
  const landCost = new Float32Array(adj.length);
  const seaCost = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const l = len[k];
      // 航线:走进开阔海面(起点可以是港口所在的陆地块;走进终点港口在寻路里单独处理)
      seaCost[k] = seaOk[j] && (seaOk[i] || pass[i]) ? l * depthF(j) : -1;
      if (!pass[i] || !pass[j]) {
        landCost[k] = -1;
        continue;
      }
      const ei = Math.max(0, elevation[i]);
      const ej = Math.max(0, elevation[j]);
      const slope = Math.abs(ej - ei) / (l * KM_PER_UNIT); // 米 / 公里
      const sr = slope / SLOPE_REF;
      let f = Math.min(SLOPE_MAX, 1 + sr * sr);
      f *= 1 + (ei + ej) / 2 / ELEV_REF;
      f *= (BIOME_ROAD[biome[i]] + BIOME_ROAD[biome[j]]) / 2;
      const ri = riverSize[i];
      const rj = riverSize[j];
      if (ri > 0 && rj > 0) f *= RIVER_ALONG;
      else if (ri > 0 || rj > 0) f += RIVER_CROSS * (ri + rj);
      landCost[k] = l * f;
    }
  }

  // ---- 城 ----
  const cityAt = new Int32Array(n).fill(-1);
  for (let c = 0; c < cities.length; c++) if (cityAt[cities[c].cell] < 0) cityAt[cities[c].cell] = c;
  /** 陆地连通块(可走的陆地),给航线判断"同一片陆地" */
  const comp = new Int32Array(n).fill(-1);
  {
    const q = new Int32Array(n);
    let id = 0;
    for (let s = 0; s < n; s++) {
      if (!pass[s] || comp[s] >= 0) continue;
      let qt = 0;
      q[qt++] = s;
      comp[s] = id;
      for (let qh = 0; qh < qt; qh++) {
        const i = q[qh];
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          if (pass[j] && comp[j] < 0) {
            comp[j] = id;
            q[qt++] = j;
          }
        }
      }
      id++;
    }
  }

  // ---- 寻路 ----
  const F = new Finder(n);
  /** 地块上已有路(大路、小路都算) / 已有航线 */
  const onRoad = new Uint8Array(n);
  const onSea = new Uint8Array(n);
  /** 邻接槽位上已经修过的路段(两个方向都记):陆路记 KIND_CODE,航线记 1 */
  const roadSlot = new Uint8Array(adj.length);
  const seaSlot = new Uint8Array(adj.length);
  /** 陆路段的修建年份(两个方向都记),并路时只并进那时已经有的路 */
  const roadYear = new Float64Array(adj.length);

  /** 陆路 A*:返回地块序列(起点 → 终点),走不通返回 null */
  const findLand = (start: number, goal: number): number[] | null => {
    const { g, prev, seen, done, heap } = F;
    const st = ++F.stamp;
    seen[start] = st;
    g[start] = 0;
    prev[start] = -1;
    heap.size = 0;
    heap.push(start, REUSE * heuristic(start, goal));
    while (heap.size) {
      const i = heap.pop();
      if (done[i] === st) continue;
      done[i] = st;
      if (i === goal) break;
      const gi = g[i];
      const ri = onRoad[i];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        let c = landCost[k];
        if (c < 0) continue;
        const j = adj[k];
        if (done[j] === st) continue;
        if (ri && onRoad[j]) c *= REUSE;
        if (cityAt[j] < 0) c *= NO_CITY;
        const ng = gi + c;
        if (seen[j] !== st || ng < g[j]) {
          seen[j] = st;
          g[j] = ng;
          prev[j] = i;
          heap.push(j, ng + REUSE * heuristic(j, goal));
        }
      }
    }
    if (done[goal] !== st) return null;
    const path: number[] = [];
    for (let i = goal; i >= 0; i = prev[i]) path.push(i);
    return path.reverse();
  };

  /** 航线 A*:从港口出海,只走开阔海面,最后靠进终点港口 */
  const findSea = (start: number, goal: number): number[] | null => {
    const { g, prev, seen, done, heap } = F;
    const st = ++F.stamp;
    seen[start] = st;
    g[start] = 0;
    prev[start] = -1;
    heap.size = 0;
    heap.push(start, REUSE * heuristic(start, goal));
    while (heap.size) {
      const i = heap.pop();
      if (done[i] === st) continue;
      done[i] = st;
      if (i === goal) break;
      const gi = g[i];
      const si = onSea[i];
      const fromSea = seaOk[i] === 1;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (done[j] === st) continue;
        let c: number;
        if (j === goal) {
          if (!fromSea) continue;
          c = len[k];
        } else {
          c = seaCost[k];
          if (c < 0) continue;
        }
        if (si && onSea[j]) c *= REUSE;
        const ng = gi + c;
        if (seen[j] !== st || ng < g[j]) {
          seen[j] = st;
          g[j] = ng;
          prev[j] = i;
          heap.push(j, ng + REUSE * heuristic(j, goal));
        }
      }
    }
    if (done[goal] !== st) return null;
    const path: number[] = [];
    for (let i = goal; i >= 0; i = prev[i]) path.push(i);
    return path.reverse();
  };

  interface Piece {
    kind: Route['kind'];
    cells: number[];
    built: Year;
  }
  const pieces: Piece[] = [];
  /** 小路被大路"升级"的年份(两个方向都记;−1 = 没升级) */
  const upgrade = new Float64Array(adj.length).fill(-1);
  /**
   * 阶段 3 城市兴衰:每一步路(两个方向都记)用它的连线里最晚结束的那一年(连线两端有一座城被毁 = 结束;
   * 两端都还在 = Infinity;没有路 = −Infinity)。陆路、航线各一份
   */
  const roadEnd = new Float64Array(adj.length).fill(-Infinity);
  const seaEnd = new Float64Array(adj.length).fill(-Infinity);
  /**
   * 把一条路径记进路网:和已有路段重合的部分切掉,剩下的每一段新路成为一条 Route。
   * 大路走到早先修的小路上时,那一段从这一年起"升级"成大路(小路记 abandoned,大路接着画),
   * 所以国都之间的大路是一整条,回放时先有小路、立都之后才变成大路。
   */
  const lay = (path: number[], kind: Route['kind'], built: Year, end: Year = Infinity) => {
    const slots = kind === 'sea' ? seaSlot : roadSlot;
    const cellsOn = kind === 'sea' ? onSea : onRoad;
    const ends = kind === 'sea' ? seaEnd : roadEnd;
    let cur: number[] | null = null;
    for (let t = 1; t < path.length; t++) {
      const a = path[t - 1];
      const b = path[t];
      const k = slotOf(mesh, a, b);
      if (end > ends[k]) ends[k] = ends[slotOf(mesh, b, a)] = end;
      if (slots[k]) {
        if (kind === 'road' && slots[k] === KIND_CODE.trail) {
          const back = slotOf(mesh, b, a);
          slots[k] = slots[back] = KIND_CODE.road;
          upgrade[k] = upgrade[back] = built;
          if (!cur) cur = [a];
          cur.push(b);
          continue;
        }
        if (cur) pieces.push({ kind, cells: cur, built });
        cur = null;
        continue;
      }
      const back = slotOf(mesh, b, a);
      slots[k] = slots[back] = KIND_CODE[kind];
      if (kind !== 'sea') roadYear[k] = roadYear[back] = built;
      if (!cur) cur = [a];
      cur.push(b);
    }
    if (cur) pieces.push({ kind, cells: cur, built });
    for (const c of path) cellsOn[c] = 1;
  };

  const builtOf = (a: number, b: number) => Math.max(cities[a].founded, cities[b].founded);
  const majorOf = (c: number) => Math.max(cities[c].founded, cities[c].majorFrom ?? cities[c].founded);
  const builtMajor = (a: number, b: number) => Math.max(majorOf(a), majorOf(b));
  /** 连线结束的年份:两端有一座被毁的那一年(都还在 = Infinity) */
  const endOf = (a: number, b: number) => Math.min(cities[a].ended ?? Infinity, cities[b].ended ?? Infinity);
  /** 一组城的连线:邻城图 → Urquhart */
  const linksOf = (ids: number[], cost: Float32Array, maxD?: number): Link[] =>
    ids.length < 2
      ? []
      : urquhart(
          ids.length,
          neighborGraph(
            mesh,
            ids.map((c) => cities[c].cell),
            cost,
            maxD,
          ),
        ).map((e) => ({ a: ids[e.a], b: ids[e.b], w: e.w }));

  // ---- 陆路:大城之间的大路 + 所有城之间的小路 ----
  // 修路顺序:先按修建年份(有城镇列表时才有差别),同年先大路后小路,再先近后远 ——
  // 局部路网先成形,远的连线、后来的路再并进去
  const all = cities.map((_, i) => i).filter((c) => pass[cities[c].cell]);
  const jobs = [
    ...linksOf(
      all.filter((c) => cities[c].major),
      landCost,
    ).map((e) => ({ ...e, kind: 'road' as const, built: builtMajor(e.a, e.b) })),
    ...linksOf(all, landCost).map((e) => ({ ...e, kind: 'trail' as const, built: builtOf(e.a, e.b) })),
  ];
  jobs.push(...bypassLinks(jobs, cities));
  const tier = { road: 0, trail: 1 } as const;
  jobs.sort((p, q) => p.built - q.built || tier[p.kind] - tier[q.kind] || p.w - q.w || p.a - q.a || p.b - q.b);
  for (let t = 0; t < jobs.length; t++) {
    const e = jobs[t];
    const end = endOf(e.a, e.b);
    // 修路之前一端已经被毁(阶段 3 城市兴衰):这条路从来没修过
    if (!(e.built < end)) continue;
    const path = findLand(cities[e.a].cell, cities[e.b].cell);
    if (path) lay(path, e.kind, e.built, end);
    if (t === jobs.length >> 1) progress('道路', 0.88);
  }

  // ---- 冗余的平行小路并进主干道 ----
  const kept = dropParallelTrails(mesh, pieces, roadSlot, roadYear, cityAt, len, roadEnd);

  // ---- 航线 ----
  progress('航线', 0.9);
  const ports = all.filter((c) => cities[c].port);
  const seaPieces: Piece[] = [];
  if (ports.length >= 2) {
    const links = linksOf(ports, seaCost, SEA_MAX_STEPS * step);
    links.sort((p, q) => builtOf(p.a, p.b) - builtOf(q.a, q.b) || p.w - q.w || p.a - q.a || p.b - q.b);
    for (const e of links) {
      const end = endOf(e.a, e.b);
      if (!(builtOf(e.a, e.b) < end)) continue;
      const ca = cities[e.a].cell;
      const cb = cities[e.b].cell;
      if (comp[ca] === comp[cb]) {
        // 同一片陆地:陆路本来就连着。海路要比陆路近得多才开
        const land = findLand(ca, cb);
        if (land) {
          let lc = 0;
          for (let t = 1; t < land.length; t++) lc += landCost[slotOf(mesh, land[t - 1], land[t])];
          if (lc <= SEA_VS_LAND * e.w) continue;
        }
      }
      const path = findSea(ca, cb);
      if (!path) continue;
      const before = pieces.length;
      lay(path, 'sea', builtOf(e.a, e.b), end);
      seaPieces.push(...pieces.splice(before));
    }
  }

  const out: Route[] = [];
  for (const p of [...kept, ...seaPieces]) {
    if (p.cells.length < 2) continue;
    // 按"停用年份"切段:小路升级过的那几段到升级那年为止(之后由大路接着画);
    // 通往废城的那几段到城被毁那年为止(阶段 3 城市兴衰)。修好当年就停用的不留
    const ends = p.kind === 'sea' ? seaEnd : roadEnd;
    const stopOf = (k: number) => {
      const u = p.kind === 'trail' && upgrade[k] >= 0 ? upgrade[k] : Infinity;
      return Math.min(u, ends[k]);
    };
    let run: number[] = [p.cells[0]];
    let runU = NaN;
    const flush = () => {
      if (run.length >= 2 && runU > p.built) {
        const r: Route = { kind: p.kind, cells: Int32Array.from(run), built: p.built };
        if (runU < Infinity) r.abandoned = runU;
        out.push(r);
      }
    };
    for (let t = 1; t < p.cells.length; t++) {
      const u = stopOf(slotOf(mesh, p.cells[t - 1], p.cells[t]));
      if (t > 1 && u !== runU) {
        flush();
        run = [p.cells[t - 1]];
      }
      runU = u;
      run.push(p.cells[t]);
    }
    flush();
  }
  const order = { road: 0, trail: 1, sea: 2 } as const;
  out.sort((a, b) => order[a.kind] - order[b.kind]);
  return out;
}

/** 废城邻城之间的绕行连线:一座废城的邻城不超过这么多座时两两相连,多了每座连代价最接近的两座 */
const BYPASS_ALL = 4;

/**
 * 废城的绕行连线(阶段 3 城市兴衰):被毁的城(RouteCity.ended)在陆路连线图里的邻城,两两之间另加一条小路连线,
 * 修建年份 = 两条经过废城的连线都修好的那年、代价 = 两段之和(同一年排在后面修:寻路时几乎全走经过废城的原路,
 * 这些路段因此"还有人用",不随废城荒废)。邻城也在这之前被毁了的不连(它自己的绕行另算)。
 * 废城毁了以后才长起来的邻城(和废城之间的路从来没修过)也算:不然它的邻城全是废城时,它就孤零零地不通路
 */
function bypassLinks<L extends { a: number; b: number; w: number; kind: Route['kind']; built: Year }>(jobs: L[], cities: RouteCity[]): L[] {
  const out: L[] = [];
  const nb = new Map<number, Map<number, L>>();
  const add = (c: number, o: number, e: L) => {
    let m = nb.get(c);
    if (!m) nb.set(c, (m = new Map()));
    const old = m.get(o);
    if (!old || e.built < old.built || (e.built === old.built && e.w < old.w)) m.set(o, e);
  };
  for (const e of jobs) {
    if (cities[e.a].ended !== undefined) add(e.a, e.b, e);
    if (cities[e.b].ended !== undefined) add(e.b, e.a, e);
  }
  const seen = new Set<number>();
  for (const c of [...nb.keys()].sort((x, y) => x - y)) {
    const end = cities[c].ended!;
    const spokes = [...nb.get(c)!]
      .filter(([o]) => (cities[o].ended ?? Infinity) > end)
      .sort((x, y) => x[1].w - y[1].w || x[0] - y[0]);
    const pairs: [number, number][] = [];
    for (let i = 0; i < spokes.length; i++) {
      if (spokes.length <= BYPASS_ALL) {
        for (let j = i + 1; j < spokes.length; j++) pairs.push([i, j]);
        continue;
      }
      const near = spokes
        .map((sp, j) => [j, Math.abs(sp[1].w - spokes[i][1].w)] as const)
        .filter(([j]) => j !== i)
        .sort((x, y) => x[1] - y[1] || x[0] - y[0])
        .slice(0, 2);
      for (const [j] of near) pairs.push([i, j]);
    }
    for (const [i, j] of pairs) {
      const [oa, ea] = spokes[i];
      const [ob, eb] = spokes[j];
      const a = Math.min(oa, ob);
      const b = Math.max(oa, ob);
      const key = a * cities.length + b;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...ea, a, b, w: ea.w + eb.w, kind: 'trail', built: Math.max(ea.built, eb.built) });
    }
  }
  return out;
}

/**
 * 删掉冗余的平行小路:把陆路网在"城 / 岔口 / 端点 / 大小路交界"处断成一段段,
 * 对每段小路(从长到短),看它两端之间沿其余路网有没有另一条不超过 PARALLEL_RATIO 倍长、
 * 而且处处紧挨着它(它的每一块都在那条路上或和那条路相邻)的路;有就删掉它,车马改走那条路。
 * 段的中间没有城(城是断点),两端又仍然连着,所以删掉不会把任何城孤立。
 * 只并进"那时已经有"的路(修建年份不晚于它),回放时不会出现一段时间没路可走。
 * slot 就地改写(删掉的路段清零),返回切好的路段。
 */
function dropParallelTrails<P extends { kind: Route['kind']; cells: number[]; built: Year }>(
  mesh: World['mesh'],
  pieces: P[],
  slot: Uint8Array,
  year: Float64Array,
  cityAt: Int32Array,
  len: Float32Array,
  ends?: Float64Array,
): P[] {
  const { n, adjStart, adj } = mesh;
  const TRAIL = KIND_CODE.trail;
  const kindAt = (i: number) => {
    // 这个地块连着几段路、是不是大小路都有:度数 ≠ 2 或两类都有 → 断点
    let deg = 0;
    let kinds = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      if (!slot[k]) continue;
      deg++;
      kinds |= 1 << slot[k];
    }
    return { deg, mixed: (kinds & (kinds - 1)) !== 0 };
  };
  const isStop = (i: number) => {
    if (cityAt[i] >= 0) return true;
    const { deg, mixed } = kindAt(i);
    return deg !== 2 || mixed;
  };

  // ---- 串成段 ----
  interface Chain {
    cells: number[];
    slots: number[];
    len: number;
    /** 这段路里最晚修的那一截的年份 */
    year: number;
  }
  const nodes: number[] = [];
  {
    const seen = new Uint8Array(n);
    for (const p of pieces) {
      if (p.kind === 'sea') continue;
      for (const c of p.cells) if (!seen[c]) (seen[c] = 1), nodes.push(c);
    }
    nodes.sort((a, b) => a - b);
  }
  const used = new Uint8Array(adj.length);
  const chains: Chain[] = [];
  for (const a of nodes) {
    if (!isStop(a)) continue;
    for (let k0 = adjStart[a]; k0 < adjStart[a + 1]; k0++) {
      if (slot[k0] !== TRAIL || used[k0]) continue;
      const ch: Chain = { cells: [a], slots: [], len: 0, year: -Infinity };
      let k = k0;
      let prev = a;
      for (;;) {
        const b = adj[k];
        used[k] = 1;
        used[slotOf(mesh, b, prev)] = 1;
        ch.cells.push(b);
        ch.slots.push(k);
        ch.len += len[k];
        ch.year = Math.max(ch.year, year[k]);
        if (isStop(b)) break;
        let nk = -1;
        for (let q = adjStart[b]; q < adjStart[b + 1]; q++) if (slot[q] && adj[q] !== prev) nk = q;
        if (nk < 0 || used[nk] || slot[nk] !== TRAIL) break;
        prev = b;
        k = nk;
      }
      if (ch.cells.length >= 3) chains.push(ch);
    }
  }
  chains.sort((p, q) => q.len - p.len || p.cells[0] - q.cells[0]);

  // ---- 逐段检查 ----
  const dist = new Float64Array(n);
  const prevOf = new Int32Array(n);
  const seen = new Int32Array(n);
  const near = new Int32Array(n);
  let stamp = 0;
  const heap = new MinHeap(256);
  const setSlots = (ch: Chain, v: number) => {
    for (let t = 0; t < ch.slots.length; t++) {
      slot[ch.slots[t]] = v;
      slot[slotOf(mesh, ch.cells[t + 1], ch.cells[t])] = v;
    }
  };
  for (const ch of chains) {
    const u = ch.cells[0];
    const v = ch.cells[ch.cells.length - 1];
    if (u === v) continue;
    setSlots(ch, 0);
    // 沿其余路网从 u 到 v 的最短路(限长;只走那时已经修好的路)
    const limit = PARALLEL_RATIO * ch.len;
    const st = ++stamp;
    seen[u] = st;
    dist[u] = 0;
    prevOf[u] = -1;
    heap.size = 0;
    heap.push(u, 0);
    let found = false;
    while (heap.size) {
      const i = heap.pop();
      const d = heap.lastPri;
      if (d > dist[i]) continue;
      if (i === v) {
        found = true;
        break;
      }
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        if (!slot[k] || year[k] > ch.year) continue;
        const j = adj[k];
        const nd = d + len[k];
        if (nd > limit) continue;
        if (seen[j] !== st || nd < dist[j]) {
          seen[j] = st;
          dist[j] = nd;
          prevOf[j] = i;
          heap.push(j, nd);
        }
      }
    }
    let redundant = false;
    if (found) {
      // 那条路上的地块和它们的邻居
      for (let i = v; i >= 0; i = prevOf[i]) {
        near[i] = st;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) near[adj[k]] = st;
      }
      redundant = true;
      for (let t = 1; t < ch.cells.length - 1; t++) {
        if (near[ch.cells[t]] !== st) {
          redundant = false;
          break;
        }
      }
    }
    if (!redundant) setSlots(ch, TRAIL);
    else if (ends) {
      // 删掉的小路上走的连线改走替代它的那条路:那条路至少用到它的连线结束那年(阶段 3 城市兴衰)
      let e = -Infinity;
      for (const k of ch.slots) e = Math.max(e, ends[k]);
      for (let i = v; prevOf[i] >= 0; i = prevOf[i]) {
        const k = slotOf(mesh, prevOf[i], i);
        if (e > ends[k]) ends[k] = ends[slotOf(mesh, i, prevOf[i])] = e;
      }
    }
  }

  // ---- 按删剩的路段重新切 ----
  const out: P[] = [];
  for (const p of pieces) {
    if (p.kind === 'sea') {
      out.push(p);
      continue;
    }
    let cur: number[] | null = null;
    for (let t = 1; t < p.cells.length; t++) {
      const a = p.cells[t - 1];
      const b = p.cells[t];
      if (!slot[slotOf(mesh, a, b)]) {
        if (cur && cur.length >= 2) out.push({ ...p, cells: cur });
        cur = null;
        continue;
      }
      if (!cur) cur = [a];
      cur.push(b);
    }
    if (cur && cur.length >= 2) out.push({ ...p, cells: cur });
  }
  return out;
}
