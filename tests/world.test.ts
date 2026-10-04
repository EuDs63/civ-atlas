import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS } from '../src/gen/world';
import { rasterize } from '../src/gen/raster';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

describe('世界生成', () => {
  const w7 = generateWorld({ ...small, seed: 7 });
  const latOf = (w: typeof w7, i: number) => 90 - (180 * w.mesh.y[i]) / w.mesh.height;

  it('同一个种子两次生成逐字节相同', () => {
    const b = generateWorld({ ...small, seed: 7 });
    expect(Array.from(b.mesh.xyz)).toEqual(Array.from(w7.mesh.xyz));
    expect(Array.from(b.elevation)).toEqual(Array.from(w7.elevation));
    expect(Array.from(b.biome)).toEqual(Array.from(w7.biome));
    expect(Array.from(b.seaIce)).toEqual(Array.from(w7.seaIce));
    expect(b.rivers.map((r) => Array.from(r.cells))).toEqual(w7.rivers.map((r) => Array.from(r.cells)));
  });

  it('不同种子生成不同的世界', () => {
    const a = generateWorld({ ...small, seed: 1 });
    const b = generateWorld({ ...small, seed: 2 });
    expect(Array.from(a.tect.land)).not.toEqual(Array.from(b.tect.land));
  });

  it('整颗球:两极都有地块,纬度到 ±90°;陆地比例接近设定值', () => {
    let top = 0;
    let bottom = 0;
    for (let i = 0; i < w7.mesh.n; i++) {
      top = Math.max(top, latOf(w7, i));
      bottom = Math.min(bottom, latOf(w7, i));
    }
    expect(top).toBeGreaterThan(88);
    expect(bottom).toBeLessThan(-88);
    for (const lf of [0.2, 0.33, 0.5]) {
      const w = generateWorld({ ...small, seed: 5, landFraction: lf });
      let land = 0;
      for (let i = 0; i < w.mesh.n; i++) if (w.tect.land[i]) land++;
      expect(Math.abs(land / w.mesh.n - lf)).toBeLessThan(0.03);
    }
  });

  it('海拔、气温、降水在合理范围内;海冰只在高纬度,两极的海面结冰', () => {
    for (const seed of [7, 2024, 3]) {
      const w = seed === 7 ? w7 : generateWorld({ ...small, seed });
      let polarSea = 0;
      let polarIce = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        expect(Number.isFinite(w.elevation[i])).toBe(true);
        // 海沟最深约 -10500 米(地球上最深的马里亚纳海沟约 -11000 米)
        expect(w.elevation[i]).toBeGreaterThan(-11000);
        expect(w.elevation[i]).toBeLessThan(11000);
        expect(w.temperature[i]).toBeGreaterThan(-60);
        expect(w.temperature[i]).toBeLessThan(45);
        expect(w.precipitation[i]).toBeGreaterThanOrEqual(0);
        const lat = Math.abs(latOf(w, i));
        if (w.seaIce[i] > 0.5) expect(lat, `seed ${seed} 地块 ${i} 的海冰`).toBeGreaterThan(45);
        if (w.water[i] === 1 && lat > 80) {
          polarSea++;
          if (w.seaIce[i] > 0.5) polarIce++;
        }
      }
      if (polarSea > 20) expect(polarIce / polarSea).toBeGreaterThan(0.9);
    }
  });

  it('河道存地块链:和折线的点一一对应,顺着水流相邻,终点流进海、湖或另一条河', () => {
    const { mesh, water, rivers, flux, riverThreshold } = w7;
    const { adjStart, adj } = mesh;
    const adjacent = (a: number, b: number) => {
      for (let k = adjStart[a]; k < adjStart[a + 1]; k++) if (adj[k] === b) return true;
      return false;
    };
    expect(rivers.length).toBeGreaterThan(10);
    for (const r of rivers) {
      const c = r.cells;
      expect(c.length).toBe(r.pts.length / 3);
      for (let k = 0; k + 1 < c.length; k++) expect(adjacent(c[k], c[k + 1])).toBe(true);
      for (let k = 0; k < c.length; k++) {
        if (water[c[k]] !== 0) continue;
        expect(r.pts[3 * k]).toBe(mesh.x[c[k]]);
        expect(r.pts[3 * k + 1]).toBe(mesh.y[c[k]]);
      }
      const end = c[c.length - 1];
      expect(water[end] !== 0 || flux[end] >= riverThreshold).toBe(true);
    }
  });

  it('陆地高度分布接近地球:大半是平原 / 丘陵,约七成低于 1000 米,高山只占一小部分', () => {
    for (const seed of [7, 2024]) {
      const w = seed === 7 ? w7 : generateWorld({ ...small, seed });
      const el: number[] = [];
      for (let i = 0; i < w.mesh.n; i++) if (w.water[i] === 0) el.push(w.elevation[i]);
      const share = (lo: number, hi: number) => el.filter((e) => e >= lo && e < hi).length / el.length;
      const below1000 = share(-1e9, 1000);
      expect(below1000, `seed ${seed} 低于 1000 米`).toBeGreaterThan(0.6);
      expect(below1000, `seed ${seed} 低于 1000 米`).toBeLessThan(0.85);
      // 低平原(< 500 米)仍是最多的一类;3000 米以上的高山不到一成
      expect(share(-1e9, 500), `seed ${seed} 低于 500 米`).toBeGreaterThan(0.4);
      expect(share(3000, 1e9), `seed ${seed} 3000 米以上`).toBeLessThan(0.1);
    }
  });

  it('像素图尺寸正确、东西相连且没有非法值', () => {
    const w = generateWorld({ ...small, seed: 4 });
    const r = rasterize(w, 0.5);
    expect(r.w).toBe(1024);
    expect(r.h).toBe(512);
    expect(r.wrap).toBe(true);
    for (let k = 0; k < r.elev.length; k += 97) expect(Number.isFinite(r.elev[k])).toBe(true);
  });
});
