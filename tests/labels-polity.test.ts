/**
 * 国名排版(render/labels/polity.ts):用画好的几块假国土检查 —— 狭长的竖排、宽的横排,
 * 路径都在国土里,国土越大字越大,放不下全称时写简称,国都挡在正中时有绕开国都的备选路径。
 */
import { describe, expect, it } from 'vitest';
import type { Civ, Polity } from '../src/gen/civ/types';
import { fitAll, GRID, ownerAtPoint, territoryField, type PolityLabel, type TerritoryGrid } from '../src/render/labels/polity';

const GW = 200;
const GH = 100;
const WORLD_W = GW * GRID;

/** 画一块国土:cells(gx, gy) 为真的格子属于 0 号州 */
function gridOf(inside: (gx: number, gy: number) => boolean): TerritoryGrid {
  const region = new Int16Array(GW * GH).fill(-1);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (inside(x, y)) region[y * GW + x] = 0;
  return { G: GRID, gw: GW, gh: GH, region };
}

function polity(name: string, eastern = false): Polity {
  return {
    id: 0,
    name,
    culture: 0,
    capital: 0,
    founded: 0,
    kind: 'farm',
    expansionism: 1,
    color: [200, 100, 80],
    lineage: 'realm',
    titles: [{ year: 0, tier: 2 }],
    eastern,
  };
}

function fit(inside: (gx: number, gy: number) => boolean, p: Polity, regions: number, capital?: [number, number]): { label: PolityLabel; own: (x: number, y: number) => boolean } {
  const grid = gridOf(inside);
  const field = territoryField(grid, new Int16Array([0]));
  const civ = { polities: [p] } as unknown as Civ;
  const labels = fitAll(civ, 100, field, new Int32Array([regions]), { refCss: 1300 }, WORLD_W, capital ? () => capital : undefined);
  expect(labels.length).toBe(1);
  return { label: labels[0], own: (x, y) => ownerAtPoint(field, x, y) === 0 };
}

/** 路径上每隔一点取样,都在国土里 */
function pathInside(l: PolityLabel, own: (x: number, y: number) => boolean) {
  const p = l.path;
  for (let i = 0; i + 3 < p.length; i += 2) {
    for (let t = 0; t <= 1; t += 0.1) {
      const x = p[i] + (p[i + 2] - p[i]) * t;
      const y = p[i + 1] + (p[i + 3] - p[i + 1]) * t;
      expect(own(x, y), `(${x.toFixed(0)}, ${y.toFixed(0)})`).toBe(true);
    }
  }
}

function tiltOf(l: PolityLabel): number {
  const p = l.path;
  const dx = p[p.length - 2] - p[0];
  const dy = p[p.length - 1] - p[1];
  return (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
}

describe('国名排版(放射线拟合)', () => {
  it('东西宽的国家横排,路径平、在国土里,字距能拉开', () => {
    const { label, own } = fit((x, y) => x >= 20 && x < 180 && y >= 38 && y < 62, polity('卡德斯坦'), 60);
    expect(label.vertical).toBe(false);
    expect(tiltOf(label)).toBeLessThan(10);
    pathInside(label, own);
    // 路径长 ≥ 字数 × 字号 × (1 + 疏排字距)
    const p = label.path;
    const len = Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]);
    expect(len).toBeGreaterThan([...label.text].length * label.size * 1.5);
    expect(own(label.anchor[0], label.anchor[1])).toBe(true);
  });

  it('南北狭长的国家竖排', () => {
    // 东西只有 32 个世界单位宽、南北 360:横排只能用很小的字,竖排能用大字
    const { label, own } = fit((x, y) => x >= 96 && x < 104 && y >= 5 && y < 95, polity('昌', true), 30);
    expect(label.text).toBe('大昌');
    expect(label.vertical).toBe(true);
    expect(tiltOf(label)).toBeGreaterThan(70);
    pathInside(label, own);
  });

  it('斜着的狭长国土:沿走向略斜着排(不超过 25°),路径在国土里', () => {
    const inside = (x: number, y: number) => Math.abs(y - 50 - (x - 100) * 0.3) < 9 && x > 25 && x < 175;
    const { label, own } = fit(inside, polity('哈尔提亚'), 40);
    expect(label.vertical).toBe(false);
    expect(tiltOf(label)).toBeGreaterThan(5);
    expect(tiltOf(label)).toBeLessThanOrEqual(26);
    pathInside(label, own);
  });

  it('国土越大字越大(同样形状,放大一倍)', () => {
    const small = fit((x, y) => x >= 80 && x < 120 && y >= 42 && y < 58, polity('托莱特'), 10).label;
    const big = fit((x, y) => x >= 60 && x < 140 && y >= 34 && y < 66, polity('托莱特'), 40).label;
    expect(big.size).toBeGreaterThan(small.size * 1.3);
  });

  it('放得下就写全称,放不下写简称', () => {
    // 很长的国土:全称"索拉特王国"放得下
    const long = fit((x, y) => x >= 10 && x < 190 && y >= 40 && y < 60, polity('索拉特'), 60).label;
    expect(long.text).toBe('索拉特王国');
    // 小的国土:全称只能用很小的字,写简称"索拉特"
    const short = fit((x, y) => x >= 92 && x < 108 && y >= 44 && y < 56, polity('索拉特'), 8).label;
    expect(short.text).toBe('索拉特');
    expect(short.full).toBe('索拉特王国');
  });

  it('给了国都:另算一条绕开国都的备选路径,也在国土里', () => {
    const inside = (x: number, y: number) => x >= 40 && x < 160 && y >= 35 && y < 65;
    const cap: [number, number] = [100 * GRID, 50 * GRID];
    const { label, own } = fit(inside, polity('梅尔金'), 40, cap);
    expect(label.alt).toBeDefined();
    const p = label.alt!.path;
    for (let i = 0; i + 1 < p.length; i += 2) expect(own(p[i], p[i + 1])).toBe(true);
    // 备选路径离国都至少一个"洞"的半径
    const minD = Math.min(...Array.from({ length: p.length / 2 - 1 }, (_, i) => segDist(cap, p, i * 2)));
    expect(minD).toBeGreaterThan(8);
  });
});

function segDist(c: [number, number], p: number[], i: number): number {
  const [ax, ay, bx, by] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
  const dx = bx - ax;
  const dy = by - ay;
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((c[0] - ax) * dx + (c[1] - ay) * dy) / L));
  return Math.hypot(ax + dx * t - c[0], ay + dy * t - c[1]);
}
