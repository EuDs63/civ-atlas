/**
 * 手绘风放大后的岸线外波纹、近岸排线(矢量线):等值线的位置、排线的起止、浓度图、按视口挑排线、东西相连;
 * 以及"没画波纹、排线"的像素层要拼回去的原色(PixelPatch)。(真正的画面在 scripts/snap.ts 放大截图里看)
 */
import { describe, expect, it } from 'vitest';
import { distanceTo } from '../src/render/common';
import { DIST_Q, PixelPatch, coastChunks, forChunksIn, forHatchIn, projectHatch, seaHatchAlpha, seaHatchSegments, seaRippleLines, type SeaGrid } from '../src/render/fantasy';
import { mapProj, projector } from '../src/render/projection';

const w = 256;
const h = 128;

/** 一张小像素图:圆形的岛(圆心 cx, cy,半径 R 像素;陆地海拔 +1、海 −1),scale = 1;fade 默认全海 255 */
function island(cx: number, cy: number, R: number) {
  const water = new Uint8Array(w * h);
  const elev = new Float32Array(w * h);
  const land = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      // 东西相连:按环上的距离
      const dx = Math.min(Math.abs(x - cx), w - Math.abs(x - cx));
      const isLand = Math.hypot(dx, y - cy) <= R;
      land[k] = isLand ? 1 : 0;
      water[k] = isLand ? 0 : 1;
      elev[k] = isLand ? 1 : -1;
    }
  const d = distanceTo(land, w, h);
  const dist = new Uint16Array(w * h);
  for (let k = 0; k < w * h; k++) dist[k] = Math.min(65535, Math.round(d[k] * DIST_Q));
  const fade = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) fade[k] = water[k] === 1 ? 255 : 0;
  const r: SeaGrid = { w, h, scale: 1, water, elev };
  return { r, dist, fade, land };
}

/** 世界坐标 (x, y) 到最近的陆地像素中心的距离(暴力算;东西相连) */
function distToLand(land: Uint8Array, x: number, y: number): number {
  let best = Infinity;
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      if (!land[py * w + px]) continue;
      const dx0 = Math.abs(px + 0.5 - x) % w;
      const dx = Math.min(dx0, w - dx0);
      best = Math.min(best, Math.hypot(dx, py + 0.5 - y));
    }
  return best;
}

describe('波纹:离陆地距离的等值线', () => {
  it('三圈都是绕岛一周的闭合线,线上的点离陆地 4、9、15 格', () => {
    const { r, dist, fade, land } = island(100, 64, 8);
    const rings = seaRippleLines(r, dist, fade);
    expect(rings.length).toBe(3);
    [4, 9, 15].forEach((D, i) => {
      expect(rings[i].length).toBe(1);
      const p = rings[i][0];
      expect([p[0], p[1]]).toEqual([p[p.length - 2], p[p.length - 1]]);
      for (let j = 0; j < p.length; j += 2) expect(Math.abs(distToLand(land, p[j], p[j + 1]) - D)).toBeLessThan(0.2);
    });
  });

  it('跨过 180° 经线的岛:等值线是连着的一整圈(x 展开成连续的,不在接缝处断开)', () => {
    const { r, dist, fade } = island(2, 64, 8);
    const rings = seaRippleLines(r, dist, fade);
    for (const ls of rings) {
      expect(ls.length).toBe(1);
      const p = ls[0];
      for (let j = 2; j < p.length; j += 2) expect(Math.hypot(p[j] - p[j - 2], p[j + 1] - p[j - 1])).toBeLessThan(1.5);
      const xs = p.filter((_, j) => j % 2 === 0);
      // 一部分伸出了主图的左边或右边
      expect(Math.min(...xs) < 0 || Math.max(...xs) > w).toBe(true);
    }
  });

  it('浓度为 0 的地方(冰面)那几截不要:上半边结冰,剩下的线都在下半边', () => {
    const { r, dist, fade } = island(100, 64, 8);
    for (let k = 0; k < (h / 2) * w; k++) fade[k] = 0;
    const rings = seaRippleLines(r, dist, fade);
    for (const ls of rings) {
      expect(ls.length).toBeGreaterThan(0);
      for (const p of ls) for (let j = 1; j < p.length; j += 2) expect(p[j]).toBeGreaterThan(63);
    }
  });
});

describe('近岸排线', () => {
  const ok = (g: ReturnType<typeof island>, k: number) => g.r.water[k] === 1 && g.dist[k] < 9 * DIST_Q && g.fade[k] > 0;

  it('只在每隔 3 行的那几行;离陆地 9 格以内的海面都盖到,线段里面没有不该画的像素', () => {
    const g = island(100, 64, 8);
    const seg = seaHatchSegments(g.r, g.dist, g.fade);
    expect(seg.length).toBeGreaterThan(0);
    for (let i = 0; i < seg.length; i += 3) {
      const py = seg[i + 2] - 0.5;
      expect(py % 3).toBe(0);
      expect(seg[i + 1]).toBeGreaterThan(seg[i]);
      // 线段里面的像素中心都是该画的
      for (let x = Math.ceil(seg[i] - 0.5); x + 0.5 < seg[i + 1]; x++) {
        if (x + 0.5 <= seg[i]) continue;
        expect(ok(g, py * w + (((x % w) + w) % w))).toBe(true);
      }
    }
    // 该画的像素都在某一条线段里
    for (let py = 0; py < h; py += 3)
      for (let x = 0; x < w; x++) {
        if (!ok(g, py * w + x)) continue;
        let hit = false;
        for (let i = 0; i < seg.length; i += 3) if (seg[i + 2] === py + 0.5 && seg[i] < x + 0.5 && seg[i + 1] > x + 0.5) hit = true;
        expect(hit).toBe(true);
      }
  });

  it('靠岸的一头停在海岸线上(海拔过零处),朝外的一头伸到下一个像素中心(那里浓度为 0)', () => {
    const g = island(100, 64, 8);
    const seg = seaHatchSegments(g.r, g.dist, g.fade);
    // 过岛中心那一行(py = 63):左右各一段
    const row = [];
    for (let i = 0; i < seg.length; i += 3) if (seg[i + 2] === 63.5) row.push([seg[i], seg[i + 1]]);
    expect(row.length).toBe(2);
    row.sort((a, b) => a[0] - b[0]);
    const [left, right] = row;
    // 这一行岛占的列:海拔 ±1,过零处在像素边上(陆地第一列的左边、最后一列的右边)
    let landX0 = 0;
    while (!g.land[63 * w + landX0]) landX0++;
    let landX1 = landX0;
    while (g.land[63 * w + landX1]) landX1++;
    expect(left[1]).toBeCloseTo(landX0, 5);
    expect(right[0]).toBeCloseTo(landX1, 5);
    // 朝外那头:那个像素离陆地 ≥ 9 格,它的中心
    const outL = left[0] - 0.5;
    expect(g.dist[63 * w + outL]).toBeGreaterThanOrEqual(9 * DIST_Q);
    expect(g.dist[63 * w + outL + 1]).toBeLessThan(9 * DIST_Q);
  });

  it('跨过 180° 经线:岛在接缝上,排线不在接缝处断开(x 展开成连续的)', () => {
    const g = island(0, 64, 8);
    const seg = seaHatchSegments(g.r, g.dist, g.fade);
    // 岛中心那一行以外、岛顶上那一行(py = 54,离岛顶不到 9 格):一整段从左边海面跨到右边
    const row54 = [];
    for (let i = 0; i < seg.length; i += 3) if (seg[i + 2] === 54.5) row54.push([seg[i], seg[i + 1]]);
    expect(row54.length).toBe(1);
    expect(row54[0][1]).toBeGreaterThan(w);
    expect(row54[0][0]).toBeLessThan(w);
  });

  it('浓度图:离岸越远越淡,冰面为 0;挨着海的陆地像素取相邻海面的最大值,岛中间为 0', () => {
    const g = island(100, 64, 8);
    g.fade[64 * w + 120] = 0; // 一个冰面像素
    const a = seaHatchAlpha(g.r, g.dist, g.fade);
    // 往右一格一格走:越来越淡,9 格外为 0
    let prev = 256;
    for (let x = 108; x < 125; x++) {
      const v = a[63 * w + x];
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
    expect(a[63 * w + 108]).toBeGreaterThan(200);
    expect(a[63 * w + 120]).toBe(0);
    expect(a[64 * w + 120]).toBe(0);
    // 岸边的陆地像素(107 列)= 它四周海面像素里最大的
    expect(g.land[63 * w + 107]).toBe(1);
    let m = 0;
    for (let y = 62; y <= 64; y++) for (let x = 106; x <= 108; x++) if (!g.land[y * w + x]) m = Math.max(m, a[y * w + x]);
    expect(m).toBeGreaterThan(200);
    expect(a[63 * w + 107]).toBe(m);
    expect(a[64 * w + 100]).toBe(0);
  });

  it('按视口挑排线:只给范围里的那几行;东西相连,范围伸出左右边时给平移一整圈的那一份', () => {
    // 三条:y = 0.5 / 3.5 / 6.5,第二条跨过右边
    const seg = Float32Array.from([10, 20, 0.5, w - 5, w + 4, 3.5, 100, 140, 6.5]);
    const got = (x0: number, y0: number, x1: number, y1: number) => {
      const out: [number, number][] = [];
      forHatchIn(seg, w, x0, y0, x1, y1, (i, dx) => out.push([i, dx || 0]));
      return out;
    };
    // 整个主图:跨过右边那一条,原位和挪到左边的那一份都伸进来
    expect(got(0, 0, w, 10)).toEqual([
      [0, 0],
      [1, -w],
      [1, 0],
      [2, 0],
    ]);
    expect(got(20, 3, 200, 4)).toEqual([]);
    expect(got(w - 10, 3, w, 4)).toEqual([[1, 0]]);
    // 看主图左边:跨过右边那一条挪到左边(x −5 … 4)
    expect(got(0, 0, 8, 10)).toEqual([[1, -w]]);
    // 看主图右边接的那一份:第一条挪过来
    expect(got(w + 5, 0, w + 30, 10)).toEqual([[0, w]]);
    expect(got(30, 0, 90, 10)).toEqual([]);
  });
});

describe('弯边投影的地图平面', () => {
  it('排线投影后还是横线段,按 y 排好;伸出 ±180° 的那截在另一边再出一份', () => {
    const W = 2048;
    const H = 1024;
    // 中央经线 150°:离它 180° 的经线(−30°)在世界 x = W·150/360 处
    const pj = projector(mapProj('robinson', 150, W, H));
    const xs = (W * 150) / 360;
    const seg = Float32Array.from([100, 140, 200.5, xs - 20, xs + 30, 300.5, 900, 960, 700.5, 500, 520, 800.5]);
    const out = projectHatch(seg, pj);
    const k2 = (2 * Math.PI) / W;
    // 跨经线的那条出两份,其余各一份
    expect(out.length / 3).toBe(5);
    for (let i = 3; i < out.length; i += 3) expect(out[i + 2]).toBeGreaterThanOrEqual(out[i - 1]);
    for (let i = 0; i < seg.length; i += 3) {
      const y = pj.Y(seg[i + 2]);
      const got: number[][] = [];
      for (let j = 0; j < out.length; j += 3) if (Math.abs(out[j + 2] - y) < 1e-3) got.push([out[j], out[j + 1]]);
      const r0 = pj.rel(seg[i]);
      const r1 = r0 + (seg[i + 1] - seg[i]) * k2;
      const want = [[r0, r1]];
      if (r1 > Math.PI) want.push([r0 - 2 * Math.PI, r1 - 2 * Math.PI]);
      expect(got.length).toBe(want.length);
      const at = (rr: number) => W / 2 + pj.K(seg[i + 2]) * rr;
      want.forEach(([a, b], n) => {
        const g = got.find((q) => Math.abs(q[0] - at(a)) < 0.05);
        expect(g, `第 ${i / 3} 条第 ${n} 份`).toBeDefined();
        expect(g![1]).toBeCloseTo(at(b), 1);
      });
    }
  });

  it('按范围挑段、挑排线:W = 0 时不东西相连,只看有没有交叠', () => {
    const c = coastChunks([Float32Array.from([0, 0, 10, 0, 10, 10]), Float32Array.from([100, 50, 120, 60])]);
    const got: [number, number][] = [];
    forChunksIn(c, 0, 5, -1, 15, 20, (j, dx) => got.push([j, dx]));
    expect(got).toEqual([[0, 0]]);
    got.length = 0;
    forChunksIn(c, 0, -500, -500, 500, 500, (j, dx) => got.push([j, dx]));
    expect(got).toEqual([
      [0, 0],
      [1, 0],
    ]);
    const seg = Float32Array.from([-30, -10, 0.5, 10, 20, 3.5]);
    got.length = 0;
    forHatchIn(seg, 0, -20, 0, 15, 10, (i, dx) => got.push([i, dx]));
    expect(got).toEqual([
      [0, 0],
      [1, 0],
    ]);
    got.length = 0;
    forHatchIn(seg, 0, 21, 0, 2000, 10, (i, dx) => got.push([i, dx]));
    expect(got).toEqual([]);
  });
});

describe('拼回原色的像素(PixelPatch)', () => {
  it('记多少都行(会自己变大);写回时和写进 ImageData 一样取整、不透明;后写的盖掉先写的', () => {
    const p = new PixelPatch();
    for (let i = 0; i < 10000; i++) p.push(i, i % 256, 100.4, 100.6);
    expect(p.n).toBe(10000);
    const q = new PixelPatch();
    q.push(5, 1, 2, 3);
    const d = new Uint8ClampedArray(10000 * 4);
    p.putInto(d);
    q.putInto(d);
    expect(Array.from(d.subarray(4 * 4, 4 * 4 + 4))).toEqual([4, 100, 101, 255]);
    expect(Array.from(d.subarray(5 * 4, 5 * 4 + 4))).toEqual([1, 2, 3, 255]);
    expect(Array.from(d.subarray(9999 * 4, 9999 * 4 + 4))).toEqual([9999 % 256, 100, 101, 255]);
  });
});
