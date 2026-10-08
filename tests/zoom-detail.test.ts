/**
 * 放大后的细节(写实风):山坡上的沟和山脊(gen/gully.ts)、放大后按屏幕现算的一块(gen/rasterWindow.ts)、小溪(gen/creeks.ts)。
 *   - 沟和山脊只管写实风的明暗:分段算和一次算完一样;海拔、水陆不变;起伏是连着的(跨过噪声格子的边不断开)
 *   - 现算的块:相邻两块接得上(多铺一圈裁掉以后,和一次铺一大块逐像素一样)、跨 180° 经线和挪一整圈一样、水陆和整张图大体一致、没有 NaN
 *   - 小溪:都比成河门槛小、不走河上的地块,同一个世界结果一样
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { gullyHeights, rasterize, rasterizeDeferred, type Raster } from '../src/gen/raster';
import { WINDOW_PAD, rasterizeWindow, zoomSource, type ZoomSource } from '../src/gen/rasterWindow';
import { CREEK_FRAC, creeksOf } from '../src/gen/creeks';
import { Gullies } from '../src/gen/gully';
import { macroGrids, realisticWindowPixels, type MacroGrids } from '../src/render/realistic';

let world: World;
let whole: Raster;
let src: ZoomSource;
let grids: MacroGrids;
beforeAll(() => {
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
  whole = rasterize(world, 1);
  src = zoomSource(world, whole);
  grids = macroGrids(whole);
});

/** 找一块陆地多、有山的地方(S 倍主图上的左上角,对齐到 64 像素) */
function landSpot(S: number): [number, number] {
  let best = [0, 0, -1];
  for (let y = 200; y < whole.h - 264; y += 32)
    for (let x = 0; x < whole.w - 64; x += 32) {
      let land = 0;
      let high = 0;
      for (let yy = y; yy < y + 64; yy += 4)
        for (let xx = x; xx < x + 64; xx += 4) {
          const k = yy * whole.w + xx;
          if (whole.water[k] === 0) land++;
          if (whole.elev[k] > 800) high++;
        }
      if (land > 200 && high > best[2]) best = [x, y, high];
    }
  return [Math.round((best[0] * S) / 64) * 64, Math.round((best[1] * S) / 64) * 64];
}

describe('沟和山脊(整张主图)', () => {
  it('分几段算和一次算完一样;只叠在陆地上,海拔、水陆不变(不要沟壑时也一样)', () => {
    const { raster, job } = rasterizeDeferred(world, 1);
    // 中间一段:一次算完 vs 拆成两段
    const lo = Math.floor(job.n * 0.4);
    const hi = Math.floor(job.n * 0.5);
    const mid = Math.floor((lo + hi) / 2) + 7;
    const all = gullyHeights(job, lo, hi);
    const parts = [gullyHeights(job, lo, mid), gullyHeights(job, mid, hi)];
    expect(parts[0].length + parts[1].length).toBe(all.length);
    let diff = 0;
    for (let i = 0; i < all.length; i++) if ((i < parts[0].length ? parts[0][i] : parts[1][i - parts[0].length]) !== all[i]) diff++;
    expect(diff).toBe(0);
    // 铺像素先不算沟壑、或者干脆不要沟壑(导出高度图那样):海拔、水陆和算完的一样(沟壑只管明暗)
    const plain = rasterize(world, 1, false);
    expect(plain.gully).toBeUndefined();
    let changed = 0;
    for (let k = 0; k < whole.elev.length; k++) {
      if (raster.elev[k] !== whole.elev[k] || raster.water[k] !== whole.water[k]) changed++;
      if (plain.elev[k] !== whole.elev[k] || plain.water[k] !== whole.water[k]) changed++;
    }
    expect(changed).toBe(0);
    const g = whole.gully!;
    let bad = 0;
    let onWater = 0;
    let onLand = 0;
    let strong = 0;
    for (let k = 0; k < g.length; k++) {
      if (!Number.isFinite(g[k])) bad++;
      if (g[k] !== 0) {
        if (whole.water[k] === 1) onWater++;
        onLand++;
        if (Math.abs(g[k]) > 30) strong++;
      }
    }
    expect(bad).toBe(0);
    expect(onWater).toBe(0);
    // 山地上看得出来
    expect(onLand).toBeGreaterThan(1000);
    expect(strong).toBeGreaterThan(100);
  });

  it('起伏是连着的:跨过噪声格子的边不突然跳', () => {
    const gl = new Gullies(12345);
    const R = 2048 / (2 * Math.PI);
    // 球面上斜着走的一条线(t = 走了多少世界单位),坡度固定,放大 4 倍时的细度(叠 4 层)
    const f = (t: number) => {
      const lon = t / R;
      const lat = 0.3 + (t * 0.37) / R;
      const cl = Math.cos(lat);
      const sl = Math.sin(lat);
      const cL = Math.cos(lon);
      const sL = Math.sin(lon);
      return gl.height(cl * cL * R, cl * sL * R, sl * R, -sL, cL, -sl * cL, -sl * sL, cl, 10, 5, 100, 4);
    };
    // 先粗走找最陡的几步,再把每一步切成 1000 小步:连着的话小步也跟着小;断开的话总有一小步和整步差不多大
    const step = 0.005;
    const steps: { t: number; d: number }[] = [];
    for (let i = 1; i < 20000; i++) steps.push({ t: i * step, d: Math.abs(f(i * step) - f((i - 1) * step)) });
    steps.sort((a, b) => b.d - a.d);
    let worst = 0;
    for (const { t, d } of steps.slice(0, 8)) {
      let m = 0;
      for (let q = 0; q < 1000; q++) m = Math.max(m, Math.abs(f(t - step + ((q + 1) * step) / 1000) - f(t - step + (q * step) / 1000)));
      worst = Math.max(worst, m / d);
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe('放大后现算的一块', () => {
  it('相邻两块裁掉多铺的一圈以后,和一次铺一大块逐像素一样(海拔、水陆、颜色)', () => {
    const S = 4;
    const [x0, y0] = landSpot(S);
    const T = 64;
    const P = WINDOW_PAD;
    const big = rasterizeWindow(src, S, x0 - P, y0 - P, 2 * T + 2 * P, T + 2 * P);
    const bigPx = realisticWindowPixels(big, grids);
    let diff = 0;
    for (const tx of [0, 1]) {
      const r = rasterizeWindow(src, S, x0 + tx * T - P, y0 - P, T + 2 * P, T + 2 * P);
      const px = realisticWindowPixels(r, grids);
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const a = (y + P) * r.w + x + P;
          const b = (y + P) * big.w + tx * T + x + P;
          if (r.elev[a] !== big.elev[b] || r.water[a] !== big.water[b]) diff++;
          for (let c = 0; c < 3; c++) if (px[a * 4 + c] !== bigPx[b * 4 + c]) diff++;
        }
    }
    expect(diff).toBe(0);
  });

  it('跨 180° 经线的一块和挪一整圈的那一块一样;没有 NaN', () => {
    const S = 2;
    const W = world.width * S;
    const y0 = Math.round(world.height * S * 0.45);
    const a = rasterizeWindow(src, S, -40, y0, 80, 40);
    const b = rasterizeWindow(src, S, W - 40, y0, 80, 40);
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev));
    let bad = 0;
    for (const f of [a.elev, a.temp, a.precip, a.ice]) for (const v of f) if (!Number.isFinite(v)) bad++;
    expect(bad).toBe(0);
  });

  it('水陆和整张图大体一致,山上比整张图拉大的样子起伏多', () => {
    const S = 4;
    const [x0, y0] = landSpot(S);
    const n = 192;
    const r = rasterizeWindow(src, S, x0, y0, n, n);
    let same = 0;
    let rough = 0;
    let roughWhole = 0;
    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++) {
        const k = y * n + x;
        const wx = Math.floor((x0 + x + 0.5) / S);
        const wy = Math.floor((y0 + y + 0.5) / S);
        const j = wy * whole.w + wx;
        if ((whole.water[j] === 0) === (r.water[k] === 0)) same++;
        // 相邻像素的高差(现算的)和整张图拉大以后相邻像素的高差(约等于整张图的高差 / S)
        if (r.water[k] === 0) {
          rough += Math.abs(r.elev[k + 1] - r.elev[k]);
          roughWhole += Math.abs(whole.elev[j + 1] - whole.elev[j]) / S;
        }
      }
    expect(same / ((n - 2) * (n - 2))).toBeGreaterThan(0.93);
    expect(rough).toBeGreaterThan(1.5 * roughWhole);
  });
});

describe('小溪', () => {
  it('都比成河门槛小、不走河上的地块(只在最后一点接上河),同一个世界结果一样', () => {
    const cr = creeksOf(world);
    expect(cr.length).toBeGreaterThan(50);
    expect(creeksOf(world)).toBe(cr);
    const onRiver = new Set<number>();
    for (const r of world.rivers) for (const c of r.cells) onRiver.add(c);
    const thr = world.riverThreshold;
    for (const c of cr) {
      expect(c.pts.length / 3).toBe(c.cells.length);
      for (let i = 0; i < c.cells.length; i++) {
        const f = c.pts[i * 3 + 2];
        expect(f).toBeLessThan(thr);
        expect(f).toBeGreaterThanOrEqual(thr * CREEK_FRAC * 0.999);
        if (i < c.cells.length - 1) expect(onRiver.has(c.cells[i])).toBe(false);
      }
    }
    const again = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
    const cr2 = creeksOf(again);
    expect(cr2.length).toBe(cr.length);
    expect(Array.from(cr2[0].pts)).toEqual(Array.from(cr[0].pts));
  });
});
