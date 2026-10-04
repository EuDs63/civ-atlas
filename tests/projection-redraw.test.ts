/**
 * 弯边投影按投影重画(第二档):快速投影和精确投影对得上、线过 ±180° 在另一边接着画、
 * 符号规划按投影后的距离留间距、海岸线描出来是闭合的、东西相连。
 * (真正的画面在 pnpm test:visual 的弯边投影基准图、scripts/snap.ts 截图里看)
 */
import { describe, expect, it } from 'vitest';
import { PROJECTION_IDS, glyphMetric, mapProj, projectLinePts, projectWorld, projectWorldNear, projector, relShifts } from '../src/render/projection';
import { lineShifts, relAlong } from '../src/render/common';
import { fantasyCoastLines, planGlyphs, G_MOUNTAIN } from '../src/render/fantasy';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import type { Raster } from '../src/gen/raster';

const W = 2048;
const H = 1024;
const CURVED = PROJECTION_IDS.filter((id) => id !== 'equirect');

describe('按投影重画:快速投影', () => {
  it('查表投影和精确投影(文字层用的那一套)差不到 0.02 个地图平面单位', () => {
    for (const id of PROJECTION_IDS) {
      for (const lon0 of [0, 73.5, -150]) {
        const mp = mapProj(id, lon0, W, H);
        const pj = projector(mp);
        let worst = 0;
        for (let i = 0; i < 400; i++) {
          const wx = (i * 997.3) % W;
          // 墨卡托只比 ±80° 以内(外面精确投影截在轮廓上,快速投影照样往外伸,由外轮廓裁掉)
          const lat = mp.def.latMax * 0.999;
          const wy = H / 2 - ((((i * 379.1) % H) - H / 2) / (H / 2)) * (lat / (Math.PI / 2)) * (H / 2);
          const [ex, ey] = projectWorld(mp, wx, wy);
          const fx = W / 2 + pj.K(wy) * pj.rel(wx);
          const fy = pj.Y(wy);
          worst = Math.max(worst, Math.abs(ex - fx), Math.abs(ey - fy));
        }
        expect(worst, `${id} lon0=${lon0}`).toBeLessThan(0.02);
      }
    }
  });

  it('折线过 ±180° 经线:投影后在另一边再出一份,每份都和"接着上一点展开"的精确投影一致', () => {
    const mp = mapProj('mollweide', 40, W, H);
    const pj = projector(mp);
    // 中央经线 40° → 左右边是 −140°(世界 x ≈ 227.6):一条从边左边一点横穿到右边一点的线
    const edgeX = ((-140 + 180) / 360) * W;
    const pts = [edgeX - 30, 300, edgeX - 5, 310, edgeX + 5, 320, edgeX + 30, 330];
    const v = { s: 1, ox: 0, oy: 0 };
    const polys = projectLinePts(pts, 2, pj, v);
    expect(polys.length).toBe(2);
    // 第一份从第一点开始(按中央经线挪到 ±180° 以内),点逐个和 projectWorldNear 对得上
    const p0 = polys[0];
    const [ax, ay] = projectWorld(mp, pts[0], pts[1]);
    expect(Math.abs(p0[0] - ax)).toBeLessThan(0.05);
    expect(Math.abs(p0[1] - ay)).toBeLessThan(0.05);
    const last = p0.length - 2;
    const [bx, by] = projectWorldNear(mp, pts[6], pts[7], pts[0]);
    expect(Math.abs(p0[last] - bx)).toBeLessThan(0.05);
    expect(Math.abs(p0[last + 1] - by)).toBeLessThan(0.05);
    // 另一份平移了一整圈:它的最后一点就是这一点按中央经线挪回来的位置(轮廓里面)
    const [cx, cy] = projectWorld(mp, pts[6], pts[7]);
    const q = polys[1];
    expect(Math.abs(q[q.length - 2] - cx)).toBeLessThan(0.05);
    expect(Math.abs(q[q.length - 1] - cy)).toBeLessThan(0.05);
  });

  it('长段按约 1.5° 加密;不过边的线只有一份', () => {
    const mp = mapProj('robinson', 0, W, H);
    const pj = projector(mp);
    const polys = projectLinePts([900, 200, 1100, 200], 2, pj, { s: 1, ox: 0, oy: 0 });
    expect(polys.length).toBe(1);
    // 200 个世界单位 ≈ 35°:至少 20 个点
    expect(polys[0].length / 2).toBeGreaterThan(20);
    // 加密的点落在同一条纬线上(伪圆柱投影:纬线是水平直线)
    for (let i = 1; i < polys[0].length; i += 2) expect(Math.abs(polys[0][i] - polys[0][1])).toBeLessThan(1e-6);
  });

  it('点在 ±180° 附近时另一边再画一份;经度差沿线连续展开', () => {
    expect(relShifts(0, 0.1)).toEqual([0]);
    expect(relShifts(Math.PI - 0.05, 0.1)).toEqual([0, -2 * Math.PI]);
    expect(relShifts(-Math.PI + 0.05, 0.1)).toEqual([0, 2 * Math.PI]);
    const pj = projector(mapProj('mollweide', 0, W, H));
    // 世界 x 从 2040 跨过右边到 8(东西相连):经度差连续地超过 π
    const { rel, lo, hi } = relAlong([2040, 500, 2047, 500, 8, 500], 2, pj);
    expect(rel[2] - rel[0]).toBeCloseTo(((16) / W) * 2 * Math.PI, 6);
    expect(hi).toBeGreaterThan(Math.PI);
    expect(lineShifts(lo, hi)).toEqual([0, -2 * Math.PI]);
  });
});

describe('按投影重画:符号规划按投影后的距离留间距', () => {
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 20000 });
  const eq = planGlyphs(world);

  it('等距圆柱的规划不变(不给尺子 = 原来的算法)', () => {
    const again = planGlyphs(world, undefined);
    expect(again.glyphs.length).toBe(eq.glyphs.length);
    expect(again.glyphs.slice(0, 50)).toEqual(eq.glyphs.slice(0, 50));
  });

  it('摩尔威德 / 罗宾森 / 墨卡托:按投影后的距离量,全图就有的山挤在一起的对数比拿等距圆柱规划硬套少得多', () => {
    for (const id of CURVED) {
      const m = glyphMetric(id, world.width, world.height);
      const pp = planGlyphs(world, m);
      expect(pp.glyphs.length).toBeGreaterThan(50);
      // 一对全图就有的山,投影后(中央经线处的横竖倍数)中心距离不到大的那座 0.6 倍 = 挤成一团(符号按屏幕大小画,会叠成一坨)
      const crowded = (gs: typeof eq.glyphs) => {
        const ms = gs.filter((g) => g.kind === G_MOUNTAIN && g.z <= 1);
        let n = 0;
        for (let i = 0; i < ms.length; i++)
          for (let j = i + 1; j < ms.length; j++) {
            const a = ms[i];
            const b = ms[j];
            let dx = b.x - a.x;
            dx -= world.width * Math.round(dx / world.width);
            const my = (a.y + b.y) / 2;
            const d = Math.hypot(dx * m.fx(my), (b.y - a.y) * m.fy(my));
            if (d < 0.6 * Math.max(a.s, b.s)) n++;
          }
        return n;
      };
      const mine = crowded(pp.glyphs);
      const naive = crowded(eq.glyphs);
      expect(naive, id).toBeGreaterThan(0);
      expect(mine, id).toBeLessThanOrEqual(Math.floor(naive * 0.3));
    }
  });
});

/** 小的假像素图:water(0 陆 / 1 海 / 2 湖)、海拔(海 −100、陆 +100) */
function fakeRaster(w: number, h: number, water: (x: number, y: number) => number): Raster {
  const wa = new Uint8Array(w * h);
  const el = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = water(x, y);
      wa[y * w + x] = v;
      el[y * w + x] = v === 1 ? -100 : 100;
    }
  return { w, h, scale: 1, water: wa, elev: el } as unknown as Raster;
}

describe('按投影重画:海岸线、湖岸线', () => {
  it('海里的一个方形岛:一条闭合的海岸线,交点在海拔过零处(像素中心之间的正中)', () => {
    const r = fakeRaster(64, 32, (x, y) => (x >= 20 && x < 30 && y >= 10 && y < 20 ? 0 : 1));
    const { sea, lake } = fantasyCoastLines(r);
    expect(lake.length).toBe(0);
    expect(sea.length).toBe(1);
    const p = sea[0];
    expect(p[0]).toBeCloseTo(p[p.length - 2], 6);
    expect(p[1]).toBeCloseTo(p[p.length - 1], 6);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
    }
    // 陆地像素 20..29 的中心是 20.5..29.5;和海的分界在像素边上:20、30
    expect(x0).toBeCloseTo(20, 1);
    expect(x1).toBeCloseTo(30, 1);
  });

  it('跨过左右边的岛(东西相连):海岸线是一整条闭合的环,x 连续展开(伸出图外),不在接缝处断开', () => {
    const r = fakeRaster(64, 32, (x, y) => ((x >= 58 || x < 6) && y >= 8 && y < 24 ? 0 : 1));
    const { sea } = fantasyCoastLines(r);
    expect(sea.length).toBe(1);
    const p = sea[0];
    for (let i = 2; i < p.length; i += 2) expect(Math.abs(p[i] - p[i - 2])).toBeLessThan(2);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
    }
    expect(x1 - x0).toBeCloseTo(12, 0);
  });

  it('湖岸:湖一圈一条闭合线(抹平过);碰到上下边的海岸线在那里断开', () => {
    const r = fakeRaster(64, 32, (x, y) => (y < 4 ? 1 : x >= 30 && x < 36 && y >= 12 && y < 18 ? 2 : 0));
    const { sea, lake } = fantasyCoastLines(r);
    expect(lake.length).toBe(1);
    const l = lake[0];
    expect(l[0]).toBeCloseTo(l[l.length - 2], 6);
    // 顶上一整条海(东西相连):海岸线绕一圈回到起点,首尾差一整圈或闭合
    expect(sea.length).toBe(1);
  });
});
