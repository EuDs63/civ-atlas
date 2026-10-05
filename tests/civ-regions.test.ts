import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type World } from '../src/gen/world';
import { Biome } from '../src/gen/biomes';
import { generateCiv, civTransferables, type Civ } from '../src/gen/civ';
import { AdjKind } from '../src/gen/civ/types';
import { keyed } from '../src/gen/civ/rand';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

/** 按陆地连通(不过水)算陆块编号 */
function landmasses(w: World): Int32Array {
  const { n, adjStart, adj } = w.mesh;
  const lm = new Int32Array(n).fill(-1);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (w.water[s] !== 0 || lm[s] >= 0) continue;
    const q = [s];
    lm[s] = id;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (w.water[j] === 0 && lm[j] < 0) {
          lm[j] = id;
          q.push(j);
        }
      }
    }
    id++;
  }
  return lm;
}

/** 检查州的基本不变量:每块陆地都属于一个州、州内连通(不跨水)、每个岛至少一个州、CSR 一致 */
function checkRegions(w: World, civ: Civ) {
  const R = civ.regions;
  const { n, adjStart, adj } = w.mesh;
  // 每块陆地属于一个州,水不属于任何州
  for (let i = 0; i < n; i++) {
    if (w.water[i] === 0) expect(R.of[i]).toBeGreaterThanOrEqual(0);
    else expect(R.of[i]).toBe(-1);
    expect(R.of[i]).toBeLessThan(R.count);
  }
  // CSR:州 → 地块 与 of 一致;治所在本州里
  expect(R.cellStart[R.count]).toBe(R.cells.length);
  for (let r = 0; r < R.count; r++) {
    expect(R.cellStart[r + 1]).toBeGreaterThan(R.cellStart[r]);
    for (let t = R.cellStart[r]; t < R.cellStart[r + 1]; t++) expect(R.of[R.cells[t]]).toBe(r);
    expect(R.of[R.seat[r]]).toBe(r);
  }
  // 州内陆地连通(从治所出发只走本州地块能走遍全州)→ 没有州跨水
  const seen = new Uint8Array(n);
  for (let r = 0; r < R.count; r++) {
    const q = [R.seat[r]];
    seen[R.seat[r]] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (!seen[j] && R.of[j] === r) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    expect(q.length).toBe(R.cellStart[r + 1] - R.cellStart[r]);
  }
  // 每个岛至少一个州,州的陆块编号和它的地块一致
  const lm = landmasses(w);
  const has = new Set<number>();
  const lmOfRegion = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (lm[i] < 0) continue;
    has.add(lm[i]);
    const r = R.of[i];
    const prev = lmOfRegion.get(r);
    if (prev === undefined) lmOfRegion.set(r, lm[i]);
    else expect(prev).toBe(lm[i]);
  }
  const withRegion = new Set(lmOfRegion.values());
  for (const l of has) expect(withRegion.has(l)).toBe(true);
  // 同陆块的州,landmass 字段相同
  for (let r = 0; r < R.count; r++) {
    for (let r2 = r + 1; r2 < Math.min(R.count, r + 5); r2++) {
      if (lmOfRegion.get(r) === lmOfRegion.get(r2)) expect(R.landmass[r]).toBe(R.landmass[r2]);
    }
  }
  // 邻接对称,陆上相邻的州必须真的有相邻地块
  for (let r = 0; r < R.count; r++) {
    for (let k = R.adjStart[r]; k < R.adjStart[r + 1]; k++) {
      const o = R.adj[k];
      expect(o).not.toBe(r);
      let back = -1;
      for (let k2 = R.adjStart[o]; k2 < R.adjStart[o + 1]; k2++) if (R.adj[k2] === r) back = k2;
      expect(back).toBeGreaterThanOrEqual(0);
      expect(R.adjKind[back]).toBe(R.adjKind[k]);
      expect(Number.isFinite(R.adjLen[k])).toBe(true);
      expect(R.adjLen[k]).toBeGreaterThan(0);
      if (R.adjKind[k] === AdjKind.Strait || R.adjKind[k] === AdjKind.SeaRoute) continue;
      expect(R.landmass[o]).toBe(R.landmass[r]);
    }
  }
}

function landCount(w: World) {
  let land = 0;
  for (let i = 0; i < w.mesh.n; i++) if (w.water[i] === 0) land++;
  return land;
}

describe('文明骨架:宜居度与州', () => {
  it('小世界:每块陆地都属于一个州,州不跨水,每个岛至少一个州', () => {
    for (const seed of [4, 21]) {
      const w = generateWorld({ ...small, seed });
      checkRegions(w, generateCiv(w));
    }
  });

  it('宜居度:数值合法,冰原不可居,水面为 0', () => {
    const w = generateWorld({ ...small, seed: 5 });
    const { habitat } = generateCiv(w);
    let habitable = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const s = habitat.suitability[i];
      expect(Number.isFinite(s)).toBe(true);
      expect(Number.isFinite(habitat.capacity[i])).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(60);
      if (w.water[i] !== 0 || w.biome[i] === Biome.Ice) expect(s).toBe(0);
      if (s > 1) habitable++;
      if (w.water[i] === 0) expect(habitat.coastDist[i]).toBeGreaterThan(0);
      if (w.water[i] === 1) expect(habitat.coastDist[i]).toBeLessThan(0);
      if (w.water[i] !== 0) expect(habitat.harbor[i]).toBe(0);
    }
    expect(habitable).toBeGreaterThan(500);
  });

  it('同一个种子跑两次,所有数组逐字节相等', () => {
    const a = generateWorld({ ...small, seed: 13 });
    const b = generateWorld({ ...small, seed: 13 });
    const ca = generateCiv(a);
    const cb = generateCiv(b);
    const ta = civTransferables(ca);
    const tb = civTransferables(cb);
    expect(ta.length).toBe(tb.length);
    expect(ta.length).toBeGreaterThan(10);
    for (let i = 0; i < ta.length; i++) expect(Buffer.from(ta[i]).equals(Buffer.from(tb[i]))).toBe(true);
    expect(ca.regions.count).toBe(cb.regions.count);
    // 同一个世界再算一次也一样(没有藏在模块里的状态)
    const cc = generateCiv(a);
    expect(Buffer.from(cc.regions.of.buffer).equals(Buffer.from(ca.regions.of.buffer))).toBe(true);
  });

  it(
    '默认参数:州的不变量成立;州数 750–1100(约 900),平均每州 8–20 块陆地;精细度 1.2 万 / 8 万时州数变化不超过 ±35%',
    () => {
      const count = (cells: number) => {
        const w = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells });
        const civ = generateCiv(w);
        return { w, civ, n: civ.regions.count };
      };
      const mid = count(36000);
      checkRegions(mid.w, mid.civ);
      expect(mid.n).toBeGreaterThanOrEqual(750);
      expect(mid.n).toBeLessThanOrEqual(1100);
      const avg = landCount(mid.w) / mid.n;
      expect(avg).toBeGreaterThanOrEqual(8);
      expect(avg).toBeLessThanOrEqual(20);
      // 1.2 万块时一州只有五六块地,太小的州并进邻区更多,州数少两三成:放宽到 ±35%
      for (const cells of [12000, 80000]) {
        const { n } = count(cells);
        expect(Math.abs(n / mid.n - 1)).toBeLessThanOrEqual(0.35);
      }
    },
    60_000,
  );

  it('荒原的州比沃野的州大', () => {
    const w = generateWorld({ ...DEFAULT_PARAMS, seed: 2024 });
    const { regions: R, habitat } = generateCiv(w);
    // 按治所宜居度分成最好 / 最差两组(不可居的除外),比平均面积。
    // 20 个种子里最差一组是最好一组的 1.55–2.39 倍(GENERATOR_VERSION 7 以后 1.67–2.33,平均都约 2 倍;这个世界 1.76 倍)
    const idx = [...Array(R.count).keys()].filter((r) => habitat.suitability[R.seat[r]] > 0);
    idx.sort((a, b) => habitat.suitability[R.seat[b]] - habitat.suitability[R.seat[a]]);
    const q = Math.floor(idx.length / 4);
    const mean = (xs: number[]) => xs.reduce((s, r) => s + R.area[r], 0) / xs.length;
    expect(mean(idx.slice(-q))).toBeGreaterThan(1.5 * mean(idx.slice(0, q)));
  }, 30_000);

  it('极端参数不报错:气温 −12、陆地 12% / 60%、极干', () => {
    for (const p of [{ temperature: -12 }, { landFraction: 0.12 }, { landFraction: 0.6 }, { rainfall: 0.4 }]) {
      const w = generateWorld({ ...small, ...p, seed: 3 });
      const civ = generateCiv(w);
      checkRegions(w, civ);
      for (let r = 0; r < civ.regions.count; r++) {
        expect(Number.isFinite(civ.regions.area[r])).toBe(true);
        expect(Number.isFinite(civ.regions.capacity[r])).toBe(true);
        expect(Number.isFinite(civ.regions.elevation[r])).toBe(true);
      }
    }
  });

  it('全是冰原的星球:返回"无文明"的空 Civ,不报错', () => {
    const w = generateWorld({ ...small, temperature: -12, seed: 9 });
    const frozen: World = { ...w, biome: w.biome.map((b, i) => (w.water[i] === 0 ? Biome.Ice : b)) };
    const civ = generateCiv(frozen);
    expect(civ.viable).toBe(false);
    expect(civ.cultures).toEqual([]);
    expect(civ.settlements).toEqual([]);
    expect(civ.polities).toEqual([]);
    expect(civ.routes).toEqual([]);
    for (let i = 0; i < w.mesh.n; i++) expect(civ.habitat.suitability[i]).toBe(0);
    checkRegions(frozen, civ);
  });

  it('keyed:同样的键同样的数,键不同则不同,落在 [0,1)', () => {
    expect(keyed(1, 2, 3, 4)).toBe(keyed(1, 2, 3, 4));
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = keyed(7, i, 0, 0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      seen.add(v);
    }
    expect(seen.size).toBe(1000);
    expect(keyed(7, 1, 2)).not.toBe(keyed(7, 2, 1));
  });
});
