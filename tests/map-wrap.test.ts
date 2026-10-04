/**
 * 球面世界的主图视图(ui/mapWrap.ts):左右无限拖动时平移量挪整数圈、视窗永远被"主图 + 右边接的一份"盖满,
 * 中心经度、世界 ↔ 屏幕坐标换算互逆,转一整圈回到原处。
 */
import { describe, expect, it } from 'vitest';
import { centerX, clampSphere, frameSpan, lonOfX, stageToWorld, viewCentredAt, windowSpan, worldToStage, xOfLon, type StageBox } from '../src/ui/mapWrap';

const W = 2048;
const H = 1024;
const BOXES: StageBox[] = [
  { sw: 1350, sh: 700, bw: 1326, bh: 663 }, // 普通桌面:地图框几乎铺满
  { sw: 2400, sh: 700, bw: 1352, bh: 676 }, // 宽屏:地图框两边有空白
  { sw: 700, sh: 900, bw: 676, bh: 338 }, // 竖屏
];

describe('球面世界的视图数学', () => {
  it('平移量挪整数圈:主图那一份的左边在视窗左边或更左一点,主图 + 右边接的一份盖满视窗', () => {
    for (const b of BOXES) {
      for (const k of [1, 1.3, 2.5, 7]) {
        for (const x of [-12345.6, -800, -1, 0, 3, 999, 40000]) {
          const v = clampSphere({ k, x, y: 0 }, b);
          const [wl, wr] = windowSpan(k, b);
          const L = v.x + k * (b.sw - b.bw) / 2;
          const P = k * b.bw;
          expect(L).toBeLessThanOrEqual(wl + 1e-6);
          expect(L).toBeGreaterThan(wl - P - 1e-6);
          expect(L + 2 * P).toBeGreaterThanOrEqual(wr - 1e-6);
          // 挪的是整数圈:中心经度不变
          expect(Math.abs(centerX(v, b, W) - centerX({ k, x, y: 0 }, b, W)) % W).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('视窗 = 外框 ∩ 舞台;缩放 1 倍时外框就是地图框', () => {
    const b = BOXES[1];
    expect(frameSpan(1, b)).toEqual([(b.sw - b.bw) / 2, (b.sw + b.bw) / 2]);
    expect(windowSpan(5, b)).toEqual([0, b.sw]);
  });

  it('上下和平面地图一样夹在两极以内', () => {
    const b = BOXES[0];
    expect(clampSphere({ k: 1, x: 0, y: 50 }, b).y).toBe(0);
    expect(clampSphere({ k: 2, x: 0, y: -5000 }, b).y).toBe(b.sh - 2 * b.sh);
  });

  it('默认视图(k = 1、不平移)中心是 0° 经线;转到某经度再读回来一样;转一整圈回到原处', () => {
    for (const b of BOXES) {
      const v0 = clampSphere({ k: 1, x: 0, y: 0 }, b);
      expect(lonOfX(centerX(v0, b, W), W)).toBeCloseTo(0, 9);
      for (const lon of [-179.5, -90, 0, 45, 90, 179.9]) {
        const v = viewCentredAt({ k: 2, x: 0, y: 0 }, b, W, xOfLon(lon, W));
        expect(lonOfX(centerX(v, b, W), W)).toBeCloseTo(lon, 6);
        const round = clampSphere({ ...v, x: v.x + 2 * b.bw }, b);
        expect(round.x).toBeCloseTo(v.x, 6);
      }
    }
  });

  it('世界 ↔ 屏幕坐标互逆', () => {
    const b = BOXES[0];
    const v = viewCentredAt({ k: 3, x: 0, y: -400 }, b, W, 100);
    for (const [wx, wy] of [[100, 500], [-30, 200], [2100, 900]]) {
      const [X, Y] = worldToStage(wx, wy, v, b, W, H);
      const [a, c] = stageToWorld(X, Y, v, b, W, H);
      expect(a).toBeCloseTo(wx, 6);
      expect(c).toBeCloseTo(wy, 6);
    }
  });
});
