/**
 * 主图(等距圆柱,东西相连):铺像素没有漏洞、没有 NaN,第 0 列和最后一列接得上,
 * 画风(写实 / 手绘 / 数据图层)左右接缝处的颜色和相邻两列一样连续。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, sphereCover, sphereGrid, type Raster } from '../src/gen/raster';
import { buildHistoryFrames } from '../src/gen/history';
import { realisticBase } from '../src/render/realistic';
import { fantasyBase } from '../src/render/fantasy';
import { renderLayer } from '../src/render/layers';
import { distanceTo, hillshade } from '../src/render/common';
import { mergeChains, traceChains } from '../src/render/civ/borders';
import { traceBoundaries } from '../src/render/civ/lines';

/**
 * Node 里没有画布:像素层只用 createImageData / putImageData,给一个只存像素的假画布就能跑
 * (矢量层要真正的画布,这里不测)
 */
class FakeCanvas {
  img: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    const cv = this;
    return {
      canvas: cv,
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }) => {
        cv.img = img;
      },
    };
  }
}
beforeAll(() => {
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas ??= FakeCanvas;
});

const sphere = (seed: number, cells = 12000) => generateWorld({ ...DEFAULT_PARAMS, seed, cells });

/**
 * 接缝两边(最后一列 → 第 0 列)的差,和接缝附近相邻两列的差(左右各两对:w−3|w−2、w−2|w−1、0|1、1|2)比。
 * 同一片地方比才公平(接缝正好落在海岸上时,附近本来就起伏大)。
 * v(x, y) = 第 y 行第 x 列的量(可以是几个通道,差按各通道绝对值之和);按 B 行一组取列平均再比,压掉逐像素的噪点
 */
function seamStats(w: number, h: number, v: (x: number, y: number) => number[], B = 1): { seam: number; inner: number } {
  const col = (x: number, y0: number) => {
    const s = v(x, y0).slice();
    for (let y = y0 + 1; y < y0 + B; y++) v(x, y).forEach((q, i) => (s[i] += q));
    return s;
  };
  const diff = (p: number[], q: number[]) => p.reduce((acc, pi, i) => acc + Math.abs(pi - q[i]), 0) / B;
  let seam = 0;
  let inner = 0;
  let n = 0;
  for (let y0 = 0; y0 + B <= h; y0 += B, n++) {
    const c = [w - 3, w - 2, w - 1, 0, 1, 2].map((x) => col(x, y0));
    seam += diff(c[2], c[3]);
    inner += (diff(c[0], c[1]) + diff(c[1], c[2]) + diff(c[3], c[4]) + diff(c[4], c[5])) / 4;
  }
  return { seam: seam / n, inner: inner / n };
}

/** RGBA 像素 → [R, G, B] */
const rgb = (d: Uint8ClampedArray, w: number) => (x: number, y: number) => {
  const k = (y * w + x) * 4;
  return [d[k], d[k + 1], d[k + 2]];
};

describe('主图铺像素(东西相连)', () => {
  const worlds: [string, World, Raster][] = [];
  beforeAll(() => {
    for (const [seed, cells] of [
      [7, 36000],
      [2024, 12000],
      [11, 5000],
    ] as const) {
      const w = sphere(seed, cells);
      worlds.push([`seed ${seed} · ${cells}`, w, rasterize(w)]);
    }
  });

  it('按球面三角形铺满整张图:没有漏掉的像素(含两极、180° 经线)', () => {
    for (const [, w] of worlds) {
      expect(sphereCover(w.mesh, sphereGrid(2048, 1024)).holes).toBe(0);
      expect(sphereCover(w.mesh, sphereGrid(1024, 512)).holes).toBe(0);
      expect(sphereCover(w.mesh, sphereGrid(731, 365)).holes).toBe(0);
    }
  });

  it('没有 NaN / 无穷;带 wrap 标记;两极那几行也是正常的值', () => {
    for (const [name, , r] of worlds) {
      expect(r.wrap, name).toBe(true);
      for (const f of [r.elev, r.temp, r.precip, r.ice]) {
        for (let k = 0; k < f.length; k++) if (!Number.isFinite(f[k])) throw new Error(`${name}:像素 ${k} 不是有限数`);
      }
      // 第一行 / 最后一行(贴着极点):一行之内是连续的(那一行是极点周围一小圈,不是乱跳的空洞)
      for (const row of [0, 1, r.h - 2, r.h - 1]) {
        let jump = 0;
        for (let x = 0; x < r.w; x++) jump = Math.max(jump, Math.abs(r.elev[row * r.w + x] - r.elev[row * r.w + ((x + 1) % r.w)]));
        expect(jump, `${name} 第 ${row} 行`).toBeLessThan(300);
      }
    }
  });

  it('第 0 列和最后一列接得上:海拔、气温、降水的差和接缝附近相邻两列同一量级', () => {
    for (const [name, , r] of worlds) {
      for (const [field, f] of [
        ['海拔', r.elev],
        ['气温', r.temp],
        ['降水', r.precip],
      ] as const) {
        const s = seamStats(r.w, r.h, (x, y) => [f[y * r.w + x]]);
        expect(s.seam, `${name} ${field}:接缝 ${s.seam.toFixed(2)},附近相邻两列 ${s.inner.toFixed(2)}`).toBeLessThan(1.5 * s.inner + 1e-6);
      }
    }
  });

  it('同一个种子铺两次逐字节一样', () => {
    const [, w, r] = worlds[1];
    const r2 = rasterize(w);
    expect(Buffer.from(r2.elev.buffer).equals(Buffer.from(r.elev.buffer))).toBe(true);
    expect(Buffer.from(r2.ice.buffer).equals(Buffer.from(r.ice.buffer))).toBe(true);
    expect(Buffer.from(r2.biome.buffer).equals(Buffer.from(r.biome.buffer))).toBe(true);
  });

  it('换个分辨率(导出用)也能铺,没有 NaN', () => {
    const [, w] = worlds[2];
    const r = rasterize(w, 0.5);
    expect(r.w).toBe(1024);
    for (let k = 0; k < r.elev.length; k++) if (!Number.isFinite(r.elev[k])) throw new Error(`像素 ${k}`);
  });

  it('画风左右无缝:写实、手绘、数据图层接缝两边的颜色差和接缝附近相邻两列同一量级', () => {
    for (const [name, w, r] of worlds.slice(0, 2)) {
      const real = (realisticBase(r) as unknown as FakeCanvas).img!.data;
      const fan = (fantasyBase(w, r) as unknown as FakeCanvas).img!.data;
      const layer = new FakeCanvas(r.w, r.h);
      renderLayer(layer.getContext() as unknown as CanvasRenderingContext2D, w, r, 'temperature');
      for (const [style, d] of [
        ['写实', real],
        ['手绘', fan],
        ['气温图层', layer.img!.data],
      ] as const) {
        // 8 行一组取列平均(手绘的纸纹是逐像素的噪点,不压掉会盖过接缝)。
        // 真的接缝(两边纹理、颜色对不上)会差好几倍;一段海岸线正好落在接缝上时,接缝处本来就会大一些,放宽到 1.7 倍
        const s = seamStats(r.w, r.h, rgb(d, r.w), 8);
        expect(s.seam, `${name} ${style}:接缝 ${s.seam.toFixed(2)},附近相邻两列 ${s.inner.toFixed(2)}`).toBeLessThan(1.7 * s.inner + 0.5);
      }
    }
  });

  it('晕渲、距离变换左右相通', () => {
    const [, , r] = worlds[0];
    const sh = hillshade(r, 0.01);
    const s = seamStats(r.w, r.h, (x, y) => [sh[y * r.w + x]]);
    expect(s.seam).toBeLessThan(1.5 * s.inner);
    // 一张只在最后一列有"源"的掩膜:第 0 列离它 1 个像素(左右相通),第 3 列 4 个像素
    const mask = new Uint8Array(64 * 8);
    for (let y = 0; y < 8; y++) mask[y * 64 + 63] = 1;
    const d = distanceTo(mask, 64, 8);
    expect(d[0]).toBeCloseTo(1, 5);
    expect(d[3]).toBeCloseTo(4, 5);
    expect(d[31]).toBeCloseTo(32, 5);
  });

  it('回放帧:照常出帧,左右接缝处接得上', () => {
    const [, w] = worlds[2];
    const fr = buildHistoryFrames(w);
    expect(fr.frames.length).toBeGreaterThan(3);
    const last = fr.frames[fr.frames.length - 1];
    const s = seamStats(fr.w, fr.h, rgb(last, fr.w), 4);
    expect(s.seam).toBeLessThan(1.5 * s.inner + 0.5);
  });
});

describe('矢量线跨 180° 经线', () => {
  it('州界、国界的折线展开成连续的(相邻两点不跨半张图)', () => {
    const w = sphere(7, 12000);
    // 陆地按纬度切成 6 条带当"州":界线沿纬线绕一整圈,一定跨过 180° 经线
    const label = Int32Array.from({ length: w.mesh.n }, (_, i) => (w.water[i] === 0 ? Math.floor((w.mesh.y[i] / w.height) * 6) : -1));
    const check = (pts: ArrayLike<number>) => {
      for (let i = 2; i < pts.length; i += 2) expect(Math.abs(pts[i] - pts[i - 2])).toBeLessThan(w.width / 4);
    };
    const lines = traceBoundaries(w.mesh, label);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) check(l.pts);
    const rc = traceChains(w.mesh, label);
    expect(rc.wrap).toBe(w.width);
    const own = Int32Array.from({ length: 6 }, (_, i) => i % 3);
    for (const l of mergeChains(rc, own)) check(l.pts);
  });
});
