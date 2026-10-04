import { describe, expect, it } from 'vitest';
import { washPixels } from '../src/render/civ/territory';

/**
 * 手绘风的水彩给地形符号"让位"(fantasyInkMask 的 hard / soft):
 * 墨线上不上色;林块、山的纸色底在国土内部基本不上色,紧贴边界的色带照样上色。
 */
describe('手绘水彩给符号让位', () => {
  // 64×16 的小图:左半边归 0 号、右半边归 1 号,边界在 x = 32
  const w = 64;
  const h = 16;
  const pixRegion = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixRegion[y * w + x] = x < 32 ? 0 : 1;
  const owner = Int16Array.from([0, 1]);
  const colors = Uint8Array.from([200, 60, 50, 60, 90, 200]);
  const alpha = (hard: Uint8Array | null, soft: Uint8Array | null) => {
    const out = new Uint8ClampedArray(w * h * 4);
    washPixels(
      { w, h, f: 1, pixRegion, owner, colors, style: 'fantasy', polity: true, ink: hard && soft ? { hard, soft } : null },
      out,
    );
    return (x: number, y: number) => out[(y * w + x) * 4 + 3];
  };
  const hard = new Uint8Array(w * h);
  const soft = new Uint8Array(w * h);
  const at = (x: number, y: number) => y * w + x;
  hard[at(8, 8)] = 255; // 国土深处的一笔墨线
  soft[at(4, 8)] = 255; // 国土深处的林块
  soft[at(31, 8)] = 255; // 紧贴边界的林块
  const base = alpha(null, null);
  const masked = alpha(hard, soft);

  it('墨线上不上色', () => {
    expect(base(8, 8)).toBeGreaterThan(0);
    expect(masked(8, 8)).toBe(0);
  });
  it('国土深处的林块基本不上色,紧贴边界的保留大半', () => {
    expect(masked(4, 8)).toBeLessThan(base(4, 8) * 0.25);
    expect(masked(31, 8)).toBeGreaterThan(base(31, 8) * 0.7);
  });
  it('没有符号的地方不受影响', () => {
    expect(masked(20, 8)).toBe(base(20, 8));
    expect(masked(40, 4)).toBe(base(40, 4));
  });
});
