import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS } from '../src/gen/world';
import { rasterize } from '../src/gen/raster';
import { Biome } from '../src/gen/biomes';
import { riverGeometry } from '../src/render/common';

const small = { ...DEFAULT_PARAMS, cells: 12000 };

describe('海冰', () => {
  it('每个地块 0–1,只在海面上有,同种子结果相同', () => {
    const a = generateWorld({ ...small, seed: 21 });
    const b = generateWorld({ ...small, seed: 21 });
    expect(Array.from(a.seaIce)).toEqual(Array.from(b.seaIce));
    for (let i = 0; i < a.mesh.n; i++) {
      const v = a.seaIce[i];
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (a.water[i] !== 1) expect(v).toBe(0);
    }
  });

  it('冰缘随经度起伏,不是一条水平直线', () => {
    const w = generateWorld({ ...small, seed: 7 });
    // 北边 180 像素内,按经度切 16 条,比较每条里结冰海面的比例
    const B = 16;
    const tot = new Float32Array(B);
    const ice = new Float32Array(B);
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.water[i] !== 1 || w.mesh.y[i] > 180) continue;
      const b = Math.min(B - 1, Math.floor((w.mesh.x[i] / w.width) * B));
      tot[b]++;
      if (w.seaIce[i] >= 0.5) ice[b]++;
    }
    const f = Array.from(tot, (t, b) => ice[b] / Math.max(1, t));
    expect(Math.max(...f) - Math.min(...f)).toBeGreaterThan(0.25);
  });

  it('群落和海冰一致:地块和像素两层都是"过半算海冰"', () => {
    const w = generateWorld({ ...small, seed: 7 });
    for (let i = 0; i < w.mesh.n; i++) {
      if (w.water[i] !== 1) continue;
      expect(w.biome[i] === Biome.SeaIce).toBe(w.seaIce[i] >= 0.5);
    }
    // 画风直接读 r.ice(铺像素时算好的同一份),逐像素核对群落和它一致
    const r = rasterize(w, 0.5);
    let iced = 0;
    let bad = 0;
    for (let k = 0; k < r.w * r.h; k++) {
      const v = r.ice[k];
      if (!(v >= 0 && v <= 1)) bad++;
      if (r.water[k] !== 1) {
        if (v !== 0 || r.biome[k] === Biome.SeaIce) bad++;
        continue;
      }
      if ((r.biome[k] === Biome.SeaIce) !== v >= 0.5) bad++;
      // 有冰的地方一定在冰区里(冰间水面的颜色要用 iceConc)
      if (v > 0 && r.iceConc[k] === 0) bad++;
      if (v >= 0.5) iced++;
    }
    expect(bad).toBe(0);
    expect(iced).toBeGreaterThan(0);
    // 同一个世界再铺一次,海冰像素逐字节相同(懒算的噪声格点、查表不带进任何状态)
    const r2 = rasterize(w, 0.5);
    expect(Buffer.from(r2.ice.buffer).equals(Buffer.from(r.ice.buffer))).toBe(true);
    expect(Buffer.from(r2.iceConc.buffer).equals(Buffer.from(r.iceConc.buffer))).toBe(true);
    expect(Buffer.from(r2.iceTone.buffer).equals(Buffer.from(r.iceTone.buffer))).toBe(true);
  });

  it('极冷世界冰多但不封死全球海洋,极热世界边缘仍有漂浮冰', () => {
    const frac = (temperature: number) => {
      const w = generateWorld({ ...small, seed: 3, temperature });
      let sea = 0;
      let ice = 0;
      let any = 0;
      for (let i = 0; i < w.mesh.n; i++) {
        if (w.water[i] !== 1) continue;
        sea++;
        if (w.seaIce[i] >= 0.5) ice++;
        if (w.seaIce[i] > 0.05) any++;
      }
      return { ice: ice / sea, any: any / sea };
    };
    const cold = frac(-12);
    const mid = frac(0);
    const hot = frac(12);
    expect(cold.ice).toBeLessThan(0.7);
    expect(cold.ice).toBeGreaterThan(mid.ice);
    expect(mid.ice).toBeGreaterThan(hot.ice);
    expect(hot.any).toBeGreaterThan(0);
  });
});

describe('河网画法', () => {
  it('支流终点正好落在它汇入的那条河上(汇合处不断开)', () => {
    const w = generateWorld({ ...small, seed: 8 });
    const { n, x, y } = w.mesh;
    const lines = riverGeometry(w.rivers, w.riverThreshold, { color: '', minW: 0.5, maxW: 6, fluxRef: 1000 }, 1.7, 0.65);
    let joins = 0;
    for (const d of lines) {
      const m = d.x.length;
      for (let i = 0; i < m; i++) expect(Number.isFinite(d.x[i]) && Number.isFinite(d.y[i]) && d.w[i] > 0).toBe(true);
      const ex = d.x[m - 1];
      const ey = d.y[m - 1];
      let onOther = false;
      for (const o of lines) {
        if (o === d) continue;
        for (let i = 0; i < o.x.length && !onOther; i++) {
          if (Math.abs(o.x[i] - ex) < 1e-3 && Math.abs(o.y[i] - ey) < 1e-3) onOther = true;
        }
      }
      if (onOther) joins++;
      // 入海 / 入湖的河口伸到水面地块中心;停在陆地上的终点必须接在另一条河上
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dd = (x[i] - ex) ** 2 + (y[i] - ey) ** 2;
        if (dd < bd) (bd = dd), (best = i);
      }
      if (w.water[best] === 0) expect(onOther).toBe(true);
    }
    expect(joins).toBeGreaterThan(5);
  });
});
