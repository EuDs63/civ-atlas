/**
 * 地区层("州"):把几万个地块按地形 + 宜居度捏成约 900 个地区,作为文明推演的底座。
 *
 *   1. 撒种子(邻接版泊松撒点):陆地块按宜居度从高到低排队,还没被"罩住"的成为新种子,
 *      再从它出发做一次有代价上限的洇染,把半径内的地块标为已罩住。
 *      半径随宜居度变:沃土小、荒原大 —— 沃野里州县密,荒漠里一州千里。洇染不过水,所以每个岛都有种子。
 *   2. 分地块:从所有种子同时洇染(多源 Dijkstra),翻山、跨大河、换群落都要加价,不能过水
 *      —— 州界自然落在山脊、大河上。
 *   3. 修整:锯齿修平(Azgaar normalize 的规则)、碎片并回邻区、太小的州(孤岛除外)并进共享边界最长的邻区。
 *   4. 建地区邻接图:陆上相邻(平地 / 跨河 / 翻山),海上用多源洇染找"水波相遇"(海峡 / 航线),冻住的海不能走。
 *
 * 只沿 mesh 邻接走,距离一律来自 geo.ts,不用 x、y 算间距。
 */
import type { World } from '../world';
import { MinHeap } from '../util';
import { AdjKind, type Habitat, type Regions } from './types';
import { adjLengths, cellAreas, REF_MESH_CELLS, refSpacing, REGION_AREA_SCALE } from './geo';
import { MAJOR_RIVER, frozenSea } from './habitat';
import { flog2, fpow, keyed, subSeed } from './rand';

export interface RegionParams {
  /** 每州目标面积(世界单位²) */
  regionArea: number;
}

// ---- 调参(以截图效果为准) ----
/** 撒种子半径 = √目标面积 × 这个系数 × 宜居度系数 × 随机抖动 */
const SEED_RADIUS = 0.8;
/** 宜居度系数 = ((S_REF + 1) / (s + 1)) ^ SIZE_EXP,夹在 [SIZE_MIN, SIZE_MAX] */
const SIZE_REF = 12;
const SIZE_EXP = 0.35;
const SIZE_MIN = 0.7;
const SIZE_MAX = 2.3;
/** 分地块时种子势力范围 = 个头 ^ REACH_EXP(0 = 不按个头,纯按地形代价分) */
const REACH_EXP = 0.8;
/** 每爬升 / 下降多少米,相当于多走一个地块的路 */
const CLIMB_METERS_PER_STEP = 550;
/**
 * 撒种子时计入几成地形代价(翻山、换群落;跨大河总是计入)。取 0:种子疏密只由宜居度和距离决定。
 * 地形代价会随精细度变(细网格起伏更多),计入它会让州数随精细度漂移;州界贴山脊靠第 2 步分地块。
 */
const SEED_TERRAIN = 0;
/** 跨大河:每跨一次相当于多走几个地块;按流量取 log2(流量 / 阈值) − 1,夹在 [0, 4] */
const RIVER_STEPS = 0.9;
/** 换群落:这一步多走几成路 */
const BIOME_CHANGE = 0.3;
/** 小于目标面积的这个比例的州,并进邻区(孤岛除外) */
const MIN_AREA_FRAC = 0.22;
/** 海上连接:海路不超过几个地块间距算"海峡",不超过多少算"航线" */
const STRAIT_STEPS = 4;
const ROUTE_STEPS = 30;
/** 州界两侧治所都比山口低这么多米 → 翻山;或者较低的一侧低这么多 */
const MOUNTAIN_ABOVE_HIGHER = 350;
const MOUNTAIN_ABOVE_LOWER = 1100;
/** 州界上这么大比例的地块对挨着大河 → 跨河 */
const RIVER_BORDER_FRAC = 0.4;
/**
 * 精细度修正:细网格的海岸、湖泊更曲折,洇染绕路更多,同样的半径会撒出更多种子(约 ∝ 地块数^0.13)。
 * 半径乘 (地块数 / 默认精细度下的地块数)^RES_EXP 抵消,让改"精细度"时州数大致不变。
 * 默认精细度下的地块数见 geo.ts 的 REF_MESH_CELLS
 */
const RES_EXP = 0.07;

/** 河的阻隔系数:流量 ≥ 2 倍河流阈值开始算,log2(流量 / 阈值) − 1,夹在 [0, 4];大河(6 倍)约 1.6 */
function riverSize(flux: number, thr: number): number {
  const v = flog2(Math.max(1e-6, flux / thr)) - 1;
  return v <= 0 ? 0 : v > 4 ? 4 : v;
}

export function buildRegions(world: World, habitat: Habitat, p: RegionParams): Regions {
  const { mesh, water, biome, elevation, flux, riverThreshold } = world;
  const { n, adjStart, adj } = mesh;
  const base = subSeed(world.params.seed, 'civ-regions');
  const len = adjLengths(mesh);
  const cellArea = cellAreas(mesh);
  const step = refSpacing(mesh);
  const suit = habitat.suitability;
  /** 州的目标面积(另有修正,见 geo.ts 的 REGION_AREA_SCALE) */
  const regionArea = p.regionArea * REGION_AREA_SCALE;

  // ---- 陆块编号(按面积从大到小) ----
  const lmOf = landmassOf(world, cellArea);
  let lmCount = 0;
  for (let i = 0; i < n; i++) if (lmOf[i] >= lmCount) lmCount = lmOf[i] + 1;

  // ---- 每条邻接边的地形代价(只有陆地 → 陆地) ----
  const river = new Float32Array(n);
  for (let i = 0; i < n; i++) if (water[i] === 0) river[i] = riverSize(flux[i], riverThreshold);
  const climbK = step / CLIMB_METERS_PER_STEP;
  /** 分地块用的完整代价 */
  const cost = new Float32Array(adj.length);
  /** 撒种子用的代价:距离 + 打折的地形 */
  const seedCost = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    if (water[i] !== 0) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (water[j] !== 0) {
        cost[k] = seedCost[k] = -1;
        continue;
      }
      const l = len[k];
      let terrain = climbK * Math.abs(elevation[j] - elevation[i]);
      if (biome[i] !== biome[j]) terrain += BIOME_CHANGE * l;
      // 跨河:恰好一侧是大河地块(顺着河走不加价)。撒种子时也算,这样大河两岸各有各的州
      const ri = river[i];
      const rj = river[j];
      const cross = (ri > 0) !== (rj > 0) ? RIVER_STEPS * step * Math.max(ri, rj) : 0;
      cost[k] = l + terrain + cross;
      seedCost[k] = l + SEED_TERRAIN * terrain + cross;
    }
  }

  // ---- 1. 撒种子 ----
  const landCells: number[] = [];
  for (let i = 0; i < n; i++) if (water[i] === 0) landCells.push(i);
  const tie = new Float64Array(n);
  for (const i of landCells) tie[i] = keyed(base, i);
  landCells.sort((a, b) => suit[b] - suit[a] || tie[a] - tie[b]);
  // 大河地块不作治所(城建在岸边,大河本身多是州界);没被罩住的大河段在第 2 步分给两岸。
  // 只有整个岛上除了大河没有别的地块时,才让大河地块当种子(每个岛至少一个州)
  const major = MAJOR_RIVER * riverThreshold;
  const lmSeeded = new Uint8Array(lmCount);

  const R0 = Math.sqrt(regionArea) * SEED_RADIUS * fpow(n / REF_MESH_CELLS, RES_EXP);
  const covered = new Uint8Array(n);
  const dist = new Float64Array(n);
  const stamp = new Int32Array(n).fill(-1);
  const heap = new MinHeap(256);
  const seeds: number[] = [];
  /** 每个种子的"个头":荒原大、沃土小,分地块时也按它放大 / 缩小势力范围 */
  const reach: number[] = [];
  const plant = (s: number) => {
    const id = seeds.length;
    seeds.push(s);
    const f = Math.min(SIZE_MAX, Math.max(SIZE_MIN, fpow((SIZE_REF + 1) / (suit[s] + 1), SIZE_EXP)));
    reach.push(fpow(f, REACH_EXP));
    const budget = R0 * f * (0.85 + 0.3 * keyed(base, s, 1));
    covered[s] = 1;
    stamp[s] = id;
    dist[s] = 0;
    heap.size = 0;
    heap.push(s, 0);
    while (heap.size) {
      const i = heap.pop();
      const d = heap.lastPri;
      if (d > dist[i]) continue;
      covered[i] = 1;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const c = seedCost[k];
        if (c < 0) continue;
        const j = adj[k];
        const nd = d + c;
        if (nd > budget) continue;
        if (stamp[j] !== id || nd < dist[j]) {
          stamp[j] = id;
          dist[j] = nd;
          heap.push(j, nd);
        }
      }
    }
  };
  for (const s of landCells) {
    if (covered[s] || flux[s] >= major) continue;
    plant(s);
    lmSeeded[lmOf[s]] = 1;
  }
  for (const s of landCells) {
    if (lmSeeded[lmOf[s]]) continue;
    plant(s);
    lmSeeded[lmOf[s]] = 1;
  }

  // ---- 2. 分地块:多源洇染("晶体生长":每个种子的代价按自己的个头缩放,荒原的州长得更开) ----
  let of = new Int32Array(n).fill(-1);
  dist.fill(Infinity);
  heap.size = 0;
  for (let r = 0; r < seeds.length; r++) {
    dist[seeds[r]] = 0;
    heap.push(seeds[r], 0);
  }
  const from = new Int32Array(n).fill(-1);
  for (let r = 0; r < seeds.length; r++) from[seeds[r]] = r;
  while (heap.size) {
    const i = heap.pop();
    const d = heap.lastPri;
    if (d > dist[i] || of[i] >= 0) continue;
    of[i] = from[i];
    const inv = 1 / reach[of[i]];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const c = cost[k];
      if (c < 0) continue;
      const j = adj[k];
      const nd = d + c * inv;
      if (nd < dist[j]) {
        dist[j] = nd;
        from[j] = of[i];
        heap.push(j, nd);
      }
    }
  }

  // ---- 3. 修整 ----
  const isSeed = new Uint8Array(n);
  for (const s of seeds) isSeed[s] = 1;
  normalizeBorders(world, of, isSeed);
  fixFragments(world, of, seeds);
  const merged = mergeSmall(world, of, seeds, cellArea, regionArea * MIN_AREA_FRAC);

  // 压缩编号:按种子先后(第 1 州 = 最宜居的种子)
  const newId = new Int32Array(seeds.length).fill(-1);
  const seat: number[] = [];
  for (let r = 0; r < seeds.length; r++) {
    if (merged[r]) continue;
    newId[r] = seat.length;
    seat.push(seeds[r]);
  }
  const count = seat.length;
  const of2 = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (of[i] >= 0) of2[i] = newId[of[i]];
  of = of2;

  return finishRegions(world, habitat, of, Int32Array.from(seat), lmOf, cellArea, len, river, step);
}

/** 陆块编号:地块 → 所在陆块 / 岛(按面积从大到小编号,0 起;面积一样按第一块地块先后);水 = −1 */
function landmassOf(world: World, cellArea: Float32Array): Int32Array {
  const { mesh, water } = world;
  const { n, adjStart, adj } = mesh;
  const lmOf = new Int32Array(n).fill(-1);
  const lmArea: number[] = [];
  const lmFirst: number[] = [];
  const q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (water[s] !== 0 || lmOf[s] >= 0) continue;
    const id = lmArea.length;
    let a = 0;
    let qh = 0;
    let qt = 0;
    q[qt++] = s;
    lmOf[s] = id;
    while (qh < qt) {
      const i = q[qh++];
      a += cellArea[i];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (water[j] === 0 && lmOf[j] < 0) {
          lmOf[j] = id;
          q[qt++] = j;
        }
      }
    }
    lmArea.push(a);
    lmFirst.push(s);
  }
  const order = lmArea.map((_, i) => i).sort((a, b) => lmArea[b] - lmArea[a] || lmFirst[a] - lmFirst[b]);
  const rank = new Int32Array(order.length);
  order.forEach((id, r) => (rank[id] = r));
  for (let i = 0; i < n; i++) if (lmOf[i] >= 0) lmOf[i] = rank[lmOf[i]];
  return lmOf;
}

/**
 * 锯齿修平(Azgaar normalize 的规则):一块地有 ≥ 2 个邻居属于别州、同州邻居 ≤ 2 个,
 * 而且别州邻居比同州邻居多,就划给邻居最多的那个州。种子(治所)不动。
 */
function normalizeBorders(world: World, of: Int32Array, protect: Uint8Array) {
  const { n, adjStart, adj } = world.mesh;
  const ids: number[] = [];
  const cnt: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const own = of[i];
      if (own < 0 || protect[i]) continue;
      ids.length = 0;
      cnt.length = 0;
      let buddies = 0;
      let foes = 0;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const r = of[adj[k]];
        if (r < 0) continue;
        if (r === own) {
          buddies++;
          continue;
        }
        foes++;
        const at = ids.indexOf(r);
        if (at >= 0) cnt[at]++;
        else {
          ids.push(r);
          cnt.push(1);
        }
      }
      if (foes < 2 || buddies > 2 || foes <= buddies) continue;
      let best = 0;
      for (let t = 1; t < ids.length; t++) if (cnt[t] > cnt[best] || (cnt[t] === cnt[best] && ids[t] < ids[best])) best = t;
      of[i] = ids[best];
    }
  }
}

/** 碎片并回:一个州里和治所不连通的碎块,划给和它接壤最多的邻州(陆上接壤,所以不会跨水) */
function fixFragments(world: World, of: Int32Array, seeds: number[]) {
  const { n, adjStart, adj } = world.mesh;
  const reach = new Uint8Array(n);
  const q = new Int32Array(n);
  let qt = 0;
  for (let r = 0; r < seeds.length; r++) {
    const s = seeds[r];
    if (of[s] !== r) continue;
    reach[s] = 1;
    q[qt++] = s;
  }
  for (let qh = 0; qh < qt; qh++) {
    const i = q[qh];
    const r = of[i];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (!reach[j] && of[j] === r) {
        reach[j] = 1;
        q[qt++] = j;
      }
    }
  }
  // 没连上治所的碎块:整块找接壤最多的(已连上治所的)邻州。
  // 碎块只挨着别的碎块时这一轮先跳过,等邻居归位后下一轮再处理
  const seen = new Uint8Array(n);
  const comp: number[] = [];
  const tally = new Map<number, number>();
  for (let pass = 0, left = true; left && pass < 8; pass++) {
    left = false;
    seen.fill(0);
    for (let s = 0; s < n; s++) {
      if (of[s] < 0 || reach[s] || seen[s]) continue;
      const r = of[s];
      comp.length = 0;
      comp.push(s);
      seen[s] = 1;
      tally.clear();
      for (let c = 0; c < comp.length; c++) {
        const i = comp[c];
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          const rj = of[j];
          if (rj < 0) continue;
          if (rj === r) {
            if (!seen[j] && !reach[j]) {
              seen[j] = 1;
              comp.push(j);
            }
          } else if (reach[j]) tally.set(rj, (tally.get(rj) ?? 0) + 1);
        }
      }
      let best = -1;
      let bc = -1;
      for (const [rj, c] of tally) if (c > bc || (c === bc && rj < best)) (best = rj), (bc = c);
      if (best < 0) {
        left = true;
        continue;
      }
      for (const i of comp) {
        of[i] = best;
        reach[i] = 1;
      }
    }
  }
}

/**
 * 太小的州并进共享边界最长的邻州(从最小的开始)。孤岛上唯一的州不并(不能跨水)。
 * from = 只看编号从这里起的州(地形大事里新划出来的州;并进去的可以是任何州)。
 * 返回每个州是否已被并掉;of 就地改写。
 */
function mergeSmall(
  world: World,
  of: Int32Array,
  seeds: number[],
  cellArea: Float32Array,
  minArea: number,
  from = 0,
): Uint8Array {
  const { n, adjStart, adj } = world.mesh;
  const R = seeds.length;
  const area = new Float64Array(R);
  const cellsOf: number[][] = Array.from({ length: R }, () => []);
  for (let i = 0; i < n; i++) {
    const r = of[i];
    if (r < 0) continue;
    area[r] += cellArea[i];
    cellsOf[r].push(i);
  }
  const merged = new Uint8Array(R);
  const small: number[] = [];
  for (let r = from; r < R; r++) if (area[r] < minArea) small.push(r);
  small.sort((a, b) => area[a] - area[b] || a - b);
  const tally = new Map<number, number>();
  for (const r of small) {
    if (merged[r] || area[r] >= minArea) continue;
    tally.clear();
    for (const i of cellsOf[r]) {
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const rj = of[adj[k]];
        if (rj >= 0 && rj !== r) tally.set(rj, (tally.get(rj) ?? 0) + 1);
      }
    }
    let best = -1;
    let bc = -1;
    for (const [rj, c] of tally) if (c > bc || (c === bc && rj < best)) (best = rj), (bc = c);
    if (best < 0) continue; // 孤岛
    for (const i of cellsOf[r]) of[i] = best;
    cellsOf[best].push(...cellsOf[r]);
    cellsOf[r] = [];
    area[best] += area[r];
    area[r] = 0;
    merged[r] = 1;
  }
  return merged;
}

/** 由最终的"地块 → 州"算出州的各项属性和邻接图 */
function finishRegions(
  world: World,
  habitat: Habitat,
  of: Int32Array,
  seat: Int32Array,
  lmOf: Int32Array,
  cellArea: Float32Array,
  len: Float32Array,
  river: Float32Array,
  step: number,
): Regions {
  const { mesh, water, biome, elevation } = world;
  const { n, adjStart, adj } = mesh;
  const count = seat.length;

  // ---- CSR:州 → 地块 ----
  const cellStart = new Int32Array(count + 1);
  for (let i = 0; i < n; i++) if (of[i] >= 0) cellStart[of[i] + 1]++;
  for (let r = 0; r < count; r++) cellStart[r + 1] += cellStart[r];
  const cells = new Int32Array(cellStart[count]);
  const fill = cellStart.slice(0, count);
  for (let i = 0; i < n; i++) if (of[i] >= 0) cells[fill[of[i]]++] = i;

  // ---- 面积、人口上限、主导群落、平均海拔、陆块 ----
  const area = new Float32Array(count);
  const capacity = new Float32Array(count);
  const rBiome = new Uint8Array(count);
  const rElev = new Float32Array(count);
  const landmass = new Int32Array(count);
  const bArea = new Float64Array(16);
  for (let r = 0; r < count; r++) {
    let a = 0;
    let cap = 0;
    let e = 0;
    bArea.fill(0);
    for (let t = cellStart[r]; t < cellStart[r + 1]; t++) {
      const i = cells[t];
      const ca = cellArea[i];
      a += ca;
      cap += habitat.capacity[i];
      e += elevation[i] * ca;
      bArea[biome[i]] += ca;
    }
    let bb = 0;
    for (let b = 1; b < 16; b++) if (bArea[b] > bArea[bb]) bb = b;
    area[r] = a;
    capacity[r] = cap;
    rBiome[r] = bb;
    rElev[r] = a > 0 ? e / a : 0;
    landmass[r] = lmOf[seat[r]];
  }

  // ---- 区内离治所的路程(给邻接边算"两治所间路程") ----
  const dSeat = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(1024);
  for (let r = 0; r < count; r++) {
    dSeat[seat[r]] = 0;
    heap.push(seat[r], 0);
  }
  while (heap.size) {
    const i = heap.pop();
    const d = heap.lastPri;
    if (d > dSeat[i]) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (of[j] !== of[i]) continue;
      const nd = d + len[k];
      if (nd < dSeat[j]) {
        dSeat[j] = nd;
        heap.push(j, nd);
      }
    }
  }

  // ---- 陆上邻接 ----
  interface Edge {
    a: number;
    b: number;
    pairs: number;
    riverPairs: number;
    pass: number;
    len: number;
    border: number;
    kind: number;
  }
  const edges: Edge[] = [];
  const edgeOf = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const ri = of[i];
    if (ri < 0) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const rj = of[j];
      if (rj < 0 || rj === ri || j < i) continue;
      const a = ri < rj ? ri : rj;
      const b = ri < rj ? rj : ri;
      const key = a * count + b;
      let e = edgeOf.get(key);
      if (e === undefined) {
        e = edges.length;
        edgeOf.set(key, e);
        edges.push({ a, b, pairs: 0, riverPairs: 0, pass: Infinity, len: Infinity, border: 0, kind: AdjKind.Flat });
      }
      const E = edges[e];
      E.pairs++;
      if (river[i] > 0 || river[j] > 0) E.riverPairs++;
      E.pass = Math.min(E.pass, Math.max(elevation[i], elevation[j]));
      E.len = Math.min(E.len, dSeat[i] + len[k] + dSeat[j]);
      E.border += len[k] * 0.577; // 近似六边形:共享边长 ≈ 中心距 / √3
    }
  }
  for (const E of edges) {
    const ea = Math.max(0, elevation[seat[E.a]]);
    const eb = Math.max(0, elevation[seat[E.b]]);
    const pass = Math.max(0, E.pass);
    if (pass - Math.max(ea, eb) > MOUNTAIN_ABOVE_HIGHER || pass - Math.min(ea, eb) > MOUNTAIN_ABOVE_LOWER) E.kind = AdjKind.Mountain;
    else if (E.riverPairs >= RIVER_BORDER_FRAC * E.pairs) E.kind = AdjKind.River;
  }

  // ---- 海上连接:从所有海岸块出发在开阔海面上洇染,两州的"水波"相遇就连一条边 ----
  const seaD = new Float64Array(n).fill(Infinity);
  const seaLab = new Int32Array(n).fill(-1);
  const seaOrig = new Int32Array(n).fill(-1);
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (water[i] === 1 && !frozenSea(world, i)) open[i] = 1;
  heap.size = 0;
  for (let i = 0; i < n; i++) {
    if (of[i] < 0) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      if (open[adj[k]]) {
        seaD[i] = 0;
        seaLab[i] = of[i];
        seaOrig[i] = i;
        heap.push(i, 0);
        break;
      }
    }
  }
  const routeMax = ROUTE_STEPS * step;
  while (heap.size) {
    const i = heap.pop();
    const d = heap.lastPri;
    if (d > seaD[i]) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (!open[j]) continue;
      const nd = d + len[k];
      if (nd < seaD[j] && nd <= routeMax) {
        seaD[j] = nd;
        seaLab[j] = seaLab[i];
        seaOrig[j] = seaOrig[i];
        heap.push(j, nd);
      }
    }
  }
  const seaBest = new Map<number, { d: number; oa: number; ob: number }>();
  for (let i = 0; i < n; i++) {
    if (!open[i] || seaLab[i] < 0) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      // j 是被水波到达的开阔海面(每对只数一次:i < j),或别州的海岸块
      if (seaLab[j] < 0 || seaLab[j] === seaLab[i]) continue;
      if (open[j] && j < i) continue;
      const d = seaD[i] + len[k] + seaD[j];
      if (d > routeMax) continue;
      let a = seaLab[i];
      let b = seaLab[j];
      let oa = seaOrig[i];
      let ob = seaOrig[j];
      if (a > b) {
        [a, b] = [b, a];
        [oa, ob] = [ob, oa];
      }
      const key = a * count + b;
      if (edgeOf.has(key)) continue; // 陆上已经相邻
      const cur = seaBest.get(key);
      if (!cur || d < cur.d) seaBest.set(key, { d, oa, ob });
    }
  }
  const strait = STRAIT_STEPS * step;
  for (const [key, v] of seaBest) {
    const a = Math.floor(key / count);
    const b = key - a * count;
    edges.push({
      a,
      b,
      pairs: 0,
      riverPairs: 0,
      pass: 0,
      len: dSeat[v.oa] + v.d + dSeat[v.ob],
      border: 0,
      kind: v.d <= strait ? AdjKind.Strait : AdjKind.SeaRoute,
    });
  }

  // ---- 邻接 CSR(邻居按编号升序) ----
  const deg = new Int32Array(count + 1);
  for (const E of edges) {
    deg[E.a + 1]++;
    deg[E.b + 1]++;
  }
  for (let r = 0; r < count; r++) deg[r + 1] += deg[r];
  const adjStartR = deg;
  const m = adjStartR[count];
  const tmp: { to: number; e: number }[][] = Array.from({ length: count }, () => []);
  edges.forEach((E, e) => {
    tmp[E.a].push({ to: E.b, e });
    tmp[E.b].push({ to: E.a, e });
  });
  const adjR = new Int32Array(m);
  const adjKind = new Uint8Array(m);
  const adjLen = new Float32Array(m);
  const adjBorder = new Float32Array(m);
  for (let r = 0; r < count; r++) {
    const list = tmp[r].sort((x, y) => x.to - y.to);
    let o = adjStartR[r];
    for (const { to, e } of list) {
      const E = edges[e];
      adjR[o] = to;
      adjKind[o] = E.kind;
      adjLen[o] = E.len;
      adjBorder[o] = E.border;
      o++;
    }
  }

  return {
    count,
    of,
    seat,
    cellStart,
    cells,
    adjStart: adjStartR,
    adj: adjR,
    adjKind,
    adjLen,
    area,
    capacity,
    biome: rBiome,
    elevation: rElev,
    landmass,
    adjBorder,
  };
}

/** 没有陆地时的空地区表 */
export function emptyRegions(n: number): Regions {
  return {
    count: 0,
    of: new Int32Array(n).fill(-1),
    seat: new Int32Array(0),
    cellStart: new Int32Array(1),
    cells: new Int32Array(0),
    adjStart: new Int32Array(1),
    adj: new Int32Array(0),
    adjKind: new Uint8Array(0),
    adjLen: new Float32Array(0),
    area: new Float32Array(0),
    capacity: new Float32Array(0),
    biome: new Uint8Array(0),
    elevation: new Float32Array(0),
    landmass: new Int32Array(0),
    adjBorder: new Float32Array(0),
  };
}

/**
 * 地形大事之后的州(upheaval.ts):沿用之前的划分和编号,只改地形变了的地方 ——
 *   - 变成水的地块离开原来的州;一块陆地也不剩的州还占着编号(没有地块、没有邻接,人口上限 0)
 *   - 新冒出来的陆地:离原有的州近的(一个种子半径以内,沿新陆地走)并进最近的州;远的(海里新长的岛、大片新陆地)
 *     按建州时同样的规则撒种子,编号接在后面;新州太小的(和建州时同一个门槛)并进共享边界最长的邻州,孤岛上的不并
 *   - 治所还在本州的陆地上就不动,否则换成区内最宜居的地块
 *   - 稳定键用的 keyOf、keySeat 记着每块地、每州最早的样子(types.ts 的 Regions)
 * 之后按新地形重算各州的面积、人口上限、群落、海拔、陆块和邻接(和 buildRegions 最后一步同一套)。
 */
export function reshapeRegions(world: World, habitat: Habitat, prev: Regions, p: RegionParams): Regions {
  const { mesh, water, flux, riverThreshold } = world;
  const { n, adjStart, adj } = mesh;
  const base = subSeed(world.params.seed, 'civ-regions');
  const len = adjLengths(mesh);
  const cellArea = cellAreas(mesh);
  const step = refSpacing(mesh);
  const suit = habitat.suitability;
  const regionArea = p.regionArea * REGION_AREA_SCALE;
  const R0 = Math.sqrt(regionArea) * SEED_RADIUS * fpow(n / REF_MESH_CELLS, RES_EXP);

  const of = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (water[i] === 0) of[i] = prev.of[i];
  // 新陆地:从挨着它的老州地块出发沿新陆地洇染,一个种子半径以内的并进来
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap(256);
  for (let i = 0; i < n; i++) {
    if (of[i] < 0) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (water[j] === 0 && of[j] < 0) {
        dist[i] = 0;
        heap.push(i, 0);
        break;
      }
    }
  }
  while (heap.size) {
    const i = heap.pop();
    const d = heap.lastPri;
    if (d > dist[i]) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (water[j] !== 0 || prev.of[j] >= 0) continue;
      const nd = d + len[k];
      if (nd > R0 || nd >= dist[j]) continue;
      dist[j] = nd;
      of[j] = of[i];
      heap.push(j, nd);
    }
  }
  // 剩下的新陆地:按宜居度从高到低撒种子,各自洇染一个种子半径
  const seat: number[] = Array.from(prev.seat);
  const left: number[] = [];
  for (let i = 0; i < n; i++) if (water[i] === 0 && of[i] < 0) left.push(i);
  if (left.length) {
    const tie = new Float64Array(n);
    for (const i of left) tie[i] = keyed(base, i, 7);
    left.sort((a, b) => suit[b] - suit[a] || tie[a] - tie[b]);
    for (const s of left) {
      if (of[s] >= 0) continue;
      const id = seat.length;
      seat.push(s);
      of[s] = id;
      dist[s] = 0;
      heap.size = 0;
      heap.push(s, 0);
      while (heap.size) {
        const i = heap.pop();
        const d = heap.lastPri;
        if (d > dist[i]) continue;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          if (water[j] !== 0 || of[j] >= 0) continue;
          const nd = d + len[k];
          if (nd > R0) continue;
          dist[j] = nd;
          of[j] = id;
          heap.push(j, nd);
        }
      }
    }
  }
  // 新州太小的并进邻州,剩下的新州重新编号(接在原有的州后面)
  if (seat.length > prev.count) {
    const merged = mergeSmall(world, of, seat, cellArea, regionArea * MIN_AREA_FRAC, prev.count);
    const newId = new Int32Array(seat.length);
    const kept = seat.slice(0, prev.count);
    for (let r = 0; r < seat.length; r++) {
      if (r < prev.count) newId[r] = r;
      else if (merged[r]) newId[r] = -1;
      else {
        newId[r] = kept.length;
        kept.push(seat[r]);
      }
    }
    for (let i = 0; i < n; i++) if (of[i] >= prev.count) of[i] = newId[of[i]];
    seat.length = 0;
    seat.push(...kept);
  }
  // 治所:还在本州陆地上的不动;不在了的换成区内最宜居的地块(一块陆地也不剩的州留着原来的治所)
  const best = new Int32Array(seat.length).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = of[i];
    if (r < 0) continue;
    if (best[r] < 0 || suit[i] > suit[best[r]] || (suit[i] === suit[best[r]] && i < best[r])) best[r] = i;
  }
  for (let r = 0; r < seat.length; r++) if (!(water[seat[r]] === 0 && of[seat[r]] === r) && best[r] >= 0) seat[r] = best[r];

  const lmOf = landmassOf(world, cellArea);
  const river = new Float32Array(n);
  for (let i = 0; i < n; i++) if (water[i] === 0) river[i] = riverSize(flux[i], riverThreshold);
  // 稳定键:地块按最早属于的州、州按最早的治所(大事以后沉了的地方、换了的治所照样指回同一州)
  const prevOf = prev.keyOf ?? prev.of;
  const prevSeat = prev.keySeat ?? prev.seat;
  const keyOf = new Int32Array(n);
  for (let i = 0; i < n; i++) keyOf[i] = prevOf[i] >= 0 ? prevOf[i] : of[i];
  const keySeat = Int32Array.from(seat);
  for (let r = 0; r < prev.count; r++) keySeat[r] = prevSeat[r];
  // 新州的键要指回它自己:治所那块地早先属于别的州(沉下去又抬起来的地方)时,换一块从没属于过别的州的;
  // 都属于过,就挑一块不是别的州治所键的地块,改指这个新州
  const used = new Set(keySeat.subarray(0, prev.count));
  for (let r = prev.count; r < seat.length; r++) {
    if (keyOf[keySeat[r]] === r) continue;
    let pick = -1;
    for (let i = 0; i < n && pick < 0; i++) if (of[i] === r && keyOf[i] === r) pick = i;
    for (let i = 0; i < n && pick < 0; i++) if (of[i] === r && !used.has(i)) pick = i;
    if (pick < 0) continue;
    keySeat[r] = pick;
    keyOf[pick] = r;
  }
  return { ...finishRegions(world, habitat, of, Int32Array.from(seat), lmOf, cellArea, len, river, step), keyOf, keySeat };
}
