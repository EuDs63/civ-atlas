/**
 * 写实风放大后的岸线(细节层):陆地范围按方格拼成的路径(addLandCells)、岸线位置(shoreT)、
 * 岸线两侧各一份的像素层(shoreSides)。(真正的画面在 scripts/snap.ts 放大截图里看)
 */
import { describe, expect, it } from 'vitest';
import type { Raster } from '../src/gen/raster';
import { addLandCells, shoreSides, shoreT, type CellMap, type PathSink } from '../src/render/realistic';

/** 记下每一块(从 moveTo 起到下一个 moveTo 之前)的点 */
function recorder(): PathSink & { polys: number[][] } {
  const polys: number[][] = [];
  return {
    polys,
    moveTo: (x, y) => void polys.push([x, y]),
    lineTo: (x, y) => void polys[polys.length - 1].push(x, y),
  };
}

/** 一块的有向面积(画布坐标,y 朝下:顺时针为正) */
function area(p: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    s += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return s / 2;
}

/** 点 (x, y) 的环绕数(所有块加起来;非零 = 在陆地里) */
function winding(polys: number[][], x: number, y: number): number {
  let n = 0;
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      const [ax, ay, bx, by] = [p[i], p[i + 1], p[j], p[j + 1]];
      if (ay <= y && by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) n++;
      else if (ay > y && by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) n--;
    }
  }
  return n;
}

function raster(w: number, h: number, water: ArrayLike<number>, elev: ArrayLike<number>): Raster {
  return { w, h, scale: 1, water: Uint8Array.from(water), elev: Float32Array.from(elev) } as unknown as Raster;
}

/** 等距圆柱:1 个像素 = 10 个画布像素,画布原点 = 世界原点;第 i 列像素中心在画布 x = 5 + 10 i */
const flat = (r: Raster, i0: number, i1: number): CellMap => ({
  rows: [-1, r.h - 1],
  cols: () => [i0, i1],
  at: (wy, out) => {
    out[0] = 5;
    out[1] = 10;
    out[2] = wy * 10;
  },
});

/** 固定的伪随机数 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 有海、陆地、湖的小图(海拔和水陆一致:陆地 ≥ 0、海 < 0) */
function randomRaster(w: number, h: number, seed: number): Raster {
  const rand = rng(seed);
  const water: number[] = [];
  const elev: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.sin(x * 0.9 + seed) + Math.cos(y * 1.3 - seed * 0.5) + 0.8 * (rand() - 0.5);
      const kind = v > 0.2 ? (rand() < 0.15 ? 2 : 0) : 1;
      water.push(kind);
      elev.push(kind === 1 ? -1 - 600 * rand() : 600 * rand());
    }
  }
  return raster(w, h, water, elev);
}

describe('写实风放大后的陆地范围', () => {
  it('全是陆地:每行一块长方形,左右一整圈,上下各盖到图边', () => {
    const r = raster(4, 3, new Array(12).fill(0), new Array(12).fill(100));
    const rec = recorder();
    addLandCells(rec, r, flat(r, 0, 3));
    expect(rec.polys.length).toBe(4);
    for (const p of rec.polys) expect(area(p)).toBeCloseTo(400, 6);
    // 第 −1 行从图的上边(世界 y = 0 往上半格)起,最后一行到下边往下半格
    expect(Math.min(...rec.polys.flatMap((p) => p.filter((_, i) => i % 2)))).toBeCloseTo(-5, 6);
    expect(Math.max(...rec.polys.flatMap((p) => p.filter((_, i) => i % 2)))).toBeCloseTo(35, 6);
  });

  it('海里一个陆地像素:四周的交点在海拔过零处,围成一个小菱形', () => {
    // 中间海拔 100、四周 −300:过零在离中心 100 / 400 = 1/4 像素处
    const e = new Array(9).fill(-300);
    e[4] = 100;
    const wt = new Array(9).fill(1);
    wt[4] = 0;
    const r = raster(3, 3, wt, e);
    const rec = recorder();
    addLandCells(rec, r, flat(r, 0, 1));
    const total = rec.polys.reduce((s, p) => s + area(p), 0);
    expect(total).toBeCloseTo(2 * 2.5 * 2.5, 6);
    expect(rec.polys.every((p) => area(p) > 0)).toBe(true);
    expect(winding(rec.polys, 15, 15)).toBe(1);
    expect(winding(rec.polys, 15 + 2.4, 15)).toBe(1);
    expect(winding(rec.polys, 15 + 2.6, 15)).toBe(0);
    expect(winding(rec.polys, 15 + 1.3, 15 + 1.3)).toBe(0);
  });

  it('像素中心:陆地的在里面、海和湖的在外面;小块转向一致,哪一点都最多盖一层', () => {
    for (const seed of [1, 2, 3]) {
      const r = randomRaster(24, 16, seed);
      const rec = recorder();
      addLandCells(rec, r, flat(r, -1, 24));
      expect(rec.polys.every((p) => area(p) > 0)).toBe(true);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const land = r.water[y * r.w + x] === 0 ? 1 : 0;
          // 偏开一点点(正好在像素中心是方格的角)
          expect(winding(rec.polys, 5 + 10 * x + 0.04, 5 + 10 * y + 0.03)).toBe(land);
        }
      }
      const rand = rng(seed + 100);
      for (let n = 0; n < 2000; n++) {
        const wn = winding(rec.polys, 5 + 10 * (-0.4 + 24 * rand()), -4 + 10 * (r.h + 0.8) * rand());
        expect(wn === 0 || wn === 1).toBe(true);
      }
    }
  });

  it('东西相连:伸进右边那一份的方格,和左边对应的方格一样(挪一整圈)', () => {
    const r = randomRaster(24, 16, 5);
    const a = recorder();
    addLandCells(a, r, flat(r, -3, 2));
    const b = recorder();
    addLandCells(b, r, flat(r, 21, 26));
    expect(b.polys.length).toBe(a.polys.length);
    for (let j = 0; j < a.polys.length; j++) {
      expect(b.polys[j].length).toBe(a.polys[j].length);
      for (let i = 0; i < a.polys[j].length; i++) expect(b.polys[j][i]).toBeCloseTo(a.polys[j][i] + (i % 2 ? 0 : 240), 6);
    }
  });

  it('岸线位置:海岸按海拔过零处,两个方向量出来加起来是 1;湖岸在两个像素中心之间', () => {
    const r = raster(4, 1, [0, 1, 0, 2], [300, -100, 50, 20]);
    expect(shoreT(r, 0, 1)).toBeCloseTo(0.75, 6);
    expect(shoreT(r, 1, 0)).toBeCloseTo(0.25, 6);
    expect(shoreT(r, 1, 2)).toBeCloseTo(1 - 50 / 150, 6);
    const t = shoreT(r, 2, 3);
    expect(t).toBeGreaterThanOrEqual(0.1);
    expect(t).toBeLessThanOrEqual(0.9);
    // 贴着岸的陆地海拔几乎是 0:交点不会正好压在像素中心上
    const flatShore = raster(2, 1, [0, 1], [0, -500]);
    expect(shoreT(flatShore, 0, 1)).toBeCloseTo(0.02, 6);
  });
});

describe('写实风岸线两侧的像素层', () => {
  it('对岸两圈像素换成本侧的颜色,远处和本侧的像素不动', () => {
    // 10 × 4:左边 5 列陆地(红),右边 5 列海(蓝)
    const w = 10;
    const h = 4;
    const water: number[] = [];
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const land = x < 5;
        water.push(land ? 0 : 1);
        px.set(land ? [200, 0, 0, 255] : [0, 0, 200, 255], (y * w + x) * 4);
      }
    }
    // 东西相连:第 9 列(海)挨着第 0 列(陆地),那边也是岸
    const r = { w, h, water: Uint8Array.from(water) };
    const { land, water: sea } = shoreSides(px, r);
    const at = (a: Uint8ClampedArray, x: number, y: number) => Array.from(a.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
    for (let y = 0; y < h; y++) {
      // 陆地那一份:岸外两列海变成红的,再往外、本来的陆地不动
      for (const x of [5, 6, 9, 8]) expect(at(land, x, y)).toEqual([200, 0, 0, 255]);
      expect(at(land, 7, y)).toEqual([0, 0, 200, 255]);
      for (const x of [0, 4]) expect(at(land, x, y)).toEqual([200, 0, 0, 255]);
      // 水那一份:岸里两列陆地变成蓝的(两边的岸都算)
      for (const x of [4, 3, 0, 1]) expect(at(sea, x, y)).toEqual([0, 0, 200, 255]);
      expect(at(sea, 2, y)).toEqual([200, 0, 0, 255]);
      for (const x of [5, 9]) expect(at(sea, x, y)).toEqual([0, 0, 200, 255]);
    }
    // 输入不动
    expect(at(px, 5, 0)).toEqual([0, 0, 200, 255]);
  });
});
