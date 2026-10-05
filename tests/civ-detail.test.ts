import { describe, expect, it } from 'vitest';
import { generateWorld, DEFAULT_PARAMS, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv, type Civ } from '../src/gen/civ';
import { washDetail, washFields, washPixels } from '../src/render/civ/territory';
import { detailPen } from '../src/render/civ/detail';
import { detailGrid, KEEP, landCover, nearestSide, segCell, segIndex } from '../src/render/civ/zoomGrid';
import { CIV_SHOW_OFF, type CivDrawParams } from '../src/render/civ/overlay';
import type { SidedLine } from '../src/render/civ/borders';
import { mapProj, projectWorld } from '../src/render/projection';

/**
 * 放大后的文明细节层(render/civ/detail.ts):按工作网格逐格上色。
 * 网格中心的世界坐标要对(等距圆柱、弯边投影),色块的边按界线、比像素还细,整张图上的归属不变
 */
const small = { ...DEFAULT_PARAMS, cells: 12000, seed: 7 };
let cached: { w: World; r: Raster; civ: Civ } | null = null;
const setup = () => {
  if (!cached) {
    const w = generateWorld(small);
    cached = { w, r: rasterize(w, 1), civ: generateCiv(w) };
  }
  return cached;
};
const polityParams = (style: 'fantasy' | 'realistic' = 'realistic'): CivDrawParams => {
  const { w, r, civ } = setup();
  return { world: w, raster: r, civ, style, year: civ.endYear, show: { ...CIV_SHOW_OFF, polities: true } };
};

describe('工作网格', () => {
  it('等距圆柱:格子中心 = 画布像素中心换回世界坐标', () => {
    const v = { s: 4, ox: -100, oy: -50, mp: null };
    const g = detailGrid(v, 400, 200, 2, 2048, 1024);
    expect(g.gw).toBe(200);
    expect(g.gh).toBe(100);
    for (const [i, j] of [
      [0, 0],
      [57, 33],
      [199, 99],
    ]) {
      expect(g.wy[j]).toBeCloseTo(((j + 0.5) * 2 + 50) / 4, 9);
      expect(g.a[j] + g.b[j] * i).toBeCloseTo(((i + 0.5) * 2 + 100) / 4, 9);
      expect(g.i0[j]).toBe(0);
      expect(g.i1[j]).toBe(200);
    }
  });

  it('弯边投影:每一格中心的世界坐标投回地图平面,正好落在这一格中心;外轮廓外的格子不算', () => {
    for (const [id, lon0] of [
      ['robinson', 30],
      ['mollweide', -150],
      ['mercator', 179],
    ] as const) {
      const mp = mapProj(id, lon0, 2048, 1024);
      const v = { s: 0.5, ox: 0, oy: 0, mp };
      const g = detailGrid(v, 1024, 512, 1, 2048, 1024);
      let n = 0;
      for (let j = 0; j < g.gh; j += 7) {
        for (let i = g.i0[j]; i < g.i1[j]; i += 13) {
          const [mx, my] = projectWorld(mp, g.a[j] + g.b[j] * i, g.wy[j]);
          expect(mx * v.s).toBeCloseTo(i + 0.5, 3);
          expect(my * v.s).toBeCloseTo(j + 0.5, 3);
          n++;
        }
      }
      expect(n).toBeGreaterThan(500);
      // 四个角在外轮廓外(罗宾森、摩尔威德)
      if (id !== 'mercator') expect(g.i1[0] - g.i0[0]).toBeLessThan(g.gw / 2);
    }
  });
});

describe('界线的空间索引', () => {
  // 一条从 (10, 10) 到 (30, 10) 的线,左边归 1、右边归 2,右端是海岸断头
  const line: SidedLine = { pts: Float32Array.from([10, 10, 20, 10, 30, 10]), closed: false, left: 1, right: 2, end0: false, end1: true };
  const ix = segIndex([line], 2, [0, 0, 40, 20], 0)!;
  const side = new Int32Array(1);
  const at = (x: number, y: number) => {
    const c = segCell(ix, x, y);
    const d = c >= 0 ? nearestSide(ix, c, x, y, side) : Infinity;
    return { d, s: side[0] };
  };
  it('按在线的哪一侧判归属、量出离线多远', () => {
    expect(at(15, 10.5)).toEqual({ d: 0.5, s: 1 });
    expect(at(25, 9.25)).toEqual({ d: 0.75, s: 2 });
    expect(at(20, 13).d).toBe(Infinity);
  });
  it('海岸断头外面保持原样', () => {
    expect(at(31, 10).s).toBe(KEEP);
    expect(at(9.5, 10.2).s).toBe(1);
  });
});

describe('海岸抗锯齿', () => {
  // 2×2 的小图:左边陆地(海拔 300)、右边海(−100)
  const r = { w: 2, h: 2, water: Uint8Array.from([0, 1, 0, 1]), elev: Float32Array.from([300, -100, 300, -100]) } as unknown as Raster;
  it('写实:岸线在两个像素中心的正中;手绘:按海拔过零处', () => {
    expect(landCover(r, 0, 1, 2, 3, 0.45, 0.5, 0.01, false)).toBe(1);
    expect(landCover(r, 0, 1, 2, 3, 0.55, 0.5, 0.01, false)).toBe(0);
    // 海拔过零在 300 / 400 = 0.75 处
    expect(landCover(r, 0, 1, 2, 3, 0.7, 0.5, 0.01, true)).toBe(1);
    expect(landCover(r, 0, 1, 2, 3, 0.8, 0.5, 0.01, true)).toBe(0);
    // 一格宽的过渡:正好在岸线上 = 一半
    expect(landCover(r, 0, 1, 2, 3, 0.75, 0.5, 0.2, true)).toBeCloseTo(0.5, 6);
  });
});

describe('细节层的色块', () => {
  it('网格和全分辨率像素一一对应时,哪里上色、上什么颜色和整张图的色块一样', () => {
    const p = polityParams();
    const { w, r } = setup();
    const fl = washFields(p, 1)!;
    const full = new Uint8ClampedArray(r.w * r.h * 4);
    washPixels({ w: r.w, h: r.h, f: 1, pixRegion: fl.pix, owner: fl.owner, colors: fl.colors, fade: fl.fade, style: 'realistic', label: fl.label, polity: true, wrap: true, edge: fl.edge }, full);
    const g = detailGrid({ s: r.scale, ox: 0, oy: 0, mp: null }, r.w, r.h, 1, w.width, w.height);
    const segs = segIndex(fl.lines, 1.05 / r.scale, g.box, w.width);
    const det = new Uint8ClampedArray(r.w * r.h * 4);
    washDetail(det, g, r, w.mesh, fl, 'realistic', segs, null, 1);
    let land = 0;
    let differ = 0;
    for (let k = 0; k < r.w * r.h; k++) {
      const a = full[k * 4 + 3] > 0;
      const b = det[k * 4 + 3] > 0;
      if (!a && !b) continue;
      land++;
      if (a !== b || full[k * 4] !== det[k * 4] || full[k * 4 + 1] !== det[k * 4 + 1] || full[k * 4 + 2] !== det[k * 4 + 2]) differ++;
    }
    expect(land).toBeGreaterThan(r.w * r.h * 0.1);
    // 只有海岸(抗锯齿后少了半个像素)、界线上(按线判比按像素中心判细)差一点
    expect(differ / land).toBeLessThan(0.02);
  });

  it('放大 8 倍:色块的边就是界线 —— 线两侧各 0.15 个世界单位(1 个多屏幕像素)就是两边的颜色', () => {
    const p = polityParams('fantasy');
    const { w, r } = setup();
    const fl = washFields(p, 1)!;
    const lines = fl.lines.filter((l) => l.left >= 0 && l.right >= 0 && l.pts.length >= 24);
    expect(lines.length).toBeGreaterThan(3);
    let checked = 0;
    let wrong = 0;
    for (const [l, m] of lines.slice(0, 30).flatMap((l) => [0.25, 0.5, 0.75].map((t) => [l, Math.floor((l.pts.length / 2 - 1) * t)] as const))) {
      // 线上的一点、这一段的法线
      const x = l.pts[m * 2];
      const y = l.pts[m * 2 + 1];
      const dx = l.pts[m * 2 + 2] - x;
      const dy = l.pts[m * 2 + 3] - y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      // 以这一点为中心、8 倍放大的一小块网格(每格 1/8 世界单位)
      const s = 8 * r.scale;
      const v = { s, ox: -(x - 4) * s, oy: -(y - 4) * s, mp: null };
      const g = detailGrid(v, 64, 64, 1, w.width, w.height);
      const segs = segIndex(fl.lines, 1.25 / r.scale, g.box, w.width);
      const out = new Uint8ClampedArray(64 * 64 * 4);
      washDetail(out, g, r, w.mesh, fl, 'fantasy', segs, null, detailPen(8, 'fantasy'));
      for (const [sgn, want] of [
        [1, l.left],
        [-1, l.right],
      ]) {
        const px = x + nx * 0.15 * sgn;
        const py = y + ny * 0.15 * sgn;
        const i = Math.floor((px - (x - 4)) * 8);
        const j = Math.floor((py - (y - 4)) * 8);
        const o = (j * 64 + i) * 4;
        if (!out[o + 3]) continue; // 落在水边
        checked++;
        // 水彩的颜色:水痕不画在国土上,颜色就是这一国的
        const c = fl.colors.subarray(want * 3, want * 3 + 3);
        if (out[o] !== c[0] || out[o + 1] !== c[1] || out[o + 2] !== c[2]) wrong++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(wrong).toBe(0);
  });
});

describe('线宽', () => {
  it('缩放 1.35 倍以下和整张图一样;放大后屏幕上的线宽(pen × 倍数)变粗,但比地图放大得慢', () => {
    for (const style of ['fantasy', 'realistic'] as const) {
      expect(detailPen(1, style)).toBe(1);
      expect(detailPen(1.3, style)).toBe(1);
      let prev = 1.35;
      for (const k of [2, 4, 8, 12]) {
        const screen = detailPen(k, style) * k;
        expect(screen).toBeGreaterThan(prev);
        expect(detailPen(k, style)).toBeLessThan(1);
        prev = screen;
      }
    }
    // 写实风收得比手绘快
    expect(detailPen(12, 'realistic')).toBeLessThan(detailPen(12, 'fantasy'));
  });
});
