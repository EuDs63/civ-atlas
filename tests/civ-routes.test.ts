import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type World } from '../src/gen/world';
import { Biome } from '../src/gen/biomes';
import { generateCiv, type Civ } from '../src/gen/civ';
import { buildRoutes, icyWater, roadPassable, seatCities, type RouteCity } from '../src/gen/civ/routes';
import { edgeLen } from '../src/gen/civ/geo';
import { routeCities } from '../src/gen/civ/polities';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

function adjacent(w: World, a: number, b: number): boolean {
  const { adjStart, adj } = w.mesh;
  for (let k = adjStart[a]; k < adjStart[a + 1]; k++) if (adj[k] === b) return true;
  return false;
}

/** 修路用的城:有城镇时是城镇(见 polities.ts 的 routeCities),没有城镇时是各州治所 */
function citiesOf(w: World, civ: Civ): RouteCity[] {
  return civ.settlements.length ? routeCities(civ.settlements, civ.polities, civ.endYear) : seatCities(w, civ.habitat, civ.regions);
}

/** 路段的基本不变量:前后相邻;陆路不下水、不穿冰原;航线只走没结冰的海,陆地只在两端(港口);修建年份在文明史之内 */
function checkRoutes(w: World, civ: Civ) {
  for (const r of civ.routes) {
    expect(r.cells.length).toBeGreaterThanOrEqual(2);
    expect(r.built).toBeGreaterThanOrEqual(0);
    expect(r.built).toBeLessThanOrEqual(civ.endYear);
    for (let t = 0; t < r.cells.length; t++) {
      const c = r.cells[t];
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(w.mesh.n);
      if (t > 0) expect(adjacent(w, r.cells[t - 1], c)).toBe(true);
      if (r.kind === 'sea') {
        const end = t === 0 || t === r.cells.length - 1;
        if (w.water[c] === 0) expect(end).toBe(true);
        else {
          expect(w.water[c]).toBe(1); // 不进湖
          expect(icyWater(w, c)).toBe(false);
          expect(w.biome[c]).not.toBe(Biome.SeaIce);
        }
      } else {
        expect(w.water[c]).toBe(0);
        expect(w.biome[c]).not.toBe(Biome.Ice);
      }
    }
  }
}

/** 陆路网的连通块(并查集,只看大路和小路) */
function roadComponents(w: World, civ: Civ): Int32Array {
  const parent = new Int32Array(w.mesh.n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const r of civ.routes) {
    if (r.kind === 'sea') continue;
    for (let t = 1; t < r.cells.length; t++) parent[find(r.cells[t])] = find(r.cells[t - 1]);
  }
  for (let i = 0; i < w.mesh.n; i++) parent[i] = find(i);
  return parent;
}

/** 可走陆地(不含冰原)的连通块 */
function passableComponents(w: World): Int32Array {
  const { n, adjStart, adj } = w.mesh;
  const comp = new Int32Array(n).fill(-1);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!roadPassable(w, s) || comp[s] >= 0) continue;
    const q = [s];
    comp[s] = id;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (roadPassable(w, j) && comp[j] < 0) {
          comp[j] = id;
          q.push(j);
        }
      }
    }
    id++;
  }
  return comp;
}

/** 同一片陆地(冰原隔开的算两片)上的城,沿陆路两两连通 */
function checkConnected(w: World, civ: Civ) {
  const cities = citiesOf(w, civ);
  const comp = passableComponents(w);
  const roads = roadComponents(w, civ);
  const onLand = new Uint8Array(w.mesh.n);
  for (const r of civ.routes) if (r.kind !== 'sea') for (const c of r.cells) onLand[c] = 1;
  const first = new Map<number, number>();
  for (const c of cities) {
    const k = comp[c.cell];
    expect(k).toBeGreaterThanOrEqual(0);
    // 被毁的城,邻城都是它毁了以后才建的:通往它的路从来没修过(routes.ts"修路之前一端已经被毁"),它不在路网上,不算
    if (c.ended !== undefined && !onLand[c.cell]) continue;
    const f = first.get(k);
    if (f === undefined) first.set(k, c.cell);
    else expect(roads[c.cell]).toBe(roads[f]);
  }
  return cities;
}

describe('道路网与航线', () => {
  it('默认参数 seed = 7 / 2024:路不下海、不穿冰原;航线不走冰海;同一片陆地上的城彼此连通', () => {
    for (const seed of [7, 2024]) {
      const w = generateWorld({ ...DEFAULT_PARAMS, seed });
      const civ = generateCiv(w);
      checkRoutes(w, civ);
      const cities = checkConnected(w, civ);
      const kinds = new Set(civ.routes.map((r) => r.kind));
      expect(kinds).toEqual(new Set(['road', 'trail', 'sea']));
      expect(cities.length).toBeGreaterThan(300);
      expect(cities.some((c) => c.major)).toBe(true);
      expect(cities.some((c) => c.port)).toBe(true);
      // 大路连的是真国都:同一片陆地上还有别的(城还在的)国都的国都,都在大路上
      // 按"立国"立起来的国家,国都各不相同;分裂 / 复国出来的国家(阶段 3 分合)常常就都于故都,同一座城可以先后是几国的国都
      const founded = civ.polities.filter((p) => p.parent === undefined).map((p) => civ.settlements[p.capital].cell);
      expect(new Set(founded).size).toBe(founded.length);
      // 城被毁了的国都不算:大路要等两头都是国都才修,修之前一头已经被毁就从来没修过(routes.ts),先毁的国都可能一条大路都没有
      const standing = (cell: number) => civ.settlements.filter((s) => s.cell === cell).some((s) => s.ended === undefined);
      const capitals = [...new Set(civ.polities.map((p) => civ.settlements[p.capital].cell))].filter(standing);
      const onRoad = new Set<number>();
      for (const r of civ.routes) if (r.kind === 'road') for (const c of r.cells) onRoad.add(c);
      const comp = passableComponents(w);
      let linked = 0;
      for (const c of capitals) {
        if (!capitals.some((o) => o !== c && comp[o] === comp[c])) continue;
        expect(onRoad.has(c)).toBe(true);
        linked++;
      }
      expect(linked).toBeGreaterThan(1);
      // 路随城出现:每条路的修建年份不早于它两端附近的城(至少不早于最早的城)
      const firstCity = Math.min(...civ.settlements.map((s) => s.founded));
      for (const r of civ.routes) expect(r.built).toBeGreaterThanOrEqual(firstCity);
    }
  }, 60_000);

  it('球面世界 seed = 7 / 2024:不变量照样成立;有跨 180° 经线的路和航线,跨过去的那一步是网格上的邻居(走短的一边)', () => {
    const kinds = new Set<string>();
    for (const seed of [7, 2024]) {
      const w = generateWorld({ ...DEFAULT_PARAMS, seed });
      const civ = generateCiv(w);
      checkRoutes(w, civ);
      checkConnected(w, civ);
      const W = w.width;
      for (const r of civ.routes) {
        for (let t = 1; t < r.cells.length; t++) {
          const a = r.cells[t - 1];
          const b = r.cells[t];
          // 每一步都短(网格邻居);主图上 x 相差大半张图的,就是跨 180° 经线的那一步
          expect(edgeLen(w.mesh, a, b)).toBeLessThan(4 * w.mesh.spacing);
          if (Math.abs(w.mesh.x[a] - w.mesh.x[b]) > W / 2) kinds.add(r.kind);
        }
      }
    }
    expect(kinds.has('sea')).toBe(true);
    expect(kinds.has('trail') || kinds.has('road')).toBe(true);
  }, 60_000);

  it('小世界、极端参数:不变量照样成立,不报错', () => {
    for (const p of [{ seed: 4 }, { seed: 21 }, { temperature: -12, seed: 3 }, { landFraction: 0.12, seed: 3 }, { landFraction: 0.6, seed: 3 }, { rainfall: 0.4, seed: 3 }]) {
      const w = generateWorld({ ...small, ...p });
      const civ = generateCiv(w);
      checkRoutes(w, civ);
      if (civ.viable) checkConnected(w, civ);
    }
  }, 60_000);

  it('任何一年路段之间都不重叠(重合的部分已经切掉;小路升级成大路时,小路在那一年停用)', () => {
    const w = generateWorld({ ...small, seed: 8 });
    const civ = generateCiv(w);
    let upgraded = 0;
    // 阶段 3 城市兴衰:通往废城的路(大路、小路、航线都可能)在城被毁那年荒废
    const ruinYears = new Set(civ.settlements.filter((s) => s.ended !== undefined).map((s) => s.ended));
    for (const sea of [false, true]) {
      const seen = new Map<number, [number, number][]>();
      for (const r of civ.routes) {
        if ((r.kind === 'sea') !== sea) continue;
        const from = r.built;
        const to = r.abandoned ?? Infinity;
        expect(to).toBeGreaterThan(from);
        if (r.abandoned !== undefined && !ruinYears.has(r.abandoned)) {
          expect(r.kind).toBe('trail');
          upgraded++;
        }
        for (let t = 1; t < r.cells.length; t++) {
          const a = Math.min(r.cells[t - 1], r.cells[t]);
          const b = Math.max(r.cells[t - 1], r.cells[t]);
          const key = a * w.mesh.n + b;
          const spans = seen.get(key) ?? [];
          for (const [f, e] of spans) expect(from >= e || to <= f).toBe(true);
          spans.push([from, to]);
          seen.set(key, spans);
        }
      }
    }
    expect(upgraded).toBeGreaterThan(0);
  });

  it('没有冗余的平行小路:任何一段小路,旁边都不存在一条紧挨着它、长度差不多的另一条路', () => {
    const w = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
    const civ = generateCiv(w);
    const { n, adjStart, adj } = w.mesh;
    // 陆路图:地块 → 相邻的路上地块(按类别),以及每一步的修建年份
    const links = new Map<number, Map<number, string>>();
    const built = new Map<string, number>();
    // 同一段先修成小路、后来又在上面修了大路(路网里两条都有,修建年份不同):这一段按大路算(和 routes.ts 里
    // 路段的类别一致,大路盖过小路),修建年份取早的那次(那时就有路了)
    const link = (a: number, b: number, kind: string, year: number) => {
      if (!links.has(a)) links.set(a, new Map());
      const m = links.get(a)!;
      if (m.get(b) !== 'road') m.set(b, kind);
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      built.set(k, Math.min(built.get(k) ?? Infinity, year));
    };
    for (const r of civ.routes) {
      if (r.kind === 'sea') continue;
      for (let t = 1; t < r.cells.length; t++) {
        link(r.cells[t - 1], r.cells[t], r.kind, r.built);
        link(r.cells[t], r.cells[t - 1], r.kind, r.built);
      }
    }
    const city = new Set(citiesOf(w, civ).map((c) => c.cell));
    const stop = (i: number) => {
      const m = links.get(i)!;
      return city.has(i) || m.size !== 2 || new Set(m.values()).size > 1;
    };
    // 在城 / 岔口处断成段
    const used = new Set<string>();
    const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    let checked = 0;
    for (const [a, m] of links) {
      if (!stop(a)) continue;
      for (const [b0, kind] of m) {
        if (kind !== 'trail' || used.has(key(a, b0))) continue;
        const cells = [a];
        let prev = a;
        let cur = b0;
        used.add(key(a, b0));
        let length = edgeLen(w.mesh, a, b0);
        for (;;) {
          cells.push(cur);
          if (stop(cur)) break;
          const nxt = [...links.get(cur)!.keys()].find((x) => x !== prev)!;
          if (used.has(key(cur, nxt))) break;
          used.add(key(cur, nxt));
          length += edgeLen(w.mesh, cur, nxt);
          prev = cur;
          cur = nxt;
        }
        if (cells.length < 3 || cells[0] === cells[cells.length - 1]) continue;
        checked++;
        // 去掉这一段,沿其余路网从一端到另一端的最短路(Dijkstra,限 1.6 倍长;只走那时已经修好的路 ——
        // 并路只并进"那时已经有"的路,回放时不会有一段时间没路可走)
        const inChain = new Set<string>();
        let chainYear = -Infinity;
        for (let t = 1; t < cells.length; t++) {
          inChain.add(key(cells[t - 1], cells[t]));
          chainYear = Math.max(chainYear, built.get(key(cells[t - 1], cells[t]))!);
        }
        const dist = new Map<number, number>([[cells[0], 0]]);
        const from = new Map<number, number>();
        const open = [cells[0]];
        const goal = cells[cells.length - 1];
        while (open.length) {
          open.sort((p, q) => dist.get(p)! - dist.get(q)!);
          const i = open.shift()!;
          if (i === goal) break;
          for (const j of links.get(i)!.keys()) {
            if (inChain.has(key(i, j)) || built.get(key(i, j))! > chainYear) continue;
            const nd = dist.get(i)! + edgeLen(w.mesh, i, j);
            if (nd > 1.6 * length) continue;
            if (!dist.has(j) || nd < dist.get(j)!) {
              dist.set(j, nd);
              from.set(j, i);
              if (!open.includes(j)) open.push(j);
            }
          }
        }
        if (!dist.has(goal)) continue;
        const near = new Set<number>();
        for (let i: number | undefined = goal; i !== undefined; i = from.get(i)) {
          near.add(i);
          for (let k = adjStart[i]; k < adjStart[i + 1]; k++) near.add(adj[k]);
        }
        const parallel = cells.slice(1, -1).every((c) => near.has(c));
        expect(parallel, `小路 ${cells.join('-')} 和另一条路平行`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(50);
    void n;
  }, 60_000);

  it('同一个种子跑两次,道路逐格相同', () => {
    const a = generateWorld({ ...small, seed: 13 });
    const b = generateWorld({ ...small, seed: 13 });
    const ra = generateCiv(a).routes;
    const rb = generateCiv(b).routes;
    expect(ra.length).toBe(rb.length);
    expect(ra.length).toBeGreaterThan(100);
    for (let i = 0; i < ra.length; i++) {
      expect(ra[i].kind).toBe(rb[i].kind);
      expect(Buffer.from(ra[i].cells.buffer).equals(Buffer.from(rb[i].cells.buffer))).toBe(true);
    }
  });

  it('道路绕开高山:路经过的地块比陆地平均更平、更低', () => {
    for (const seed of [7, 2024]) {
      const w = generateWorld({ ...DEFAULT_PARAMS, seed });
      const civ = generateCiv(w);
      const { n, adjStart, adj } = w.mesh;
      const slope = (i: number) => {
        let s = 0;
        let c = 0;
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          if (w.water[j] !== 0) continue;
          s += Math.abs(w.elevation[j] - w.elevation[i]) / edgeLen(w.mesh, i, j);
          c++;
        }
        return c ? s / c : 0;
      };
      const mean = (cells: Iterable<number>) => {
        let s = 0;
        let e = 0;
        let c = 0;
        for (const i of cells) (s += slope(i)), (e += Math.max(0, w.elevation[i])), c++;
        return { slope: s / c, elev: e / c };
      };
      const land = mean([...Array(n).keys()].filter((i) => w.water[i] === 0));
      const onRoad = new Set<number>();
      for (const r of civ.routes) if (r.kind !== 'sea') for (const c of r.cells) onRoad.add(c);
      const road = mean(onRoad);
      expect(road.slope).toBeLessThan(0.85 * land.slope);
      expect(road.elev).toBeLessThan(0.8 * land.elev);
    }
  }, 60_000);

  it('built = 两端城市建城年份里较晚的那个(传入城镇时)', () => {
    const w = generateWorld({ ...small, seed: 6 });
    const civ = generateCiv(w);
    const cities: RouteCity[] = seatCities(w, civ.habitat, civ.regions).map((c, i) => ({ ...c, founded: 100 + (i % 7) * 10 }));
    const routes = buildRoutes(w, civ.habitat, civ.regions, { cities });
    expect(routes.length).toBeGreaterThan(50);
    for (const r of routes) {
      expect(r.built).toBeGreaterThanOrEqual(100);
      expect(r.built).toBeLessThanOrEqual(160);
    }
  });

  it('没有可居之地:没有路', () => {
    const w = generateWorld({ ...small, temperature: -12, seed: 9 });
    const frozen: World = { ...w, biome: w.biome.map((b, i) => (w.water[i] === 0 ? Biome.Ice : b)) };
    expect(generateCiv(frozen).routes).toEqual([]);
  });
});
