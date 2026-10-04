/** 河名排字的读序:正立字列偏竖时从上往下读,偏横时从左往右读,不许倒着读 */
import { describe, expect, it } from 'vitest';
import { Polyline, layoutRiver, readsForward } from '../src/render/labels/layout';

/** 生成一条从 (x0,y0) 到 (x1,y1) 的直河道,中间加点小折 */
function river(x0: number, y0: number, x1: number, y1: number, n = 40): Polyline {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(x0 + (x1 - x0) * t + Math.sin(t * 17) * 2, y0 + (y1 - y0) * t + Math.cos(t * 13) * 2);
  }
  return new Polyline(pts);
}

describe('河名读序', () => {
  // 各种走向:往右上陡升、往左下、竖直向上、横向向左、45° 斜线
  const cases: [string, Polyline][] = [
    ['右上陡升', river(0, 300, 120, 0)],
    ['左下陡降', river(120, 0, 0, 300)],
    ['竖直向上', river(50, 300, 52, 0)],
    ['横向向左', river(300, 50, 0, 55)],
    ['45° 右上', river(0, 250, 250, 0)],
    ['45° 左上', river(250, 250, 0, 0)],
  ];
  for (const [name, path] of cases) {
    it(`${name}:所有候选都顺读`, () => {
      const cands = layoutRiver('桃柱之水', path, 14, [0.2, 0.2], 2, 1);
      expect(cands.length).toBeGreaterThan(0);
      for (const c of cands) expect(readsForward(c.glyphs)).toBe(true);
    });
  }
});
