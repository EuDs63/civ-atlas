/**
 * 城 / 地理实体 / 州的面板要用的几样统计(纯函数,按 civ / world 缓存;不改世界数据):
 *
 *   ownersOf       这一年各州的归属(共用一份)
 *   ownerSpans     一州历年的归属(按变化日志分段):城、州面板的"历任归属"色条
 *   popSeries      一座城历年的人口(均匀取样):城面板的"兴衰"小柱图
 *   cityEntries / regionEntries  和一座城 / 一州有关的编年史条目
 *   placeFacts     地理实体的几个数:山脉的最高峰和长度、河的长度和流经的州、湖 / 岛 / 荒漠的面积、海的离岸距离和最深处,
 *                  以及它经过 / 覆盖的州(海:沿岸的州;当年在哪些国家境内 / 沿岸有哪些国家按这些州查)
 */
import type { ChangeLog, Civ, Place, Settlement } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { populationAt } from '../gen/civ/growth';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { KM_PER_UNIT } from '../gen/civ/geo';
import { geometryOf } from '../gen/geometry';
import { buildChronicle, type ChronicleEntry } from '../gen/civ/chronicle';

// ---------------------------------------------------------------------------
// 这一年各州的归属(面板共用一份;下一次换了年份再查会覆盖掉,要用的数当场取出来)

let owners: Owners | undefined;
let ownersKey: { civ: Civ; year: number } | null = null;

export function ownersOf(civ: Civ, year: number): Owners {
  if (!owners || !ownersKey || ownersKey.civ !== civ || ownersKey.year !== year) {
    owners = ownersAt(civ, year, owners);
    ownersKey = { civ, year };
  }
  return owners;
}

// ---------------------------------------------------------------------------
// 历任归属

/** 变化日志里"国家"那一层的编号(types.ts 的 Layer.Polity) */
const LAYER_POLITY = 1;

/** 各州的归属变化(按年份先后):[年份, 新主人, 年份, 新主人, …] */
const changesCache = new WeakMap<ChangeLog, number[][]>();

function polityChanges(civ: Civ): number[][] {
  const log = civ.log;
  let hit = changesCache.get(log);
  if (hit && hit.length === civ.regions.count) return hit;
  hit = Array.from({ length: civ.regions.count }, () => [] as number[]);
  for (let i = 0; i < log.size; i++) {
    if (log.layer[i] !== LAYER_POLITY) continue;
    const r = log.region[i];
    if (r >= 0 && r < hit.length) hit[r].push(log.year[i], log.value[i]);
  }
  changesCache.set(log, hit);
  return hit;
}

export interface OwnerSpan {
  from: number;
  to: number;
  /** 国家编号;−1 = 无主 */
  polity: number;
}

/**
 * 州 r 在 [from, to] 这段时间里先后归谁(相邻同主的并成一段;某一年的归属 = 年份 ≤ 这一年的变化都生效之后)。
 * 从来没归过哪国 = 空数组
 */
export function ownerSpans(civ: Civ, r: number, from: number, to: number): OwnerSpan[] {
  const ch = polityChanges(civ)[r] ?? [];
  if (!(to > from)) return [];
  let cur = -1;
  let i = 0;
  for (; i < ch.length && ch[i] <= from; i += 2) cur = ch[i + 1];
  const out: OwnerSpan[] = [];
  let at = from;
  const push = (end: number, p: number) => {
    if (end <= at) return;
    const last = out[out.length - 1];
    if (last && last.polity === p) last.to = end;
    else out.push({ from: at, to: end, polity: p });
    at = end;
  };
  for (; i < ch.length && ch[i] < to; i += 2) {
    push(ch[i], cur);
    cur = ch[i + 1];
  }
  push(to, cur);
  return out.some((s) => s.polity >= 0) ? out : [];
}

/** 州 r 第一次归某国的年份;从来没有 = null */
export function firstOwned(civ: Civ, r: number): number | null {
  const ch = polityChanges(civ)[r] ?? [];
  for (let i = 0; i < ch.length; i += 2) if (ch[i + 1] >= 0) return ch[i];
  return null;
}

// ---------------------------------------------------------------------------
// 人口

/** 一座城在 [from, to] 里均匀取 n 个年份(每一格的正中)的人口(千人) */
export function popSeries(s: Settlement, from: number, to: number, n: number): { year: number; pop: number }[] {
  const out: { year: number; pop: number }[] = [];
  const step = (to - from) / n;
  for (let i = 0; i < n; i++) {
    const y = from + (i + 0.5) * step;
    out.push({ year: y, pop: populationAt(s, y) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 相关事件

const entryCache = new WeakMap<readonly ChronicleEntry[], Map<string, ChronicleEntry[]>>();

function entriesOf(civ: Civ, key: string, test: (e: ChronicleEntry) => boolean): ChronicleEntry[] {
  const all = buildChronicle(civ);
  let m = entryCache.get(all);
  if (!m) entryCache.set(all, (m = new Map()));
  let hit = m.get(key);
  if (!hit) m.set(key, (hit = all.filter((e) => test(e) || !!e.children?.some(test))));
  return hit;
}

/** 和城 id 有关的编年史条目(建城、洗劫、毁城、重建、做国都……;折叠条目看子条目) */
export function cityEntries(civ: Civ, id: number): ChronicleEntry[] {
  return entriesOf(civ, `s${id}`, (e) => e.settlement === id);
}

/** 和州 r 有关的编年史条目(事发地在这一州) */
export function regionEntries(civ: Civ, r: number): ChronicleEntry[] {
  return entriesOf(civ, `r${r}`, (e) => e.regions.includes(r));
}

/** 到 year 为止的(条目按年份排好) */
export function entriesUpTo(list: readonly ChronicleEntry[], year: number): ChronicleEntry[] {
  let n = 0;
  while (n < list.length && list[n].year <= year + 1e-6) n++;
  return list.slice(0, n);
}

// ---------------------------------------------------------------------------
// 地理实体

export interface PlaceFacts {
  /** 最高峰(米):山脉、岛屿 */
  peak?: number;
  /** 长度(公里):山脉、河 */
  lengthKm?: number;
  /** 面积(平方公里):湖、岛、荒漠 */
  areaKm2?: number;
  /** 源头海拔(米):河 */
  source?: number;
  /** 湖面海拔(米) */
  lakeLevel?: number;
  /** 年降水(毫米):荒漠 */
  rain?: number;
  /** 离岸最远(公里)、最深处(米,正数):海 */
  shoreKm?: number;
  depth?: number;
  /** 经过 / 覆盖的州(按经过的先后或覆盖的多少排,不重复);每州取样到的次数(当年各国占多少按它算) */
  regions: number[];
  weight: number[];
}

const factsCache = new WeakMap<Place[], Map<number, PlaceFacts>>();

/** 像素 (px, py) 的下标(x 左右接上;出了上下边 = −1) */
function pixel(raster: Raster, px: number, py: number): number {
  const x = Math.floor(px);
  const y = Math.floor(py);
  if (y < 0 || y >= raster.h) return -1;
  const w = raster.w;
  return y * w + (((x % w) + w) % w);
}

/** 地块 → 州(−1 = 不属任何州:水面等) */
function regionOfCell(civ: Civ, c: number): number {
  const R = civ.regions.of;
  return c >= 0 && c < R.length ? R[c] : -1;
}

export function placeFacts(civ: Civ, world: World, raster: Raster | null, id: number): PlaceFacts {
  let m = factsCache.get(civ.places);
  if (!m) factsCache.set(civ.places, (m = new Map()));
  let f = m.get(id);
  if (!f) {
    f = computeFacts(civ, world, raster, civ.places[id]);
    // 没有像素图时算不全,不缓存(下次有了再算)
    if (raster) m.set(id, f);
  }
  return f;
}

function computeFacts(civ: Civ, world: World, raster: Raster | null, p: Place): PlaceFacts {
  const count = new Map<number, number>();
  const hit = (r: number) => {
    if (r >= 0) count.set(r, (count.get(r) ?? 0) + 1);
  };
  const f: PlaceFacts = { regions: [], weight: [] };
  const geo = geometryOf(world.mesh);
  const path = p.path;
  const size = p.size ?? 0;
  const W = world.width;
  const H = world.height;
  /** 纬度的余弦(主图 y → 纬度) */
  const cosLat = (y: number) => Math.max(0.02, Math.cos(((0.5 - y / H) * Math.PI)));
  if (p.kind === 'mountains' || p.kind === 'river') {
    let len = 0;
    for (let i = 2; i + 1 < path.length; i += 2) len += geo.pointDist(path[i - 2], path[i - 1], path[i], path[i + 1]);
    f.lengthKm = (p.kind === 'mountains' && size > 0 ? size : len) * KM_PER_UNIT;
    if (raster) {
      const sc = raster.scale;
      // 沿路径每隔约 1 像素取样;山脉再往两边看一圈(约一个地块宽)找最高处
      const band = p.kind === 'mountains' ? Math.max(3, Math.round(Math.sqrt((W * H) / 36000) * sc)) : 0;
      let peak = -Infinity;
      const order: number[] = [];
      for (let i = 0; i + 1 < path.length; i += 2) {
        const x0 = path[i];
        const y0 = path[i + 1];
        const x1 = i + 3 < path.length ? path[i + 2] : x0;
        const y1 = i + 3 < path.length ? path[i + 3] : y0;
        // 跨过左右接缝的一段按近的那边走
        const dx = x1 - x0 - W * Math.round((x1 - x0) / W);
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, y1 - y0) * sc));
        for (let k = 0; k < steps; k++) {
          const px = (x0 + (dx * k) / steps) * sc;
          const py = (y0 + ((y1 - y0) * k) / steps) * sc;
          const at = pixel(raster, px, py);
          if (at < 0) continue;
          const r = regionOfCell(civ, raster.cell[at]);
          if (r >= 0 && order[order.length - 1] !== r) order.push(r);
          hit(r);
          if (p.kind === 'river' && f.source === undefined) f.source = Math.max(0, Math.round(raster.elev[at]));
          if (band) {
            for (let oy = -band; oy <= band; oy += 2)
              for (let ox = -band; ox <= band; ox += 2) {
                if (ox * ox + oy * oy > band * band) continue;
                const q = pixel(raster, px + ox, py + oy);
                if (q >= 0 && raster.water[q] === 0 && raster.elev[q] > peak) peak = raster.elev[q];
              }
          }
        }
      }
      if (band && peak > -Infinity) f.peak = Math.round(peak);
      // 河按流经的先后(源头 → 河口);山脉按取样多少
      if (p.kind === 'river') {
        const seen = new Set<number>();
        f.regions = order.filter((r) => !seen.has(r) && seen.add(r));
        f.weight = f.regions.map((r) => count.get(r) ?? 0);
        return f;
      }
    }
  } else if (p.kind === 'sea') {
    f.shoreKm = size * KM_PER_UNIT;
    if (raster && size > 0) {
      // 以锚点为中心、离岸半径为半径的圆里最深的地方
      const sc = raster.scale;
      const cx = path[0] ?? 0;
      const cy = path[1] ?? 0;
      const c0 = p.cell !== undefined && p.cell >= 0 ? p.cell : -1;
      const ax = c0 >= 0 ? world.mesh.x[c0] : cx;
      const ay = c0 >= 0 ? world.mesh.y[c0] : cy;
      // 再往外一圈(1.35 倍)碰到的陆地算沿岸
      const ry = size * sc;
      const rx = ry / cosLat(ay);
      const out = 1.35;
      const stepY = Math.max(1, (ry * out) / 50);
      const stepX = Math.max(1, (rx * out) / 50);
      let deep = 0;
      for (let oy = -ry * out; oy <= ry * out; oy += stepY)
        for (let ox = -rx * out; ox <= rx * out; ox += stepX) {
          const d = (ox / rx) ** 2 + (oy / ry) ** 2;
          if (d > out * out) continue;
          const q = pixel(raster, ax * sc + ox, ay * sc + oy);
          if (q < 0) continue;
          if (raster.water[q] === 0) hit(regionOfCell(civ, raster.cell[q]));
          else if (d <= 1 && raster.water[q] === 1 && raster.elev[q] < deep) deep = raster.elev[q];
        }
      if (deep < 0) f.depth = Math.round(-deep);
    }
  } else {
    // 湖、岛、荒漠:size = 等面积圆的半径
    if (size > 0) f.areaKm2 = Math.PI * size * size * KM_PER_UNIT * KM_PER_UNIT;
    const c0 = p.cell !== undefined && p.cell >= 0 ? p.cell : -1;
    if (p.kind === 'lake' && c0 >= 0) f.lakeLevel = Math.round(world.waterLevel[c0]);
    if (raster && c0 >= 0) {
      const sc = raster.scale;
      const ax = world.mesh.x[c0] * sc;
      const ay = world.mesh.y[c0] * sc;
      if (p.kind === 'island') {
        // 从锚点沿陆地像素往外找(整座岛),封顶免得把大陆也算进来
        const w = raster.w;
        const start = pixel(raster, ax, ay);
        if (start >= 0 && raster.water[start] === 0) {
          const cap = Math.max(4000, Math.ceil(Math.PI * size * size * sc * sc * 6));
          const seen = new Uint8Array(raster.w * raster.h);
          const stack = [start];
          seen[start] = 1;
          let n = 0;
          let peak = -Infinity;
          while (stack.length && n < cap) {
            const q = stack.pop()!;
            n++;
            if (raster.elev[q] > peak) peak = raster.elev[q];
            hit(regionOfCell(civ, raster.cell[q]));
            const x = q % w;
            const y = (q - x) / w;
            const nb = [y * w + ((x + 1) % w), y * w + ((x - 1 + w) % w), y > 0 ? q - w : -1, y < raster.h - 1 ? q + w : -1];
            for (const v of nb) {
              if (v < 0 || seen[v] || raster.water[v] !== 0) continue;
              seen[v] = 1;
              stack.push(v);
            }
          }
          if (n < cap && peak > -Infinity) f.peak = Math.round(peak);
        }
      } else {
        // 湖:周围一圈的陆地;荒漠:圆里的陆地(顺便算年降水的平均)
        const ry = Math.max(2, size * sc * (p.kind === 'lake' ? 1.4 : 1));
        const rx = ry / cosLat(world.mesh.y[c0]);
        const stepY = Math.max(1, ry / 30);
        const stepX = Math.max(1, rx / 30);
        let rain = 0;
        let rn = 0;
        for (let oy = -ry; oy <= ry; oy += stepY)
          for (let ox = -rx; ox <= rx; ox += stepX) {
            if ((ox / rx) ** 2 + (oy / ry) ** 2 > 1) continue;
            const q = pixel(raster, ax + ox, ay + oy);
            if (q < 0 || raster.water[q] !== 0) continue;
            hit(regionOfCell(civ, raster.cell[q]));
            rain += raster.precip[q];
            rn++;
          }
        if (p.kind === 'desert' && rn) f.rain = Math.round(rain / rn);
      }
    }
  }
  const regs = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  f.regions = regs.map((x) => x[0]);
  f.weight = regs.map((x) => x[1]);
  return f;
}

// ---------------------------------------------------------------------------
// 数字的写法

/** 公里 / 平方公里 / 米:大数用"万",其余取整到两位有效数字左右 */
export function kmText(km: number): string {
  if (km >= 10000) return `${(km / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
  if (km >= 1000) return `${Math.round(km / 10) * 10}`;
  return `${Math.max(10, Math.round(km / 10) * 10)}`;
}

export function areaText(km2: number): string {
  if (km2 >= 1e4) return `${(km2 / 1e4).toFixed(km2 >= 1e5 ? 0 : 1).replace(/\.0$/, '')} 万`;
  if (km2 >= 1000) return `${Math.round(km2 / 100) * 100}`;
  return `${Math.max(10, Math.round(km2 / 10) * 10)}`;
}

export function metersText(m: number): string {
  return `${Math.round(m / 10) * 10}`;
}
