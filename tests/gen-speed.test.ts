/**
 * 新建世界里精细度滑条后面的"约 N 秒"(ui/genSpeed.ts):按最近一次生成实测的时间估
 */
import { describe, expect, it } from 'vitest';
import { genSeconds, noteGenSpeed } from '../src/ui/genSpeed';

describe('生成一次约几秒', () => {
  it('还没生成过不估;同一个精细度就是刚才那么久;生成世界那一步按地块数放大,其余涨得慢', () => {
    expect(genSeconds(36000)).toBeNull();
    noteGenSpeed(36000, 1000, 2000);
    expect(genSeconds(36000)).toBe(2);
    // 200k:1000 × 5.56^0.94 + 1000 × 5.56^0.2 ≈ 5012 + 1409
    expect(genSeconds(200000)).toBe(6);
    // 最少写 1 秒
    expect(genSeconds(12000)).toBe(1);
    // 越精细越慢
    let prev = 0;
    for (let c = 12000; c <= 200000; c += 2000) {
      const s = genSeconds(c)!;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('不合理的读数不记(还按上一次的估)', () => {
    noteGenSpeed(36000, 1000, 2000);
    noteGenSpeed(36000, 0, 2000);
    noteGenSpeed(36000, 3000, 2000);
    noteGenSpeed(0, 1000, 2000);
    expect(genSeconds(36000)).toBe(2);
  });
});
