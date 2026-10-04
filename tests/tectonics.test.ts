import { describe, expect, it } from 'vitest';
import { buildMesh, type Mesh } from '../src/gen/mesh';
import { buildTectonics, distanceField, type DistanceFieldStats } from '../src/gen/tectonics';
import { DEFAULT_PARAMS, MAP_H, MAP_W } from '../src/gen/world';
import { geometryOf, sphereSpacing } from '../src/gen/geometry';
import { MinHeap, mulberry32, subSeed } from '../src/gen/util';

/** 和 generateWorld 一样的网格(默认 36k 地块) */
function meshFor(seed: number, cells = DEFAULT_PARAMS.cells): Mesh {
  return buildMesh(MAP_W, MAP_H, sphereSpacing(MAP_W, cells), mulberry32(subSeed(seed, 'mesh')));
}

/** 参照答案:Float64 + "出过堆就定稿"标记的标准 Dijkstra,从头算一遍 */
function exactDistances(mesh: Mesh, sources: number[]): Float64Array {
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  for (const s of sources) {
    dist[s] = 0;
    heap.push(s, 0);
  }
  while (heap.size) {
    const i = heap.pop();
    if (done[i]) continue;
    done[i] = 1;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      const nd = dist[i] + geo.dist(j, i);
      if (nd < dist[j]) {
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return dist;
}

/** 几组有代表性的源点:板块碰撞带、张裂带、全部陆地(= 海岸距离)、随机散点 */
function sourceSets(seed: number, mesh: Mesh): [string, number[]][] {
  const t = buildTectonics(mesh, { ...DEFAULT_PARAMS, seed });
  const conv: number[] = [];
  const div: number[] = [];
  const land: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (t.convergence[i] > 0.25) conv.push(i);
    else if (t.convergence[i] < -0.25) div.push(i);
    if (t.land[i]) land.push(i);
  }
  const rng = mulberry32(subSeed(seed, 'test-sources'));
  const scatter = Array.from({ length: 12 }, () => Math.floor(rng() * mesh.n));
  return [
    ['碰撞带', conv],
    ['张裂带', div],
    ['陆地', land],
    ['散点', scatter],
  ];
}

describe('板块距离场 distanceField', () => {
  for (const seed of [15, 7]) {
    it(`seed ${seed}:和 Float64 精确 Dijkstra 一致,且出堆时没有误跳`, () => {
      const mesh = meshFor(seed);
      for (const [name, src] of sourceSets(seed, mesh)) {
        expect(src.length, name).toBeGreaterThan(0);
        const stats: DistanceFieldStats = { pops: 0, expanded: 0, stale: 0 };
        const { dist, str } = distanceField(mesh, src, () => 1, stats);
        const ref = exactDistances(mesh, src);
        let reached = 0;
        const bad: string[] = [];
        for (let i = 0; i < mesh.n; i++) {
          // 网格是连通的:每个地块都要到得了
          if (!Number.isFinite(ref[i])) bad.push(`参照答案到不了 ${i}`);
          if (!Number.isFinite(dist[i])) bad.push(`地块 ${i} 没被算到`);
          else reached++;
          // 不大于精确距离(容差 1e-3 相对误差;返回值是 Float32,只差一次舍入),也不会更小
          const tol = 1e-3 * Math.max(1, ref[i]);
          if (dist[i] > ref[i] + tol || dist[i] < ref[i] - tol) bad.push(`地块 ${i}:${dist[i]} ≠ 精确 ${ref[i]}`);
          if (str[i] !== 1) bad.push(`地块 ${i} 强度 ${str[i]}`);
        }
        expect(bad.length, `${name}:${bad.slice(0, 5).join(';')}`).toBe(0);
        // 没有误跳:每个到得了的地块恰好往外扩展一次;跳过的都是真正过期的旧条目
        expect(stats.expanded, `${name} 扩展次数`).toBe(reached);
        expect(stats.stale, `${name} 过期条目`).toBe(stats.pops - reached);
      }
    });
  }

  it('强度跟着最近的源走,源点本身距离为 0', () => {
    const mesh = meshFor(3, 12000);
    const src = [100, 5000, 9000];
    const { dist, str } = distanceField(mesh, src, (i) => i / 10000);
    for (const s of src) {
      expect(dist[s]).toBe(0);
      expect(str[s]).toBeCloseTo(s / 10000, 6);
    }
    const geo = geometryOf(mesh);
    for (let i = 0; i < mesh.n; i += 37) {
      // 最近源(按直线距离)通常就是网格上最近的源;只检查明显更近的情况,避开网格折线带来的平局
      const d = src.map((s) => geo.dist(s, i));
      const order = [0, 1, 2].sort((a, b) => d[a] - d[b]);
      if (d[order[1]] < d[order[0]] * 1.3) continue;
      expect(str[i]).toBeCloseTo(src[order[0]] / 10000, 6);
    }
  });
});

/** 陆块(连成一片的陆地)大小,从大到小 */
function landmasses(mesh: Mesh, land: Uint8Array): number[] {
  const { n, adjStart, adj } = mesh;
  const seen = new Uint8Array(n);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || seen[i]) continue;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        if (land[j] && !seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    sizes.push(q.length);
  }
  return sizes.sort((a, b) => b - a);
}

describe('一颗星球:陆块、海底', () => {
  const seeds = [1, 7, 2024, 42];
  const worlds = seeds.map((seed) => {
    const mesh = meshFor(seed);
    return { seed, mesh, t: buildTectonics(mesh, { ...DEFAULT_PARAMS, seed }) };
  });

  it('陆块大小有长尾:2~5 块大陆级 + 中等陆块 + 几十个小岛,最大的不独占', () => {
    let medium = 0;
    for (const { seed, mesh, t } of worlds) {
      const sizes = landmasses(mesh, t.land);
      const total = sizes.reduce((s, v) => s + v, 0);
      const continents = sizes.filter((s) => s >= 0.03 * total).length;
      const small = sizes.filter((s) => s < 0.003 * total).length;
      medium += sizes.filter((s) => s < 0.03 * total && s >= 0.003 * total).length;
      expect(continents, `seed ${seed} 大陆级陆块`).toBeGreaterThanOrEqual(2);
      expect(continents, `seed ${seed} 大陆级陆块`).toBeLessThanOrEqual(6);
      expect(sizes[0] / total, `seed ${seed} 最大陆块占比`).toBeLessThan(0.75);
      expect(small, `seed ${seed} 小岛`).toBeGreaterThanOrEqual(20);
    }
    // 中等陆块(大岛、微大陆):四个种子加起来不少于 6 块
    expect(medium).toBeGreaterThanOrEqual(6);
  });

  it('海底:洋中脊比深海平原浅,俯冲带外侧有海沟,大陆架宽窄不一', () => {
    for (const { seed, mesh, t } of worlds) {
      const { n } = mesh;
      let ridge = 0;
      let ridgeN = 0;
      let abyss = 0;
      let abyssN = 0;
      let trench = 0;
      const coast: number[] = [];
      for (let i = 0; i < n; i++) if (t.land[i]) coast.push(i);
      const dCoast = distanceField(mesh, coast, () => 0).dist;
      for (let i = 0; i < n; i++) {
        if (t.land[i] || dCoast[i] < 60) continue;
        const d = t.oceanDepth[i];
        if (t.distDiv[i] < 6 && t.strengthDiv[i] > 0.4) (ridge += d), ridgeN++;
        else if (t.distDiv[i] > 80 && t.distConv[i] > 40) (abyss += d), abyssN++;
      }
      for (let i = 0; i < n; i++) if (!t.land[i] && t.oceanDepth[i] < -6500) trench++;
      expect(ridgeN, `seed ${seed} 洋中脊地块`).toBeGreaterThan(50);
      expect(abyssN, `seed ${seed} 深海平原地块`).toBeGreaterThan(200);
      // 洋中脊平均比深海平原浅 1000 米以上
      expect(ridge / ridgeN - abyss / abyssN, `seed ${seed} 洋中脊 − 深海平原`).toBeGreaterThan(1000);
      expect(trench, `seed ${seed} 海沟(< -6500 米)地块`).toBeGreaterThan(20);
      // 大陆架:离岸 12~22 个世界单位(约 230~430 公里)处,有的地方还是浅海(< 250 米,被动边缘),有的已经是深海(> 2000 米,主动边缘)
      let shallow = 0;
      let deep = 0;
      for (let i = 0; i < n; i++) {
        if (t.land[i] || dCoast[i] < 12 || dCoast[i] > 22) continue;
        if (t.oceanDepth[i] > -250) shallow++;
        else if (t.oceanDepth[i] < -2000) deep++;
      }
      expect(shallow, `seed ${seed} 宽大陆架`).toBeGreaterThan(30);
      expect(deep, `seed ${seed} 窄大陆架`).toBeGreaterThan(30);
    }
  });
});
