import { describe, expect, it } from 'vitest';
import {
  PROJECTION_IDS,
  PROJECTIONS,
  centerShift,
  graticuleLines,
  insideProj,
  isProjectionId,
  mapProj,
  outlinePath,
  projectWorld,
  projectWorldNear,
  unprojectWorld,
  wrapLon,
} from '../src/render/projection';

const W = 2048;
const H = 1024;
/** 世界 x 的差(按整圈取最近) */
const dx = (a: number, b: number) => Math.abs(a - b - W * Math.round((a - b) / W));

describe('地图投影', () => {
  it('每种投影:纬度 → y → 纬度 往返一致,y 随纬度单调', () => {
    for (const id of PROJECTION_IDS) {
      const d = PROJECTIONS[id];
      let last = -Infinity;
      for (let a = -d.latMax; a <= d.latMax + 1e-12; a += d.latMax / 200) {
        const y = d.y(a);
        expect(y).toBeGreaterThan(last - 1e-12);
        last = y;
        expect(Math.abs(d.phi(y) - a)).toBeLessThan(1e-6);
      }
      expect(Number.isNaN(d.phi(d.y(d.latMax) * 1.02 + 0.01))).toBe(true);
    }
  });

  it('等距圆柱、中央经线 0°:地图平面就是世界坐标', () => {
    const mp = mapProj('equirect', 0, W, H);
    for (const [x, y] of [
      [0.5, 3],
      [1024, 512],
      [2000, 1000],
      [300, 70],
    ]) {
      const [mx, my] = projectWorld(mp, x, y);
      expect(mx).toBeCloseTo(x, 6);
      expect(my).toBeCloseTo(y, 6);
    }
  });

  it('正投影 → 反投影往返回到同一点(各投影、各中央经线)', () => {
    for (const id of PROJECTION_IDS) {
      for (const lon0 of [0, 37.5, -120, 180]) {
        const mp = mapProj(id, lon0, W, H);
        for (let i = 0; i < 400; i++) {
          const x = ((i * 7919) % 2039) + 0.37;
          const lat = ((i * 104729) % 1000) / 1000;
          const y = H * (0.02 + 0.96 * lat);
          const phi = Math.PI / 2 - (y / H) * Math.PI;
          if (Math.abs(phi) > mp.def.latMax - 1e-6) continue;
          const [mx, my] = projectWorld(mp, x, y);
          expect(mx).toBeGreaterThanOrEqual(-1e-6);
          expect(mx).toBeLessThanOrEqual(W + 1e-6);
          expect(insideProj(mp, mx, my, -1e-6)).toBe(true);
          const back = unprojectWorld(mp, mx, my);
          expect(back).not.toBeNull();
          expect(dx(back![0], x)).toBeLessThan(1e-3);
          expect(Math.abs(back![1] - y)).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('中央经线:地图正中就是这条经线;左右边是它 ± 180°', () => {
    for (const id of PROJECTION_IDS) {
      const mp = mapProj(id, 90, W, H);
      const c = unprojectWorld(mp, W / 2, H / 2)!;
      // 90°E:世界 x = (90 + 180) / 360 × W
      expect(dx(c[0], (270 / 360) * W)).toBeLessThan(1e-6);
      // 100°E 在正中偏右、80°E 偏左;−90°(对面)在左右边上
      expect(projectWorld(mp, (280 / 360) * W, H / 2)[0]).toBeGreaterThan(W / 2);
      expect(projectWorld(mp, (260 / 360) * W, H / 2)[0]).toBeLessThan(W / 2);
      const [ex] = projectWorld(mp, (90 / 360) * W + 1e-6, H / 2);
      expect(Math.abs(Math.abs(ex - W / 2) - mp.xMax * mp.s)).toBeLessThan(1e-3);
    }
  });

  it('外轮廓外面反投影不到;轮廓在地图平面以内、左右对称', () => {
    for (const id of PROJECTION_IDS) {
      const mp = mapProj(id, 0, W, H);
      if (id !== 'equirect') {
        expect(unprojectWorld(mp, 0.5, 0.5)).toBeNull();
        expect(insideProj(mp, 2, H / 2)).toBe(false);
      }
      const o = outlinePath(mp);
      for (let i = 0; i < o.length; i += 2) {
        expect(o[i]).toBeGreaterThanOrEqual(-1e-6);
        expect(o[i]).toBeLessThanOrEqual(W + 1e-6);
        expect(o[i + 1]).toBeGreaterThanOrEqual(-1e-6);
        expect(o[i + 1]).toBeLessThanOrEqual(H + 1e-6);
      }
    }
  });

  it('路径按参考点连续展开:跨中央经线对面的路径不在左右边断开', () => {
    const mp = mapProj('robinson', 0, W, H);
    // 180° 经线两边各一点(世界 x ≈ 0 和 ≈ W)
    const a = projectWorldNear(mp, 5, 400, 5);
    const b = projectWorldNear(mp, W - 5, 400, 5);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(20);
  });

  it('经纬网:中央经线 45° 时经线落在整 30 度上', () => {
    const mp = mapProj('mollweide', 45, W, H);
    const g = graticuleLines(mp, 30);
    // −165° … 165°(相对中央经线)每 30° 一条,都不和左右边重合
    expect(g.meridians.length).toBe(12);
    expect(g.parallels.length).toBe(5);
    // 中央经线 0° 时 ±180° 就是外轮廓,不另画
    expect(graticuleLines(mapProj('mollweide', 0, W, H), 30).meridians.length).toBe(11);
  });

  it('只换中央经线:每一行整体横移 −s · kx(φ) · Δλ,centerShift 给出中间行的挪动量和上下各行的最大偏差', () => {
    for (const id of PROJECTION_IDS) {
      for (const [l0, l1] of [
        [20, 26],
        [178, -176], // 跨 ±180°:实际只转了 6°
        [-40, -52],
      ]) {
        const from = mapProj(id, l0, W, H);
        const to = mapProj(id, l1, W, H);
        // 地图平面上这一行、靠近中央经线的一点实际横移多少
        const moved = (my: number) => {
          const phi = from.def.phi((H / 2 - my) / from.s);
          const wy = ((Math.PI / 2 - phi) / Math.PI) * H;
          const wx = ((l0 + 180) / 360) * W;
          return projectWorld(to, wx, wy)[0] - projectWorld(from, wx, wy)[0];
        };
        // 北半球一条、跨赤道一条
        for (const [my0, my1] of [
          [H / 2 - 300, H / 2 - 220],
          [H / 2 - 40, H / 2 + 60],
        ]) {
          const { dx, err } = centerShift(from, to, my0, my1);
          expect(Math.abs(moved((my0 + my1) / 2) - dx)).toBeLessThan(1e-6);
          let worst = 0;
          for (let my = my0; my <= my1; my += 4) worst = Math.max(worst, Math.abs(moved(my) - dx));
          expect(worst).toBeLessThanOrEqual(err + 1e-6);
          // 偏差估计不夸大(不然拖动时白白重画)
          expect(err).toBeLessThan(worst + 0.05 * Math.abs(dx) + 1e-6);
        }
      }
    }
    // 墨卡托、等距圆柱:各纬线一样长,转中心就是整块平移,没有偏差
    expect(centerShift(mapProj('mercator', 0, W, H), mapProj('mercator', 30, W, H), 100, 900).err).toBeLessThan(1e-9);
  });

  it('wrapLon / isProjectionId', () => {
    expect(wrapLon(190)).toBeCloseTo(-170);
    expect(wrapLon(-180)).toBeCloseTo(-180);
    expect(wrapLon(180)).toBeCloseTo(-180);
    expect(isProjectionId('robinson')).toBe(true);
    expect(isProjectionId('globe')).toBe(false);
    expect(isProjectionId('toString')).toBe(false);
  });
});
